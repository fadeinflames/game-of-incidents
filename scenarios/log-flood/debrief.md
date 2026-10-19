# Разбор: Потоп из логов

## Что было сломано

ML‑команда переключила `DEBUG_PAYLOAD=on` в `ConfigMap recommendation-config`: на каждый запрос приложение стало писать в лог полный вектор признаков (~200 KB). При 20 rps это около 4 МБ в секунду на все три реплики: объём одного тома такой поток съел бы за ~16 с, а на каждый под приходится треть потока, так что его том заполнялся меньше чем за минуту. Kubelet выселял под («Usage of EmptyDir volume "logs" exceeds the limit "64Mi"»), Deployment создавал новый, тот наполнялся снова. `log-shipper` отправляет 300 KB/с и физически не мог угнаться за ~1,3 МБ/с, которые писал каждый под: backlog рос, пока под не выселяли вместе с логами.

В облачном оригинале этой истории логи контейнеров лежат на диске ноды, и заканчивается всё `DiskPressure` и выселением соседей (включая ingress‑controller). Здесь лимит тома срабатывает раньше и защищает ноду: именно для этого его ставят.

## Как это диагностируется

1. `kubectl get pods -l app=recommendation-api` — цепочка `Evicted`, рабочие поды возрастом в минуту.
2. `kubectl describe pod <evicted>` — `Reason: Evicted`, `Message: Usage of EmptyDir volume "logs" exceeds the limit "64Mi"`.
3. `kubectl exec <живой под> -c api -- sh -c 'ls -la /var/log/app; head -c 400 /var/log/app/app.log'` — файл растёт на глазах, строки с `"debug": {"features": …}`.
4. `kubectl get configmap recommendation-config -o yaml` — `DEBUG_PAYLOAD: "on"`; `kubectl rollout history deploy/recommendation-api` — change-cause про debug.
5. `kubectl exec … -c log-shipper -- wget -qO- http://127.0.0.1:9102/metrics` — `shipper_backlog_bytes` в десятках мегабайт.

## Эталонное решение

```bash
kubectl patch configmap recommendation-config -p '{"data":{"DEBUG_PAYLOAD":"off"}}'
kubectl rollout restart deploy/recommendation-api          # env из ConfigMap читается при старте пода
kubectl rollout status deploy/recommendation-api
kubectl delete pods -l app=recommendation-api --field-selector=status.phase=Failed   # убрать Evicted
```

Через минуту backlog шиппера уходит в ноль, success rate возвращается к 100 %.

## Ловушки

- Поднять `sizeLimit` до 1Gi. Выселения станут реже, поток не исчезнет, шиппер всё так же не догоняет, а на настоящей ноде это и есть путь к `DiskPressure`.
- Удалять выселенные поды, не выключив дебаг. Новые появятся через минуту.
- Выключить дебаг и не перезапустить поды. Переменная из ConfigMap читается при старте: работающие поды продолжают писать по-старому, а свежие, которые Deployment создаёт после очередного выселения, уже получат `off`. Без `rollout restart` фикс доедет только по мере выселений, то есть придётся пережить ещё один шторм.
- Убрать `log-shipper` «чтобы не мешал». Он не причина, а первая жертва.

## Чему учит

- Логи — это I/O и диск. «Включить дебаг в проде» — изменение нагрузки, а не безобидный флаг; для отладки нужен sampling или отдельный канал.
- Лимиты на ephemeral storage и тома логов ставят затем, чтобы страдал один под, а не нода. Не снимай предохранитель, чтобы «починить» инцидент.
- Шиппер логов с ограниченной пропускной способностью — часть системы: его backlog — ранний сигнал.
- После шторма убирают обломки (`Evicted` поды), иначе через неделю `kubectl get pods` бесполезен.

## Почитать

- [Kubernetes: Ephemeral storage and emptyDir sizeLimit](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/#local-ephemeral-storage)
- [Kubernetes: Node-pressure Eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)
- [Kubernetes: Logging Architecture — log rotation](https://kubernetes.io/docs/concepts/cluster-administration/logging/)
