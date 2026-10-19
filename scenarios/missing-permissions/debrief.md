# Разбор: Недостающие права

## Что было сломано

Два года бэкап работал под `cluster-admin`, и никто не знал, какие права ему реально нужны. Security сняла cluster-admin и выдала Role, написанный по манифесту job'а: смотреть поды и job'ы в namespace `backup`. Но первое, что делает job, — `kubectl -n data get secret db-credentials`: пароль базы живёт в другом namespace. Forbidden, exit 1, снапшота нет. В облаке это выглядит как `AccessDenied: kms.decrypt denied` у workload identity; в кластере это RBAC, и механика та же: скрытая зависимость от права, о котором не было написано нигде, кроме кода.

## Как это диагностируется

1. `kubectl -n backup get jobs` — `db-backup-nightly-29 0/1 Failed`.
2. `kubectl -n backup logs job/db-backup-nightly-29` — `Error from server (Forbidden): secrets "db-credentials" is forbidden: User "system:serviceaccount:backup:backup-controller" cannot get resource "secrets" in API group "" in the namespace "data"`, и следом строка `backup: FATAL cannot read credentials (permission denied)`.
3. `kubectl get clusterrolebinding | grep backup` — пусто; `kubectl -n backup get role,rolebinding` — новый `backup-runner` с аннотацией SEC‑1187.
4. `kubectl auth can-i get secret/db-credentials -n data --as=system:serviceaccount:backup:backup-controller` — `no`.
5. `cat /app/backup.sh` внутри образа (или `kubectl -n backup get cronjob db-backup -o yaml`) — что job делает на самом деле.

## Эталонное решение

```bash
kubectl -n data create role backup-credentials-reader --verb=get --resource=secrets --resource-name=db-credentials
kubectl -n data create rolebinding backup-credentials-reader --role=backup-credentials-reader \
  --serviceaccount=backup:backup-controller
kubectl -n backup create job --from=cronjob/db-backup db-backup-manual-1
kubectl -n backup logs job/db-backup-manual-1 -f            # backup: uploaded orders-….sql
```

Ровно одно право на ровно один объект (`resourceNames`), в том namespace, где он лежит. Потом ручной запуск, чтобы закрыть дыру в RPO, и diff разрешений для security: «job'у нужно get на data/db-credentials, всё остальное у него уже есть».

## Ловушки

- Вернуть `cluster-admin`. Бэкап пойдёт, грейдер откажет, а в понедельник security снова всё снесёт.
- Дать `get/list secrets` на весь кластер (ClusterRole). Тоже слишком широко: бэкап‑аккаунт сможет читать любые пароли.
- Привязать `admin` или `edit` в namespace `data` (RoleBinding вместо Role). Формально это не cluster-admin, но аккаунт сможет удалять Deployment базы и читать все Secret'ы namespace; грейдер проверяет и это.
- Скопировать пароль в env job'а или ConfigMap. Работает, но пароль ушёл из Secret в манифест и в git.
- Починить права и не запустить бэкап руками. До следующей ночи RPO остаётся нарушенным.

## Чему учит

- «В Kubernetes всё зелёное» ничего не значит для job'а, который ходит в API или облако: смотри его логи.
- `kubectl auth can-i --as=` проверяет гипотезу о правах за секунду, без запуска job'а.
- Least privilege пишут по тому, что код делает, а не по тому, что написано в манифесте. Аудит‑лог или логи job'а — источник правды.
- После починки прав закрывают последствия: ручной запуск, проверка артефакта, сообщение владельцам данных.

## Почитать

- [Kubernetes: Using RBAC Authorization — resourceNames](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#referring-to-resources)
- [Kubernetes: Checking API access (kubectl auth can-i)](https://kubernetes.io/docs/reference/access-authn-authz/authorization/#checking-api-access)
- [Kubernetes: Configure Service Accounts for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)
