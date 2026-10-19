# Scenario image: external-api-proxy and the plain shop services (by ROLE).
FROM python:3.12-alpine
COPY app.py /app/app.py
USER 1000
EXPOSE 8080 9090
CMD ["python3", "/app/app.py"]
