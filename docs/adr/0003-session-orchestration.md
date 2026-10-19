# ADR‑0003. Оркестрация сессий

- Статус: **принято** (2026‑09‑29, вариант B, квоты 1 / 10)
- Дата: 2026‑09‑29
- Роли: техлид, backend, platform, security

## Контекст

Нужен компонент, который ведёт жизненный цикл `requested → provisioning → ready → running → checking → finished | expired | killed`, применяет квоты (на пользователя и на сервер), убивает по TTL, находит и удаляет сирот после падения платформы, и держит терминальный шлюз (ADR‑0002). Ограничения: один VPS, один человек, стек TypeScript (ADR‑0006).

## Варианты

| Вариант | Плюсы | Минусы |
|---|---|---|
| A. Логика внутри Next.js route handlers + cron | нет второго процесса | нужен docker socket в публичном веб‑процессе (Security против); долгие WS и фоновые циклы не для serverless‑модели Next.js |
| B. **Отдельный сервис‑оркестратор (Node 22 + TypeScript)**: состояние сессий в PostgreSQL (та же БД, отдельные таблицы), внутренний планировщик в процессе (reconcile‑цикл раз в N секунд), без брокера очередей | один дополнительный процесс; нет Redis/RabbitMQ; всё состояние в одной БД, которую и так бэкапим; reconcile по меткам контейнеров прост | при > 1 экземпляре оркестратора нужны блокировки — не наша задача на одном VPS |
| C. B + BullMQ/Redis как очередь задач | «правильная» очередь, ретраи | ещё один stateful‑сервис ради нагрузки в 10 сессий |
| D. k3s + Kubernetes Jobs/Pods как runtime и оркестратор | reconcile «из коробки», квоты через ResourceQuota, сетевые политики | k3s на одном VPS съедает ~1 ГБ и добавляет слой, который один человек и AI должны уметь чинить; терминал всё равно требует своего шлюза (`pods/exec`); Firecracker потом не проще |

## Решение

**B.** Компоненты внутри `services/orchestrator`:

- `SessionService` — переходы состояний, единственное место, где меняется `Session.status`; все переходы пишутся в `SessionEvent` (аудит‑лог).
- `RuntimeProvider` (ADR‑0001) — `DockerRuntimeProvider` через `dockerode` по unix‑socket.
- `TerminalGateway` (ADR‑0002).
- `GraderRunner` (ADR‑0004).
- `Reconciler` — при старте и каждые 30 с: (1) список контейнеров с меткой `wom.platform=sandbox`; (2) контейнер без активной сессии в БД → destroy; (3) сессия `running` с `expiresAt < now` → `expired` + destroy; (4) сессия `provisioning` старше 2 мин → `killed` с причиной; (5) сессия `running`, чей контейнер исчез → `killed`.
- `QuotaService` — лимиты из таблицы `PlatformSettings`: `maxSessionsPerUser` (по умолчанию 1), `maxSessionsGlobal` (по умолчанию 10), проверка в транзакции при создании.

Контракт web ↔ оркестратор:

- Оркестратор слушает только внутри compose‑сети (`orchestrator:8080`), не публикуется наружу, кроме пути `/ws/term/*`, который reverse‑proxy (ADR‑0007) пробрасывает напрямую.
- Web вызывает REST оркестратора с заголовком `X-Internal-Token` (общий секрет из env). Эндпоинты: `POST /sessions` (создать: userId, scenarioId), `GET /sessions/:id`, `POST /sessions/:id/check`, `POST /sessions/:id/hints/:level`, `DELETE /sessions/:id` (killed), `POST /sessions/:id/terminal-token`.
- Браузер общается с оркестратором **только** через WS терминала с одноразовым токеном; всё остальное — через web.
- Статус сессии фронт получает polling'ом `GET /api/sessions/:id` через web раз в 2 с в состояниях `provisioning/checking`; SSE — позже, если polling станет заметен.

Модель данных (дополнение к `packages/db`):

