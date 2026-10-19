# Как подступиться

Жалоба «изменил конфиг, а приложение не заметило» почти всегда разбирается по одной схеме: **что лежит в кластере → что реально видит под → почему поды не обновились → что ещё изменилось вместе с конфигом**.

## Убедись, что ConfigMap действительно обновлён

```bash
kubectl get configmap web-app-config -o yaml
```

Смотри на `data.API_TIMEOUT`. Если там `"30"`, сам ConfigMap в порядке, и проблема не в нём, а в том, как он доходит до приложения. Значение в кавычках — это нормально, ConfigMap хранит строки.

## Посмотри, с чем реально запущены поды

```bash
kubectl get pods -l app=web-app
kubectl exec <имя старого пода> -- env | grep API_TIMEOUT
```

`get pods` покажет два старых пода (`AGE` большой, `READY 1/1`) и, скорее всего, третий, который `Running 0/1` с растущим `RESTARTS` или `CrashLoopBackOff`. `exec … env` покажет, что старые поды запущены с `API_TIMEOUT=10`: переменные окружения фиксируются в момент старта пода, обновление ConfigMap их не меняет. Чтобы под увидел новое значение, он должен перезапуститься.

## Разберись, почему старые поды ещё живы

```bash
kubectl rollout status deploy/web-app --timeout=5s
kubectl rollout history deploy/web-app
```

Раскатка нового шаблона уже идёт, но застряла: новый под не становится Ready, а старые кластер не убирает (`maxUnavailable: 0`). `rollout history` с колонкой `CHANGE-CAUSE` подскажет, что последнюю ревизию создал присланный YAML, а не ты руками.

## Узнай, почему падает новый под

```bash
kubectl logs <имя падающего пода>
kubectl get secrets
kubectl get deploy web-app -o yaml | grep -n -A12 'env:'
```

Логи скажут прямо, какой переменной не хватает. `get secrets` покажет, что Secret на месте. А в блоке `env` Deployment ты увидишь, что ссылки на него больше нет: YAML «со всем, что нужно» описывал весь Deployment и просто не знал про пароль. `kubectl apply` заменил манифест целиком.

## Верни ссылку на Secret и дождись раскатки

```bash
kubectl edit deploy web-app
```

Добавь в `env` контейнера переменную с `valueFrom.secretKeyRef` на нужный Secret и ключ (посмотри ключи через `kubectl get secret postgres-secret -o yaml`). После сохранения проверь `kubectl rollout status` и обязательно `kubectl exec <под> -- env | grep API_TIMEOUT`.

Ловушка: если исправленный шаблон совпал со старым, Kubernetes не создаёт новые поды, а возвращает старый ReplicaSet вместе с его подами, которые всё ещё живут с `10`. Тогда нужен явный перезапуск:

```bash
kubectl rollout restart deploy/web-app
kubectl rollout status deploy/web-app
```

Когда `exec … env` показывает `30` на всех подах, жми «Проверить».
