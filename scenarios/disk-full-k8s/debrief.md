# Разбор: Полный диск в кластере

## Что было сломано

Том `/var/lib/mysql` (64 Mi) заполнили бинлоги: MySQL пишет их при каждой записи, а ротация (`binlog_expire_logs_seconds`) на этой инстанции никогда не была настроена. Когда место кончилось, база стала отвечать `Errcode: 28` (ENOSPC) на любую запись и на свою health‑проверку: `mysql-0` выпал из `Ready` и из endpoints headless‑сервиса. `blog-app` без базы отдавал 500, его liveness‑проба это видела и перезапускала контейнер раз за разом, отсюда алерт.

В сандбоксе вместо настоящего mysqld работает компактная модель сервера с тем же поведением на диске (`binlog.*`, `binlog.index`, ENOSPC, `PURGE`, `SET GLOBAL`), а том сделан memory‑backed с `sizeLimit`, потому что PVC в kind не умеет ни лимитов, ни расширения. Команды и ошибки те же, что в MySQL 8. Отличие от прода одно, и оно важное: такой том живёт вместе с подом, а не отдельно от него, как PVC.

## Как это диагностируется

1. `kubectl get pods` — у `blog-app` растёт `RESTARTS`, `mysql-0` `0/1 Running`.
2. `kubectl logs deploy/blog-app` — «Error establishing database connection» и `Can't connect to MySQL server on 'mysql'`: база выпала из `Ready`, и headless‑сервис перестал отдавать её адрес. Приложение — жертва, причина в базе.
3. `kubectl logs mysql-0` — «Disk is full writing './binlog.000042' (Errcode: 28)».
4. `kubectl exec mysql-0 -- df -h /var/lib/mysql` — `100%`; `du -sh /var/lib/mysql/*` — `binlog.*` занимают больше половины.
5. `kubectl exec mysql-0 -- mysql -e "SHOW VARIABLES LIKE 'binlog_expire%'"` — `0`: ротация выключена.

## Эталонное решение

```bash
kubectl exec mysql-0 -- mysql -e "PURGE BINARY LOGS BEFORE NOW() - INTERVAL 1 DAY"
kubectl exec mysql-0 -- mysql -e "SET GLOBAL binlog_expire_logs_seconds = 259200"
kubectl edit configmap mysql-config        # + binlog_expire_logs_seconds = 259200 в [mysqld]
kubectl get pods -w                         # mysql-0 возвращается в Ready за несколько секунд
kubectl rollout restart deploy/blog-app     # если blog-app застрял в CrashLoopBackOff
```

Про последнюю команду. Пока база лежала, liveness‑проба убивала `blog-app` снова и снова, и kubelet с каждым разом увеличивал паузу перед следующим запуском (до 5 минут): это и есть `CrashLoopBackOff`. Починка базы эту паузу не сбрасывает. Можно подождать, можно не ждать: `rollout restart` создаёт новый под без накопленной паузы. Перезапускать базу при этом не нужно: `SET GLOBAL` уже действует, а строка в ConfigMap сработает при следующем плановом рестарте.

Засчитывается и вариант «сначала SET GLOBAL»: с включённой ротацией сервер сам удаляет бинлоги старше порога и место освобождается. В настоящем проде после этого стоит ещё расширить PVC (`kubectl patch pvc … -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'` при `allowVolumeExpansion: true` у StorageClass): 64 Mi с запасом в одну неделю — не размер для базы.

## Ловушки

- `rm /var/lib/mysql/binlog.0000*`. Место освободится, блог оживёт, но `binlog.index` продолжит ссылаться на удалённые файлы: при следующем рестарте MySQL не стартует. Грейдер это ловит.
- Удалить под `mysql-0` или перезапустить StatefulSet «чтобы пересоздался». В настоящем кластере данные StatefulSet лежат на PVC, и удаление пода их не трогает: под вернётся с тем же томом, таким же полным, и ничего не изменится (данные теряют, когда удаляют PVC). В стенде том модельный и живёт вместе с подом: после пересоздания база инициализируется заново, блог «оживает» без данных, и грейдер это видит (критерий `data-preserved`). В обоих случаях это не починка.
- Почистить только место, не настроив ротацию. Через месяц тот же алерт.
- Чинить `blog-app` (rollout restart, менять пробы), пока база без места. Он жертва: новый под упадёт так же. После починки базы `rollout restart` уместен, он просто снимает накопленную паузу.

## Чему учит

- 500 у приложения — повод посмотреть на его зависимости, а не на него.
- `Errcode: 28` / `ENOSPC` в логах базы означает «место», а не «база сломалась»; `df` и `du` внутри пода отвечают за минуту.
- Журналы (бинлоги, WAL, логи приложений) без ротации всегда заполняют диск, вопрос только когда. Ротация — часть установки базы, а не оптимизация.
- Файлы, о которых знает сервер, удаляют через сервер.
- Liveness‑проба, которая зависит от базы, — антипаттерн: при сбое зависимости kubelet убивает здоровый процесс, а после восстановления сервис ещё минуты сидит в `CrashLoopBackOff`. Liveness проверяет только сам процесс; зависимости — дело readiness.

## Почитать

- [MySQL: PURGE BINARY LOGS](https://dev.mysql.com/doc/refman/8.0/en/purge-binary-logs.html)
- [MySQL: The Binary Log](https://dev.mysql.com/doc/refman/8.0/en/binary-log.html)
- [Kubernetes: Expanding Persistent Volumes Claims](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#expanding-persistent-volumes-claims)
- [Kubernetes: emptyDir memory medium and sizeLimit](https://kubernetes.io/docs/concepts/storage/volumes/#emptydir)
