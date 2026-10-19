# Scenario image: database + backup-store models and the backup job (python + kubectl for the in-cluster API).
FROM python:3.12-alpine
# kubectl stays within one minor of the cluster (kind node v1.37), same version in every image; the sha256 is read from the release server and checked
ARG KUBECTL_VERSION=v1.37.1
RUN apk add --no-cache curl ca-certificates \
 && arch="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" \
 && url="https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
 && curl -fsSL -o /usr/local/bin/kubectl "$url" \
 && sum="$(curl -fsSL "$url.sha256")" \
 && printf '%s' "$sum" | grep -Eqx '[0-9a-f]{64}' \
 && printf '%s  %s\n' "$sum" /usr/local/bin/kubectl | sha256sum -c - \
 && chmod 0755 /usr/local/bin/kubectl \
 && apk del curl
COPY services.py backup.sh /app/
RUN chmod 755 /app/backup.sh
USER 1000
EXPOSE 5432 8080
CMD ["python3", "/app/services.py"]
