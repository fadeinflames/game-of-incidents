# Разбор: Застрявшие поды

## Что было сломано

Две вещи, и вторая пряталась за первой.

1. `PodDisruptionBudget database-pdb` требовал `minAvailable: 3` при трёх репликах: ни одну реплику нельзя выселить никогда. Договорённость была «не больше одной вне строя», то есть `minAvailable: 2`. `kubectl drain` честно ждал, пока бюджет позволит, и отвалился по таймауту, оставив ноду cordoned.
2. Даже если выселить `database-1` силой, ему некуда сесть: его диск зональный (`nodeAffinity` на `topology.kubernetes.io/zone=ru-central1-b`), а единственная нода зоны `b` в пуле `db` — та, которую осушают. Запасная нода зоны `b` есть, но помечена `node-pool=spare`, а у StatefulSet `nodeSelector: node-pool=db`.

## Как это диагностируется

1. `kubectl get nodes -L topology.kubernetes.io/zone,node-pool,maintenance` — кто в какой зоне, кто cordoned, где запасная нода.
2. `kubectl -n production get pdb` — `database-pdb MIN AVAILABLE 3, ALLOWED DISRUPTIONS 0`.
3. `kubectl drain <нода> --ignore-daemonsets --delete-emptydir-data --timeout=30s` — «Cannot evict pod as it would violate the pod's disruption budget».
4. `kubectl get pv -o custom-columns=NAME:.metadata.name,ZONE:.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]` — диск `database-disk-1` в зоне `b`.
5. `kubectl -n production get statefulset database -o yaml | grep -A2 nodeSelector` — `node-pool: db`.

## Эталонное решение

```bash
spare=$(kubectl get nodes -l topology.kubernetes.io/zone=ru-central1-b,node-pool=spare -o name)
kubectl label $spare node-pool=db --overwrite                       # 1. запасная нода входит в пул базы
kubectl -n production patch pdb database-pdb -p '{"spec":{"minAvailable":2}}'   # 2. PDB = договорённость
kubectl drain <нода-на-обслуживании> --ignore-daemonsets --delete-emptydir-data   # 3. drain завершается
kubectl -n production get pods -o wide                               # database-1 на запасной ноде, 3/3
```

Порядок важен: если сначала поправить PDB и выселить `database-1`, он повиснет в `Pending` с `volume node affinity conflict`, пока не появится нода зоны `b` в пуле `db`. Пустой каталог на новой ноде «реплика бутстрапится от соседей» — как у настоящей реплицируемой базы с тремя копиями.

## Ловушки

- `kubectl delete pod database-1 --force --grace-period=0`. Под пересоздаётся и висит в `Pending`; `kubectl describe pod database-1` перечисляет причины по каждой из четырёх нод: control-plane отсекает taint, осушаемая нода `unschedulable`, у запасной ноды не тот `node-pool`, а у ноды зоны `a` `volume node affinity conflict`: диск в зоне `b`. И минуту база жила на двух репликах без всякого бюджета.
- Удалить PDB. Drain проходит, грейдер отказывает: следующий drain снесёт все реплики разом.
- `kubectl uncordon` и «сделаем в другой раз». Обновление ядра — security, окно сегодня.
- Перевесить метку `maintenance` на запасную ноду, раскордонить исходную и «осушить» запасную. Обслуживать нужно ту ноду, которую назначили по тикету INFRA-2291: ядро обновляют именно на ней.
- Поменять `nodeAffinity` у PV. Диск физически в зоне `b`, метка это не изменит.

## Чему учит

- PDB — это договорённость, записанная в YAML; проверяй, что YAML ей соответствует, до окна обслуживания, а не во время.
- Зональный диск = зональный под. Планируя drain ноды с StatefulSet, сначала посмотри, есть ли в той же зоне куда переехать.
- `drain` не «висит просто так»: его сообщения об eviction говорят, кто держит. Читай их, а не ретрай.
- Force delete пода со StatefulSet и диском — последнее средство, и почти всегда не то, что нужно.

## Почитать

- [Kubernetes: Safely Drain a Node](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)
- [Kubernetes: Specifying a Disruption Budget](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)
- [Kubernetes: Volume node affinity and storage topology](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#node-affinity)
- [Kubernetes: Force Delete StatefulSet Pods](https://kubernetes.io/docs/tasks/run-application/force-delete-stateful-set-pod/)
