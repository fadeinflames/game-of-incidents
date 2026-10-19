# Разбор: Шторм из CronJob

## Что было сломано

CronJob `nightly-export` с `concurrencyPolicy: Allow` перевели с ночного расписания на «каждую минуту». Экспорт длится 15 минут, поэтому каждую минуту к работающим job'ам добавлялся ещё один: пять уже крутились, дальше было бы пятнадцать. Каждый под экспорта упирался в свой CPU‑лимит, и суммарно они выедали namespace, а `api` получал крохи.

## Как это диагностируется

1. `kubectl -n batch get cronjobs,jobs,pods` — `SCHEDULE */1 * * * *`, пять‑шесть job'ов `0/1` возрастом от 1 до 25 минут, столько же подов `Running`.
2. `kubectl -n batch get cronjob nightly-export -o yaml` — `concurrencyPolicy: Allow`, `suspend` не задан.
3. `kubectl -n batch logs job/nightly-export-2891 --tail=3` — «this usually takes ~15 min».
4. `kubectl -n batch describe cronjob nightly-export` — Events `SuccessfulCreate` каждую минуту.

## Эталонное решение

```bash
kubectl -n batch patch cronjob nightly-export -p '{"spec":{"suspend":true}}'          # 1. остановить генератор
kubectl -n batch delete jobs -l app=nightly-export                                      # 2. убрать накопившееся
kubectl -n batch patch cronjob nightly-export --type=merge \
  -p '{"spec":{"concurrencyPolicy":"Forbid","schedule":"0 2 * * *","startingDeadlineSeconds":600}}'   # 3. причина
kubectl -n batch patch cronjob nightly-export -p '{"spec":{"suspend":false}}'         # 4. включить обратно
```

Порядок важен: без `suspend` удалённые job'ы заменятся новыми через минуту. `Replace` вместо `Forbid` тоже принимается (новый job убивает предыдущий), но для экспорта, который лучше доделать, чем начинать заново, `Forbid` честнее. Оставить CronJob в `suspend: true` грейдер тоже примет, но тогда экспорт не будет ходить вовсе.

## Ловушки

- Удалять поды по одному: job создаст под заново (`restartPolicy: Never` + `backoffLimit`), а CronJob добавит новый job.
- Удалить CronJob целиком: шторм кончится, ночной экспорт тоже. Грейдер откажет.
- Оставить `Allow` и просто расширить интервал до 5 минут: при 15‑минутном экспорте job'ы всё равно наложатся, просто медленнее.

## Чему учит

- `concurrencyPolicy` для любого CronJob длиннее минуты — осознанный выбор, а не значение по умолчанию. `Forbid` для экспортов и бэкапов, `Replace` для «свежих снимков», `Allow` только для коротких независимых задач.
- Порядок при шторме: suspend → cleanup → fix → resume. Любой другой порядок превращается в бег по кругу.
- `activeDeadlineSeconds` в шаблоне job'а и `startingDeadlineSeconds` в CronJob ограничивают ущерб, если что‑то пойдёт не так снова.
- Изменение расписания CronJob — такой же релиз, как деплой сервиса: через ревью, с оценкой длительности.

## Почитать

- [Kubernetes: CronJob — Concurrency policy](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/#concurrency-policy)
- [Kubernetes: Jobs — Job termination and cleanup](https://kubernetes.io/docs/concepts/workloads/controllers/job/#job-termination-and-cleanup)
- [Kubernetes: Running Automated Tasks with a CronJob](https://kubernetes.io/docs/tasks/job/automated-tasks-with-cron-jobs/)
