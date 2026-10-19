# 🟠 Релиз report-api завис — «отчёты должны уйти к 17:00»

**Время:** вторник, 16:10. Ты дежурный по платформе.

> 🎓 **Учебный кейс.** Если не знаешь, с чего начать, под брифом есть панель «Нужна помощь?»: она открывает этапы диагностики по одному и объясняет, зачем нужна каждая команда. Это бесплатно, как и подсказки 1 и 2. Та же задача без подсказок есть в каталоге под своим обычным названием.

## Что известно

- В namespace `production` живут три приложения: `report-api` (2 реплики, отчёты клиентам), `worker` (4 реплики, фоновая обработка) и `cache` (1 реплика).
- Команда выкатила `report-api 1.8.0` и подняла ему `requests.cpu` с `200m` до `400m`: «старые лимиты душили отчёты». Это часть релиза, а не ошибка.
- Деплой висит седьмую минуту: одна старая реплика уже удалена, новая так и не появилась. Алерт: желаемых реплик 2, доступных 1.
- На namespace стоят `ResourceQuota` и `LimitRange`, их ставила платформенная команда по согласованию с финансами.

## Что не известно

- Почему новые поды не создаются: ошибок в логах нет, потому что подов нет.
- Хватает ли namespace ресурсов на новый релиз и кто их занимает.

## Цель

`report-api 1.8.0` с `requests.cpu: 400m` полностью раскатан: 2 реплики Ready, rollout завершён. Квота и LimitRange остались как были, `worker` продолжает работать минимум в 2 репликах.

## Ограничения

- Менять или удалять `ResourceQuota` и `LimitRange` нельзя: это чужая зона ответственности, на изменение нужен тикет, а времени нет.
- Откатывать релиз или возвращать `report-api` на `200m` нельзя: отчёты на старой версии не соберутся.
- `worker` можно ужимать, но не ниже 2 реплик: так договорились с командой данных.

## Доступ

Shell на bastion‑хосте с `kubectl` под пользователем `oncall`, кластер уже в kubeconfig. Все объекты в namespace `production`, не забывай `-n production`.

## Шпаргалка

| Команда | Что показывает |
|---|---|
| `kubectl -n production get pods` | сколько подов у каждого приложения и в каком они состоянии |
| `kubectl -n production describe rs -l app=<имя>` | Events ReplicaSet: почему он не может создать поды |
| `kubectl -n production get events --sort-by=.lastTimestamp` | все события namespace по порядку, свежие внизу |
| `kubectl -n production describe quota` | used / hard по каждому ресурсу квоты |
| `kubectl -n production get limitrange -o yaml` | минимум и максимум requests на контейнер |
| `kubectl -n production get pods -o custom-columns=NAME:.metadata.name,CPU:.spec.containers[*].resources.requests.cpu` | кто сколько CPU запрашивает |
| `kubectl -n production scale deploy/<имя> --replicas=N` | изменить число реплик |
| `kubectl -n production set resources deploy/<имя> --requests=cpu=<n>` | изменить requests |
| `kubectl -n production rollout status deploy/<имя>` | завершилась ли раскатка |
| `kubectl -n production rollout restart deploy/<имя>` | начать раскатку заново с теми же настройками (новый ReplicaSet) |

## Почитать заранее

- [Kubernetes: Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/) — что считает квота и почему при исчерпании поды не создаются, а не падают.
- [Kubernetes: Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/) — минимумы, максимумы и значения по умолчанию на контейнер.
- [Kubernetes: Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/) — чем requests отличаются от limits и как их читает планировщик.
