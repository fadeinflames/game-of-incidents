# Разбор: Квота съела релиз

## Что было сломано

Namespace `production` ограничен квотой `requests.cpu: 2`. До релиза в нём было запрошено 1950m: `worker` 4 × 325m, `cache` 250m, `report-api` 2 × 200m. Релиз 1.8.0 поднял `report-api` до 400m. Раскатка с `maxUnavailable: 1` удалила одну старую реплику (освободила 200m), но новому поду нужно 400m, а свободно только 250m. ReplicaSet получил `FailedCreate: exceeded quota` и остался ждать: без ошибок в подах, потому что подов нет.

Вторая ловушка: `LimitRange` с `min.cpu: 100m`. Попытка «ужать всех до 50m» отклоняется admission‑контроллером.

## Как это диагностируется

1. `kubectl -n production get pods` — у `report-api` один под, второго нет ни в каком статусе.
2. `kubectl -n production describe rs -l app=report-api` (или `kubectl -n production get events --sort-by=.lastTimestamp`) — `FailedCreate … exceeded quota: prod-quota, requested: requests.cpu=400m, used: 1750m, limited: 2`. Событие пишется на ReplicaSet: `describe deploy` покажет только условие `ReplicaFailure True FailedCreate` без текста про квоту.
3. `kubectl -n production describe quota prod-quota` — `Used 1750m / Hard 2`.
4. `kubectl -n production get pods -o custom-columns=NAME:.metadata.name,CPU:.spec.containers[*].resources.requests.cpu` — `worker` занимает 1300m, больше всех.
5. `kubectl -n production get limitrange -o yaml` — `min.cpu: 100m`.

## Эталонное решение

```bash
kubectl -n production scale deploy/worker --replicas=2      # освобождает 650m, когда лишние поды удалятся
kubectl -n production rollout status deploy/report-api       # раскатка продолжится со следующей попытки ReplicaSet
kubectl -n production rollout restart deploy/report-api      # если следующая попытка далеко: новый ReplicaSet стартует сразу
```

Почему может понадобиться третья команда. ReplicaSet, получивший отказ от квоты, повторяет создание пода не непрерывно, а с растущей паузой: каждая неудача её удваивает, предел около 16 минут. Освобождение квоты эту паузу не сбрасывает: ReplicaSet о квоте ничего не знает, он просто ждёт своей очереди. Сразу после поломки следующая попытка случится через секунды, а после десяти минут диагностики — через минуты. `rollout restart` меняет только аннотацию шаблона: Deployment создаёт новый ReplicaSet без накопленной паузы, релиз остаётся тем же (`1.8.0`, `400m`). Ещё одна деталь: квота освобождается не в момент `scale`, а когда поды `worker` действительно удалены; пока они в `Terminating`, их requests считаются.

Засчитывается любой путь, при котором `report-api 1.8.0` с `400m` раскатан в 2 реплики, квота и LimitRange не тронуты, а `worker` остался минимум в 2 репликах: например, `kubectl set resources deploy/worker --requests=cpu=150m` при 4 репликах тоже проходит. Обрати внимание на арифметику с `maxSurge: 1`: в пике раскатки в namespace одновременно два новых пода по 400m, поэтому `worker` в 3 репликах места не даёт.

## Ловушки

- Удалить или поднять `ResourceQuota`: раскатка пройдёт, грейдер откажет. Квота стоит по согласованию с финансами, её изменение — отдельный тикет, а не действие дежурного.
- Понизить `requests` ниже `min` из LimitRange: кластер отклонит патч, поды снова не создадутся.
- Откатить релиз (`rollout undo`) или вернуть `200m`: клиенты не получат отчёты на 1.8.0.
- Уменьшить `worker` до 0–1 реплик: место есть, но SLA фоновой обработки нарушен.

## Чему учит

- Когда подов нет совсем, ответ в Events ReplicaSet (`describe rs`, `get events`), а не в логах.
- Контроллеры повторяют неудачные действия с растущей паузой. Устранил причину, а ничего не происходит — возможно, объект просто ждёт следующей попытки, и его можно подтолкнуть.
- ResourceQuota считает `requests`, а не реальное потребление: «на ноде полно свободного CPU» ничего не значит.
- Перед релизом, меняющим `requests`, посчитай квоту с учётом `maxSurge`.
- Алерт на использование квоты выше 85 % и регулярный отчёт по requests в namespace превращают этот инцидент в плановую задачу.

## Почитать

- [Kubernetes: Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- [Kubernetes: Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [Kubernetes: Deployments — Proportional scaling и maxSurge](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#proportional-scaling)
