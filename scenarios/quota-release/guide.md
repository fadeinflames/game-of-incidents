# Как подступиться

«Раскатка висит, а подов нет» — отдельный класс проблем: контейнеры не падают, логов нет, потому что кластер даже не пытается их запустить. Ответ всегда в **Events** объектов, которые должны были создать под.

## Посмотри, что есть и чего нет

```bash
kubectl -n production get pods
kubectl -n production rollout status deploy/report-api --timeout=5s
```

У `report-api` только один под, хотя реплик должно быть две. Обрати внимание: нет ни `Pending`, ни `CrashLoopBackOff`, второго пода просто не существует. Значит, его не смог создать ReplicaSet.

## Спроси у ReplicaSet, почему поды не создаются

```bash
kubectl -n production describe deploy report-api
kubectl -n production describe rs -l app=report-api
```

`describe deploy` покажет только условие `ReplicaFailure True FailedCreate`: что‑то мешает, но что именно, не сказано. Поды создаёт не Deployment, а его ReplicaSet, поэтому текст ошибки лежит в событиях ReplicaSet. В выводе `describe rs` найди новый ReplicaSet (тот, у которого `cpu: 400m`) и в самом низу, в `Events`, ищи `FailedCreate`. Сообщение говорит прямо: `exceeded quota: prod-quota, requested: requests.cpu=…, used: …, limited: …`. Это не ошибка приложения, это отказ admission‑контроллера квоты.

## Посмотри на квоту глазами кластера

```bash
kubectl -n production describe quota prod-quota
kubectl -n production get pods -o custom-columns=NAME:.metadata.name,CPU:.spec.containers[*].resources.requests.cpu
```

`describe quota` показывает `Used` и `Hard`: сколько CPU уже запрошено в namespace и сколько разрешено. Вторая команда показывает, кто именно занимает квоту. Посчитай: сколько нужно новому поду `report-api` и сколько свободно.

## Проверь, ниже чего опускаться нельзя

```bash
kubectl -n production get limitrange prod-limits -o yaml
```

`min.cpu` для контейнера — нижняя граница requests: попытка поставить меньше будет отклонена с `minimum cpu usage per Container is …`. Это вторая ловушка кейса: «поставлю всем по 50m» не сработает.

## Освободи квоту там, где это безопасно

Квоту и LimitRange трогать нельзя, релиз должен остаться на `400m`. Значит, место надо освободить у соседей. `worker` — фоновая обработка, по договорённости его можно ужать до 2 реплик:

```bash
kubectl -n production scale deploy/worker --replicas=2
kubectl -n production get pods -l app=worker
kubectl -n production describe quota prod-quota
```

Альтернатива: снизить `requests.cpu` у `worker` (не ниже минимума из LimitRange) через `kubectl set resources`. Посчитай заранее: раскатка идёт с `maxSurge: 1`, то есть в какой‑то момент в namespace будут два новых пода `report-api` одновременно.

Квота освобождается не в момент команды, а когда лишние поды `worker` действительно удалены: пока они в `Terminating`, их requests ещё считаются. Дождись, пока `Used` в `describe quota` упадёт.

## Дождись раскатки или подтолкни её

```bash
kubectl -n production rollout status deploy/report-api --timeout=60s
```

Место есть, но новые поды могут появиться не сразу. ReplicaSet, получивший отказ от квоты, повторяет попытку не непрерывно, а с растущей паузой: каждая неудача её удваивает, и за несколько минут зависшего релиза пауза сама дорастает до минут (предел около 16 минут). Освобождение квоты её не сбрасывает: ReplicaSet о квоте не знает, он просто ждёт своей очереди.

Если `rollout status` не дождался, не сиди перед таймером. Перезапусти раскатку: Deployment создаст новый ReplicaSet, у которого накопленной паузы нет. Релиз при этом остаётся тем же, `1.8.0` с `400m`.

```bash
kubectl -n production rollout restart deploy/report-api
kubectl -n production rollout status deploy/report-api
```

Когда `rollout status` говорит «successfully rolled out», жми «Проверить».
