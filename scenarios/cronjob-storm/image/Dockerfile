# Scenario image: the api service (python HTTP) and the export job (a CPU-bound shell loop), chosen by the pod's command.
FROM python:3.12-alpine
COPY app.py /app/app.py
COPY export.sh /app/export.sh
USER 1000
EXPOSE 8080
CMD ["python3", "/app/app.py"]
