# Как подступиться

«Приложение отдаёт 500» почти никогда не означает «сломано приложение». Иди по цепочке зависимостей: **кто перезапускается → что пишет в логах → от кого зависит → что кончилось у зависимости**.

## Посмотри, кто на самом деле болеет

```bash
kubectl get pods
```

`blog-app` с растущим `RESTARTS`: liveness‑проба его убивает. `mysql-0` со статусом `Running`, но `0/1`: readiness‑проба не проходит, значит, база жива как процесс, но не считает себя здоровой. Восклицательный знак ставь на базу.

## Прочитай логи обоих

```bash
kubectl logs deploy/blog-app --tail=20
kubectl logs mysql-0 --tail=20
```

У приложения «Error establishing database connection» и `Can't connect to MySQL server on 'mysql'`: оно не может даже найти базу, потому что `mysql-0` выпал из `Ready` и headless‑сервис перестал отдавать его адрес. У базы `Disk is full writing './binlog.000xxx' (Errcode: 28)`. Код ошибки 28 — это `ENOSPC`, «No space left on device». Логи уже сказали, что кончилось; осталось понять, что съело место.

## Найди, что занимает том

```bash
kubectl exec mysql-0 -- df -h /var/lib/mysql
kubectl exec mysql-0 -- du -sh /var/lib/mysql/*
kubectl exec mysql-0 -- sh -c 'du -ch /var/lib/mysql/binlog.* | tail -1'
```

`df` покажет `100%`. `du` по каталогам покажет, что данные (`mysql/`, `wordpress/`) занимают меньше трети, а остальное — файлы `binlog.*`. Это журнал изменений, который MySQL пишет для репликации и восстановления; без настроенной ротации он растёт вечно.

## Освободи место так, чтобы база об этом знала

```bash
kubectl exec mysql-0 -- mysql -e "SHOW BINARY LOGS"
kubectl exec mysql-0 -- mysql -e "PURGE BINARY LOGS BEFORE NOW() - INTERVAL 1 DAY"
kubectl exec mysql-0 -- df -h /var/lib/mysql
```

`PURGE BINARY LOGS` удаляет файлы и вычёркивает их из `binlog.index`. Если удалить их `rm`, индекс будет ссылаться на несуществующие файлы, и следующий рестарт MySQL закончится ошибкой. Через несколько секунд после освобождения места база снова пройдёт readiness. Сам под `mysql-0` при этом не трогай: в стенде его том не переживёт пересоздание.

## Дождись приложения или подтолкни его

```bash
kubectl get pods
kubectl rollout restart deploy/blog-app
```

`blog-app` поднимется вслед за базой, но не обязательно сразу. Пока база лежала, liveness‑проба убивала его раз за разом, и kubelet с каждым падением увеличивал паузу перед следующим запуском: это статус `CrashLoopBackOff`, пауза доходит до 5 минут. Починка базы её не сбрасывает. Если под уже `1/1 Running`, ничего делать не надо. Если он висит в `CrashLoopBackOff`, можно подождать, а можно выполнить вторую команду: `rollout restart` создаст новый под, у которого накопленной паузы нет. Это не лечение приложения, а способ не сидеть перед таймером.

## Сделай так, чтобы это не повторилось

```bash
kubectl exec mysql-0 -- mysql -e "SET GLOBAL binlog_expire_logs_seconds = 259200"
kubectl edit configmap mysql-config
```

`SET GLOBAL` включает ротацию сразу, но живёт до рестарта. Постоянная настройка — строка `binlog_expire_logs_seconds = 259200` (3 дня) в секции `[mysqld]` конфига из ConfigMap. Перезапускать базу ради неё не нужно: значение уже действует, а файл прочитается при следующем плановом рестарте. Проверь `kubectl get pods`: оба пода `Ready`, `RESTARTS` у `blog-app` больше не растёт. Потом жми «Проверить».
