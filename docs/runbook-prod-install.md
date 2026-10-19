# Установка и эксплуатация

Руководство по установке Game of Incidents на свой сервер и по его обслуживанию. Английское краткое изложение: [install.en.md](install.en.md).

Обозначения: `[root]` — на сервере от root; `[wom]` — от сервисного пользователя `wom` (без sudo); `[другая машина]` — на любой другой машине, например для копии бэкапов.

## Быстрый путь (рекомендуется)

Человек заводит голый хост (и домен), дальше всё делает репозиторий одной командой с его машины.

### Что нужно

1. **Хост.** Чистый Debian 13 (trixie) или Ubuntu 24.04 LTS, x86_64, systemd, cgroup v2, выделенный сервер или виртуальная машина. Минимум: 2 CPU, 8 ГБ RAM, 40 ГБ свободного места на корне; рекомендуется 8 CPU и 32 ГБ. Размер sparse-образа `docker.img` подбирается по свободному месту (до 150 ГБ, 12 ГБ остаётся системе и бэкапам), а в `.env` записывается профиль ёмкости по ресурсам машины: на 2 CPU / 8 ГБ это 4 сессии и один кластер Kubernetes за раз, на средних машинах 10 и 3, на больших прод-значения (20 и 6). Не ставь на машину с чужими сервисами: скрипт меняет фаервол, ssh и Docker. Скрипт проверит ресурсы и остановится с кодом 2, если их не хватает.
2. **Ключ у root.** Вход `ssh root@<ip>` по ключу. Если хост выдан только с паролем, один раз скопируй свой ключ: `ssh-copy-id root@<ip>` (в Windows делай это в Git Bash). Если у root нет ключа, настройка пройдёт, но ssh не будет ужесточён (вход по паролю останется), чтобы не отрезать доступ.
3. **A-запись (для домена).** `<домен> -> <ip хоста>`. Все A-записи должны вести прямо на этот сервер (без прокси и защиты перед ним): иначе Let's Encrypt не выдаст сертификат, а адреса клиентов станут общими. Порты 80 и 443 должны быть доступны снаружи; скрипт проверить это отсюда не может. Без домена см. «Без домена (по IP)».
4. **Твоя машина.** Клонированный репозиторий с закоммиченным кодом (на хост уезжает `git archive HEAD`, незакоммиченное не попадёт), `bash`, `ssh`, `git`, желательно `curl`, ключ к root хоста (в `ssh-agent`, в `~/.ssh` или через `--ssh-key`).

### Что делает скрипт

`scripts/provision/provision.sh` проходит шаги по порядку и на любом остановится с понятным текстом:

1. **Предпроверки.** Вход по ssh-ключу под root, ОС хоста, домен резолвится в адрес этого хоста, дерево git чистое.
2. **Доставка.** `git archive HEAD` по ssh в `/root/wom-src` на хосте. Секретов в архиве нет.
3. **Хост** (`scripts/provision/host-setup.sh` от root): пакеты, пользователь `wom` без sudo и его ключи, `subuid` и `subgid`, linger, sysctl, том под Docker (loop-файл xfs с `pquota`, запись в `/etc/fstab`), каталоги `/srv/backups` (700) и `/srv/pgdata`, ufw 22/80/443, ужесточение ssh (только при наличии ключа у root), unattended-upgrades, Docker CE rootless, port driver `slirp4netns`, `daemon.json`, `kind`, делегирование cgroup, на Ubuntu профиль AppArmor для `rootlesskit`. Отчёт на хосте: `/root/wom-host-setup.report`.
4. **Копирование** дерева в `/home/wom/wom-platform`, владелец `wom`; там же `git init` и коммит (деплой в режиме local собирает то, что лежит в каталоге).
5. **Платформа** (`scripts/provision/app-setup.sh` от `wom`): `.env` со случайными секретами (только если его нет), systemd-юниты `wom.service` и бэкапов по таймеру, `deploy.sh`, восстановление дампа до первого входа (если дан `--dump`), ожидание health изнутри и снаружи, дымовой тест сценария, отчёт `~/install-report.txt` на хосте.
6. **Проверка снаружи** с твоей машины: `https://<домен>/api/health` должен ответить `"ok":true`.
7. **Сводка:** адрес, логин администратора, команда чтения пароля, что остаётся сделать вручную.

Пароль администратора генерируется на хосте, пишется в `~/.wom-admin-password` (права 600) и нигде не печатается. Прочитать: `ssh wom@<ip> cat ~/.wom-admin-password`.

### Без домена (по IP)

