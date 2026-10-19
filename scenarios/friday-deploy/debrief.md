# Разбор: Пятничный деплой

## Что было сломано

`v2.1.3` завёл «кэш загрузок» и складывал в него каждый загруженный файл, не освобождая память. Под клиентским трафиком (одна загрузка в секунду) каждая загрузка оставляла в памяти около 4 МБ; при трёх подах это порядка 1,5 МБ в секунду на под, и RSS упирался в лимит 96Mi примерно за минуту. Ядро убивало контейнер (`OOMKilled`, exit code 137), kubelet перезапускал, история повторялась: `CrashLoopBackOff` с растущим backoff. Пока два пода лежали, третий получал весь трафик и падал быстрее. Каскад.

## Как это диагностируется

1. `kubectl get pods -l app=api-backend` — `CrashLoopBackOff`, `RESTARTS` растут.
2. `kubectl describe pod <под>` — `Last State: Terminated, Reason: OOMKilled, Exit Code: 137`.
3. `kubectl logs <под> --previous` — «Memory usage: 81MB (upload cache: 15 entries)» перед смертью.
4. `kubectl rollout history deploy/api-backend` — последняя ревизия «release v2.1.3 (large file uploads)» пять минут назад. Что менялось, то и виновато.

## Эталонное решение

```bash
kubectl rollout undo deploy/api-backend
kubectl rollout status deploy/api-backend
kubectl exec deploy/traffic -- wget -qO- http://127.0.0.1:9090/stats   # success_rate возвращается к 1.0
```

Засчитывается и другой путь: выключить кэш загрузок в окружении (`kubectl set env deploy/api-backend UPLOAD_CACHE=off`). Утечка уходит, версия `v2.1.3` остаётся. Грейдер смотрит на результат: утечки нет, три реплики Ready, клиенты обслужены. Но в пятницу вечером откат надёжнее: он возвращает проверенную ревизию целиком, а не гадает, что ещё принесла новая версия.

Потом сообщение тимлиду («откатил на v2.1.2, в v2.1.3 утечка памяти при загрузке файлов»), баг разработчикам с логами и `describe`, и никакого фикса в пятницу вечером.

## Ловушки

- Поднять memory limit до 512Mi. Та же утечка, только через пять минут вместо одной. Грейдер отказывает сразу: лимит должен остаться 96Mi.
- `kubectl rollout restart`. Свежие поды живут минуту.
- Масштабировать до 5 реплик. Пять падающих подов вместо трёх; трафик на загрузки распределится, и они умрут чуть позже.
- Выключить liveness‑пробу. Поды всё равно убивает ядро, а не проба.

## Чему учит

- После деплоя упало → сначала откат, потом разбор. Deployment хранит историю ревизий именно для этого.
- `Exit Code 137` = 128 + 9 = SIGKILL; вместе с `Reason: OOMKilled` это диагноз, а не загадка.
- Лимит памяти — предохранитель, а не лекарство: если контейнер растёт без потолка, больший лимит только оттягивает момент.
- Пятничный релиз с новой фичей и без canary — организационная ошибка, которую стоит вынести в постмортем.

## Почитать

- [Kubernetes: Rolling Back a Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#rolling-back-a-deployment)
- [Kubernetes: Assign Memory Resources — exceeding the limit](https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/#exceed-a-container-s-memory-limit)
- [Kubernetes: Debug Pods — CrashLoopBackOff](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
