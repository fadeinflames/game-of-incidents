# Scenario image: every service of the stand in one file, the role is picked by ROLE (see app.py).
# Debian on purpose: the services resolve names with the glibc resolver, like most production runtimes do.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 bind9-dnsutils curl procps less \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -r -u 1000 -s /usr/sbin/nologin app
COPY app.py /app/app.py
RUN rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/dpkg /usr/bin/pip /usr/bin/pip3 \
 && rm -rf /etc/apt /var/lib/apt /var/lib/dpkg
USER 1000
EXPOSE 8080 9090 5353/udp
CMD ["python3", "/app/app.py"]
