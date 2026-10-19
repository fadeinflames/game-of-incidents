# Разбор: Слепой мониторинг

## Что было сломано

Ротация корневого CA прошла в два шага, и второй остался за кластером. Шлюз наблюдаемости получил сертификат, выпущенный новым CA #2; security опубликовала CA #2 как `current` в `security/observability-ca`. Но Prometheus проверяет сертификат шлюза по файлу из `Secret monitoring/remote-write-ca`, а там по‑прежнему CA #1. Каждое TLS‑рукопожатие `remote_write` заканчивается `x509: certificate signed by unknown authority`, очередь отправки растёт и переполняется, семплы не покидают кластер. Prometheus при этом Ready, скрейп идёт, локально всё «работает». Центр не видит кластер, и алерты не сработают, потому что не с чем сравнивать. Это и есть ложное спокойствие: мониторинг молчит не потому, что всё хорошо.

## Как это диагностируется

1. `kubectl -n monitoring exec deploy/metrics-gateway -- wget -qO- http://127.0.0.1:9090/status` — `last_write_age_s: null` и `writes: 0` (шлюз перезапущен при ротации и с тех пор не принял ни одной записи), `tls_handshake_errors` растёт.
2. `kubectl -n monitoring logs deploy/prometheus --tail=30` — `remote_write … Failed to send batch … x509: certificate signed by unknown authority`.
3. `kubectl -n security get configmap observability-ca -o yaml` — `ca/current: "2"`, `ca/rotated-at: 03:00`; сравни `ca-next.crt` с содержимым `monitoring/remote-write-ca`.
4. `kubectl -n monitoring get configmap prometheus-config -o yaml` — `tls_config.ca_file: /etc/prometheus/tls/ca.crt`, то есть доверие берётся из Secret.

## Эталонное решение

```bash
kubectl -n security get configmap observability-ca -o jsonpath='{.data.ca-next\.crt}' > ca.crt
kubectl -n monitoring create secret generic remote-write-ca --from-file=ca.crt --dry-run=client -o yaml | kubectl apply -f -
kubectl -n monitoring rollout restart deploy/prometheus
kubectl -n monitoring exec deploy/metrics-gateway -- wget -qO- http://127.0.0.1:9090/status   # last_write_age_s -> единицы секунд
```

Вместо замены CA в Secret можно положить туда бандл из старого и нового CA: переходное доверие, обычная практика, грейдер засчитывает любой Secret, в котором есть CA #2.

Secret смонтирован целым томом, поэтому kubelet обновит файл сам (обычно за минуту‑две), а Prometheus перечитывает `ca_file` при следующем запросе `remote_write`: даже без рестарта семплы пошли бы сами. Рестарт (или `POST /-/reload`) нужен не для того, чтобы «сбросить кэш», а чтобы изменение применилось сразу и предсказуемо, а не «когда‑нибудь потом». Если тот же Secret смонтирован через `subPath`, kubelet файл не обновит никогда: там без рестарта не обойтись.

## Ловушки

- `insecure_skip_verify: true`. Семплы пойдут, грейдер откажет: теперь Prometheus доверяет любому, кто ответит на этом адресе.
- Подменить сертификат шлюза обратно на CA #1 или откатить его на старый CA (в том числе правкой аннотаций в security). Чужая система, откат ротации, через неделю та же история; грейдер смотрит, что шлюз остался на CA #2.
- Смонтировать CA через `subPath` и надеяться, что файл обновится сам. Для `subPath` kubelet обновления не делает, так что старый CA останется до рестарта пода.
- Поправить `ca_file` на путь внутри ConfigMap с CA, забыв про Secret: работает, но теперь два источника правды.

## Чему учит

- Мониторинг, который молчит, нужно мониторить: «нет данных от кластера N минут» — обязательный алерт на стороне центра, «remote_write failed» — на стороне кластера.
- Ротация CA — это распространение доверия ко всем клиентам, а не только выпуск новых сертификатов. У каждого потребителя должен быть владелец и план.
- Обновление смонтированного Secret доходит до пода с задержкой (синк kubelet, до минуты‑двух), а `subPath` не обновляется вообще. Prometheus файл `ca_file` перечитывает сам, но на рестарт или reload стоит рассчитывать, когда нужен предсказуемый момент применения.
- Ready у Prometheus означает «процесс жив», не «данные доходят».

## Почитать

- [Prometheus: remote_write configuration (tls_config)](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#remote_write)
- [Prometheus: management API /-/reload](https://prometheus.io/docs/prometheus/latest/management_api/)
- [Kubernetes: Secrets as files — mounted Secrets are updated automatically](https://kubernetes.io/docs/concepts/configuration/secret/#mounted-secrets-are-updated-automatically)
