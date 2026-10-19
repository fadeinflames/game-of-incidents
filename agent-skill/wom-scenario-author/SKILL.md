---
name: wom-scenario-author
description: Use when a person describes an incident (an outage, a postmortem, a ticket, a story from their own production) and their infrastructure and wants a Game of Incidents training scenario built from it. Interviews the user, designs a faithful but safe stand, writes the scenario folder (format v2), verifies it with the platform's own tools (lint, build, regression, local run) and brings it up on the platform (push, publish, start a session).
---

# Автор сценариев Game of Incidents

## Задача

Человек рассказывает свой инцидент и свою инфраструктуру. Ты доводишь рассказ до **работающего стенда**: пишешь сценарий, проверяешь его инструментами платформы и выкладываешь на платформу так, чтобы человеку оставалось нажать «Запустить» (а лучше, чтобы он уже сидел в терминале сломанного стенда). Текст без проверки и без загрузки — это не результат, а полуфабрикат.

**Готово** означает: на свежем стенде поломка воспроизводится, грейдер говорит «не решено», эталонное решение чинит стенд, грейдер говорит «решено», и сценарий доступен на платформе. Если ты дошёл не до конца, прямо назови ступень, на которой остановился, и почему:

| Ступень | Что это | Чем подтверждается |
|---|---|---|
| 0 | папка написана и сверена с правилами по тексту | только твоя проверка по справочнику ниже |
| 1 | линтер чист | `wom scenario lint` |
| 2 | регресс прошёл: свежее → «не решено», эталон → «решено», пробы харднинга | `wom scenario test` |
| 3 | стенд поднят у человека локально, он в нём | `wom scenario run` |
| 4 | сценарий загружен на платформу | `wom scenario push` |
| 5 | платформа собрала образ, прогнала регресс у себя и опубликовала | `wom scenario push --publish` |
| 6 | сессия запущена, есть ссылка на терминал | `wom scenario push --start` |

## Шаг 0. Разведай среду (сам, до вопросов)

Выясни, до какой ступени ты можешь дойти. Ничего не спрашивай у человека, что можно проверить командой.

1. Есть ли репозиторий платформы (`scenarios/`, `packages/scenario/`) и CLI. CLI живёт в репозитории (отдельного пакета в npm нет): если репозитория нет, предложи `git clone https://github.com/fadeinflames/game-of-incidents.git` и `npm ci`. Проверь `node -v` (нужен 22 или новее) и `ls node_modules/.bin/wom`; без `npm ci` не запускай `npx wom` (npx может скачать из реестра чужой пакет с таким именем), используй `./node_modules/.bin/wom` или `npx --no-install wom`. Справка: `wom scenario` без аргументов.
2. Есть ли Docker для песочниц: `docker info`. Команды `build`, `test` и `run` понимают только сокет `unix://`: на Windows запускай их из WSL2 (Docker Desktop с именованным каналом не подойдёт). `DOCKER_HOST` задавай только для rootless-демона (`unix://$XDG_RUNTIME_DIR/docker.sock`); если работает демон по умолчанию, оставь как есть. Для Kubernetes-сценариев нужны ещё `kind` в `PATH` (или `KIND_BIN`) и образ терминала: `docker build -t wom-tools:dev images/tools`; без них ступень 2 для таких сценариев недостижима. Без Docker остаются ступени 0, 1 и 4.
3. Заданы ли переменные для платформы: `WOM_URL`, `WOM_USER`, `WOM_PASSWORD`. Проверяй так, чтобы значения не попали в вывод: `[ -n "$WOM_PASSWORD" ] && echo задан || echo нет`. **Никогда не печатай и не проси прислать пароль в чате.** Если переменных нет, скажи человеку, как задать их самому в своём терминале (в PowerShell: `$env:WOM_URL="https://…"; $env:WOM_USER="…"; $env:WOM_PASSWORD="…"`), и продолжай работу с тем, что есть.

## Шаг 1. Интервью (один раз, одним сообщением)

Задай только то, чего нет в описании, не больше пяти вопросов. То, что человек уже сказал, не переспрашивай. Что нужно знать:

| Тема | Что выяснить | Если не знает |
|---|---|---|
| Инцидент | что видел дежурный (симптом, алерт), первопричина, как починили, что пробовали зря | возьми самую правдоподобную причину и назови её допущением |
| Инфраструктура | ОС и дистрибутив, сервисы и версии, как они связаны (порты, upstream, БД, очереди), одна машина или Kubernetes (сколько нод, ingress, операторы) | самый простой вариант, который даёт тот же симптом |
| Уровень и время | JUNIOR, MIDDLE или SENIOR, 15–45 минут | MIDDLE, 25 минут |
| «Починено» | что должно заработать и чем это измерить | сформулируй сам и покажи в плане |
| Платформа | адрес, есть ли аккаунт, роль (администратор или обычный пользователь) | платформы нет: ступени 1–3 |

Секреты и реальные данные в сценарий не попадают: имена компаний и людей, домены, IP-адреса, ключи, названия клиентов заменяй вымышленными (`example.com`, адреса из `192.0.2.0/24`). Если человек вставил пост-мортем с такими данными, скажи, что заменил их, и не повторяй оригиналы в файлах.

