# Scenario image: order-service / payment-service / loadgen (python) and the sg-agent (sh + iptables + kubectl).
FROM python:3.12-alpine
# kubectl stays within one minor of the cluster (kind node v1.37), same version in every image; the sha256 is read from the release server and checked
ARG KUBECTL_VERSION=v1.37.1
RUN apk add --no-cache curl ca-certificates iptables \
 && arch="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" \
 && url="https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
 && curl -fsSL -o /usr/local/bin/kubectl "$url" \
 && sum="$(curl -fsSL "$url.sha256")" \
 && printf '%s' "$sum" | grep -Eqx '[0-9a-f]{64}' \
 && printf '%s  %s\n' "$sum" /usr/local/bin/kubectl | sha256sum -c - \
 && chmod 0755 /usr/local/bin/kubectl \
 && apk del curl
COPY order_service.py payment_service.py loadgen.py sg-agent.sh /app/
RUN chmod 755 /app/sg-agent.sh
EXPOSE 8080 9090
CMD ["python3", "/app/order_service.py"]
