# Разбор: Сломанные пробы

## Что было сломано

Релиз 2.4.0 переименовал эндпоинт здоровья приложения с `/health` на `/healthz` (в манифесте это `env HEALTH_PATH`), а `readinessProbe` и `livenessProbe` в Deployment по‑прежнему ходили на `/health`. Новый под получал `404` на пробы: readiness не пускала его в endpoints, liveness перезапускала контейнер. При `maxUnavailable: 1` раскатка сняла один старый под, а новый так и не стал Ready — rollout завис, в сервисе осталось два адреса.

## Как это диагностируется

1. `kubectl rollout status deploy/web` — «Waiting for deployment "web" rollout to finish: 1 of 3 updated replicas are available…».
2. `kubectl get pods -l app=web` — новый под `0/1 Running` с растущим `RESTARTS`.
3. `kubectl describe pod <новый>` — Events: `Readiness probe failed: HTTP probe failed with statuscode: 404`.
4. `kubectl get deploy web -o yaml | grep -A3 -i probe` и `… | grep -A2 HEALTH_PATH` — пути не совпадают.

## Эталонное решение

```bash
kubectl patch deploy web --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/healthz"},
  {"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/httpGet/path","value":"/healthz"}]'
kubectl rollout status deploy/web
kubectl get endpoints web
```

Засчитывается любой путь, при котором три реплики версии 2.4.0 становятся Ready с рабочими пробами: `kubectl edit`, патч, изменение `HEALTH_PATH` обратно на `/health` под 2.4.0. Откат образа и удаление проб грейдер отклонит.

## Ловушки

- Откатить версию: раскатка завершится, но 2.4.0 нужна, откат не принимается.
- Удалить пробы: поды станут Ready мгновенно, но кластер перестанет понимать, жив ли под на самом деле.
- Подменить пробы на `tcpSocket` или на запрос к `/`: раскатка завершится, но такие пробы ничего не знают о здоровье приложения (сломанное приложение с открытым портом они пропустят). Грейдер требует `httpGet` на эндпоинт здоровья, который приложение объявляет в `HEALTH_PATH`.

## Чему учит

- Пробы — часть контракта приложения; менять эндпоинт здоровья без изменения манифеста — то же, что сломать API.
- «Пайплайн зелёный» означает лишь, что команда `set image` отработала; проверять надо `rollout status` и endpoints.
- `describe pod` с Events — первый инструмент при любом «под не Ready».

## Почитать

- [Kubernetes: Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Kubernetes: Deployments, rollout status и стратегия RollingUpdate](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
