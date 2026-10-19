# 🟡 Разработчик: «приложение всё ещё со старым таймаутом»

**Время:** вторник, 10:00. Ты дежурный по платформе.

> 🎓 **Учебный кейс.** Если не знаешь, с чего начать, под брифом есть панель «Нужна помощь?»: она открывает этапы диагностики по одному и объясняет, зачем нужна каждая команда. Это бесплатно, как и подсказки 1 и 2. Та же задача без подсказок есть в каталоге под своим обычным названием.

## Что известно

- В namespace `default` крутится `Deployment web-app` (2 реплики) за `Service web-app`. Конфигурация приложения лежит в `ConfigMap web-app-config`, пароль к базе — в `Secret postgres-secret`.
- Полчаса назад разработчик попросил поднять `API_TIMEOUT` с `10` до `30` и прислал в Slack YAML «со всем, что нужно». Ты применил его пять минут назад.
- Разработчик пишет: «в логах всё ещё `timeout=10`, вы вообще применили?». Через пару минут пришёл алерт `KubePodCrashLooping: web-app`.

## Что не известно

- Почему обновлённый ConfigMap не дошёл до приложения.
- Что именно было в присланном YAML и что он изменил кроме таймаута.

## Цель

Все реплики `web-app` работают с `API_TIMEOUT=30`, раскатка завершена, падающих подов нет, пароль к базе по‑прежнему приходит из `Secret postgres-secret`.

## Ограничения

- Пароль нельзя вписывать текстом в манифест: он должен оставаться в Secret.
- ConfigMap с новым значением трогать не нужно, он правильный.

## Доступ

Shell на bastion‑хосте с `kubectl` под пользователем `oncall`, кластер уже в kubeconfig.

## Шпаргалка

| Команда | Что показывает |
|---|---|
| `kubectl get cm <имя> -o yaml` | содержимое ConfigMap |
| `kubectl get pods -l <селектор>` | READY / STATUS / RESTARTS / AGE по каждому поду |
| `kubectl exec <под> -- env` | переменные окружения, с которыми под реально запущен |
| `kubectl logs <под>` | почему контейнер падает |
| `kubectl rollout status deploy/<имя>` | застряла ли раскатка |
| `kubectl rollout history deploy/<имя>` | кто и когда менял Deployment (change-cause) |
| `kubectl get deploy <имя> -o yaml` | манифест: блок `env`, ссылки на ConfigMap и Secret |
| `kubectl edit deploy <имя>` | правка манифеста прямо в кластере |

## Почитать заранее

- [Kubernetes: Configure a Pod to Use a ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/) — чем `env.valueFrom` отличается от монтирования томом и почему env не обновляется на лету.
- [Kubernetes: Distribute Credentials Securely Using Secrets](https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure/) — как пробросить Secret в переменную окружения через `secretKeyRef`.
- [Kubernetes: Deployments — rollout, history и откат](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#checking-rollout-history-of-a-deployment) — как узнать, что и когда изменилось в Deployment.
