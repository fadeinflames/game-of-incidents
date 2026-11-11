#!/bin/sh
# SECRET. The mesh was removed from the stage cluster, its sidecar injector webhook was not: failurePolicy Fail,
# backend Service without the webhook port. Nothing noticed while the old pods were running. Then the planned node
# maintenance (drain, uncordon) evicts every pod, and the ReplicaSets of the namespaces the webhook selects cannot
# create a single replacement.
# Worst-case budget (the brief asks for under 150 s): 45 s stand + 45 s drain + 45 s for the breakage to show.
set -u

ready() { [ "$(kubectl -n "$1" get deploy "$2" -o jsonpath='{.status.readyReplicas}' 2>/dev/null)" = "$3" ]; }

deadline=$(( $(date +%s) + 45 ))
until ready shop storefront 3 && ready billing invoicer 2 && ready tools status-page 1; do
  [ "$(date +%s)" -ge "$deadline" ] && { echo "break: FAILED, the applications did not become Ready in 45 s" >&2; exit 1; }
  sleep 2
done

# the leftover: two entries, as the real injector has (by namespace label, and by pod label in unlabelled namespaces)
kubectl create -f - >/dev/null <<'EOF' || { echo "break: FAILED, could not create the webhook configuration" >&2; exit 1; }
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: istio-sidecar-injector
  labels:
    app: sidecar-injector
    istio.io/rev: default
    operator.istio.io/component: Pilot
    release: istio
webhooks:
  - name: namespace.sidecar-injector.istio.io
    admissionReviewVersions: [v1beta1, v1]
    clientConfig:
      service: { name: istiod, namespace: istio-system, path: /inject, port: 443 }
      caBundle: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJoVENDQVN1Z0F3SUJBZ0lVUkZoOHY4UVVoUk5ud3RDN0dXZ2JVa2dPQzFJd0NnWUlLb1pJemowRUF3SXcKR0RFV01CUUdBMVVFQ2d3TlkyeDFjM1JsY2k1c2IyTmhiREFlRncweU5qRXhNVEF3TnpVMU5UZGFGdzB6TmpFeApNRGN3TnpVMU5UZGFNQmd4RmpBVUJnTlZCQW9NRFdOc2RYTjBaWEl1Ykc5allXd3dXVEFUQmdjcWhrak9QUUlCCkJnZ3Foa2pPUFFNQkJ3TkNBQVFVQ2hZeHJBS0VZdzlIUjVzL0laSTg5LzRpUDV6eElWUEJDT3VKd3FRRk5xWlkKdkxZcytRQzdkaHlxakxlajlpU3hHM3UrZVhaTDRHRmxnOURMemM1Vm8xTXdVVEFkQmdOVkhRNEVGZ1FVOHhaaApLYUZ6ZXpWZ2FqOW9MT1djRXJxMUR6RXdId1lEVlIwakJCZ3dGb0FVOHhaaEthRnplelZnYWo5b0xPV2NFcnExCkR6RXdEd1lEVlIwVEFRSC9CQVV3QXdFQi96QUtCZ2dxaGtqT1BRUURBZ05JQURCRkFpRUFrOFZ5d3JhZW9abisKSFJRNmdSc3JzWXVJS3Y4bFBqNzVmclpteisvMnF1b0NJQ3RVRjlNVTE1cmE1S2gyK21DWkN3L3RUaWNJVDRscApHb2NBcG81YjhLRDYKLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo=
    failurePolicy: Fail
    matchPolicy: Equivalent
    namespaceSelector:
      matchExpressions:
        - { key: istio-injection, operator: In, values: [enabled] }
    objectSelector:
      matchExpressions:
        - { key: sidecar.istio.io/inject, operator: NotIn, values: ["false"] }
    reinvocationPolicy: Never
    rules:
      - { apiGroups: [""], apiVersions: [v1], operations: [CREATE], resources: [pods], scope: "*" }
    sideEffects: None
    timeoutSeconds: 10
  - name: object.sidecar-injector.istio.io
    admissionReviewVersions: [v1beta1, v1]
    clientConfig:
      service: { name: istiod, namespace: istio-system, path: /inject, port: 443 }
      caBundle: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJoVENDQVN1Z0F3SUJBZ0lVUkZoOHY4UVVoUk5ud3RDN0dXZ2JVa2dPQzFJd0NnWUlLb1pJemowRUF3SXcKR0RFV01CUUdBMVVFQ2d3TlkyeDFjM1JsY2k1c2IyTmhiREFlRncweU5qRXhNVEF3TnpVMU5UZGFGdzB6TmpFeApNRGN3TnpVMU5UZGFNQmd4RmpBVUJnTlZCQW9NRFdOc2RYTjBaWEl1Ykc5allXd3dXVEFUQmdjcWhrak9QUUlCCkJnZ3Foa2pPUFFNQkJ3TkNBQVFVQ2hZeHJBS0VZdzlIUjVzL0laSTg5LzRpUDV6eElWUEJDT3VKd3FRRk5xWlkKdkxZcytRQzdkaHlxakxlajlpU3hHM3UrZVhaTDRHRmxnOURMemM1Vm8xTXdVVEFkQmdOVkhRNEVGZ1FVOHhaaApLYUZ6ZXpWZ2FqOW9MT1djRXJxMUR6RXdId1lEVlIwakJCZ3dGb0FVOHhaaEthRnplelZnYWo5b0xPV2NFcnExCkR6RXdEd1lEVlIwVEFRSC9CQVV3QXdFQi96QUtCZ2dxaGtqT1BRUURBZ05JQURCRkFpRUFrOFZ5d3JhZW9abisKSFJRNmdSc3JzWXVJS3Y4bFBqNzVmclpteisvMnF1b0NJQ3RVRjlNVTE1cmE1S2gyK21DWkN3L3RUaWNJVDRscApHb2NBcG81YjhLRDYKLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo=
    failurePolicy: Fail
    matchPolicy: Equivalent
    namespaceSelector:
      matchExpressions:
        - { key: istio-injection, operator: DoesNotExist }
    objectSelector:
      matchExpressions:
        - { key: sidecar.istio.io/inject, operator: In, values: ["true"] }
    reinvocationPolicy: Never
    rules:
      - { apiGroups: [""], apiVersions: [v1], operations: [CREATE], resources: [pods], scope: "*" }
    sideEffects: None
    timeoutSeconds: 10
