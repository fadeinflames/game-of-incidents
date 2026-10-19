# Scenario image: api-service / web-frontend (by ROLE) and the clients load generator.
FROM python:3.12-alpine
COPY app.py loadgen.py /app/
USER 1000
EXPOSE 8080 9090
CMD ["python3", "/app/app.py"]
