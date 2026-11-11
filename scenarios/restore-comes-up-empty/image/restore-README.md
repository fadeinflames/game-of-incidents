# Временный экземпляр из бэкапа

Нужен, когда надо заглянуть в данные из бэкапа: проверить архив или достать потерянные строки.
Разворачивается здесь же, на db-01, в каталоге /srv/restore. Порт 5434, только 127.0.0.1, вход без пароля.
Настройки экземпляра: /srv/restore/restore.conf.

1. Распаковать последний архив из /srv/backup:

       sudo -u postgres mkdir /srv/restore/pgdata
       sudo -u postgres tar -xzf /srv/backup/shop-base-<метка>.tar.gz -C /srv/restore/pgdata
       sudo -u postgres chmod 700 /srv/restore/pgdata

2. Запустить:

       sudo -u postgres /usr/lib/postgresql/15/bin/pg_ctl -D /srv/restore/pgdata \
           -o "-c config_file=/srv/restore/restore.conf" -l /srv/restore/restore.log start

3. Подключиться и работать:

       psql -h 127.0.0.1 -p 5434 -U postgres shop

4. После работ остановить и удалить:

       sudo -u postgres /usr/lib/postgresql/15/bin/pg_ctl -D /srv/restore/pgdata stop
       sudo rm -rf /srv/restore/pgdata
