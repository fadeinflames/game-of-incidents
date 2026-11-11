#!/usr/bin/env python3
"""Build-time: the forum database with a few dozen ordinary questions."""
import sqlite3
import sys
import time

TOPICS = [
    ("Как правильно закрывать соединения с базой в пуле?", "Пул отдаёт соединения, но часть из них остаётся в состоянии idle in transaction.\n    conn = pool.get()\n    conn.execute(query)\nЧто я упускаю?"),
    ("Почему cron запускает скрипт дважды?", "В crontab одна строка, а в логе два запуска каждую минуту.\n    * * * * * /usr/local/bin/report.sh   \nПроверил: файл один."),
    ("nginx отдаёт 499 на долгих запросах", "Клиент ждёт 60 секунд и уходит. Бэкенд отвечает за 75.\n    proxy_read_timeout 90s;\nКакой таймаут срабатывает первым?"),
    ("Чем отличается SIGTERM от SIGKILL для контейнера?", "Под завершается 30 секунд, хотя приложение обрабатывает сигнал.\n    trap 'exit 0' TERM\nПочему ждём весь grace period?"),
    ("Не сходится контрольная сумма после rsync", "Копирую 40 ГБ, размеры равны, md5 разный.\n    rsync -a src/ dst/\nНужен ли ключ --checksum?"),
    ("Как читать вывод iostat?", "Смотрю на %util и await, но не понимаю, когда диск реально упирается.\n    iostat -x 1\nНа что смотреть в первую очередь?"),
    ("Логи пишутся с задержкой в несколько минут", "Приложение пишет в stdout, в агрегаторе строки появляются пачками.\n    print(msg)\nЭто буферизация?"),
    ("PostgreSQL: запрос перестал использовать индекс", "После загрузки данных план сменился на Seq Scan.\n    EXPLAIN ANALYZE SELECT ...\nПомог только ANALYZE. Почему?"),
]
AUTHORS = ["ops_anna", "devops_petr", "sre_ivan", "backend_olga", "junior_max", "dba_sergey"]


def main(path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, created_at INTEGER NOT NULL)")
    now = int(time.time())
    for i in range(40):
        title, body = TOPICS[i % len(TOPICS)]
        suffix = "" if i < len(TOPICS) else f" (часть {i // len(TOPICS) + 1})"
        conn.execute(
            "INSERT INTO questions (title, body, author, created_at) VALUES (?, ?, ?, ?)",
            (title + suffix, body, AUTHORS[i % len(AUTHORS)], now - (40 - i) * 600),
        )
    conn.commit()
    conn.close()


if __name__ == "__main__":
    main(sys.argv[1])
