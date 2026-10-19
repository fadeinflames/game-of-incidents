# egress-guard: iptables rules in the sandbox daemon's network namespace (threat model R-7). See guard.sh.
FROM alpine:3.22
RUN apk add --no-cache iptables util-linux
COPY guard.sh /guard.sh
RUN chmod 755 /guard.sh
ENTRYPOINT ["/bin/sh", "/guard.sh"]
