# Разбор: Потерянная конфигурация

## Что было сломано

Две вещи сразу, и вторая пряталась за первой.

1. `API_TIMEOUT` попадает в контейнер через `env.valueFrom.configMapKeyRef`. Такие переменные читаются один раз при создании пода: обновление ConfigMap ничего не меняет для уже запущенных подов. Старые реплики продолжали работать с `10`.
2. Присланный YAML описывал весь Deployment, а не только таймаут, и в нём не было переменной `DATABASE_PASSWORD` из `Secret postgres-secret`. `kubectl apply` заменил манифест целиком, начался rollout, новый под упал с «Missing required environment variable: DATABASE_PASSWORD». Из‑за `maxUnavailable: 0` кластер не трогал старые поды, поэтому снаружи всё выглядело как «ничего не применилось», а не как авария.

## Как это диагностируется

1. `kubectl get configmap web-app-config -o yaml` — в ConfigMap уже `30`.
2. `kubectl get pods -l app=web-app` — два старых пода `1/1`, третий `0/1` с `RESTARTS` или `CrashLoopBackOff`.
3. `kubectl exec <старый под> -- env | grep API_TIMEOUT` — `10`: под запущен со старым значением.
4. `kubectl logs <новый под>` — не хватает `DATABASE_PASSWORD`.
5. `kubectl get deploy web-app -o yaml` — в `env` нет `secretKeyRef`; `kubectl rollout history deploy/web-app` — последняя ревизия «dev: API_TIMEOUT 30 (yaml from Slack)».

## Эталонное решение

```bash
kubectl patch deploy web-app --type=json -p='[
  {"op":"add","path":"/spec/template/spec/containers/0/env/-",
   "value":{"name":"DATABASE_PASSWORD","valueFrom":{"secretKeyRef":{"name":"postgres-secret","key":"password"}}}}]'
kubectl rollout status deploy/web-app
kubectl exec deploy/web-app -- env | grep API_TIMEOUT   # всё ещё 10!
kubectl rollout restart deploy/web-app
kubectl rollout status deploy/web-app
kubectl exec deploy/web-app -- env | grep API_TIMEOUT   # 30
```

То же самое через `kubectl edit deploy web-app`. Второй шаг важен: исправленный шаблон побайтово совпал с ревизией 1, и Deployment просто вернул старый ReplicaSet вместе с его двумя подами, а они запускались ещё с `10`. Только `rollout restart` (он меняет аннотацию в шаблоне) создаёт новые поды, которые читают обновлённый ConfigMap.

## Ловушки

- Вписать пароль в манифест текстом (`value: s3cr3t…`). Приложение поднимется, но грейдер это не примет: пароль ушёл из Secret в Git и в `kubectl get deploy`.
- `kubectl rollout undo`. Возвращает ревизию 1 вместе с её старыми подами: пароль на месте, падающий под исчез, но `API_TIMEOUT` у подов всё ещё `10`, потому что их никто не перезапускал. Грейдер не примет, пока не будет `rollout restart`. И ты откатил ревизию, не поняв, что в ней было: тот же YAML прилетит снова.
- Поменять `API_TIMEOUT` на литерал `30` прямо в Deployment. Работает, но конфигурация теперь живёт в двух местах.

## Чему учит

- Переменные окружения из ConfigMap и Secret фиксируются при старте пода. Изменил ConfigMap — перезапусти поды (`rollout restart`) или монтируй ConfigMap томом, если приложение умеет перечитывать файлы.
- `kubectl apply` YAML‑файла из чата заменяет объект целиком. Перед применением сравни его с тем, что в кластере: `kubectl diff -f file.yaml`.
- Источник правды для манифестов — Git, а не Slack. GitOps (Argo CD, Flux) делает такую ошибку невозможной: изменение проходит через diff и ревью.
- `rollout history` с `change-cause` экономит десять минут на вопрос «кто это менял».

## Почитать

- [Kubernetes: Configure a Pod to Use a ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/)
- [Kubernetes: Distribute Credentials Securely Using Secrets](https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure/)
- [kubectl diff](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_diff/)
- [Argo CD: Getting Started](https://argo-cd.readthedocs.io/en/stable/getting_started/)
