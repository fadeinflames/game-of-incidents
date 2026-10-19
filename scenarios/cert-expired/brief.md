# 🔴 «Сайт не открывается, ошибка сертификата!»

**Время:** понедельник, 09:15. Ты дежурный по платформе.

## Что известно

- Магазин `shop.production.svc.cluster.local` (это «наш домен»; DNS здесь внутрикластерный) отдаётся через `ingress-nginx` с TLS. Сертификат выпускает cert-manager по ACME HTTP-01 у `ClusterIssuer letsencrypt-prod` (ACME‑сервер живёт в namespace `acme`).
- Ночью сертификат истёк. Браузер показывает ошибку сертификата: ingress отдаёт «Kubernetes Ingress Controller Fake Certificate». `Certificate production/shop-tls` в `Ready: False`.
- Последнее успешное продление было два месяца назад. Примерно тогда же security закрыла тикет SEC‑2210 «HTTPS only».
- CEO пишет каждые пять минут.

## Что не известно

- Почему cert-manager не может перевыпустить сертификат: у него есть заказ, есть challenge, и он не проходит.
- Что именно изменил SEC‑2210.

## Цель

`Certificate shop-tls` в `Ready: True` с действующим сроком, ingress отдаёт сертификат от ACME CA (не fake и не самоподписанный), сертификат по‑прежнему выпущен через `ClusterIssuer letsencrypt-prod`, а следующее продление сможет пройти (HTTP-01 должен работать). cert-manager не тронут.

## Ограничения

- Подменить issuer на самоподписанный или выпустить сертификат руками нельзя: через 90 дней та же история, и браузеры такому не поверят.
- ACME‑сервер и его правила менять нельзя: это внешняя сторона.

## Доступ

Shell на bastion‑хосте с `kubectl` под пользователем `oncall`, кластер уже в kubeconfig; права cluster-admin. Полезно: `kubectl -n production describe certificate shop-tls`, `kubectl -n production get orders,challenges`, `kubectl -n cert-manager logs deploy/cert-manager --tail=50`.
