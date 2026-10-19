# Разбор: Призрачный маршрут

## Что было сломано

Ingress `catalog-v2` включил `nginx.ingress.kubernetes.io/use-regex: "true"` и `rewrite-target: /index.html` с путём `/(.*)` и объявил это правило для двух хостов: `shop.local` и `api.shop.local` («чтобы приложение работало и там»). В ingress-nginx `use-regex` действует на весь хост, а не на один Ingress: все пути этого хоста, в том числе чужой `/api` из Ingress `api`, становятся regex‑location (`~*`), и контроллер выстраивает их по длине пути, длинные раньше (Path Priority). `/(.*)` длиннее `/api`, поэтому стоит в `nginx.conf` первым и забирает любой запрос к `api.shop.local`. Запрос переписывается на `/index.html` и уходит в `web-frontend`, который отдаёт HTML с кодом 200. Ни одной 5xx, все поды Ready, алерты по ошибкам молчат: «призрачный» маршрут.

## Как это диагностируется

1. Воспроизвести: `wget --header 'Host: api.shop.local' …/api/orders` → `Content-Type: text/html`.
2. `kubectl get ingress` — три Ingress'а; у `catalog-v2` в `HOSTS` оба хоста.
3. `kubectl describe ingress catalog-v2` — аннотация `use-regex`, путь `/(.*)`, хост `api.shop.local`.
4. `kubectl -n ingress-nginx exec deploy/ingress-nginx-controller -- cat /etc/nginx/nginx.conf | grep -n -E 'server_name|location'` — в блоке `api.shop.local` `location ~* "^/(.*)"` стоит выше `location ~* "^/api"`.
5. `kubectl get ingress -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp` — `catalog-v2` самый свежий из Ingress'ов: поломка началась с него.

## Эталонное решение

```bash
kubectl patch ingress catalog-v2 --type=json -p='[{"op":"remove","path":"/spec/rules/1"}]'   # убрать хост api.shop.local
kubectl get ingress catalog-v2                                                             # HOSTS: shop.local
```

Засчитывается и вариант «удалить `catalog-v2` и перенести SPA‑роутинг в Ingress `web`» (`use-regex`, путь `/(.*)`, `rewrite-target: /index.html`), если `shop.local/products/42` продолжает отдавать HTML. Просто удалить `catalog-v2` нельзя: `web-frontend` отдаёт `index.html` только на `/`, клиентский роутинг каталога сломается, а грейдер проверяет `/products/42`.

## Ловушки

- Перезапустить контроллер. Конфиг сгенерируется тем же.
- Удалить `catalog-v2`. API оживёт, каталог на `/products/42` начнёт отдавать 404.
- Переименовать путь API в `/api/(.*)` с regex. Заработает, но только потому, что этот путь длиннее чужого `/(.*)`; следующий Ingress с ещё более длинным regex снова всё сломает.
- Чинить `api-service`: он не получает трафика вовсе.

## Чему учит

- `200 OK` с неправильным телом — тоже отказ. Проверяй `Content-Type` и содержимое, а не только код; алерты на «HTML там, где ждём JSON» дешёвы.
- В ingress-nginx `use-regex` включает regex‑location для всех путей хоста, а их порядок определяет длина пути. Regex `/(.*)` перекрывает всё, что короче, то есть весь хост.
- Один хост должен принадлежать одной команде; Ingress с чужим хостом должен блокироваться на ревью или admission‑политикой.
- Сгенерированный `nginx.conf` — источник правды о том, куда реально уходит запрос.

## Почитать

- [ingress-nginx: Regular expressions in paths и приоритет location'ов](https://kubernetes.github.io/ingress-nginx/user-guide/ingress-path-matching/)
- [nginx: location — порядок сопоставления](https://nginx.org/ru/docs/http/ngx_http_core_module.html#location)
- [Kubernetes: Ingress — pathType и конфликты правил](https://kubernetes.io/docs/concepts/services-networking/ingress/#path-types)
