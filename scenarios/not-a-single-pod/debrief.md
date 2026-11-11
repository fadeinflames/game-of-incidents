## Что было сломано

Во вторник со stage удалили Istio, но не до конца. Рабочие нагрузки из `istio-system` убрали, а объект уровня кластера `MutatingWebhookConfiguration istio-sidecar-injector` остался.

- Этот вебхук перехватывает создание каждого пода в namespace с меткой `istio-injection=enabled`. Метка осталась на `shop` и `billing`.
- За ответом вебхук ходит в `Service istiod` в `istio-system`, порт 443. От сервиса осталась оболочка с одним портом метрик (15014) и без единого пода за ней.
- У вебхука `failurePolicy: Fail`: если он не ответил, API-сервер отклоняет запрос. Для инжектора sidecar это разумная настройка, пока mesh жив: под без sidecar хуже, чем отсутствие пода.

Пока старые поды работали, никто ничего не замечал: вебхук вызывается только при создании пода. Утреннее обслуживание ноды выселило все поды разом. Контроллеры ReplicaSet попытались создать замену, и в `shop` и `billing` каждую попытку API-сервер отклонил на этапе admission. Объект пода при этом не появляется вообще, поэтому `kubectl get pods` пуст, нечего описывать и не у кого читать логи. В `tools` метки нет, там `status-page` поднялся как обычно. Системные поды тоже.

## Как это диагностируется

1. `kubectl get deploy -A`: `storefront` 0/3 и `invoicer` 0/2, а `status-page` и `coredns` в порядке. Пострадало не всё, значит, дело не в ноде.
2. `kubectl -n shop get pods`: `No resources found`. Планировщик и kubelet ни при чём: до них дело не дошло.
3. `kubectl -n shop describe deploy storefront`: в условиях `ReplicaFailure True FailedCreate`, в событиях только масштабирование ReplicaSet. Сам текст ошибки тут не виден.
4. `kubectl -n shop describe rs` или `kubectl -n shop get events --sort-by=.lastTimestamp`: событие `FailedCreate` от `replicaset-controller` с текстом

   ```
   Error creating: Internal error occurred: failed calling webhook "namespace.sidecar-injector.istio.io": failed to call webhook: Post "https://istiod.istio-system.svc:443/inject?timeout=10s": no service port 443 found for service "istiod"
   ```

5. `kubectl get mutatingwebhookconfigurations`, затем `kubectl get mutatingwebhookconfiguration istio-sidecar-injector -o yaml`: `clientConfig.service` указывает на `istio-system/istiod:443`, `failurePolicy: Fail`, `namespaceSelector` выбирает `istio-injection In [enabled]`.
6. `kubectl -n istio-system get svc,endpoints,pods`: у сервиса один порт 15014, endpoints пусты, подов нет.
7. `kubectl get ns -L istio-injection`: метка стоит на `shop` и `billing`. Отсюда и граница поражения.
8. Квоту проверить стоит, потому что превышение квоты даёт такое же `FailedCreate`: `kubectl -n shop describe quota` показывает 0 из 20. Квота ни при чём.

## Эталонное решение

```bash
# 1. убрать вебхук, оставшийся от удалённого mesh
kubectl delete mutatingwebhookconfiguration istio-sidecar-injector

# 2. подтолкнуть контроллеры: сами они повторят попытку нескоро
kubectl -n shop rollout restart deploy/storefront
kubectl -n billing rollout restart deploy/invoicer
kubectl -n shop rollout status deploy/storefront
kubectl -n billing rollout status deploy/invoicer

# 3. убрать остальные хвосты
kubectl label namespace shop billing istio-injection-
kubectl -n shop delete configmap istio-ca-root-cert
kubectl -n billing delete configmap istio-ca-root-cert
kubectl delete namespace istio-system
kubectl delete crd virtualservices.networking.istio.io destinationrules.networking.istio.io
```

Про шаг 2. После каждой неудачи контроллер ReplicaSet откладывает следующую попытку вдвое дальше. Уже через несколько минут простоя паузы между попытками измеряются минутами, поэтому после удаления вебхука поды сами появятся не сразу: на стенде через минуту после поломки ждать пришлось больше двух с половиной минут, а чем дольше простой, тем дольше ожидание. Любое изменение ReplicaSet или Deployment запускает синхронизацию немедленно: `rollout restart`, удаление ReplicaSet, даже новая аннотация на нём.

Проверка принимает любой путь, при котором приложения в полном составе, новый под в `shop` и `billing` создаётся, и API-сервер при этом не обращается к мёртвому вебхуку. Подойдёт и снятие метки `istio-injection` с обоих namespace, и правка селектора вебхука. Но оставлять в кластере вебхук, за которым никого нет, значит оставить ловушку следующему, кто поставит такую метку: шаг 3 нужен не грейдеру, а кластеру.

## Ловушки