```prisma
enum SessionStatus { REQUESTED PROVISIONING READY RUNNING CHECKING FINISHED EXPIRED KILLED FAILED }
// FAILED добавлен при реализации (2026‑09‑30): провал provisioning отличается от KILLED (действие человека/TTL) и показывается пользователю с причиной.

model TrainingSession {
  id            String        @id @default(cuid())
  userId        String
  scenarioId    String
  status        SessionStatus @default(REQUESTED)
  runtimeHandle Json?         // {provider:"docker", containerId, networkId}
  createdAt     DateTime      @default(now())
  readyAt       DateTime?
  expiresAt     DateTime?
  finishedAt    DateTime?
  result        Json?         // последний ответ грейдера
  hintsUsed     Int[]         @default([])
  score         Int?
  events        SessionEvent[]
  @@index([userId, status])
  @@index([status, expiresAt])
}

model SessionEvent {
  id        String   @id @default(cuid())
  sessionId String
  kind      String   // status_change | hint | check | terminal_open | killed_by_admin ...
  payload   Json?
  createdAt DateTime @default(now())
  @@index([sessionId, createdAt])
}
```

## Последствия

- Плюс: одна БД, один дополнительный процесс, всё воспроизводится `docker compose up`.
- Плюс: reconciler по меткам не зависит от состояния памяти процесса — переживает рестарты.
- Минус: оркестратор — единственная точка отказа для активных терминалов; при его рестарте WS рвутся, окружения остаются (live‑restore), пользователь переподключается.
- Минус: polling статуса; приемлемо при 10 пользователях.

## Принятое решение

2026‑09‑29: B принят вместе с квотами по умолчанию (1 активная сессия на пользователя, 10 на сервер).

## Реализация и отклонения (дополнение 2026‑10‑01)

Раздел сверен с кодом `services/orchestrator` и схемой `packages/db`. Решение B (отдельный оркестратор, состояние в PostgreSQL, reconciler по меткам) сделано; ниже — что реализовано иначе, чем написано выше.

