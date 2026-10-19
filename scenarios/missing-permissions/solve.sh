#!/bin/sh
# SECRET reference solution: grant exactly the missing permission (get on that one Secret in namespace data),
# then run the backup by hand to close the RPO gap.
set -eu
cat <<'EOF' | kubectl apply -f - >/dev/null
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: backup-credentials-reader
  namespace: data
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["db-credentials"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: backup-credentials-reader
  namespace: data
subjects:
  - { kind: ServiceAccount, name: backup-controller, namespace: backup }
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: backup-credentials-reader
EOF
kubectl -n backup create job --from=cronjob/db-backup db-backup-manual-1 >/dev/null
kubectl -n backup wait --for=condition=complete job/db-backup-manual-1 --timeout=120s >/dev/null
echo "solve: done"
