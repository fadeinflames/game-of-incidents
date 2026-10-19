# Разбор: Невидимая сеть

## Что было сломано

Hardening NET‑8802 заменил в security group `prod-workloads` строку `ingress tcp cross-zone allow` на `deny`. `sg-agent` на каждой ноде честно превратил это в правила iptables: TCP‑пакеты из pod‑CIDR других зон в pod‑CIDR своей ноды дропаются. Канарейка прошла, потому что в канареечном окружении все сервисы живут в одной зоне. В проде `order-service` (зоны a и d) стучится в `payment-service` (зона b) и получает таймауты; часть запросов от `frontend` (зона a) к репликам `order-service` в зоне d тоже не доходит. Дальше сработал второй механизм: circuit breaker в `order-service` после трёх подряд ошибок пометил оба payment‑endpoint'а `EJECTED` на 5 минут, и даже после отката правил заказы продолжали падать «circuit open».

В облачном оригинале первое — VPC security group, второе — waypoint‑прокси Istio Ambient с outlier detection. Механика та же.

## Как это диагностируется

1. `kubectl -n production logs deploy/order-service --tail=20` — `payment 10.244.2.5:8080 failed: URLError (timeout 2s)`, `circuit breaker: endpoint 10.244.2.5:8080 EJECTED for 300s after 3 consecutive failures`.
2. `kubectl -n production get pods -o wide` — паттерн: падают вызовы из зон a/d в зону b; `exec … wget -T 3 http://<payment-ip>:8080/health` из order‑пода висит, из соседнего пода зоны b отвечает.
3. `kubectl -n kube-system get configmap security-groups -o yaml` — `ingress tcp cross-zone deny`, аннотация `change-ticket: NET-8802, changed-at 08:30`.
4. `kubectl -n kube-system logs ds/sg-agent` — `DROP ingress tcp 10.244.1.0/24 -> 10.244.2.0/24 (cross-zone deny)`.
5. После отката: `GET /breaker` на order‑подах — endpoint'ы всё ещё `EJECTED`, `ejected_for_s` идёт на убыль.

## Эталонное решение

```bash
kubectl -n kube-system edit configmap security-groups        # cross-zone deny -> allow (откат NET-8802, тикет сетевикам)
kubectl -n kube-system logs ds/sg-agent --tail=3              # "no deny rules: chain SG-INGRESS flushed"
kubectl -n production rollout restart deploy/order-service    # сбросить circuit breaker
kubectl -n production exec deploy/frontend -- wget -qO- http://127.0.0.1:9090/stats   # success_rate -> 1.0
```

Вместо рестарта можно дождаться истечения eject (5 минут), но в пик это 5 минут ошибок.

## Ловушки

- Удалить `sg-agent` или ConfigMap. Связь появится, грейдер откажет: security group — механизм сетевой команды, его выключение вслепую снимает и все остальные правила.
- Сбросить цепочку iptables руками в privileged‑поде агента: связь на время появится, но правило в ConfigMap осталось, и после перезапуска агента drop вернётся. Грейдер проверяет сам откат ConfigMap, а не только связность.
- Откатить правила и остановиться: ещё до 5 минут 503 «circuit open», пока breaker не отпустит endpoint'ы.
- Чинить `payment-service` (рестарт, скейл): он жертва, до него просто не долетают пакеты.
- Перенести `payment-service` в зоны a/d: нарушает PCI‑сегментацию и маскирует сетевую проблему.

## Чему учит

- «Все поды Running» ничего не говорит о сети между ними. Проверяй связность попарно по зонам, паттерн отказа укажет на слой.
- Изменения сетевых политик проверяют на топологии, похожей на прод: канарейка в одной зоне не видит межзональных правил.
- Circuit breaker живёт своей жизнью: после устранения причины его надо закрыть (рестарт прокси/сервиса) или знать время eject.
- Чужой механизм не удаляют, а откатывают его изменение через владельца.

## Почитать

- [Kubernetes: Network Policies (и почему CNI должен их исполнять)](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Istio: Outlier detection / circuit breaking](https://istio.io/latest/docs/tasks/traffic-management/circuit-breaking/)
- [Yandex Cloud: группы безопасности](https://yandex.cloud/ru/docs/vpc/concepts/security-groups)