- **Переключить `failurePolicy` на `Ignore`.** Поды начинают создаваться, и кажется, что всё починено. На деле API-сервер при каждом создании пода по-прежнему идёт к несуществующему бэкенду, получает ошибку и молча её пропускает. Мёртвая настройка остаётся в кластере и перестаёт о себе напоминать. Проверка это видит по счётчику пропущенных ошибок вебхуков на API-сервере и не засчитывает.
- **Снять метку только с `shop`.** `storefront` поднимается, алерт гаснет, а `invoicer` в `billing` так и стоит в 0 из 2: по нему просто ещё никто не позвонил.
- **Пометить шаблон пода `sidecar.istio.io/inject: "false"`.** Вебхук такие поды пропускает, Deployment оживает. Но любой другой под в этом namespace (новый Deployment, Job, отладочный под) по-прежнему отклоняется.
- **Поднять поды руками.** Голый под в `shop` упрётся в тот же вебхук. А если обойти его меткой из предыдущего пункта, получатся поды, которыми никто не управляет.
- **Ждать или перезапускать деплой.** Джоба деплоя применяет тот же манифест и ничего не меняет. Контроллер повторяет попытки сам, и каждая заканчивается так же.
- **Удалить `istio-system` или дорисовать сервису порт 443.** Текст ошибки изменится (`service "istiod" not found` или отказ соединения), результат нет: отвечать вебхуку по-прежнему некому.
- **Искать в квоте, планировщике или на ноде.** Всё это проверяется за минуту, но событие ReplicaSet называет причину прямо. Его нужно прочитать первым.

## Как было на самом деле

Сценарий сделан по пятой истории из шестой части «Практических историй из наших SRE-будней» компании «Флант» (апрель 2022 года).

- В одном из namespace stage-кластера перестали создаваться поды. Заметили это при масштабировании: Deployment увеличили до двух реплик, а второй под не появился. Не было ни `Pending`, ни `CrashLoopBackOff`: объекта пода не существовало.
- `kubectl describe deploy` показал только событие масштабирования ReplicaSet. Причина нашлась в `kubectl describe rs`: предупреждение `FailedCreate` от `replicaset-controller` с ошибкой вызова вебхука `sidecar-injector.istio.io` и словами о том, что у сервиса `istiod` не найден порт 443.
- Istio в кластере был удалён не до конца: сервис уже никуда не вёл, а вебхук инжектора с `failurePolicy: Fail` остался.
- Авторы отдельно говорят про `failurePolicy: Ignore`: с ним под создастся, но, по их мнению, ошибку лучше отслеживать, а не прятать. Каким именно действием они вернули работу, в статье не сказано.
- Вывод у них про мониторинг: такую поломку ловят алерты на контроллеры, у которых подов меньше, чем должно быть. В их платформе Deckhouse это делает модуль `extended-monitoring`.

Чем стенд отличается от оригинала. В оригинале старый под продолжал работать, а не создавался только новый. В стенде обслуживание ноды выселяет все поды, поэтому простой полный, и затронуты два namespace вместо одного. Почему и как удаляли Istio, в статье не сказано: заявка PLAT-1873, ручное удаление по списку и сервис метрик от чарта мониторинга придуманы для стенда. Имена приложений и namespace тоже вымышленные. Настоящий Istio в стенд не ставился: вебхук, сервис, ConfigMap и CRD созданы как обычные объекты.

## Чему учит

- **Пода нет совсем, значит, спрашивать нужно создателя.** `Pending` объясняет планировщик, `CrashLoopBackOff` объясняет контейнер. Отсутствие объекта объясняет контроллер: события ReplicaSet (а также Job и StatefulSet).
- **Admission-вебхук с `failurePolicy: Fail` становится частью пути создания каждого объекта, который он выбирает.** Его бэкенд нужно считать критичной зависимостью кластера и следить за ним так же.
- **Удаление компонента заканчивается на объектах уровня кластера.** `kubectl delete namespace` не трогает вебхуки, CRD, ClusterRole и метки на чужих namespace. После удаления стоит пройтись по `kubectl get mutatingwebhookconfigurations,validatingwebhookconfigurations` и `kubectl api-resources`.
- **Скрытая поломка ждёт первого пересоздания пода.** Между причиной и симптомом могут пройти дни. Плановый drain, выселение по памяти или обычный релиз превращают её в простой. Алерт «у контроллера подов меньше, чем нужно» сокращает это время до минут.
- **После починки причины проверь, что система сама вернулась.** Контроллеры с растущей паузой между попытками не заметят исправления мгновенно. Их нужно подтолкнуть.
- **Проверяй радиус поражения.** Алерт пришёл по одному Deployment, а селектор вебхука выбирал два namespace.

## Почитать

- [Флант: Практические истории из наших SRE-будней. Часть 6](https://habr.com/ru/companies/flant/articles/662459/)
- [Kubernetes: Dynamic Admission Control](https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/)
- [Kubernetes: Admission Webhook Good Practices](https://kubernetes.io/docs/concepts/cluster-administration/admission-webhooks-good-practices/)
- [Istio: Uninstall](https://istio.io/latest/docs/setup/install/istioctl/#uninstall-istio)
