# Разбор: Пропавшее хранилище

## Что было сломано

Ротация прошла в два шага, и второй сломал первый. Security выпустила новый ключ хранилища (версия 2 в vault, S3‑шлюз перезапущен с новым root‑ключом) и той же ночью «ужесточила политику vault»: удалила RoleBinding, по которому `ServiceAccount media/secret-sync` читал `security/s3-credentials`. Синхронизация упала с `Forbidden`, `media-s3` остался с ключом версии 1, `media-api` продолжил подписывать запросы старым ключом и получать ошибку ключа доступа (`InvalidAccessKeyId` у AWS, `XAdminUserNotFound: No user exists with the provided access key ID` у VersityGW). Чтение старых файлов шло из локального кэша приложения, поэтому «в остальном работает».

## Как это диагностируется

1. `kubectl -n media logs deploy/media-api --tail=20` — `PUT s3://media/… -> 404 XAdminUserNotFound (key AKIA…) — no user exists with this access key: the key is stale or was rotated`.
2. `kubectl -n media get jobs` — `secret-sync-29010200 0/1 Failed`; `kubectl -n media logs job/secret-sync-29010200` — `secrets "s3-credentials" is forbidden`.
3. `kubectl -n security get secret s3-credentials -o jsonpath='{.metadata.annotations}'` — `security/key-version: 2`, `security/rotated-at: …`; у `media/media-s3` в аннотации `security/key-version` — `1`. Версия ключа живёт именно в аннотациях Secret, в самих данных её нет.
4. `kubectl -n security get rolebinding` — `secret-sync-reader` отсутствует, Role `secret-reader` на месте.
5. `kubectl auth can-i get secret/s3-credentials -n security --as=system:serviceaccount:media:secret-sync` — `no`.

## Эталонное решение

```bash
kubectl -n security create rolebinding secret-sync-reader --role=secret-reader --serviceaccount=media:secret-sync
kubectl -n media create job --from=cronjob/secret-sync secret-sync-manual-1
kubectl -n media logs job/secret-sync-manual-1        # media/media-s3 updated to version 2, media-api restarting
kubectl -n media rollout status deploy/media-api
```

Синхронизация обновляет Secret и меняет аннотацию в шаблоне Deployment, поэтому `media-api` перезапускается сам. Ручное обновление `media-s3` из vault плюс `rollout restart` тоже принимается, если после этого починена и синхронизация.

## Ловушки

- Взять ключ из `storage/storage-root` и вписать в `media-s3` руками, не трогая RoleBinding. Загрузки оживут на 15 минут: следующий запуск `secret-sync` упадёт, а через одну ротацию всё повторится. Грейдер проверяет, что sync может читать vault.
- Обновить Secret и не перезапустить `media-api`. Переменные окружения читаются при старте пода.
- Выдать `secret-sync` `cluster-admin` или роль на весь vault, «чтобы точно заработало». Синхронизации нужен один Secret (`get` на `s3-credentials`); грейдер отказывает, если аккаунт может читать больше.
- Удалить или приостановить CronJob. Ключ больше никогда не обновится автоматически.

## Чему учит

- «Неизвестный ключ доступа» (`InvalidAccessKeyId`) почти никогда про код: это ключ, который приложение реально использует, и он не тот, что в источнике правды. Сравни версии.
- Автоматическая синхронизация секретов (ExternalSecret, Vault Agent, sync‑job) — тоже сервис со своим статусом. Если он «Error», приложение живёт на устаревших данных и падает при первой ротации.
- Изменение политики доступа и ротация в одну ночь без проверки потребителей — организационная причина. В постмортем: ротация как процесс с проверкой синка у каждого потребителя.

## Почитать

- [External Secrets Operator: troubleshooting (ExternalSecret status)](https://external-secrets.io/latest/guides/troubleshooting/)
- [VersityGW: S3-compatible gateway (root credentials)](https://github.com/versity/versitygw/wiki)
- [Kubernetes: RBAC — RoleBinding across namespaces](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#rolebinding-and-clusterrolebinding)
