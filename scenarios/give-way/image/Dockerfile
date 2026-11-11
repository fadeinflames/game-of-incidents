# Scenario image: stand-ins for a hosted metrics service (ingester, gateway, customers' agents, alerting; role by env ROLE).
FROM python:3.12-alpine
COPY app.py /app/app.py
USER 1000
EXPOSE 8080 9095
CMD ["python3", "-u", "/app/app.py"]
