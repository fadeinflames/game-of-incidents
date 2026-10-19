# Scenario image: every in-house service of "Phantom network" (Python stand-ins with the original names/behaviour).
# Which program runs is chosen by the Deployment's `args`.
FROM python:3.12-alpine
RUN pip install --no-cache-dir pg8000==1.31.2
COPY order_service.py payment_proxy.py acquirer.py loadgen.py /app/
USER 1000
CMD ["python3", "/app/order_service.py"]
