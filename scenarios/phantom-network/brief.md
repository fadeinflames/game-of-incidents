# 🔴 ALERT: HTTP5xxRate edge-gateway /orders > 50 %

**Время:** понедельник, 10:52. Ты дежурный. Инцидент идёт пять минут, деньги утекают.

## Архитектура

```
мобильные клиенты
        │
        ▼
edge-gateway (nginx)
        │
        ▼
order-service ×3 ──► PostgreSQL
        │
        │ оплата картой
        ▼
payment-proxy
   ├──► эквайер А (карты, основной)
   └──► эквайер Б (карты, резерв)
```

Оплату через СБП `order-service` проводит сам, без `payment-proxy`.

## Что известно

- С 10:47 `edge-gateway` отдаёт `504 Gateway Time-out` на `POST /orders`.
- RPS растёт: мобильное приложение ретраит неудачные оплаты.
- `order-service` перезапускается: kubelet считает его неживым.
- `payment-proxy` «зелёный»: `Ready`, нет ошибок в логах, рестартов нет.
- Поддержка: «оплата картой висит и падает, оплата через СБП работает».
- Ничего не выкатывали с пятницы.

## Что не известно

- Где именно запрос застревает.
- Что с эквайером А: его статус‑страница зелёная.

## Цель

`POST /orders` через `edge-gateway` отвечает не дольше 5 секунд: успех (`201`) через резервный эквайер или честный быстрый отказ, то есть осознанный `503` (например, карты временно отключены), а не `502` или таймаут от неудавшейся оплаты. `order-service` стабилен, в базе нет зависших транзакций, в `payment-proxy` нет висящих соединений к эквайеру А.

## Ограничения

- Убирать пробы у `order-service` нельзя: без них деплой не примут.
- Эквайеры А и Б (`acquirer-a`, `acquirer-b`) и их настройки — внешние системы, их не трогаем: починить нужно то, что на нашей стороне.
- «Расширить пул базы» и «отмасштабировать payment-proxy» можно пробовать, но причину это не починит.
- Конфигурация сервисов живёт в Deployment'ах (env) и ConfigMap'ах, применяй через `kubectl`.

## Доступ

Shell на bastion‑хосте с `kubectl` под пользователем `oncall`, кластер уже в kubeconfig. Полезные точки входа:

```bash
kubectl exec -it deploy/postgres -- psql -U orders -d orders
kubectl exec deploy/postgres -- psql -U orders -d orders -c "select state, count(*) from pg_stat_activity group by 1"
kubectl exec deploy/payment-proxy -- wget -qO- localhost:8081/metrics
kubectl exec deploy/load-generator -- python3 /app/loadgen.py --probe 3
```