EOF

# the planned maintenance of the only node, as the night shift would run it
node=$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
[ -n "$node" ] || { echo "break: FAILED, no node found" >&2; exit 1; }
kubectl drain "$node" --ignore-daemonsets --delete-emptydir-data --force --timeout=45s >/dev/null 2>&1 || true
kubectl uncordon "$node" >/dev/null 2>&1 || { echo "break: FAILED, could not uncordon $node" >&2; exit 1; }

# wait until the breakage is visible: no pods at all in the two selected namespaces, FailedCreate events in both,
# while the namespace outside the selector and the system pods came back
count() { kubectl -n "$1" get "$2" -o name $3 2>/dev/null | wc -l; }
deadline=$(( $(date +%s) + 45 ))
while :; do
  sp=$(count shop pods ""); bp=$(count billing pods "")
  se=$(count shop events "--field-selector=reason=FailedCreate"); be=$(count billing events "--field-selector=reason=FailedCreate")
  tools=$(kubectl -n tools get deploy status-page -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  dns=$(kubectl -n kube-system get deploy coredns -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  if [ "$sp" -eq 0 ] && [ "$bp" -eq 0 ] && [ "$se" -ge 1 ] && [ "$be" -ge 1 ] && [ "${tools:-0}" = "1" ] && [ "${dns:-0}" -ge 1 ]; then
    echo "break: done (pods in shop: 0, in billing: 0; FailedCreate events: $se and $be; status-page and coredns are back)"
    exit 0
  fi
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep 2
done
echo "break: FAILED (pods shop=$sp billing=$bp, FailedCreate events shop=$se billing=$be, status-page ready=${tools:-0}, coredns ready=${dns:-0})" >&2
exit 1
