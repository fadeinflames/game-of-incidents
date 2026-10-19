# wom-tools: the on-call engineer's terminal for kubernetes scenarios (ADR-0008) and the runner for their scripts.
# kubectl + the usual shell tools; user `oncall` with sudo (sudo affects this container only, never the cluster nodes).
FROM alpine:3.22
# kubectl stays within one minor of the cluster (kind node v1.37); the sha256 is read from the release server and checked
ARG KUBECTL_VERSION=v1.37.1
RUN apk add --no-cache bash bash-completion curl jq less vim nano sudo coreutils procps iproute2 bind-tools ca-certificates \
 && arch="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" \
 && url="https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
 && curl -fsSL -o /usr/local/bin/kubectl "$url" \
 && sum="$(curl -fsSL "$url.sha256")" \
 && printf '%s' "$sum" | grep -Eqx '[0-9a-f]{64}' \
 && printf '%s  %s\n' "$sum" /usr/local/bin/kubectl | sha256sum -c - \
 && chmod 0755 /usr/local/bin/kubectl \
 && adduser -D -s /bin/bash -u 1000 oncall \
 && echo 'oncall ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oncall && chmod 0440 /etc/sudoers.d/oncall \
 && echo 'source /usr/share/bash-completion/bash_completion 2>/dev/null; source <(kubectl completion bash) 2>/dev/null; alias k=kubectl; complete -o default -F __start_kubectl k' >> /home/oncall/.bashrc \
 && rm -f /sbin/apk /usr/bin/pip /usr/bin/pip3 && rm -rf /etc/apk /var/cache/apk /lib/apk
CMD ["sleep", "infinity"]
