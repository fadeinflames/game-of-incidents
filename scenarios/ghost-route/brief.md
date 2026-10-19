# 🟠 Мобильное приложение получает HTML вместо JSON

**Время:** среда, 11:40. Ты дежурный по платформе.

## Что известно

- Через `ingress-nginx` (namespace `ingress-nginx`, класс `nginx`) наружу смотрят два хоста: `api.shop.local` → `api-service` (JSON, путь `/api`), `shop.local` → `web-frontend` (SPA каталога).
- В 11:20 фронтенд‑команда выкатила «catalog v2» с клиентским роутингом: теперь любой URL каталога должен отдавать `index.html`. Для этого они добавили свой Ingress `catalog-v2`: `web-frontend` сам отдаёт `index.html` только на `/`, остальные пути каталога на `index.html` переписывает этот Ingress.
- С 11:25 мобильное приложение ломается: `GET api.shop.local/api/orders` возвращает `200`, но тело — HTML страницы каталога. Ошибок 5xx нет, поды все Ready.
- Клиенты (мобильные и браузерные) идут через Service контроллера: `kubectl exec deploy/clients -- wget -qO- http://127.0.0.1:9090/stats`. Ручная проверка: `kubectl exec deploy/clients -- wget -qO- --header 'Host: api.shop.local' http://ingress-nginx-controller.ingress-nginx.svc/api/orders`.

## Что не известно

- Какой Ingress отвечает на `api.shop.local` и почему выигрывает не тот.
- Как починить API, не сломав клиентский роутинг каталога.

## Цель

`api.shop.local/api/orders` через ingress снова отдаёт JSON, `shop.local/` и `shop.local/products/42` по‑прежнему отдают HTML каталога, оба потока клиентов с success rate ≥ 95 %, контроллер не тронут.

## Ограничения

- Удалять или перезапускать `ingress-nginx-controller` не нужно и не поможет: он делает ровно то, что написано в Ingress'ах.
- Catalog v2 должен остаться: клиентский роутинг на `shop.local` нужен фронтенду.

## Доступ

Shell на bastion‑хосте с `kubectl` под пользователем `oncall`, кластер уже в kubeconfig. Сгенерированный nginx.conf: `kubectl -n ingress-nginx exec deploy/ingress-nginx-controller -- cat /etc/nginx/nginx.conf`.
