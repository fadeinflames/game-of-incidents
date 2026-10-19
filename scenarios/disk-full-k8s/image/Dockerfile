# Scenario image: the compact mysqld model (+ `mysql` CLI) and blog-app, chosen by the pod's command.
FROM python:3.12-alpine
COPY server.py app.py fill.py /app/
COPY mysql /usr/local/bin/mysql
RUN chmod 755 /usr/local/bin/mysql /app/*.py && mkdir -p /etc/mysql/conf.d /var/lib/mysql && chown 1000:1000 /var/lib/mysql
USER 1000
EXPOSE 3306 8080
CMD ["python3", "/app/server.py"]
