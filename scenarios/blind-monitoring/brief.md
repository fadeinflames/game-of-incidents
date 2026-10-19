# 🟡 Центральный мониторинг: кластер prod-ru-1 замолчал

**Время:** понедельник, 09:20. Ты дежурный SRE.

## Что известно

- В кластере стоит Prometheus (namespace `monitoring`), который скрейпит приложения (`shop/checkout`) и отправляет все семплы по `remote_write` в центральный шлюз наблюдаемости `metrics-gateway.monitoring.svc:9443` (TLS). Алерты считаются централизованно, локально только recording rules.
- С 03:10 из кластера в центр не пришло ни одного семпла. Дашборды пустые, алерты по `checkout` не сработают, даже если он упадёт: «ложное спокойствие».
- В 03:00 security провела плановую ротацию корневого CA платформы. Бандл опубликован в `ConfigMap security/observability-ca` (аннотации `ca/current`, `ca/previous`).
- Статус шлюза: `kubectl -n monitoring exec deploy/metrics-gateway -- wget -qO- http://127.0.0.1:9090/status` (возраст последней записи, `null`, пока записей не было; число ошибок TLS‑рукопожатия).

## Что не известно

- Почему Prometheus не отправляет: он сам Ready, скрейпит и ничего не пишет в алерты.
- Какой CA сейчас доверяет `remote_write` и какому должен.

## Цель

Семплы снова доходят до шлюза (запись не старше 60 с), при этом TLS по‑прежнему проверяется, а trust store Prometheus (`Secret monitoring/remote-write-ca`) содержит текущий CA из бандла security. Prometheus и `checkout` в Ready.

## Ограничения

- `insecure_skip_verify: true` не принимается: «починить», перестав проверять сертификат шлюза, значит отправлять метрики кому угодно.
- Шлюз и его сертификат менять нельзя: это чужая система, ротация там уже прошла корректно.

## Доступ

Shell на bastion‑хосте с `kubectl` под пользователем `oncall`, кластер уже в kubeconfig. Логи Prometheus: `kubectl -n monitoring logs deploy/prometheus --tail=30`.
