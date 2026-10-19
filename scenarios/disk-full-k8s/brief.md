# 🔴 Блог отдаёт 500 — «не могу опубликовать статью»

**Время:** понедельник, 15:02. Ты дежурный по платформе.

> 🎓 **Учебный кейс.** Если не знаешь, с чего начать, под брифом есть панель «Нужна помощь?»: она открывает этапы диагностики по одному и объясняет, зачем нужна каждая команда. Это бесплатно, как и подсказки 1 и 2. Та же задача без подсказок есть в каталоге под своим обычным названием.

## Что известно

- В namespace `default` живёт блог: `Deployment blog-app` за `Service blog-app` и база `StatefulSet mysql` (под `mysql-0`) за headless `Service mysql`. Конфиг базы в `ConfigMap mysql-config`.
- Контент‑менеджер не может ни опубликовать статью, ни добавить комментарий: при сохранении ошибка 500.
- Алерт: контейнер `blog-app` перезапускается раз за разом, его liveness‑проба не проходит. База блога работает 240 дней, её никто не обслуживал.
- Внутри пода `mysql-0` есть клиент `mysql`. Проще всего передавать запрос через `-e`: `kubectl exec mysql-0 -- mysql -e "SHOW BINARY LOGS"`.

## Что не известно

- Почему приложение не может писать в базу, если база «работает».
- Что именно занимает место на томе базы и с какой скоростью оно растёт.

## Цель

Блог снова принимает записи: `blog-app` и `mysql-0` в `Ready`, на томе `/var/lib/mysql` занято не больше 70 %, а ротация бинлогов настроена так, чтобы через месяц всё не повторилось.

## Ограничения

- Данные блога терять нельзя: том нельзя пересоздавать «с нуля», StatefulSet нельзя удалять.
- Под `mysql-0` не удаляй и не перезапускай (`delete pod`, `rollout restart statefulset/mysql`). В этом стенде том базы живёт вместе с подом и не переживёт его пересоздание: база поднимется пустой. Всё, что нужно для починки, делается на работающем сервере.
- Бинлоги удалять можно, но так, чтобы MySQL об этом знал: `binlog.index` должен оставаться согласованным с файлами.

## Доступ

Shell на bastion‑хосте с `kubectl` под пользователем `oncall`, кластер уже в kubeconfig.

## Шпаргалка

| Команда | Что показывает |
|---|---|
| `kubectl get pods` | READY / RESTARTS: кто перезапускается, кто выпал из Ready |
| `kubectl logs <под> --tail=20` | ошибки приложения и базы (`Errcode: 28` = ENOSPC) |
| `kubectl exec mysql-0 -- df -h /var/lib/mysql` | сколько занято на томе базы |
| `kubectl exec mysql-0 -- du -sh /var/lib/mysql/*` | что именно занимает место |
| `kubectl exec mysql-0 -- mysql -e "SHOW BINARY LOGS"` | список бинлогов и их размер |
| `kubectl exec mysql-0 -- mysql -e "PURGE BINARY LOGS BEFORE NOW() - INTERVAL 1 DAY"` | удалить старые бинлоги правильно |
| `kubectl exec mysql-0 -- mysql -e "SET GLOBAL binlog_expire_logs_seconds = 259200"` | включить ротацию на лету |
| `kubectl edit configmap mysql-config` | сделать настройку постоянной |

## Почитать заранее

- [MySQL: PURGE BINARY LOGS](https://dev.mysql.com/doc/refman/8.0/en/purge-binary-logs.html) — почему бинлоги удаляют командой, а не `rm`.
- [MySQL: binlog_expire_logs_seconds](https://dev.mysql.com/doc/refman/8.0/en/replication-options-binary-log.html#sysvar_binlog_expire_logs_seconds) — автоматическая ротация бинлогов.
- [Kubernetes: StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/) — почему под называется `mysql-0` и что с ним нельзя делать как с Deployment.
- [Kubernetes: Debug Running Pods — kubectl exec](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/#container-exec) — как смотреть внутрь пода.
