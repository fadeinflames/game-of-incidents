# Scenario app image: tiny HTTP service that refuses to start without DATABASE_PASSWORD and reports its API_TIMEOUT.
FROM python:3.12-alpine
COPY app.py /app/app.py
USER 1000
EXPOSE 8080
CMD ["python3", "/app/app.py"]
