# Разбор: Обновление пошло не так

## Что было сломано

В 02:00 открылось окно обслуживания, `autoUpgrade` стал `true`, и контроллер честно сделал то, что умеет: взял первую ноду пула `stateful` со старой версией kubelet, cordon + drain. PDB `minAvailable: 2` разрешили выселить по одной реплике `events` и `store`. Но их диски зональные (`topology.kubernetes.io/zone=ru-central1-a`), а новая нода, которую платформа добавила взамен, оказалась в зоне `d`. Реплики повисли в `Pending` с `volume node affinity conflict`: `events` потерял треть партиций, одна нода `store` вышла из кластера. Какая именно реплика окажется выселенной, зависит от порядка выселения: на ноде зоны `a` стоят по две реплики `events` и `store`, а PDB пропускает по одной. Контроллер при этом продолжает раз в 30 секунд «дожимать» drain и, стоит вернуть ноду в строй, осушит её снова.

## Как это диагностируется

1. `kubectl get nodes -L topology.kubernetes.io/zone,node-pool,upgrade/kubelet-version` — старая нода зоны `a` `SchedulingDisabled`, новая v1.34.0 в зоне `d` (версия пула берётся из метки; колонка `VERSION` у нод учебного кластера одинакова).
2. `kubectl -n production get pods -o wide` — одна реплика `events` и одна `store` в `Pending`; `kubectl describe pod` — в Events `2 node(s) had volume node affinity conflict` (ноды зон `b` и `d`) и `1 node(s) were unschedulable` (cordoned нода зоны `a`).
3. `kubectl -n kube-system logs deploy/node-upgrade-controller --tail=20` — «node … is behind v1.34.0: cordon + drain», «drain … did not finish (timeout), will retry».
4. `kubectl -n kube-system get configmap node-upgrade -o yaml` — `autoUpgrade: "true"`.
5. `kubectl get pv -o custom-columns=NAME:.metadata.name,ZONE:.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]` — диски выселенных реплик в зоне `a`.

## Эталонное решение

```bash
kubectl -n kube-system patch configmap node-upgrade -p '{"data":{"autoUpgrade":"false"}}'   # 1. остановить кровотечение
kubectl uncordon <старая нода зоны a>                                                       # 2. вернуть ноду репликам
kubectl -n production get pods -w                                                            # выселенные реплики events и store поднимаются с данными
```

Паузой засчитывается и остановка контроллера (`scale --replicas=0`), но не его удаление. Порядок важен: `uncordon` без паузы живёт 30 секунд, до следующего тика контроллера. Правильное обновление — утром: сначала нода v1.34.0 в зоне `a`, дождаться, потом drain старой. Это и есть тикет платформенной команде.

## Ловушки

- `uncordon` без паузы контроллера: через 30 секунд нода снова cordoned, реплики снова Pending. Грейдер ждёт минуту и ловит это.
- Удалить контроллер обновлений. Кластер перестанет обновляться вообще; утром его вернут, и всё повторится. Грейдер откажет.
- `kubectl delete pod --force` для Pending‑реплик: они пересоздаются и снова висят, диск всё так же в зоне `a`.
- Убрать `nodeAffinity` у PV или переклеить зону новой ноде: диск физически в зоне `a`, метки его не переносят: реплика стартует на пустом каталоге и «рапортует» Ready без данных. Грейдер сверяет зоны и версии stateful-нод и привязки PVC.
- Снять PDB «чтобы drain прошёл»: drain пройдёт, вторая и третья реплики тоже улетят в Pending.

## Чему учит

- Первое действие при каскаде во время автоматических работ — поставить автоматику на паузу. Потом разбираться.
- Для StatefulSet с зональными дисками auto‑upgrade «нода за нодой» работает только если замена приходит в ту же зону. Это надо проверять до окна, а не в 02:05.
- PDB защищает от лишних выселений, но не от выселения «в никуда». Планируй, куда переедут поды, а не только сколько их может отсутствовать.
- Алерт на `Pending` stateful‑поды старше двух минут во время окна обслуживания — дешёвая страховка.

## Почитать

- [Kubernetes: Safely Drain a Node](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)
- [Kubernetes: Volume node affinity](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#node-affinity)
- [Kubernetes: Pod Disruption Budgets](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/)
- [Yandex Managed Kubernetes: автоматическое обновление групп узлов](https://yandex.cloud/ru/docs/managed-kubernetes/concepts/release-channels-and-updates)
