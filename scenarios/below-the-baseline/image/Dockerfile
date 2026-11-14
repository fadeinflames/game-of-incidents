# Scenario image: the job queue, the clients, the dispatchers and the capacity controller in one file (see app.py),
# the role is picked by ROLE. `stats` inside a pod prints the stats of that service.
FROM python:3.12-alpine
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY app.py /app/app.py
RUN printf '#!/bin/sh\nexec python3 /app/app.py stats\n' > /usr/local/bin/stats \
 && chmod 0755 /usr/local/bin/stats
USER 1000
EXPOSE 8080 9090
CMD ["python3", "/app/app.py"]
