# Scenario app image: tiny HTTP service whose health endpoint path is configured by env (HEALTH_PATH).
# The same image plays "2.3.9" (/health) and "2.4.0" (/healthz) via APP_VERSION / HEALTH_PATH in the Deployment.
FROM python:3.12-alpine
COPY app.py /app/app.py
USER 1000
EXPOSE 8080
CMD ["python3", "/app/app.py"]