## Шаг 2. План стенда (покажи до написания файлов)

Коротко, 8–12 строк: название и slug; уровень; что сломано и как это видно; тип стенда; что из инфраструктуры воспроизводится как есть, что заменено аналогом, что не воспроизводится вовсе; по каким критериям грейдер решает «починено»; какие ловушки не должны проходить; три подсказки; допущения. Если человек возражает, поправь план. Если не отвечает или просил «просто сделай», иди дальше и перечисли допущения в отчёте.

**Какой тип стенда выбрать**

- `container` — один Linux-хост: конфиги, процессы и сервисы SysV, диск, права, cron, логи, сеть внутри хоста. База данных и кэш ставятся пакетом внутрь того же образа. Несколько сервисов на одном хосте: каждый как SysV-скрипт, `entrypoint.sh` запускает их по очереди и в конце создаёт маркер `/run/.boot-complete` (образец: `nginx-502-upstream`, nginx плюс приложение через `app.initd`).
- `kubernetes` — всё, где есть кластер: Deployment, Service, Ingress, пробы, RBAC, NetworkPolicy, квоты, PVC, CronJob, HPA, до четырёх нод. У каждой сессии свой кластер kind.
- Не воспроизводится: несколько отдельных хостов с сетью между ними (делай Kubernetes с несколькими подами или нодами), ядро и железо, облачные API (замени аналогом), графический интерфейс, Windows, доступ в интернет и во внешние сервисы (egress закрыт).

**Инфраструктура → аналог на стенде**

| В жизни | На стенде |
|---|---|
| nginx, apache, haproxy | пакет в образе (container) или Deployment (kubernetes) |
| PostgreSQL, MySQL, Redis | пакет в образе или StatefulSet |
| systemd-юнит | SysV-скрипт в `/etc/init.d/`; чтобы хост походил на обычный Debian, скопируй `images/sysv-shims/systemctl` и `journalctl` в `<slug>/image/` и добавь в Dockerfile `COPY systemctl journalctl /usr/local/bin/` (образец: `nginx-502-upstream`) |
| AWS S3 | S3-совместимое хранилище в кластере (образец: `lost-storage`, versitygw) |
| IAM | RBAC |
| Security Group | NetworkPolicy |
| managed БД | StatefulSet |
| облачный балансировщик | Service и ingress-nginx |
| Prometheus | манифесты в кластере (образец: `blind-monitoring`, Prometheus с remote_write); Alertmanager в образцах нет, пиши сам |
| CI, Terraform state | файлы в образе |

Платформа делит память между сессиями: обычному Linux-хосту хватает 256–512 МБ, терминалу в Kubernetes 384 МБ, тяжёлые компоненты кластера (cert-manager, Prometheus) требуют `startup.expectedSec`. Легенда в брифе может говорить «мы в облаке», но всё, что игрок трогает, живёт на стенде.

**Образцы в репозитории** (скопируй ближайший и меняй, не пиши с нуля):

| Паттерн | Образец |
|---|---|
| конфиг на Linux-хосте (порт, upstream) | `nginx-502-upstream` |
| диск, tmpfs, данные | `disk-full`, `disk-full-k8s` |
| права и владельцы файлов | `backup-permissions` |
| пробы, rollout, ресурсы | `broken-probes`, `friday-deploy` |
| квоты, лимиты | `quota-release` |
| конфигурация, Secret/ConfigMap | `lost-config`, `lost-storage` |
| DNS, сетевые политики, маршруты | `lost-in-dns`, `ghost-route`, `invisible-network`, `phantom-network` |
| CronJob, `concurrencyPolicy`, Job-ы | `cronjob-storm` |
| логи, вытеснение подов | `log-flood` |
| сертификаты, cert-manager | `cert-expired` |
| RBAC | `missing-permissions` |
| миграции БД | `schema-ahead` |
| автоскейлинг и метрики | `lying-autoscaler`, `blind-monitoring` |
| узлы, drain, обновление кластера | `stuck-drain`, `upgrade-gone-wrong` (4 ноды) |

## Шаг 3. Напиши папку

Папка `scenarios/<slug>/` в репозитории (без репозитория — `<slug>/` в рабочем каталоге). Порядок: `scenario.yaml` → `image/` (или `k8s/`) → `break.sh` → `check.sh` → `solve.sh` → `brief.md` → `debrief.md` → `guide.md` (только для JUNIOR). Формат файлов, правила и образец — в справочнике ниже. Три принципа, которые нельзя ослаблять:

1. **Честная поломка**: диагностируется стандартными инструментами, есть хотя бы один правильный путь.
2. **Грейдер проверяет результат, а не способ**: заглушка, которая прячет симптом (`return 200`, убранная проба), не проходит.
3. **Скрипты `break/check/solve` секретны**: не копируй их в образ и не упоминай их текст в брифе и подсказках.

Язык текстов — язык человека (по умолчанию русский). Сообщения критериев грейдера не содержат спойлеров до решения. В Kubernetes-сценарии `wom scenario build` собирает только `images[0]`: остальные образы приложения собирай и перечисляй в `images` сам, а публичные образы закрепляй версией.

