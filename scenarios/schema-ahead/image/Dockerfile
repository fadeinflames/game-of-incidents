# Scenario image: billing-api (v1 and v2 by env), the customer load generator; pg8000 is a pure-python driver.
FROM python:3.12-alpine
RUN pip install --no-cache-dir pg8000==1.31.2
COPY app.py loadgen.py /app/
USER 1000
EXPOSE 8080 9090
CMD ["python3", "/app/app.py"]
