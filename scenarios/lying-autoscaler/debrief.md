# Разбор: Лживый автоскейлер

## Что было сломано

Релиз 3.4 включил `PEER_GOSSIP`: каждая реплика раз в секунду синхронизирует таблицу in‑flight корзин с каждой другой репликой через headless‑сервис `checkout-api-peers`. Стоимость синка растёт с числом реплик: при 3 подах это ~120 мс CPU в секунду на под (больше 100m запроса), при 4 и больше — почти весь лимит 150m. HPA по CPU видит рост утилизации, добавляет реплики, реплики добавляют друг другу работы, утилизация растёт ещё. Самоусиливающаяся петля: метрика, по которой масштабируем, зависит от результата масштабирования. В облачном оригинале то же самое делала агрегированная метрика `http_requests_in_flight` по всему сервису, не делённая на под.

## Как это диагностируется

1. `kubectl get hpa checkout-api -w` — `TARGETS 140%/50%`, `REPLICAS` растут до 12; трафик при этом 10 rps.
2. `kubectl top pods -l app=checkout-api` — каждая реплика тратит 100–150m при трафике в 10 rps, чем больше подов, тем ближе к лимиту.
3. `kubectl rollout history deploy/checkout-api` — «release 3.4: cart consistency across pods (peer gossip)».
4. `kubectl logs deploy/checkout-api --tail=5` — `gossip: synced with 11 peers`.
5. `kubectl get configmap checkout-config -o yaml` — `PEER_GOSSIP: "on"`.

## Эталонное решение

```bash
kubectl patch hpa checkout-api -p '{"spec":{"minReplicas":3,"maxReplicas":3}}'   # 1. заморозить: шторм планирования стоп
kubectl patch configmap checkout-config -p '{"data":{"PEER_GOSSIP":"off"}}'       # 2. убрать усилитель
kubectl rollout restart deploy/checkout-api && kubectl rollout status deploy/checkout-api
kubectl patch hpa checkout-api -p '{"spec":{"minReplicas":2,"maxReplicas":12}}'   # 3. вернуть HPA его работу
```

Заморозка HPA (min = max) или его удаление останавливают шторм, но не лечат: gossip остаётся включённым, и при любом снятии заморозки петля вернётся. Грейдер такой ответ не засчитывает: он проверяет, что поды действительно работают без gossip, что реплик 2–6 и их число стабильно. Выключить gossip мало: ConfigMap читается только при старте пода, поэтому нужен перезапуск.

## Ловушки

- Поднять `maxReplicas` до 30 «чтобы хватило». Петля не имеет насыщения, кроме лимита; будет 30 подов с тем же CPU.
- Заморозить HPA (min = max) и сказать «стабильно». Пока gossip включён, это пауза, а не решение.
- Поправить ConfigMap и не перезапустить поды. Работающие поды держат старое значение и продолжают синхронизироваться.
- Поднять цель HPA до 90 %. Замедлит раскачку, не остановит.
- Дать подам больше CPU (`limits`). Синк съест и его.
- Удалить HPA, не заморозив реплики на разумном числе: Deployment останется на 12.

## Чему учит

- Метрика для автоскейлинга должна быть нормирована на под и не должна зависеть от числа подов. Если рост реплик увеличивает метрику, это не нагрузка, а петля.
- При хаотичном скейлинге первое действие — заморозить (min = max), второе — понять, третье — вернуть автоматику.
- Любая «синхронизация между всеми репликами» — O(n²); автоскейлинг превращает её в инцидент.
- Релиз, меняющий профиль нагрузки, заслуживает канарейки с включённым HPA, а не «выкатили в пятницу в 12:40».

## Почитать

- [Kubernetes: Horizontal Pod Autoscaling — algorithm details](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/#algorithm-details)
- [Kubernetes: HPA scaling behavior (stabilization windows)](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/#configurable-scaling-behavior)
- [metrics-server](https://github.com/kubernetes-sigs/metrics-server)
