# Разбор: Полный диск

## Что было сломано

Раздел `/var/lib/postgresql` заполнился на 100 %: ночной `pg_dump` из `/etc/cron.d/pgdump` складывал дампы в `/var/lib/postgresql/backups/` и никогда их не удалял, хотя лог `/var/log/pgdump.log` подтверждает, что каждый дамп уже загружен в S3. Пока база работала, ей хватало уже выделенных страниц; при рестарте PostgreSQL не смог записать служебные файлы (например, `postmaster.pid`): `No space left on device` в `/var/log/postgresql/postgresql-15-main.log`. Приложение получало `connection refused` и отвечало `500`.

## Как это диагностируется

1. `sudo tail -n 30 /var/log/postgresql/postgresql-15-main.log` — `FATAL` с `No space left on device`.
2. `df -h /var/lib/postgresql` — `100%`.
3. `sudo du -sh /var/lib/postgresql/*` — виновник `backups/`: десятки файлов `*.dump`, по одному на каждую ночь; именно они забили раздел, а сам кластер `15/` занимает лишь остальное.
4. `cat /var/log/pgdump.log` и `cat /etc/cron.d/pgdump` — дампы уже в S3, ретеншена нет. Заодно `/var/log/config-sync.log` показывает, что ночной рестарт PostgreSQL не удался.

## Эталонное решение

```bash
sudo rm -f /var/lib/postgresql/backups/*.dump     # они уже в S3 (см. /var/log/pgdump.log)
sudo service postgresql start
sudo service app start
curl -s -X POST http://127.0.0.1:8080/order        # 201
df -h /var/lib/postgresql
```

Хороший тон (не проверяется грейдером, но проверяется жизнью): добавить ретеншен в `/etc/cron.d/pgdump`, например `find /var/lib/postgresql/backups -name '*.dump' -mtime +2 -delete`, и алерт на свободное место.

## Ловушки

- **Пересоздать кластер** (`pg_dropcluster` и `pg_createcluster`, `initdb`, `rm -rf` каталога данных). Место освободится, PostgreSQL запустится и API вернёт `201`, но заказы пропадут. Это та самая потеря данных, которую запрещает бриф; грейдер проверяет, что прежние заказы на месте (критерий `data-intact`), и такую «починку» не засчитывает.
- **Освобождать место за счёт файлов самой базы** (`pg_wal`, `base/`) вместо ненужных дампов. Кластер ломается: база либо не запустится, либо потеряет заказы, и грейдер это не пропустит.

## Чему учит

- «Диск полный» ломает не в момент заполнения, а при следующей операции, которой нужен новый блок: рестарт, checkpoint, создание файла. Поэтому база «внезапно» падает ночью.
- Локальные копии того, что уже лежит в S3, — расход места без пользы; у каждого дампа должен быть ретеншен.
- Сначала освободить место и поднять сервис, потом чинить причину. Но причину чинить обязательно.

## Почитать

- [PostgreSQL: «Disk Full Failure»](https://www.postgresql.org/docs/current/disk-full.html)
- `man 1 df`, `man 1 du`, `man 1 find` (`-mtime`, `-delete`)
