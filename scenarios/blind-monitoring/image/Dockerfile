# Scenario image: metrics-gateway (TLS remote_write receiver), the checkout app, the ca-publisher job (kubectl), and two
# CAs with server certificates generated at build time: CA #1 (trusted by every cluster today) and CA #2 (this year's rotation).
# The CA private keys are dropped after signing; the server key is readable only by uid 1000 (the gateway).
FROM python:3.12-alpine
# kubectl stays within one minor of the cluster (kind node v1.37), same version in every image; the sha256 is read from the release server and checked
ARG KUBECTL_VERSION=v1.37.1
RUN apk add --no-cache openssl curl ca-certificates \
 && arch="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" \
 && url="https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
 && curl -fsSL -o /usr/local/bin/kubectl "$url" \
 && sum="$(curl -fsSL "$url.sha256")" \
 && printf '%s' "$sum" | grep -Eqx '[0-9a-f]{64}' \
 && printf '%s  %s\n' "$sum" /usr/local/bin/kubectl | sha256sum -c - \
 && chmod 0755 /usr/local/bin/kubectl \
 && for n in 1 2; do \
      mkdir -p /certs/ca$n \
      && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Observability Root CA $n/O=platform" \
           -keyout /certs/ca$n/ca.key -out /certs/ca$n/ca.crt 2>/dev/null \
      && openssl req -newkey rsa:2048 -nodes -subj "/CN=metrics-gateway.monitoring.svc" \
           -keyout /certs/ca$n/server.key -out /certs/ca$n/server.csr 2>/dev/null \
      && printf "subjectAltName=DNS:metrics-gateway.monitoring.svc,DNS:metrics-gateway.monitoring.svc.cluster.local,DNS:metrics-gateway\n" > /certs/ca$n/ext.cnf \
      && openssl x509 -req -in /certs/ca$n/server.csr -CA /certs/ca$n/ca.crt -CAkey /certs/ca$n/ca.key -CAcreateserial \
           -days 825 -extfile /certs/ca$n/ext.cnf -out /certs/ca$n/server.crt 2>/dev/null \
      && rm -f /certs/ca$n/ca.key \
      && chown 1000:1000 /certs/ca$n/server.key && chmod 600 /certs/ca$n/server.key \
      && chmod 644 /certs/ca$n/*.crt; \
    done \
 && apk del openssl curl
COPY gateway.py app.py publish-ca.sh /app/
RUN chmod 755 /app/publish-ca.sh
USER 1000
EXPOSE 8080 9090 9443
CMD ["python3", "/app/app.py"]
