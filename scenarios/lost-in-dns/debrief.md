# Разбор: Потерянные в DNS

## Что было сломано

NetworkPolicy `kube-system/coredns-hardening` объявила `policyTypes: [Ingress, Egress]`, описала ingress (53/udp, 53/tcp откуда угодно) и не описала egress вовсе. В NetworkPolicy «Egress в policyTypes и пустой список egress» означает «запретить весь исходящий трафик». CoreDNS перестал доходить до корпоративного DNS: форвард `corp.internal` → `10.96.0.53` заканчивался `i/o timeout`, клиенты получали SERVFAIL. Имена кластера при этом работали: плагин `kubernetes` отвечает из локального кэша объектов, ему исходящее соединение на каждый запрос не нужно (хотя его watch к API‑серверу политика тоже сломала, и через время он бы отвалился). В staging все партнёрские имена были замоканы внутри кластера, поэтому тест «прошёл».

## Как это диагностируется

1. `kubectl -n shop logs deploy/external-api-proxy --tail=10` — `lookup payments-gateway.corp.internal: [Errno -3] Temporary failure in name resolution`, а рядом успешные резолвы `backend-api.shop.svc.cluster.local`.
2. `kubectl -n kube-system logs deploy/coredns --tail=30` — `[ERROR] plugin/errors: 2 payments-gateway.corp.internal. A: read udp …->10.96.0.53:53: i/o timeout`.
3. Сравнение: из обычного пода запрос напрямую к корпоративному DNS проходит: `kubectl -n shop exec deploy/external-api-proxy -- nslookup payments-gateway.corp.internal. 10.96.0.53` возвращает `10.10.0.5`. Из пода CoreDNS тот же запрос заканчивается таймаутом: в образе CoreDNS нет ни shell, ни `nslookup`, поэтому подключают временный контейнер с нужными утилитами в тот же под (`kubectl -n kube-system debug <под coredns> -it --image=wom-scenario/lost-in-dns:dev --target=coredns -- nslookup payments-gateway.corp.internal. 10.96.0.53`); он делит с CoreDNS сетевой неймспейс, поэтому политика действует на него так же. Проблема специфична для подов CoreDNS. Проверять UDP через `nc -zu` бессмысленно: без ответа он «успешен» даже при полном запрете.
4. `kubectl -n kube-system get networkpolicy` → `coredns-hardening`; `kubectl -n kube-system describe networkpolicy coredns-hardening` — `Allowing egress traffic: <none> (Selected pods are isolated for egress connectivity)`.

## Эталонное решение

```bash
kubectl -n kube-system edit networkpolicy coredns-hardening
```

Добавить блок `egress`: 53/udp и 53/tcp куда угодно (upstream DNS), 443/tcp и 6443/tcp (API‑сервер для плагина `kubernetes`). Ingress оставить как был. Через несколько секунд CoreDNS снова форвардит, кэш обновляется, приложение резолвит.

## Ловушки

- `kubectl delete networkpolicy coredns-hardening`. Резолв оживёт, грейдер откажет: требование «CoreDNS ограничен политикой» никуда не делось, а в понедельник политику вернут в том же виде.
- Перезапустить CoreDNS. Политика применяется к новым подам точно так же.
- Править Corefile или `corp-dns`. Они не менялись.
- Поднять `cache` до часа. Скроет симптом до следующего истечения.

## Чему учит

- `policyTypes` определяет, что политика ограничивает; пустой список правил в объявленном типе — это «запретить всё», а не «не трогать». Самая частая ошибка в NetworkPolicy.
- Паттерн «страдают только имена X» → смотри на путь этих имён: stub‑зона, форвард, upstream. Логи CoreDNS говорят прямо.
- «Тесты в staging прошли» для сетевых политик означает лишь, что staging похож на прод настолько, насколько похож. Внешние зависимости в staging часто замоканы.
- Проверка политики из пода CoreDNS (временный контейнер через `kubectl debug` и запрос к upstream) занимает секунды и заменяет часы гаданий.
- SERVFAIL и NXDOMAIN — разные ошибки. NXDOMAIN («Name or service not known»): upstream ответил, что записи нет. SERVFAIL («Temporary failure in name resolution»): путь до upstream сломан, как здесь. NXDOMAIN говорит о данных, SERVFAIL о сети и доступности upstream.

## Почитать

- [Kubernetes: Network Policies — policyTypes, default deny](https://kubernetes.io/docs/concepts/services-networking/network-policies/#default-policies)
- [CoreDNS: forward plugin](https://coredns.io/plugins/forward/)
- [Kubernetes: Debugging DNS Resolution](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