- **`QuotaService` и `PlatformSettings` нет.** Квоты читаются из переменных окружения оркестратора (`services/orchestrator/src/config.ts`) и проверяются в `SessionService.create` в одной транзакции: `MAX_SESSIONS_PER_USER` (1), `MAX_SESSIONS_GLOBAL` (10, на проде 20), `MAX_K8S_SESSIONS` (3, на проде 6), `MAX_K8S_PROVISIONING` (1, на проде 2 — сколько кластеров поднимается одновременно, остальные ждут в `REQUESTED` с фазой `queued` до `QUEUE_TIMEOUT_MS`, 20 минут). Менять квоты можно только через `.env` и перезапуск. Таблицы настроек в `schema.prisma` нет.
- **Квота по адресу клиента (2026‑10‑01).** Web передаёт в `POST /sessions` адрес клиента (`clientIp`, только корректный IP), оркестратор считает активные сессии с адреса и при `MAX_SESSIONS_PER_IP` (3, 0 — выключено) отказывает текстом «С твоего адреса уже запущено N стенда: это предел». Адрес хранится в `TrainingSession.clientIp` (индекс `clientIp, status`). Срок хранения адреса не определён: вопрос открыт (`docs/threat-model.md`). Квота считает точный адрес, адреса одной IPv6‑подсети /64 не объединяются.
- **Защита по диску (2026‑10‑01).** Оркестратор меряет занятость файловой системы `DISK_GUARD_PATH` (по умолчанию `/` внутри контейнера, то есть data‑root демона): от `DISK_REFUSE_PCT` (85) новые сессии получают отказ «заканчивается место на диске», от `DISK_KILL_PCT` (93) шаг 0 reconciler завершает все активные сессии с причиной `disk pressure` (статус `KILLED`). Значение 0 выключает порог. Занятость и состояние egress‑guard отдаёт `GET /health`.
- **Отказ кластерным сессиям без защиты сети (2026‑10‑01).** Если файл heartbeat egress‑guard (`EGRESS_HEARTBEAT_FILE`) отсутствует или старше `EGRESS_HEARTBEAT_MAX_AGE_SEC` (150 с), `create` для Kubernetes‑сессий отказывает. Проверка срабатывает только при создании: сессии, уже стоящие в очереди `REQUESTED`, будут подняты.
- **Восстановление после рестарта оркестратора (2026‑10‑01).** Очередь и подъём живут в памяти процесса, поэтому `SessionService.recoverAfterRestart()` вызывается при старте до приёма запросов: `PROVISIONING` без живого процесса сразу становится `FAILED` с текстом «Платформа перезапускалась во время подъёма стенда. Запусти сценарий заново.» (остатки на демоне убирает reconciler как сирот), `CHECKING` возвращается в `RUNNING`, `REQUESTED` заново ставятся в подъём в порядке `createdAt`. Зависшую проверку без рестарта освобождает шаг 2a reconciler: `CHECKING` дольше `GRADER_TIMEOUT_MS` и минуты запаса (колонка `checkStartedAt`) возвращается в `RUNNING`.
- **Шаги reconciler (каждые 30 с и при старте) на самом деле такие:** 0) диск ≥ порога → завершить все активные; 1) `expiresAt < now` у `READY`, `RUNNING`, `CHECKING` → `EXPIRED` и удаление; 2) `PROVISIONING` дольше `PROVISIONING_TIMEOUT_MS` (отсчёт от `provisioningStartedAt`) или `REQUESTED` дольше `QUEUE_TIMEOUT_MS` → `FAILED` (не `KILLED`, как написано выше); 2a) зависшие проверки; 3) песочница без активной сессии → удалить (песочницы CLI `wom scenario test|run` не трогаются два часа); 4) активная сессия с исчезнувшей песочницей → `KILLED`.
- **Песочницы переживают рестарт оркестратора, но не рестарт демона Docker.** Строка «окружения остаются (live‑restore)» устарела: `live-restore` не включён и в rootless‑режиме практически неработоспособен. Песочницы и кластеры kind живут вне compose, поэтому `docker compose up` их не задевает; рестарт самого rootless‑демона (`systemctl --user restart docker`) завершает все сессии.
- **Реальный список внутренних маршрутов оркестратора** (все, кроме `GET /health`, требуют `X-Internal-Token`): `GET /health` (число активных сессий, `disk.usedPct`, `egress`), `POST /sessions` (`userId`, `scenarioId`, необязательный `clientIp`), `GET /sessions/:id`, `DELETE /sessions/:id`, `POST /sessions/:id/check`, `POST /sessions/:id/hints/:level`, `POST /sessions/:id/terminal-token`, `GET /capacity` (занято и максимум: всего и Kubernetes; оценка времени ожидания входит в текст отказа по квоте), `POST /submissions/:id/test` (ADR‑0009), `POST /admin/reconcile`, `POST /admin/drain` (режим «платформа обновляется»: новые сессии получают отказ, существующие не затрагиваются; `{"draining": false}` снимает режим), `DELETE /admin/sessions/:id`. Терминал: `WS /ws/term/:id?token=…`.
- **Статус `READY` не присваивается.** Он остался в enum `SessionStatus` и в списке активных статусов (`ACTIVE_STATUSES`, шаги reconciler), но сессия идёт `PROVISIONING → RUNNING` напрямую. Удалять его не стали: нужна миграция Prisma, смысла от этого нет.
- **Добавлено сверх ADR.** Статус `FAILED` (причина — в `lastError`); колонки `provider`, `startupMs`, `startupPhase`, `provisioningStartedAt`, `checkStartedAt`, `checkAttempts`, `clientIp`; `AccountJanitor` (отключение учёток без активности `INACTIVE_ACCOUNT_DAYS` = 7 дней, решено 2026‑09‑30, админов не трогает); `SubmissionRunner` (ADR‑0009).
- **Место в очереди.** Для сессии, ждущей слот кластера, оркестратор добавляет в её представление `queuePosition` (1 — следующая) и оценку ожидания `queueEtaMin`. Статус сессии по‑прежнему опрашивается раз в 2 с, SSE нет.

## Дополнение 2026-10-04: снимок сценария в сессии

`TrainingSession.scenarioSnapshot` (JSONB, может быть пустым) хранит версию сценария, по которой идёт сессия: подсказки с штрафами, скрипт проверки и параметры окружения. Проверка и подсказки считаются по снимку, поэтому переопубликация сценария во время идущей сессии не меняет правил для игрока. Снимок содержит скрипт проверки, поэтому очищается вместе с `runtimeHandle` при завершении сессии; сессии, начатые до появления колонки, идут по живому сценарию, как раньше.
