# 🟠 Ночной бэкап не отработал — RPO нарушен

**Время:** четверг, 07:30. Ты дежурный SRE.

## Что известно

- База заказов живёт в namespace `data` (`Deployment database`, пароль в `Secret db-credentials`). Бэкапы делает `CronJob db-backup` в namespace `backup` под `ServiceAccount backup-controller`: читает пароль из Secret, снимает дамп, кладёт снапшот в `backup-store` (тоже в `backup`).
- Ночной запуск `db-backup-nightly-29` завершился с exit 1. В хранилище снапшоты за три предыдущих дня есть, за сегодня нет. Приложение живо, но RPO уже нарушен.
- Вчера security закрыла тикет SEC‑1187: «убрать cluster-admin у сервисного аккаунта бэкапа, выдать минимальные права». В Kubernetes всё зелёное: CronJob на месте, под запускается, Secret существует.
- Список снапшотов: `kubectl -n backup exec deploy/backup-store -- wget -qO- http://127.0.0.1:8080/snapshots`.

## Что не известно

- На каком именно шаге падает job и почему.
- Каких именно прав не хватает и какие из выданных лишние.

## Цель

Свежий снапшот лежит в `backup-store`, запуск бэкапа в `backup` завершился успешно, CronJob жив. При этом права `backup-controller` минимальны: не cluster-admin, без широких ролей вроде `admin`/`edit` и без доступа к чужим Secret'ам и объектам кластера.

## Ограничения

- Вернуть cluster-admin «как было» нельзя: тикет security закрыт, и в понедельник это снова уберут.
- Пароль базы нельзя перекладывать в манифест job'а или ConfigMap: он должен оставаться в Secret `data/db-credentials`: образ job'а читает его именно оттуда, копия Secret в другом namespace не засчитывается.

## Доступ

Shell на bastion‑хосте с `kubectl` под пользователем `oncall`, кластер уже в kubeconfig; права cluster-admin. Полезно: `kubectl auth can-i … --as=system:serviceaccount:backup:backup-controller`.