## Шаг 4. Проверь (цикл до зелёного, не больше пяти кругов)

Из корня репозитория:

```bash
export DOCKER_HOST=unix:///run/user/1000/docker.sock      # только если песочницы в rootless-демоне; иначе не задавай
./node_modules/.bin/wom scenario lint  scenarios/<slug>
./node_modules/.bin/wom scenario build scenarios/<slug>
./node_modules/.bin/wom scenario test  scenarios/<slug>   # автоматическая проверка: поломка, эталон, пробы харднинга
```

`wom scenario run scenarios/<slug>` (опция `--solve` применяет эталон перед входом) открывает интерактивный терминал внутри стенда, поэтому сам ты его не запускаешь: дай человеку команду для его терминала (ступень 3).

Что делать, когда проверка падает:

| Симптом | Что чинить |
|---|---|
| `lint`: ошибка с правилом | найди правило в справочнике ниже и поправь файл; **не ослабляй проверку и не вырезай правило, чтобы пройти** |
| `build`: Dockerfile не собирается | читай вывод `docker build`; базовый образ только из списка (правило 14) |
| `test`: «baseline» не совпал | грейдер требует состояние, которого до поломки нет: поставь `test: { baseline: fail }` или поправь грейдер |
| `test`: грейдер не падает на сломанном стенде | `break.sh` не сработал (ждёт маркер entrypoint? дождался ли эффекта?) или грейдер слишком мягкий |
| `test`: грейдер не проходит после `solve.sh` | `solve.sh` неполон, грейдер просит лишнего или есть гонка: добавь ожидание и повторы в `check.sh` (правило 7) |
| `test`: пробы харднинга | запись в корень, пакетный менеджер или права: проверь `writable`, `tmpfs` и конец Dockerfile |
| `run`: стенд не похож на задуманный | перечитай `break.sh` и образ, сверь с планом |

Если после пяти кругов зелёного нет, не изображай успех: покажи человеку, что падает и на каком шаге, и спроси, что делать. Если Docker недоступен, не пиши «проверено»: честно назови ступень 0 или 1, отдай папку и zip для страницы «Мои сценарии» (ступень 4).

## Шаг 5. Выложи на платформу

Выбери по тому, что нашёл на шаге 0. Платформа запускает код сценария только после действия модератора или администратора: обычный пользователь не может опубликовать свой сценарий сам, и обходить это нельзя.

| Ситуация | Команда | Результат |
|---|---|---|
| платформы нет | `npx wom scenario run scenarios/<slug>` | локальный стенд у человека (ступень 3) |
| своя платформа, аккаунт администратора | `npx wom scenario push scenarios/<slug> --start` | загрузка, сборка и регресс на платформе, публикация, сессия, ссылка `SESSION_URL=…` (ступень 6) |
| то же, но без запуска | `… push … --publish` | сценарий в каталоге, ссылка `SCENARIO_URL=…` (ступень 5) |
| чужая платформа, обычный аккаунт | `npx wom scenario push scenarios/<slug>` | заявка загружена, ждёт модератора (ступень 4); после публикации сценарий появится в каталоге |
| нет CLI | zip папки (`tar -a -cf <slug>.zip <slug>` в Windows, `zip -r` в Linux и macOS) и страница «Мои сценарии» | то же, что в предыдущей строке |
| есть ssh на сервер платформы | скопируй папку в `~/wom-platform/scenarios/`, прогони там `wom scenario test` и выполни `./scripts/deploy.sh` | деплой линтует все сценарии (ошибка в любом останавливает деплой), собирает образы и добавляет сценарий в каталог; регресс он не запускает и перезапускает стек |

Адрес и учётка — `--url` или `WOM_URL`, `WOM_USER`, `WOM_PASSWORD` в окружении (в аргументах пароль не принимается). Пределы архива: 5 МБ, 200 файлов, файл до 2 МБ, 20 МБ распакованного; zip64 и пароль не поддерживаются; `push` не кладёт в архив `.git*` и `node_modules` и отказывается от символических ссылок. Лимиты платформы: 3 загрузки в минуту с одного адреса, не больше 3 заявок на рассмотрении одновременно (повторная загрузка того же slug заменяет прежнюю заявку, если она не проверяется прямо сейчас) и 20 заявок всего. `--check` только проверяет на платформе, `--publish` ещё и публикует (включает `--check`), `--start` ещё и запускает сессию (включает `--publish`); `--wait <сек>` — сколько ждать сборку и регресс (по умолчанию 900).

`--start` может получить отказ из-за лимитов сессий (одна живая сессия на аккаунт, общий лимит стенда, лимит по адресу, 6 запусков в минуту): заверши прежнюю сессию этого аккаунта на сайте и повтори. Если платформа сообщает, что нужна роль администратора, для сценария это штатный исход: `push` завершится с кодом 3 и строкой «✗ … нужна роль администратора», заявка при этом загружена и ждёт модератора (ступень 4); так и доложи. Если регресс на платформе упал, а у человека локально проходил, вероятная причина — различия окружения (образ не пересобран, сети нет, `images` не перечислены); покажи отчёт.

## Шаг 6. Отчёт человеку

