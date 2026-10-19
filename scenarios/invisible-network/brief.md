# 🔴 HighErrorRate order-service 12 % 503, payment p95 5.2 s — пик, четверг 14:30

**Время:** четверг, 14:30, пиковый трафик. Ты дежурный SRE.

## Что известно

- Кластер из трёх рабочих нод в зонах `ru-central1-a`, `b`, `d`. В namespace `production`: `order-service` (3 реплики, зоны a и d), `payment-service` (2 реплики, только зона b: PCI‑сегмент), `frontend` с клиентским трафиком.
- `order-service` ходит в `payment-service` напрямую по IP подов (headless `payment-service-peers`) и держит собственный circuit breaker: endpoint после трёх подряд ошибок помечается `EJECTED` на 5 минут. Таблица: `GET /breaker` на поде order-service.
- Сетевой доступ между нодами регулирует «security group» `prod-workloads`: правила в `ConfigMap kube-system/security-groups` (владелец — сетевая команда), их применяет на каждой ноде `DaemonSet kube-system/sg-agent` через iptables.
- Утром в 08:30 сетевая команда применила hardening (тикет NET‑8802), канарейка прошла. Сейчас: 12 % 503 у `order-service`, в его логах `payment <ip>:8080 failed: … (timeout 2s)`, у `payment-service` подозрительно мало запросов. `kubectl get pods` — всё Running.
- Success rate клиентов: `kubectl -n production exec deploy/frontend -- wget -qO- http://127.0.0.1:9090/stats`.

## Что не известно

- Что именно изменилось в security group и почему канарейка этого не заметила.
- Почему после устранения причины ошибки могут продолжаться.

## Цель

Клиенты снова получают ответы (success rate ≥ 95 %), из подов `order-service` есть связь до каждого пода `payment-service` по IP, circuit breaker закрыт (нет `EJECTED`), `sg-agent` жив на всех нодах, оба сервиса в полном составе.

## Ограничения

- Удалять `sg-agent` или ConfigMap security group нельзя: это чужой механизм, без него сетевая команда потеряет контроль. Править правила можно (это и есть откат NET‑8802): откатывается сама security group, ручной сброс iptables на нодах откатом не считается.
- Переселять `payment-service` из зоны b нельзя: PCI.

## Доступ

Shell на bastion‑хосте с `kubectl` под пользователем `oncall`, кластер уже в kubeconfig; права cluster-admin. Проверка связности из пода: `kubectl -n production exec <order-pod> -- wget -qO- -T 3 http://<payment-pod-ip>:8080/health`.
