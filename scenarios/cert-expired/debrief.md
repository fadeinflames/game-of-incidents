# Разбор: Сертификат исчез

## Что было сломано

Тикет SEC‑2210 «HTTPS only» убрал порт 80 из `Service ingress-nginx-controller`. HTTPS продолжал работать, никто ничего не заметил. Но ACME HTTP-01 по определению ходит на порт 80: cert-manager поднимает solver, публикует `/.well-known/acme-challenge/<token>` через Ingress и сначала сам проверяет, что путь доступен (self‑check), потом просит ACME‑сервер проверить. Self‑check упирался в `connection refused`, и до проверки со стороны ACME‑сервера дело не доходило. Два месяца продление тихо падало, за ночь сертификат истёк, ingress-nginx переключился на fake certificate. Self‑check здесь ещё и защита: пока он не прошёл, cert-manager не просит CA проверять challenge и не тратит лимит неудачных валидаций, который у настоящего Let's Encrypt равен 5 в час на имя хоста. Когда падает уже проверка на стороне CA, повторные попытки начинают отбиваться ещё и по этому лимиту; поэтому выпуск отлаживают на staging‑issuer.

## Как это диагностируется

1. `kubectl -n production describe certificate shop-tls` — `Ready: False`, `Issuing`, ссылка на Order.
2. `kubectl -n production get orders,challenges` — Challenge в `pending`; `describe challenge` — `Waiting for HTTP-01 challenge propagation: failed to perform self check GET request 'http://shop…/.well-known/acme-challenge/…': dial tcp …:80: connect: connection refused`.
3. `kubectl -n ingress-nginx get svc ingress-nginx-controller` — только `443/TCP`; аннотация `change-cause: SEC-2210: HTTPS only, drop plain HTTP`.
4. `kubectl -n cert-manager logs deploy/cert-manager --tail=50` — те же ошибки self‑check, по кругу.

## Эталонное решение

```bash
kubectl -n ingress-nginx patch svc ingress-nginx-controller --type=json \
  -p='[{"op":"add","path":"/spec/ports/-","value":{"name":"http","port":80,"targetPort":"http","protocol":"TCP"}}]'
kubectl -n production get certificate shop-tls -w      # через ~30 с Ready: True
```

HTTPS-only не противоречит открытому порту 80: ingress-nginx сам отвечает редиректом на HTTPS для обычных путей и пропускает `/.well-known/acme-challenge/`. Альтернатива на будущее — DNS-01 (не требует порта 80 вовсе), но у нашего DNS нет API, а в 09:15 с CEO на проводе это не время.

## Ловушки

- Создать самоподписанный Issuer и перевыпустить через него: ошибка в браузере останется, грейдер откажет (issuerRef должен остаться `letsencrypt-prod`).
- Удалить и пересоздать Certificate/Order: тот же challenge, тот же `connection refused`.
- Перезапустить cert-manager или ingress-nginx: они делают ровно то, что описано.
- Выставить порт 80 только на время выпуска и снова убрать: через 60 дней всё повторится.

## Чему учит

- HTTP-01 требует порт 80 у точки входа. «HTTPS only» реализуется редиректом, а не удалением порта.
- Алерт на `Certificate Ready=False` дольше часа и на «до истечения меньше 14 дней» превращает этот инцидент в тикет.
- У внешних CA есть лимиты; retry‑цикл cert-manager без внимания человека может их исчерпать. Runbook: staging‑issuer для отладки, DNS-01 как запасной путь.
- Изменение «безопасности» точки входа должно проходить через владельцев всего, что этой точкой пользуется.

## Почитать

- [cert-manager: HTTP01 challenge и self-check](https://cert-manager.io/docs/configuration/acme/http01/)
- [cert-manager: Troubleshooting ACME issuance](https://cert-manager.io/docs/troubleshooting/acme/)
- [Let's Encrypt: Rate limits](https://letsencrypt.org/docs/rate-limits/)
- [Pebble: ACME test server](https://github.com/letsencrypt/pebble)
