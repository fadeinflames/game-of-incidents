# Scenario app image: one tiny HTTP service that plays storefront, invoicer and status-page (by APP_NAME).
FROM python:3.12-alpine
COPY app.py /app/app.py
USER 1000
EXPOSE 8080
CMD ["python3", "/app/app.py"]
