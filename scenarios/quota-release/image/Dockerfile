# Scenario app image: tiny HTTP service (report-api / cache) and an idle worker, selected by the Deployment's command.
FROM python:3.12-alpine
COPY app.py /app/app.py
USER 1000
EXPOSE 8080
CMD ["python3", "/app/app.py"]
