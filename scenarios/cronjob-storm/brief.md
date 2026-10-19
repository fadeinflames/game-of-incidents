# 🔴 ALERT: NamespaceCPUSaturation — batch

**Время:** среда, 09:05. Ты дежурный по платформе.

> 🎓 **Учебный кейс.** Если не знаешь, с чего начать, под брифом есть панель «Нужна помощь?»: она открывает этапы диагностики по одному и объясняет, зачем нужна каждая команда. Это бесплатно, как и подсказки 1 и 2. Та же задача без подсказок есть в каталоге под своим обычным названием.

## Что известно

- В namespace `batch` живёт `api` (2 реплики) и ночной экспорт `nightly-export`: CronJob, который выгружает отчётные таблицы в объектное хранилище. Экспорт идёт около 15 минут.
- Алерт: CPU в namespace на 95 % от лимитов, latency `api` выросла в четыре раза. Алерт пришёл из внешнего мониторинга: метрик внутри кластера нет, `kubectl top` не работает, так что причину ищи по объектам, а не по графикам.
- Команда данных пишет: «мы утром поставили экспорт почаще, это же не могло ничего сломать?».

## Что не известно

- Что именно поменяли в расписании и сколько экспортов сейчас работает.
- Почему экспорты мешают `api`, если раньше не мешали.

## Цель

Одновременно работает не больше одного экспорта, `api` в норме (2 реплики Ready), CronJob `nightly-export` жив и настроен так, что накопление невозможно: `concurrencyPolicy` не `Allow`, расписание не «каждую минуту».

## Ограничения

- Удалять CronJob нельзя: экспорт нужен бизнесу, команда данных договорится о частоте позже.
- `api` трогать не нужно, он жертва, а не причина.

## Доступ

Shell на bastion‑хосте с `kubectl` под пользователем `oncall`, кластер уже в kubeconfig. Все объекты в namespace `batch`, не забывай `-n batch`.

## Шпаргалка

| Команда | Что показывает |
|---|---|
| `kubectl -n batch get cronjobs,jobs,pods` | batch‑объекты одной картиной: расписание, активные job'ы, их поды |
| `kubectl -n batch get cronjob <имя> -o yaml` | schedule, concurrencyPolicy, suspend, шаблон job'а |
| `kubectl -n batch describe cronjob <имя>` | Events: когда и какие job'ы создавались |
| `kubectl -n batch logs job/<имя>` | что делает экспорт и сколько ему осталось |
| `kubectl -n batch patch cronjob <имя> -p '{"spec":{"suspend":true}}'` | остановить создание новых job'ов |
| `kubectl -n batch delete jobs -l <селектор>` | удалить job'ы вместе с их подами |
| `kubectl -n batch edit cronjob <имя>` | поправить политику и расписание |

## Почитать заранее

- [Kubernetes: CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/) — `schedule`, `concurrencyPolicy` (Allow / Forbid / Replace), `suspend`, `startingDeadlineSeconds`.
- [Kubernetes: Running Automated Tasks with a CronJob](https://kubernetes.io/docs/tasks/job/automated-tasks-with-cron-jobs/) — как посмотреть job'ы и их поды, как остановить.
- [Kubernetes: Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/) — `activeDeadlineSeconds`, `backoffLimit`, удаление и очистка.
