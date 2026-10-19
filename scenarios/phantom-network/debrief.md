# Разбор: Фантомная сеть

## Что было сломано

Эквайер А начал принимать TCP‑соединения и **молчать**: ни ответа, ни `FIN`, ни `RST`. `payment-proxy` ходит к нему без таймаута (`ACQUIRER_TIMEOUT` пуст), поэтому каждый запрос оплаты повисал навсегда, а сам прокси оставался «зелёным»: он не падал и не логировал ошибок, просто копил соединения (`payment_proxy_inflight_upstream{acquirer="a"}` росло). `order-service` вызывал прокси **внутри открытой транзакции** и тоже без таймаута: рабочие потоки заканчивались, в PostgreSQL копились сессии `idle in transaction`, `/health` не успевал ответить kubelet'у, liveness‑проба убивала под, kubelet поднимал новый, и всё повторялось. Сверху мобильное приложение ретраило каждую неудачу, разгоняя нагрузку.

## Как это диагностируется

1. `kubectl get pods` — `order-service` с растущими `RESTARTS`, `payment-proxy` без единого.
2. `kubectl exec deploy/postgres -- psql -U orders -d orders -c "select state, count(*), max(now()-state_change) from pg_stat_activity where datname='orders' group by 1"` — десятки `idle in transaction`.
3. `kubectl exec deploy/payment-proxy -- wget -qO- localhost:8081/metrics` — inflight к эквайеру А растёт и никогда не убывает.
4. `kubectl exec deploy/payment-proxy -- python3 -c "import socket;s=socket.create_connection(('acquirer-a',8443),3);s.sendall(b'GET / HTTP/1.0\r\n\r\n');s.settimeout(5);print(s.recv(10))"` — соединение проходит, ответа нет: классический «чёрный ящик» на TCP.
5. `kubectl get deploy payment-proxy -o yaml | grep -A2 ACQUIRER_TIMEOUT` — таймаута нет.

## Эталонное решение

```bash
# 1. таймаут и резервный эквайер на платёжном прокси
kubectl set env deploy/payment-proxy ACQUIRER_TIMEOUT=2 FALLBACK_ACQUIRER=true
kubectl rollout status deploy/payment-proxy
# 2. таймаут на вызов оплаты в order-service и перезапуск, чтобы освободить зависшие потоки
kubectl set env deploy/order-service PAYMENT_TIMEOUT=5
kubectl rollout status deploy/order-service
# 3. проверить
kubectl exec deploy/load-generator -- python3 /app/loadgen.py --probe
```

Засчитывается любой путь, при котором заказы отвечают быстро и система стабильна: kill‑switch карт с честным `503`, асинхронная оплата, резервный эквайер. Заказ должен получить `201` или осознанный `503`: `502` от неудавшейся оплаты быстрым отказом не считается. Не засчитывается: удаление или ослабление liveness‑пробы, расширение пула БД, масштабирование прокси — они не убирают висящие потоки.

## Ловушки

- «База виновата»: `idle in transaction` — следствие, не причина. Расширение пула даст больше зависших сессий.
- «Убрать liveness» (или растянуть её до `periodSeconds: 3600`): поды перестанут рестартовать, но и работать не будут.
- «Вернуть эквайера А в норму» (правка ConfigMap `acquirer-sim` или его Deployment'а): это внешняя система, у неё своего рубильника нет. Грейдер сверяет, что эквайеры и образы сервисов не тронуты.
- «Отмасштабировать payment-proxy»: больше «зелёных» реплик с висящими соединениями.
- «Перезапустить order-service без таймаута»: 30 секунд облегчения, потом всё снова.

## Чему учит

- Каждый сетевой вызов должен иметь таймаут; вызов внешней системы внутри транзакции БД — двойная ошибка.
- «Зелёный» сервис без ошибок может быть центром инцидента: смотри на то, что растёт и не убывает.
- Ретраи клиентов превращают деградацию в шторм; их надо резать на edge.

## Почитать

- [Google SRE Book, «Handling Overload» и «Addressing Cascading Failures»](https://sre.google/sre-book/addressing-cascading-failures/)
- [PostgreSQL: `idle_in_transaction_session_timeout`](https://www.postgresql.org/docs/current/runtime-config-client.html)

## Автор кейса

Кирилл Борисов; кейс придуман совместно с сопровождающим проекта и публикуется с его согласия (CC BY 4.0).