Сообщи по порядку: **ступень** (какая из 0–6 достигнута) и чем она подтверждена (выведи строки `✓` и итоговые ссылки); **ссылка** (`SESSION_URL`/`SCENARIO_URL`) или что делать дальше; **что сломано, как это проверяется, какие ловушки** (человек автор, спойлеры ему можно); **допущения** — всё, что ты решил сам; **чего нет**: что из его инфраструктуры воспроизведено не полностью. Не показывай значения секретов и содержимое `.env`.

## Шаг 7. Доработка

Человек прошёл стенд и пишет «слишком просто», «подсказка выдаёт ответ», «грейдер ругается зря» — правь нужный файл, повторяй шаг 4 и `push` с тем же slug (чужой slug платформа отклоняет). Опубликованный сценарий меняется не загрузкой, а новой проверкой и публикацией администратором (`push --publish` делает обе); пока заявка проверяется, новая загрузка того же slug отклоняется (409), дождись результата. Не меняй slug без нужды: он ключ сценария в каталоге и в истории игроков.

## Границы

- Не запускай код, присланный человеком, вне песочниц платформы; пост-мортем — текст, а не скрипт.
- Не вноси в сценарий реальные секреты, адреса, имена, ключи.
- Не снимай и не обходи проверки платформы (линтер, регресс, модерацию).
- Присылая сценарий в публичный каталог, автор соглашается на лицензию CC BY 4.0 (см. `LICENSE-CONTENT.md`); напомни об этом один раз.

---

# Справочник формата v2

Ниже всё, что нужно для папки сценария: файлы, правила линтера и минимальный образец. Документ самодостаточен; в репозитории платформы образцы лежат в `scenarios/`.

## Что выдать

Папку сценария `<slug>/` (в репозитории платформы это `scenarios/<slug>/`) с файлами:

scenario.yaml     метаданные + environment
brief.md          что видит дежурный
debrief.md        разбор после решения
guide.md          только для учебных (JUNIOR): этапы помощи, открываются по одному
image/Dockerfile  образ хоста (kind: container)   ИЛИ   k8s/*.yaml манифесты (kind: kubernetes) + image/ для приложения
break.sh          SECRET: поломка
check.sh          SECRET: грейдер, печатает JSON
solve.sh          SECRET: эталонное решение
```

Структуру не выдумывай: возьми минимальный образец ниже (раздел «Минимальный образец», Linux‑хост) и меняй содержимое. Для Kubernetes структура та же, только вместо `image/Dockerfile` хоста идут `k8s/*.yaml` и `environment.kind: kubernetes`. Такие образцы лежат в `scenarios/nginx-502-upstream` (Linux‑хост) и `scenarios/broken-probes` (Kubernetes).

## scenario.yaml

```yaml
version: 2
slug: <a-z0-9-, 3..64, уникальный>
title: "Короткое название"
summary: "Одно предложение: что видит дежурный."
type: "домен, инструменты"
difficulty: JUNIOR | MIDDLE | SENIOR
durationMin: 15..45                  # ttlMin окружения не меньше этого числа
tags: [linux, nginx, ...]           # a-z0-9-; тег tutorial не писать: его добавляет платформа учебной копии
contextJson: { infra: "...", services: [...], setup: "...", time: "..." }
eventsJson: [ { t: 0, type: alert, title: "...", body: "..." } ]
hintsJson:
  - { level: 1, penalty: 0,  text: "Направление: ..." }
  - { level: 2, penalty: 5,  text: "Инструмент: ..." }
  - { level: 3, penalty: 15, text: "Почти ответ: ..." }
actionsJson: []
gmScriptJson: null
brief: brief.md
debrief: debrief.md
guide: guide.md                      # только учебные кейсы (difficulty: JUNIOR), см. правило 9
test: { baseline: pass }             # fail, если грейдер требует состояние, которого до поломки нет
environment:
  kind: container                    # или kubernetes
  image: wom-scenario/<slug>:dev     # container: образ хоста; kubernetes: wom-tools:dev
  build: ./image
  break: break.sh
  check: check.sh
  solve: solve.sh
  ttlMin: 45                         # не меньше durationMin, иначе ошибка ttl-too-short
  startup: { expectedSec: 60, note: "Поднимаем ingress‑nginx" }   # сколько обычно ждать; note — для тяжёлых стендов
  resources: { cpus: 1, memoryMb: 512, pids: 256 }
  network: { egress: none }
  shell: { user: oncall, cwd: /home/oncall, shell: /bin/bash, sudo: true }
  hostname: web-01
  writable: ["/etc", "/var", "/home", "/root"]
  # kubernetes only:
  # cluster: { nodes: 1 }              # до 4; воркеры можно подписать: workerLabels: [ { topology.kubernetes.io/zone: a, node-pool: db }, ... ]
  # manifests: ./k8s                   # применяются в порядке имён файлов (00-…, 10-…); CRD и их объекты лучше разводить через Job
  # images: ["wom-scenario/<slug>:dev", "postgres:16-alpine"]   # все образы из манифестов, включая публичные (кластер без egress)
```

## Правила, которые проверяет линтер и регресс

1. **Честная поломка.** Проблема диагностируется стандартными инструментами (логи, `ss`, `df`, `kubectl describe`…), есть хотя бы один корректный путь, грейдер проверяет **результат**, а не способ. Ловушки (расширить пул, убрать пробу) не должны проходить.
2. **Скрипты на POSIX `sh`** (`#!/bin/sh`), без bash‑измов, LF. `check.sh` печатает ровно один JSON: `{"passed": true|false, "criteria": [{"id": "...", "ok": true|false, "message": "..."}]}`. Сообщения критериев на русском, без спойлеров до решения.
3. **Секреты не в образе.** `break.sh`, `check.sh`, `solve.sh` подаются платформой через stdin; в Dockerfile их не копировать.
4. **Образ хоста** (kind: container): Debian slim, пользователь `oncall` с `NOPASSWD` sudo, сервисы как SysV‑скрипты (`/etc/init.d/…`), entrypoint запускает их и ждёт (`sleep` в цикле); шимы `systemctl` и `journalctl` (чтобы хост походил на обычный Debian) лежат в репозитории платформы в `images/sysv-shims/`; без репозитория сервисы просто запускает entrypoint, как в образце; в конце удалить `apt`, `dpkg`, `pip`. Корневая ФС будет read‑only: всё, что сервис пишет, должно лежать в `writable`. Для «диск заполнен» использовать `tmpfs: { "/path": "size=128m" }` и восстанавливать содержимое в entrypoint.
5. **Kubernetes** (kind: kubernetes): все образы из манифестов перечислить в `images` (кластер без egress), `image` = `wom-tools:dev`, `break/check/solve` используют `kubectl`; для запросов изнутри кластера использовать `kubectl exec` в под, а не сеть снаружи. В `images` идут и образы, которые контроллеры запускают сами: `cert-manager-acmesolver` (задан не полем `image:`, а флагом `--acme-http01-solver-image=…` у cert-manager), `kube-webhook-certgen` (Job в штатном манифесте ingress-nginx). Линтер сверяет с `images` каждое поле `image:` и каждый флаг вида `--…-image=…` из `k8s/*.yaml` (правило `k8s-images-listed`, ошибка); образы `wom-scenario/…` он пропускает. Образ, заданный иначе (другим флагом, переменной окружения, через `kubectl set image` в `break.sh` или `solve.sh`), линтер не видит: впиши его в `images` сам.
   **Что есть в runner‑образе** (`wom-tools`, он же терминал игрока и место, где выполняются `break/check/solve` в Kubernetes‑сценариях): Alpine 3.22 с `bash`, `curl`, `jq`, `kubectl`, `coreutils`, `procps`, `iproute2`, `bind-tools` (`dig`, `nslookup`), `less`, `vim`, `nano`, `sudo`. **Нет `python3`, `psql`, `git`.** Всё, что требует Python или клиентов БД, делай внутри пода: `kubectl exec deploy/<имя> -- python3 -c '…'`, а в образ приложения (его собираешь ты) клади нужные утилиты.
6. **Тег образа и источники образов.** Образ, собранный из `environment.build`, тегируется `wom-scenario/<slug>:<тег>`. Без `build` в Linux‑сценарии `image` — это `wom-scenario/<slug>:…` или один из базовых образов из правила 14. В Kubernetes‑сценарии `image` всегда `wom-tools:<тег>` (образы других сценариев и платформы не подходят: ошибка `image-source`). Элементы `images` — это `wom-scenario/<slug>:…` (только свой slug) или публичные образы из реестров Docker Hub, `registry.k8s.io`, `quay.io`, `ghcr.io` (`image-registry`); образ без тега или с `:latest` даёт предупреждение `image-unpinned`: фиксируй версию или `@sha256:…`, иначе регресс завтра может сломаться без изменений в сценарии.
7. **Гонки.** После `service … reload` или `rollout` ждать реального эффекта в `break.sh` и давать грейдеру несколько попыток с паузой.
8. **Бриф** — секции `## Что известно`, `## Что не известно`, `## Цель`, `## Ограничения`, `## Доступ`. **Разбор** — `## Что было сломано`, `## Как это диагностируется`, `## Эталонное решение`, `## Ловушки` (если есть), `## Чему учит`, `## Почитать` (ссылки как `[текст](url)`). Бриф — не стена текста: всё обучающее уходит в `guide.md`.
9. **Учебный формат (JUNIOR).** Папка с `guide.md` даёт **две карточки в каталоге**: обычную (`<slug>`, как написано в yaml) и учебную (`<slug>-tutorial`, «<title> · учебный», тег `tutorial` и штраф 0 у подсказок 1–2 ставятся автоматически). В брифе плашка‑цитата, начинающаяся с `> 🎓`, и секции `## Шпаргалка` (таблица команда → что показывает) и `## Почитать заранее` (3 ссылки с пояснением, зачем) — они попадают только в учебную копию, из обычной вырезаются. Тег `tutorial` в yaml не писать (предупреждение `tutorial-tag`), slug не должен кончаться на `-tutorial`. Линтер напоминает предупреждениями `guide-junior` (у кейса с `guide.md` не JUNIOR) и `tutorial-brief-parts` (в брифе нет плашки `> 🎓` или одной из двух секций). `guide.md` — лестница диагностики: каждый `## Заголовок` = один этап, который игрок открывает кнопкой «Не знаю, что делать»; внутри одна‑две команды, что смотреть в выводе и почему. Ответ в этапах не пишется, последний этап говорит «исправь и дождись эффекта». Проверка кейса всё равно одна, целиком.
10. **Тяжёлые стенды.** Если в кластер ставятся дополнительные компоненты (CNI, ingress‑контроллер, Prometheus, cert‑manager), укажи `environment.startup: { expectedSec, note }`: платформа покажет игроку фазы подъёма и обычное время ожидания, а в каталоге пометит «старт ~N мин».
11. **Тяжёлые стенды и порядок манифестов.** Всё, что применяется одним `kubectl apply -f k8s/`, не имеет гарантированного порядка: объекты CRD (Certificate, ClusterIssuer) и всё, что зависит от webhook'ов, создавай из Job'а с `kubectl`, который ждёт готовности контроллера (образец: `scenarios/cert-expired`). Генераторы нагрузки, чьи окна метрик пусты сразу после старта, требуют `test: { baseline: skip }`.
12. **Облако → аналог в кластере.** Платформа работает полностью локально: IAM → RBAC, S3 → MinIO, ExternalSecret → Secret, облачный SG → NetworkPolicy, managed БД → StatefulSet. Легенда брифа может говорить «мы в облаке», но всё, что игрок трогает, живёт в kind.

13. **`break.sh` стартует сразу после запуска контейнера**, когда entrypoint ещё может поднимать сервисы или восстанавливать данные. Если поломка зависит от состояния, которое готовит entrypoint (база запущена, данные скопированы на tmpfs), entrypoint в конце создаёт файл‑маркер (`: > /run/.boot-complete`), а `break.sh` первым делом ждёт его с таймаутом и падает с понятным сообщением, если не дождался (в минимальном образце выше это уже сделано; в репозитории: `scenarios/disk-full`). Регресс для Linux‑хостов запускает `break.sh` на свежем контейнере без паузы, как платформа.
14. **Базовые образы.** `FROM` в `image/Dockerfile` только из списка: `debian:bookworm-slim`, `python:3.12-alpine`, `alpine:3.22` и `alpine:3.20` (3.20 больше не поддерживается, бери 3.22; можно с `@sha256:…`). Стадии того же Dockerfile (`FROM … AS build`, `COPY --from=build`) разрешены, если стадия объявлена выше по файлу; чужой образ в `COPY --from=` или `RUN --mount=…,from=`, переменная в `FROM ${BASE}`, директивы `# syntax=` и `# escape=`, `FROM`, разорванный переносом строки, дают ошибку `image-base`: сборку заявки запускает модератор на сервере платформы, и она не должна тянуть произвольные образы. Если нужен другой базовый образ, скажи об этом пользователю: список расширяет владелец платформы.
15. **Грейдер не читает файлы игрока.** `/root`, `/home` и `/etc` в стенде записываемы, поэтому клиент, который подхватывает rc‑файл, можно обмануть. В `check.sh` вызывай `psql -X …` (без `~/.psqlrc`) и `curl -q …` (`-q` обязательно первым аргументом, иначе `~/.curlrc` всё равно прочитается). Линтер предупреждает правилами `grader-psql-rc` и `grader-curl-rc`. Подробнее об окружении скриптов в правиле 17.
16. **Строгие поля `scenario.yaml`.** `image` и каждый элемент `images` — обычная ссылка на образ в нижнем регистре (`[registry/]name[:tag][@sha256:…]`), без пробелов и кавычек внутри значения. `cluster.nodeImage` можно не указывать; если нужен, то только `kindest/node:vX.Y.Z` (можно с `@sha256:…`). `capabilities` пишутся без префикса `CAP_` и заглавными (`NET_BIND_SERVICE`); `SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE` и другие из списка запрета не выдаются никому. `environment.build` и `environment.manifests` — относительные пути внутри папки сценария (без ведущего `/` и без `..`: иначе файл не загрузится), `ttlMin` не меньше `durationMin`. Пути в `writable` и `tmpfs` записывай в нормальном виде: без `..`, `.`, `//` и завершающего `/` (`/etc/../usr/bin` не пройдёт). Поле `environment.setup` платформа не выполняет (ошибка `setup-unsupported`): подготовку клади в образ или в `break.sh`.
17. **Окружение скриптов.** `break.sh`, `check.sh` и `solve.sh` выполняются от root с `HOME=/nonexistent`: файлов настроек в домашнем каталоге нет (`~/.psqlrc`, `~/.curlrc`, `~/.kube/config` и подобных), а игрок всё равно может подложить их в `/root` и `/home`. Поэтому всё нужное передавай явно: `psql -X -h … -U …`, `curl -q …`, пути и учётные данные в аргументах; в Kubernetes‑сценариях `KUBECONFIG` уже выставлен. `break.sh` обязан уложиться в **240 секунд** целиком (в том числе ожидание готовности стенда); линтер оценивает самое долгое ожидание в циклах и предупреждает правилом `break-wait-budget`, если оно больше 240 с. Ограничивай циклы ожидания по времени, а не только по числу шагов, и завершайся с кодом 1 и понятным сообщением, если стенд не готов.
18. **Ресурсы.** Платформа запускает много сессий на одном сервере, память делится между ними. Бери `resources.memoryMb` по необходимости: до 1024 МБ без замечаний, от 1025 до 2048 — предупреждение `memory-budget`, выше 2048 — ошибка. Обычному Linux‑хосту хватает 256–512 МБ; в Kubernetes‑сценариях параметр описывает терминальный контейнер игрока (самому кластеру платформа выделяет память отдельно), там хватает 384.

## Минимальный образец

Рабочий каркас Linux‑сценария: nginx проксирует на приложение, после «ночного релиза» в конфиге не тот порт. Он проходит линтер без ошибок и предупреждений; в Docker образец не запускался, так что собери и прогони свой сценарий так же, как описано в шаге 4. Структуру, порядок действий в `break.sh` (дождаться entrypoint, сломать, дождаться, что поломка стала видна) и грейдер (проверка результата, а не способа) переноси в свой сценарий; текст, порты и команды замени.

Каталог: `upstream-port/` (имя папки = slug).

**scenario.yaml**

```yaml
version: 2
slug: upstream-port
title: "502 после ночного релиза"
summary: "После ночного релиза сайт отвечает 502 Bad Gateway, хотя приложение живо."
type: "Linux, nginx"
difficulty: MIDDLE
durationMin: 20
tags: [linux, nginx]
contextJson: { infra: "web-01: nginx проксирует запросы на приложение", services: ["nginx :80", "app :8081"], setup: "Ночью выкатили релиз 2.3.1.", time: "03:40" }
eventsJson:
  - { t: 0, type: alert, title: "HTTP 5xx > 5%", body: "web-01: GET / отвечает 502 Bad Gateway" }
hintsJson:
  - { level: 1, penalty: 0, text: "Направление: 502 говорит, что nginx не достучался до upstream. Начни с логов nginx." }
  - { level: 2, penalty: 5, text: "Инструмент: ss -ltnp покажет, кто слушает порты; сравни с proxy_pass в конфиге." }
  - { level: 3, penalty: 15, text: "Почти ответ: порт в proxy_pass не совпадает с портом приложения." }
actionsJson: []
gmScriptJson: null
brief: brief.md
debrief: debrief.md
environment:
  kind: container
  image: wom-scenario/upstream-port:dev
  build: ./image
  break: break.sh
  check: check.sh
  solve: solve.sh
  ttlMin: 45
  resources: { cpus: 1, memoryMb: 256, pids: 256 }
  network: { egress: none }
  shell: { user: oncall, cwd: /home/oncall, shell: /bin/bash, sudo: true }
  hostname: web-01
  writable: ["/etc", "/var", "/home", "/root"]
```

**brief.md**

```markdown
## Что известно

Сайт на web-01 отвечает 502 Bad Gateway. Ночью выкатили релиз 2.3.1.

## Что не известно

Что именно изменилось и почему nginx не получает ответ от приложения.

## Цель

Вернуть `GET http://127.0.0.1/` в 200, чтобы ответ давало приложение.

## Ограничения

Не перезапускай приложение без причины: оно держит соединения клиентов.

## Доступ

Ты работаешь как `oncall` с `sudo`. Логи в `/var/log`.
```

**debrief.md**

```markdown
## Что было сломано

В конфиге nginx `proxy_pass` указывал на порт 8082, где ничего не слушает; приложение работает на 8081.

## Как это диагностируется

`tail /var/log/nginx/error.log` показывает `connect() failed (111: Connection refused)`, `ss -ltnp` показывает, что слушает 8081.

## Эталонное решение

Вернуть порт 8081 в `/etc/nginx/sites-available/default` и выполнить `nginx -s reload`.

## Ловушки

Заглушка `return 200` в nginx убирает 502, но ответ даёт не приложение: грейдер это замечает.

## Чему учит

Читать ошибку прокси раньше, чем перезапускать сервисы.

## Почитать

- [ngx_http_proxy_module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
```

**break.sh**

```sh
#!/bin/sh
# SECRET. Wait for the entrypoint, then point nginx at a port where nothing listens.
set -eu
i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 60 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the entrypoint did not finish in 30 s" >&2; exit 1; }
sed -i 's/127\.0\.0\.1:8081/127.0.0.1:8082/' /etc/nginx/sites-available/default
nginx -s reload
i=0
while [ $i -lt 20 ]; do
  code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1/ || echo 000)
  [ "$code" = "502" ] && { echo "break: done"; exit 0; }
  i=$((i + 1)); sleep 0.5
done
echo "break: FAILED, last code $code" >&2
exit 1
```

**check.sh**

```sh
#!/bin/sh
# SECRET grader: checks the result, not the method. Prints one JSON object.
token="wom-$$-$(date +%s)"
code=000; i=0
while [ $i -lt 5 ]; do
  code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1/?check=$token" 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  i=$((i + 1)); sleep 1
done
ok_http=false; msg_http="GET / вернул $code"
[ "$code" = "200" ] && { ok_http=true; msg_http="GET / вернул 200"; }
# the request must have reached the app (it logs to /var/log/app.log), not a stub inside nginx
ok_app=false; msg_app="приложение не получило запрос: ответ даёт не оно"
sleep 0.5
grep -qF "check=$token" /var/log/app.log 2>/dev/null && { ok_app=true; msg_app="ответ приходит от приложения"; }
passed=false
$ok_http && $ok_app && passed=true
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"http-200","ok":%s,"message":"%s"},' "$ok_http" "$msg_http"
printf '{"id":"served-by-app","ok":%s,"message":"%s"}' "$ok_app" "$msg_app"
printf ']}\n'
```

**solve.sh**

```sh
#!/bin/sh
# SECRET. Reference solution: the right port back, reload.
set -eu
sed -i 's/127\.0\.0\.1:8082/127.0.0.1:8081/' /etc/nginx/sites-available/default
nginx -s reload
```

**image/Dockerfile**

```dockerfile
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx python3 sudo curl procps iproute2 less nano ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall \
 && chmod 0440 /etc/sudoers.d/oncall \
 && mkdir -p /opt/app && echo ok > /opt/app/index.html
COPY nginx-site.conf /etc/nginx/sites-available/default
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /usr/local/bin/entrypoint \
 && rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/dpkg /usr/bin/pip /usr/bin/pip3 \
 && rm -rf /etc/apt /var/lib/apt /var/lib/dpkg
CMD ["/usr/local/bin/entrypoint"]
```

**image/nginx-site.conf**

```nginx
server {
    listen 80 default_server;
    location / {
        proxy_pass http://127.0.0.1:8081;
    }
}
```

**image/entrypoint.sh**

```sh
#!/bin/sh
python3 -m http.server 8081 --bind 127.0.0.1 --directory /opt/app >/var/log/app.log 2>&1 &
nginx
: > /run/.boot-complete
while :; do sleep 3600; done
```

Что в образце сделано намеренно: `break.sh` ждёт файл‑маркер `/run/.boot-complete` из entrypoint (правило 13); грейдер сам повторяет запрос несколько раз, вызывает `curl -q` и убеждается, что запрос дошёл до приложения (заглушка `return 200` в nginx не пройдёт); `solve.sh` — эталон, он не попадает в образ и не показывается игроку до конца сессии; в Dockerfile в самом конце удалены пакетные менеджеры.

## Правила линтера по идентификаторам

Линтер (`wom scenario lint`, он же работает при модерации) выдаёт ошибки, которые блокируют публикацию, и предупреждения.

Ошибки: `hints-contiguous`, `kind-unsupported` (`compose` не поддерживается), `k8s-manifests`, `k8s-images-listed`, `k8s-build`, `file-missing`, `brief-required`, `debrief-required`, `guide-stages`, `slug-reserved`, `build-escapes`, `build-dockerfile`, `image-base`, `image-tag-namespace`, `image-source`, `image-registry`, `image-forbidden`, `setup-unsupported`, `script-posix-sh`, `script-crlf`, `grader-json`, `writable-immutable`, `writable-root`, `tmpfs-immutable`, `cap-forbidden`, `ttl-too-short`, `memory-budget` (выше 2048 МБ), `artifacts-unsupported` (`environment.artifacts` ничего не копирует: клади файлы в образ), `text-too-large` (бриф, разбор, учебник, любой из скриптов длиннее 100 000 символов или JSON-поля `scenario.yaml` больше 256 КБ), `manifests-size` (манифесты всех файлов вместе больше 4 МБ). `python-syntax` (ошибка синтаксиса в `.py` образа) выдаёт только `wom scenario lint` на машине с Python 3: при модерации на сервере эта проверка не запускается, поэтому прогони линтер локально.

Опечатка в ключе вложенных объектов (`resources`, `network`, `shell`, `cluster`, `test`, подсказка в `hintsJson`) теперь ошибка загрузки, а не молчаливое значение по умолчанию.

Предупреждения: `hints-penalty-order`, `hints-three-levels`, `k8s-fields`, `k8s-kubectl`, `k8s-shell-user`, `tutorial-tag`, `guide-junior`, `tutorial-brief-parts`, `image-unpinned`, `image-package-managers`, `grader-independent`, `grader-psql-rc`, `grader-curl-rc`, `tmpfs-under-writable`, `egress-unsupported`, `sudo-as-root`, `break-package-manager`, `break-wait-budget`, `memory-budget` (1025–2048 МБ), `services-unsupported` (`environment.services` платформа не читает: порты не публикуются и не проверяются), `context-shape` (в `contextJson` не строки там, где карточка ждёт строки), а для манифестов Kubernetes: `manifest-resources` (контейнер без `resources.requests` или `resources.limits`), `manifest-image-unpinned` (образ без тега или `:latest`), `manifest-privileged` и `manifest-host-access` (`privileged: true`, `hostPath`, `hostNetwork`/`hostPID`/`hostIPC` без комментария рядом, который объясняет зачем: на той же строке или строками выше), `manifest-requests-budget` (сумма запросов всех подов больше ёмкости нод kind: 4 ГБ и 2 CPU на ноду), `manifest-yaml` (файл не разобрался как YAML).
