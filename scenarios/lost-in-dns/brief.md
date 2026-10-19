# 🟠 «temporary failure in name resolution» — только для партнёрских имён

**Время:** четверг, 11:00. Ты дежурный по платформе.

## Что известно

- Магазин в namespace `shop`: `frontend`, `backend-api`, `external-api-proxy`. Последний ходит к партнёрским API в корпоративной зоне `corp.internal` (например, `payments-gateway.corp.internal`).
- Корпоративная зона обслуживается «on-prem» DNS: `corp-dns` в namespace `infra` (10.96.0.53). Кластерный CoreDNS форвардит `corp.internal` туда через stub‑зону в своём Corefile.
- С 08:00 `external-api-proxy` сыплет «temporary failure in name resolution» на `payments-gateway.corp.internal`, при этом имена кластера (`backend-api.shop.svc.cluster.local`) резолвятся нормально. Все поды Running.
- Утром в 08:00 сетевая команда применила NetworkPolicy «для hardening CoreDNS» (тикет NET‑8811). «Тесты в staging прошли».
- Статистика резолва: `kubectl -n shop exec deploy/external-api-proxy -- wget -qO- http://127.0.0.1:9090/stats`.

## Что не известно

- Почему страдают только имена `corp.internal`, а имена кластера нет.
- Что именно ограничила новая политика.

## Цель

`payments-gateway.corp.internal` и имена кластера резолвятся из подов приложения, success rate резолва за минуту ≥ 95 %, CoreDNS в 2 из 2 Ready. При этом CoreDNS остаётся под NetworkPolicy сетевой команды: ingress только 53, а egress разрешён явным правилом, а не отсутствием политики.

## Ограничения

- Просто удалить NetworkPolicy нельзя: требование security «CoreDNS ограничен политикой» остаётся. Политику надо исправить.
- `corp-dns` и Corefile трогать не нужно: они не менялись.

## Доступ

Shell на bastion‑хосте с `kubectl` под пользователем `oncall`, кластер уже в kubeconfig; права cluster-admin. Логи CoreDNS: `kubectl -n kube-system logs deploy/coredns --tail=30`.