Для пробной установки, лаборатории или репетиции домен не нужен: если `--host` задан адресом IPv4, `--domain` можно опустить (или указать тот же IPv4). Сайт будет по `https://<IP>`, Caddy выдаёт собственный самоподписанный сертификат (браузер предупредит), DNS-проверка пропускается, проверка здоровья идёт с ключом `-k`. Почта администратора по умолчанию `admin@game.local`. Позже домен включается повторным запуском: `provision.sh --host <ip> --domain game.example.com --full --yes` (Caddy получит сертификат Let's Encrypt, ссылки со старым адресом перестанут работать).

### Команды

Запуск из корня клонированного репозитория. Сначала посмотри план: `--dry-run` ничего не делает и не ходит по сети.

```bash
bash scripts/provision/provision.sh --host 203.0.113.10 --domain game.example.com --dry-run
bash scripts/provision/provision.sh --host 203.0.113.10 --domain game.example.com --admin-user boss --admin-email boss@example.com --contact-url https://t.me/example_chat
```

Windows PowerShell 5.1: скрипт остаётся bash-скриптом, PowerShell только запускает `bash`. Нужен Git for Windows (в нём есть `bash`, `ssh`, `git` и `curl`) или WSL:

```powershell
bash scripts/provision/provision.sh --host 203.0.113.10 --domain game.example.com --ssh-key C:/Users/me/.ssh/id_ed25519
```

Если в PowerShell `bash` попадает на WSL, а не на Git Bash, WSL отвергнет ключ из `C:\Users\...` из-за прав доступа (`UNPROTECTED PRIVATE KEY FILE`): положи ключ в домашний каталог WSL (`chmod 600`) или запускай из Git Bash.

| Параметр | По умолчанию | Что делает |
|---|---|---|
| `--host H` | обязателен | адрес хоста (IPv4 или имя) |
| `--domain D` | обязателен (кроме `--update` и хоста по IPv4) | домен платформы; его A-запись уже должна указывать на хост |
| `--port N` | 22 | порт ssh |
| `--ssh-user U` | root | поддерживается только root |
| `--ssh-key PATH` | ssh-агент и `~/.ssh` | приватный ключ для ssh |
| `--admin-user NAME` | `admin` | логин администратора |
| `--admin-email EMAIL` | пусто | почта администратора |
| `--registration open\|closed` | `open` | открыта ли регистрация |
| `--contact-url URL` | пусто | ссылка «Написать нам» (Telegram, `mailto:`) |
| `--trusted-proxy CIDR` | пусто | адрес TCP-прокси перед машиной, который передаёт адрес клиента PROXY protocol (схема «один IP на несколько машин») |
| `--dump FILE.sql.gz` | нет | восстановить дамп до первого входа; только при первой установке |
| `--smoke none\|linux\|full` | `linux` | дымовой тест: ничего, один Linux-сценарий или ещё и кластерный |
| `--hostwatch` | выкл. | включить локального сторожа хоста (Telegram настраивается отдельно) |
| `--update` | | только доставить код и выполнить `deploy.sh` |
| `--full` | | полный путь, даже если на хосте уже есть `.env`; нужен `--yes` |
| `--adopt` | | передать `--adopt` в `host-setup.sh`: принять существующие данные в `/srv/docker` |
| `--skip-dns-check` | | не останавливаться, если домен не указывает на хост |
| `--allow-dirty` | | разрешить незакоммиченные правки (уедет только `HEAD`) |
| `--dry-run` | | напечатать план, ничего не делать |
| `--yes` | | не спрашивать подтверждений |

Коды выхода: `0` готово; `1` шаг не удался (причина в выводе, повторный запуск безопасен); `2` неверные параметры или не прошла предпроверка; `3` в `/srv/docker` чужие данные (повтори с `--adopt`, если они твои); `4` нужно подтверждение (`--yes`).

### Повторный запуск и обновление

- Все шаги идемпотентны. Если запуск прервался (сеть, сертификат, нехватка ресурсов), исправь причину и запусти ту же команду: `.env` с секретами не перезаписывается, готовые шаги пропускаются.
- Если на хосте уже есть `/home/wom/wom-platform/.env`, скрипт сам работает как `--update`: доставляет код и выполняет `deploy.sh` (дамп БД, миграции, рестарт стека, health). `host-setup.sh` и `app-setup.sh` не запускаются, `.env` не меняется. Такой запуск перезапускает web и orchestrator (активные сессии это переживают), поэтому без терминала он требует `--yes`.
- Установка, прервавшаяся после создания `.env`, для скрипта тоже выглядит как «уже установлено»: допиши её флагами `--full --yes`.
- `--dump` на работающей платформе скрипт не применяет (дамп стирает базу): есть ручная процедура «Восстановление из дампа» (§6).

### После установки (вручную)

1. Копия бэкапов за пределы сервера: ночной дамп лежит в `/srv/backups`, забирай его с другой машины (§6).
2. Telegram (по желанию): `TG_BOT_TOKEN` и `TG_CHAT_ID` в `~/.wom-hostwatch.env` на хосте (`chmod 600`) для сторожа хоста и сообщений об упавших юнитах (§6).
3. `CONTACT_URL`, если не задан флагом: строка в `~/wom-platform/.env` и `docker compose up -d web`.
4. Регистрация: если сайт не публичный, закрой её (`--registration closed`, запуск с `--full --yes`).
5. Проверь адрес клиента в логе Caddy (§5).

### Типичные остановки

| Сообщение | Что делать |
|---|---|
| не удалось войти по ssh-ключу | `ssh-copy-id root@<ip>`, либо `--ssh-key`, `--port` |
| на хосте не Debian 13 / Ubuntu 24.04 | переустановить ОС |
| A-запись указывает не на хост, домен не резолвится | поправить A-запись, подождать TTL; для NAT и прокси `--skip-dns-check` |
| в рабочем дереве есть незакоммиченные правки | закоммитить или `--allow-dirty` |
| host-setup: код 2 | не хватает ресурсов или ОС не та; текст проверки в выводе |
| host-setup: код 3 | в `/srv/docker` чужие данные; если это твоя прежняя установка, `--adopt` |
| health с твоей машины не отвечает | DNS ещё не обновился, порты 80 и 443 закрыты у провайдера, сертификат: `docker logs wom_caddy` на хосте |

### Один публичный IP на несколько машин

Если у сервера один публичный адрес, а платформа живёт в виртуальной машине рядом с другими (например, на Proxmox), входящие 80/443 принимает TCP-прокси и раскладывает по машинам по имени сайта:

- машины во внутренней сети (например, мост `vmbr1` 10.10.10.0/24 с NAT наружу), на узле DNAT 80/443 на прокси и hairpin-NAT, чтобы машины могли открыть публичный адрес изнутри;
- прокси (HAProxy в маленьком контейнере): на 443 пропускает TLS без расшифровки и выбирает машину по SNI и передаёт адрес клиента через PROXY protocol (`send-proxy-v2`); на 80 выбирает машину по заголовку `Host` и передаёт обычный HTTP без PROXY-заголовка (там Caddy только перенаправляет на https и отвечает Let's Encrypt, а его служебный HTTP-сервер PROXY-заголовок не разбирает);
- `--trusted-proxy` записывает в `.env` `WOM_TRUSTED_PROXY=<адрес прокси>/32`: Caddy принимает PROXY-заголовок только от прокси, и лимиты по адресу клиента работают (на уже установленной платформе — та же строка в `.env` и `docker compose up -d caddy`);
- установка: `provision.sh --host <внутренний IP машины> --domain <домен или публичный IP> --trusted-proxy <адрес прокси>/32`; ssh до машины через узел (`ProxyJump` в `~/.ssh/config`), DNS-проверку при домене пропускает `--skip-dns-check` (домен смотрит на узел, а не на машину).

Проверка адреса клиента — как в §5: в логе Caddy должен быть публичный адрес посетителя, а не адрес прокси.

## 3. Docker (rootless) и инструменты

Скрипты устанавливают то, что ниже, сами. Этот раздел нужен, чтобы понимать устройство и чинить отдельные шаги.

- **Rootless Docker** пользователя `wom` (пакеты Docker CE и `docker-ce-rootless-extras`; системный демон отключён). Все песочницы и сама платформа живут в этом демоне.
- **Port driver `slirp4netns`** (`~/.config/systemd/user/docker.service.d/port-driver.conf`, `DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=slirp4netns`). Стандартный драйвер скрывает адрес клиента, и лимиты по адресу стали бы общими.
- **Том под data-root** `/srv/docker`: xfs в loop-файле `/srv/images/docker.img` (sparse, 150 ГБ, `loop,noatime,pquota`) или отдельный раздел. Переполнение песочницами ограничено этим томом и не касается корня.
- **Делегирование cgroup v2** (`cpu memory pids`) пользователю `wom` (`/etc/systemd/system/user@.service.d/delegate.conf`): без него лимиты памяти и процессов песочниц не действуют.
- **sysctl**: `net.ipv4.ip_unprivileged_port_start=80` (Caddy слушает 80/443 без root), `fs.inotify.max_user_instances=1024` и `max_user_watches=1048576` (несколько кластеров kind упираются в 128), `kernel.keys.maxkeys=20000` (runc создаёт ключ сессии на каждый контейнер, лимит 200 исчерпывается при ~6 кластерах).
- **kind** в `~/.local/bin` (версия и контрольная сумма берутся из `services/orchestrator/Dockerfile`).
- **egress-guard** (`images/egress-guard`): правила iptables `WOM-EGRESS` в сетевом пространстве демона запрещают кластерам kind исходящие соединения. Если демон запущен с `--detach-netns`, укажи `DOCKER_NETNS_FILE=/run/user/<uid>/dockerd-rootless/netns`; иначе переменная пуста. Оркестратор не стартует, пока guard не подтвердил правила.
- Ubuntu 24.04: для `rootlesskit` нужен профиль AppArmor с разрешением `userns` (`/etc/apparmor.d/usr.bin.rootlesskit`, его пишет `host-setup.sh`).

## 4. Секреты и переменные окружения

`app-setup.sh` создаёт `.env` сам (права 600, случайные секреты). Файл в git не попадает: храни копию в менеджере паролей. Демо-пользователь в продакшене не создаётся (сид создаёт только администратора из `ADMIN_*`). **Не запускай `make seed` на проде:** он создаёт администратора `demo` с паролем по умолчанию; Makefile отказывается работать, если `.env` описывает прод.

Основные ключи, которые пишет установка: `COMPOSE_FILE=docker-compose.yml:deploy/docker-compose.prod.yml`, `WOM_DOMAIN`, `REGISTRATION_ENABLED`, `POSTGRES_PASSWORD`, `INTERNAL_TOKEN`, `DATABASE_URL` (порт `DB_HOST_PORT`, по умолчанию 5433, при занятом порте берётся следующий свободный), `DOCKER_SOCKET_PATH`, `DOCKER_NETNS_FILE`, `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (только для первого входа, затем удаляется).

Отдельная роль PostgreSQL для web (необязательно): задай обе переменные `WEB_DB_USER` (например `wom_web`) и `WEB_DB_PASSWORD` (16+ символов из букв, цифр и `. _ ~ -`, например `openssl rand -hex 24`). `./scripts/deploy.sh` вызывает `deploy/db-roles.sh`, он создаёт роль без прав суперпользователя, и web подключается ею вместо владельца `wom`.

Переменная действует, только если compose пробрасывает её в контейнер: после изменения `.env` проверь `docker compose config | grep <ИМЯ>` и применяй `docker compose up -d <сервис>` (песочницы при этом не задеваются). Полный список с комментариями — [.env.example](../.env.example). Самые нужные:

| Переменная | Где | По умолчанию | Что делает |
|---|---|---|---|
| `MAX_SESSIONS_GLOBAL` | оркестратор | 20 на проде | сколько сессий одновременно |
| `MAX_K8S_SESSIONS` | оркестратор | 6 на проде | сколько из них Kubernetes |
| `MAX_K8S_PROVISIONING` | оркестратор | 2 на проде | сколько кластеров поднимается одновременно, остальные ждут в очереди |
| `MAX_SESSIONS_PER_IP` | оркестратор | 3 (0 выключает) | активных сессий с одного адреса клиента |
| `REGISTRATIONS_PER_IP_PER_DAY` | web | 5 (0 выключает) | новых учёток в сутки с одного адреса (счётчик в памяти) |
| `PROVISIONING_TIMEOUT_MS`, `BREAK_TIMEOUT_MS` | оркестратор | 480000, 300000 | таймауты подъёма стенда и скрипта поломки |
| `KIND_NODE_MEMORY_MB`, `KIND_NODE_CPUS`, `KIND_NODE_PIDS` | оркестратор | 4096, 2, 8192 | лимиты на каждую ноду kind. Сумма не ограничена: сессий × нод (до 4) × память должны помещаться в RAM хоста |
| `DISK_REFUSE_PCT`, `DISK_KILL_PCT` | оркестратор | 85, 93 | от какой занятости диска отказывать в новых сессиях и когда завершать активные |
| `EGRESS_HEARTBEAT_MAX_AGE_SEC` | оркестратор | 150 | старше этого heartbeat egress-guard считается устаревшим, Kubernetes-сессии получают отказ |
| `INACTIVE_ACCOUNT_DAYS` | оркестратор | 7 (0 выключает) | через сколько дней без активности учётка отключается |
| `RETENTION_DAYS`, `RETENTION_ARCHIVE_DAYS` | оркестратор | 90, 180 (0 отключает) | сколько хранятся события сессий и архивы закрытых заявок |
| `CONTACT_URL` | web | не задана | адрес для ссылок «Написать нам»; если пусто, ссылок нет |
| `PGDATA_MOUNT` | db | именованный том | абсолютный путь включает bind-mount, см. §6a |
| `BACKUP_DIR`, `BACKUP_AGE_RECIPIENT` | `backup.sh` | `/srv/backups`, не задана | куда писать дамп; публичный ключ `age`, чтобы рядом с дампом лежала зашифрованная копия `.env` |
| `FORCE`, `DRAIN_MAX_SEC` | `deploy.sh` (окружение запуска, не `.env`) | 0, 1500 | `FORCE=1` разрешает деплой при локальных правках, неоконченных подъёмах и неудавшемся предеплойном дампе |

## 5. DNS и первый запуск

- A-запись `<домен> -> <ip сервера>`. Caddy получает сертификат Let's Encrypt сам при первом запросе; порт 80 должен быть открыт для HTTP-challenge. Все A-записи домена должны вести прямо на этот сервер: если один адрес принадлежит прокси или защите, Caddy увидит адрес прокси, и все лимиты по адресу станут общими.
- Первый запуск делает `provision.sh`. Вручную: `[wom]` `./scripts/deploy.sh` (скрипт сам ставит зависимости командой `npm ci --ignore-scripts`, чтобы код зависимостей не запускался на хосте): соберёт образы, применит миграции, создаст администратора и сценарии, проверит health. Автозапуск после перезагрузки: `wom.service` (`deploy/wom.service` в `~/.config/systemd/user/`, `systemctl --user enable --now wom.service`).

Проверка: сайт открывается с валидным сертификатом, `curl -s https://<домен>/api/health` отдаёт `{"ok":true,"checks":{"db":true,"orchestrator":true,"disk":<число или null>,"egress":"ok"}}`, вход администратором работает, сценарий «Nginx отдаёт 502» проходится до «Решено», кластерный сценарий стартует и убирается.

**Проверка адреса клиента.** Rootless Docker с портовым драйвером по умолчанию может скрывать исходный адрес. `[wom]` `docker logs wom_caddy 2>&1 | tail -n 20 | grep -o '"remote_ip":"[^"]*"'` при заходе на сайт со своего телефона должен показать публичный адрес, а не внутренний (`10.0.2.*`). Если внутренний, минутные лимиты (вход 10, регистрация 5, запуск стенда 6) становятся общими на всех посетителей, а `MAX_SESSIONS_PER_IP` и `REGISTRATIONS_PER_IP_PER_DAY` молча не работают. Лечение: port driver `slirp4netns` (§3).

**Пароль первого входа.** После первого входа администратором `ADMIN_PASSWORD` из `.env` удаляется автоматически (`app-setup.sh`); при ручной установке сделай это сам: `sed -i '/^ADMIN_PASSWORD=/d' .env && docker compose up -d orchestrator`. Иначе переменная остаётся в окружении контейнера (видна через `docker inspect`). Пароль администратора меняется через `/admin/users` → «Сбросить пароль».

## 6. Бэкапы и наблюдение

- `[wom]` Ночной бэкап: `systemctl --user enable --now wom-backup.timer` (устанавливает `app-setup.sh`). Ежедневно в 03:30 `pg_dump` в `/srv/backups/wom-YYYY-MM-DD-HHMM.sql.gz`, хранится 14 копий. Скрипт проверяет дамп до ротации (код возврата `pg_dump` и `gzip`, `gunzip -t`, размер не меньше `BACKUP_MIN_BYTES`, завершающая строка «PostgreSQL database dump complete»); при ошибке удаляет временный файл, пишет причину в stderr, хорошие дампы не вытесняются. Дамп содержит всё содержимое БД (хеши паролей, скрипты сценариев, архивы заявок, адреса клиентов) и **не зашифрован**; права 600 в каталоге 700. Перед миграциями `deploy.sh` делает такой же дамп с префиксом `pre-deploy-` (5 последних). `.env` дамп не вернёт: сохрани его копию в менеджере паролей или включи `BACKUP_AGE_RECIPIENT`.
- `[другая машина]` Копия за пределы сервера: забирай сама (rsync по ssh), например строкой cron: `45 3 * * * rsync -az wom@<ip>:/srv/backups/ /srv/wom-backups/`. Без `--delete`: удаление `/srv/backups` на сервере не должно доезжать до копии. Для этого cron заведи отдельный ключ с ограничением `command="/usr/bin/rrsync -ro /srv/backups",restrict ssh-ed25519 …` в `~wom/.ssh/authorized_keys`.
- Проверка живости: `deploy/healthcheck.sh https://<домен>` запускается по cron на другой машине раз в 5 минут, пишет в лог и (если заданы `TG_BOT_TOKEN`, `TG_CHAT_ID` в `~/.wom-healthcheck.env`) шлёт сообщения в Telegram о падении, восстановлении и предупреждениях: `checks.disk` не меньше `DISK_ALERT_PCT` (85), `checks.egress` равен `stale`, нет свежего дампа в `BACKUP_MIRROR_DIR`. Коды выхода: `0` всё в порядке, `1` платформа недоступна, `2` есть предупреждение.
- Локальный сторож хоста (включается флагом `--hostwatch`): `deploy/hostwatch.sh` раз в 5 минут проверяет диски (`/`, `/srv/docker`, `/srv/backups`, `/srv/pgdata`), нагрузку, срок сертификата Caddy, свежесть дампа, контейнеры платформы, здоровье egress-guard, число нод kind и ответ демона Docker и шлёт в Telegram сообщение, когда набор проблем меняется. Нужны `TG_BOT_TOKEN` и `TG_CHAT_ID` в `~/.wom-hostwatch.env`; пороги необязательны (`HOST_DISK_PCT`, `DISK_PATHS`, `LOAD_MAX`, `CERT_DAYS`, `BACKUP_DIR`, `BACKUP_MAX_AGE_MIN`, `KIND_NODES_MAX`).
- Логи: `docker compose logs -f --tail=200 orchestrator web caddy`; JSON-строки оркестратора грепаются по `sessionId`.

### Восстановление из дампа

Для пустой базы после сбоя или переустановки (дамп сделан с `--no-owner`, без `--clean`, поэтому восстанавливать нужно в новую базу). Не используй `docker compose down -v`: он удаляет и `caddy_data`, и придётся заново получать сертификат.

```bash
cd ~/wom-platform
docker compose up -d db
docker compose stop web orchestrator
docker compose exec -T db psql -U wom -d postgres -c 'DROP DATABASE IF EXISTS wom WITH (FORCE)' -c 'CREATE DATABASE wom OWNER wom'
gunzip -c /srv/backups/wom-<дата>.sql.gz | docker compose exec -T db psql -U wom -d wom -v ON_ERROR_STOP=1 -q
./scripts/deploy.sh      # миграции, сид, рестарт стека, проверка health
```

### Тестовое восстановление

Проверь раз в месяц и после изменений схемы, что последний дамп поднимается. Делается в отдельной пустой базе, боевая не затрагивается:

```bash
cd ~/wom-platform
f=$(ls -1t /srv/backups/wom-*.sql.gz | head -n 1); echo "$f"
docker compose exec -T db psql -U wom -d postgres -c 'CREATE DATABASE wom_restore_test OWNER wom'
gunzip -c "$f" | docker compose exec -T db psql -U wom -d wom_restore_test -v ON_ERROR_STOP=1 -q
docker compose exec -T db psql -U wom -d wom_restore_test -tAc 'select count(*) from "User"' -c 'select count(*) from "Scenario"' -c 'select count(*) from "_prisma_migrations"'
ls packages/db/prisma/migrations | grep -c '^[0-9]'      # должно совпасть с числом строк в _prisma_migrations
docker compose exec -T db psql -U wom -d postgres -c 'DROP DATABASE wom_restore_test WITH (FORCE)'
```

## 6a. Данные PostgreSQL вне data-root песочниц

По умолчанию том БД `wom_db_data` лежит в data-root Docker, вместе с песочницами: песочница, заполнившая диск, останавливает и БД. Оркестратор от 85 % занятости перестаёт принимать сессии, от 93 % завершает активные, но надёжнее держать БД на отдельном каталоге. Установка `provision.sh` делает это для новых хостов (`PGDATA_MOUNT=/srv/pgdata`). Для уже работающей платформы:

1. `[wom]` `./deploy/backup.sh`, скопируй дамп за пределы сервера.
2. `[root]` `mkdir -p /srv/pgdata && chown wom:wom /srv/pgdata`.
3. `[wom]` дождись, пока нет активных сессий; `docker compose stop caddy web orchestrator db`.
4. `[wom]` `docker run --rm -v wom-platform_wom_db_data:/from:ro -v /srv/pgdata:/to postgres:16-alpine sh -c 'cp -a /from/. /to/ && ls -ld /to && du -sh /from /to'`.
5. `[wom]` в `.env` добавь `PGDATA_MOUNT=/srv/pgdata`, затем `docker compose up -d db`, проверь `docker compose exec -T db psql -U wom -d wom -c 'select count(*) from "User"'`, затем `docker compose up -d`.
6. Через несколько дней: `docker volume rm wom-platform_wom_db_data`.

Откат: убери `PGDATA_MOUNT` из `.env` и `docker compose up -d db`: старый том не тронут. В rootless-режиме каталог после запуска принадлежит subuid (uid 70 контейнера), это нормально.

## 7. Обновление и откат

- Обновление: `provision.sh --update` с твоей машины или на хосте `./scripts/deploy.sh [sha]`. Скрипт отказывается работать, если в рабочем дереве есть локальные правки (`FORCE=1` разрешает). Шаги: образы платформы и сценариев, `npm ci`, линт сценариев, сборка compose, предзагрузка образов, ожидание конца подъёмов и проверок сессий (до `DRAIN_MAX_SEC`, 1500 с), проверка egress-guard, предеплойный дамп БД, миграции и сид, рестарт стека, health. Активные песочницы переживают рестарт оркестратора; терминалы переподключаются. Песочницы не переживают рестарт самого демона Docker. Логи шагов: `~/.cache/wom-deploy/`.
- Откат кода: `./scripts/deploy.sh <sha предыдущего коммита>`. Если обновление включало миграцию БД и старый код не работает с новой схемой, перед откатом восстанови предеплойный дамп `pre-deploy-wom-…` (процедура в §6; путь к нему `deploy.sh` печатает при незавершённом запуске).
- Откат системы: переустановка ОС + `provision.sh --full` + восстановление дампа.

Сообщения `deploy.sh`, после которых он останавливается (`exit 1`):

| Сообщение | Что случилось | Что делать |
|---|---|---|
| `no .env` | нет файла `.env` | `cp .env.example .env` и заполнить секреты |
| `the working tree has local changes …` | есть незакоммиченные правки отслеживаемых файлов | закоммить или откати их, либо `FORCE=1 ./scripts/deploy.sh` (правки будут уничтожены) |
| `IMAGE BUILD FAILED (<образ>)` | не собрался образ платформы или сценария | хвост лога на экране, полный лог `~/.cache/wom-deploy/image-build.log`; ничего не перезапущено |
| `npm ci FAILED` | на хосте не появился `./node_modules/.bin/wom` | `npm ci` вручную, смотреть ошибку (сеть, диск) |
| `SCENARIO LINT FAILED` | линтер нашёл ошибки в `scenarios/*` | строки с `✗` на экране, лог `~/.cache/wom-deploy/lint.log` |
| `BUILD FAILED` | не собралась сборка compose | лог `~/.cache/wom-deploy/build.log` |
| `DRAIN TIMED OUT` | за `DRAIN_MAX_SEC` подъёмы и проверки сессий не закончились | запустить позже или `FORCE=1` (эти сессии упадут при рестарте) |
| `EGRESS GUARD NOT HEALTHY` | `egress-guard` не подтвердил правила | `docker logs wom_egress_guard`; проверить `DOCKER_NETNS_FILE`; web и orchestrator не перезапущены |
| `the database does not answer` | `psql` в `db` не ответил | `docker compose logs db`; `FORCE=1` идёт дальше без дампа |
| `PRE-DEPLOY DUMP FAILED` | предеплойный дамп не получился (диск, контейнер `db`) | освободить диск, проверить `db`; `FORCE=1` мигрирует без свежего дампа |
| `STACK RESTART FAILED` | `docker compose up -d` завершился с ошибкой | лог `~/.cache/wom-deploy/up.log`; **срочно**: старый контейнер оркестратора мог быть удалён |
| `health: FAILED` | за ~2 минуты `/api/health` не ответил `"ok":true` | `docker compose logs --tail=100 web orchestrator`, `docker compose ps` |

При любом незавершённом запуске `deploy.sh` в конце печатает `deploy: NOT COMPLETED`: на каком коммите было дерево до запуска и сейчас, команду отката кода и, если миграции применены, путь к дампу.

Правила `WOM-EGRESS` остаются в сетевом пространстве демона и после остановки guard (работающие стенды остаются закрытыми). Запусти guard снова (`docker compose up -d egress-guard`), он найдёт свои правила. Проверка: `docker inspect -f '{{.State.Health.Status}}' wom_egress_guard` → `healthy`; из tools-контейнера живой сессии `wget -T 3 http://1.1.1.1` заканчивается таймаутом.

## 8. Обновления системы и образов

`unattended-upgrades` ставит только пакеты ОС. `docker-ce`, `containerd`, `runc` (репозиторий Docker) и `nodejs` (NodeSource) им не обновляются, автоматической перезагрузки нет, а `deploy.sh` собирает образы без `--pull`. Рекомендуется:

1. `[root]` разрешить репозиторий Docker в `/etc/apt/apt.conf.d/50unattended-upgrades`: в `Unattended-Upgrade::Origins-Pattern` добавить `"origin=Docker,codename=${distro_codename}";` (и NodeSource, пока Node нужен на хосте).
2. `[root]` еженедельное обновление с перезагрузкой в тихое окно, например `/etc/cron.d/wom-weekly-upgrade`: `0 5 * * 1 root apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get -y -qq -o Dpkg::Options::=--force-confold full-upgrade && [ -f /var/run/reboot-required ] && systemctl reboot`. Перезагрузка завершает все активные сессии: linger и `wom.service` поднимут стек сами.
3. `[wom]` раз в месяц в тихое время: `for d in images/*/; do docker build --pull -t "wom-$(basename $d):dev" "$d"; done && docker compose build --pull && ./scripts/deploy.sh`.

## 9. Ёмкость и подбор лимитов

- Подъём кластера kind: обычный около минуты, тяжёлые стенды (cert-manager, Prometheus, ingress, четыре ноды) 1,5–3 минуты, тёплого пула нет. Шесть одновременных подъёмов на 8 потоках дают 250–300 с на кластер и таймауты, поэтому `MAX_K8S_PROVISIONING=2`: остальные сессии ждут в очереди (`QUEUE_TIMEOUT_MS`, 20 минут) со статусом на экране. `break.sh` сценария обязан укладываться в 240 с.
- Память: `MAX_K8S_SESSIONS` × нод × `KIND_NODE_MEMORY_MB` должны помещаться в RAM хоста с запасом. На хосте меньше рекомендованного (8 CPU, 32 ГБ) уменьши `MAX_K8S_SESSIONS`.
- Диск: data-root отдельным томом (§3), порог отказа 85 % и аварийной остановки 93 %; при нехватке места оркестратор останавливает по одной сессии, начиная с самых тяжёлых и старых.
- Пулы адресов Docker: при старте оркестратор пишет предупреждение, если у демона нет `default-address-pools`; встроенных диапазонов хватает примерно на 30 сетей (одна на сессию и кластер). `host-setup.sh` задаёт `default-address-pools` (10.200.0.0/12, /24).

## 10. Инцидент в песочнице

Когда: жалоба на исходящий трафик с адреса сервера, подозрение на побег из песочницы или кластера, злоупотребление стендом, неожиданная нагрузка. Шаги 1–2 выполняются сразу, остальное по ситуации. Контекст угроз: [threat-model.md](threat-model.md).

1. `[wom]` Сохрани улики до чистки (шаг 3 удалит стенды): `cd ~/wom-platform; docker logs wom_orchestrator --since 3h > /tmp/incident-orch.log 2>&1; docker logs wom_caddy --since 3h > /tmp/incident-caddy.log 2>&1; docker ps -a --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}' > /tmp/incident-ps.txt`. Найди сессию и владельца: `docker compose exec -T db psql -U wom -d wom -c "select s.id, u.username, s.\"clientIp\", s.status, s.\"createdAt\" from \"TrainingSession\" s join \"User\" u on u.id = s.\"userId\" order by s.\"createdAt\" desc limit 20"`.
2. Останови новые запуски. Регистрацию: `REGISTRATION_ENABLED=false` в `.env` и `docker compose up -d web`. Все новые сессии: `MAX_SESSIONS_GLOBAL=0` в `.env` и `docker compose up -d orchestrator` (существующие песочницы рестарт оркестратора переживают). После разбора верни значения.
3. Заверши сессии. Через веб (вход админа): `/admin/sessions` → «Завершить все сессии» либо «Остановить» у конкретной. Если веб недоступен, `[wom]`: `make clean-sandboxes` (удаляет контейнеры и сети Linux-сессий с меткой `wom.platform=sandbox`) и кластеры: `kind get clusters | grep '^wom-k8s-' | xargs -r -n1 kind delete cluster --name`. Reconciler пометит сессии в базе `KILLED` в течение 30 секунд.
4. Заблокируй аккаунт: `/admin/users` → «Отключить» (браузерные сессии обрываются сразу, но живой стенд это не останавливает: заверши его по шагу 3). Адрес: `[root] ufw deny from <ip>`; сначала убедись по §5, что в логах Caddy настоящие адреса клиентов, иначе блокировка зацепит всех.
5. Если есть признак выхода за пределы песочницы (процессы или контейнеры `wom`, которых ты не запускал, незнакомые порты в `ss -tlnp`, новые строки в `~/.ssh/authorized_keys`, `crontab -l`, `systemctl --user list-units`), считай скомпрометированным пользователя `wom` и всё, что ему доступно: разлогинь всех (`DELETE FROM "Session";`), смени `INTERNAL_TOKEN`, пароль БД (`ALTER USER wom PASSWORD …` и `POSTGRES_PASSWORD` в `.env`, пересоздать `db`, `web`, `orchestrator`), ключи доступа. Самый надёжный путь: переустановить сервер, восстановить дамп, создать `.env` с новыми секретами.
6. Пересоздание демона: `systemctl --user restart docker` завершает все сессии и перерождает сети; сервисы compose поднимутся сами (`restart: unless-stopped`). Проверь: `docker inspect -f '{{.State.Health.Status}}' wom_egress_guard` → `healthy`, `curl -s https://<домен>/api/health` → `"egress":"ok"`. Не запускай `docker system prune --volumes` и `docker volume prune`: если БД лежит в data-root, она будет удалена вместе с остановленным контейнером `db`.
7. Запиши, что произошло, что сделано, и обнови [threat-model.md](threat-model.md), если выяснился новый вектор.
