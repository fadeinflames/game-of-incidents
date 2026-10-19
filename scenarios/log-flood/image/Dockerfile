# Scenario image: recommendation-api, its log-shipper sidecar and the customer load generator (by command).
FROM python:3.12-alpine
COPY app.py shipper.py loadgen.py /app/
USER 1000
EXPOSE 8080 9090 9102
CMD ["python3", "/app/app.py"]
