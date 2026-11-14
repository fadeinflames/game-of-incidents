# Scenario image: the notification pipeline (dispatcher, recorder, history-api) in two releases, plus the stand-ins
# around it (emitter: the product that publishes events; customers: the customers' servers).
# A real pipeline ships one image per release; the stand has one image, so a release is a directory:
# /opt/pipeline/releases/<release>/. The Deployment picks the release with the path in `command`.
FROM python:3.12-alpine
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN pip install --no-cache-dir redis==5.0.8 pg8000==1.31.2 \
 && apk add --no-cache curl
COPY pipeline/README.md pipeline/CHANGELOG.md /opt/pipeline/
COPY pipeline/src/ /opt/pipeline/releases/1.8.3/
COPY pipeline/src/ /opt/pipeline/releases/2.0.0/
COPY pipeline/formats/1.8.3/recordfmt.py /opt/pipeline/releases/1.8.3/recordfmt.py
COPY pipeline/formats/2.0.0/recordfmt.py /opt/pipeline/releases/2.0.0/recordfmt.py
COPY stand/ /opt/stand/
USER 1000
CMD ["python3", "/opt/stand/customers.py"]
