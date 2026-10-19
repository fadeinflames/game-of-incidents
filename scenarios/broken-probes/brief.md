# 🟠 ALERT: DeploymentRolloutStuck — web

**Время:** четверг, 15:20. Ты дежурный по платформе.

> 🎓 **Учебный кейс.** Если не знаешь, с чего начать, под брифом есть панель «Нужна помощь?»: она открывает этапы диагностики по одному и объясняет, зачем нужна каждая команда. Это бесплатно, как и подсказки 1 и 2. Та же задача без подсказок есть в каталоге под своим обычным названием.

## Что известно

- В кластере крутится `Deployment web` (3 реплики) за `Service web` в namespace `default`. Это единственное приложение.
- 15 минут назад пайплайн выкатил релиз `2.4.0`: `kubectl set image` отработал, джоба зелёная.
- Раскатка не завершается: часть подов новой версии не становится `Ready`, у сервиса в endpoints осталось два адреса из трёх.
- Разработчики говорят, что 2.4.0 «просто переименовал эндпоинт здоровья и починил утечку», откатывать нельзя.

## Что не известно

- Почему новые поды не готовы.
- Что именно изменилось в 2.4.0 кроме слов разработчиков.

## Цель

Раскатка завершена: все три реплики версии `2.4.0` в `Ready`, у сервиса три endpoint'а, rollout не «висит».

## Ограничения

- Откат на предыдущую версию не принимается: 2.4.0 должна остаться.
- Удалять пробы совсем нельзя, кластер без них деплой не примет (так договорились с командой).
- Пробы должны остаться настоящими: обе (readiness и liveness) — HTTP‑запрос к эндпоинту здоровья приложения. Проверка «порт открыт» или запрос к корню `/` здоровья не проверяют, такое не принимается.

## Доступ

Shell на bastion‑хосте с `kubectl` под пользователем `oncall`, кластер уже в kubeconfig.

## Шпаргалка

| Команда | Что показывает |
|---|---|
| `kubectl rollout status deploy/<имя>` | застряла ли раскатка и на скольких репликах |
| `kubectl get pods -l <селектор>` | READY / STATUS / RESTARTS по каждому поду |
| `kubectl describe pod <имя>` | события пода: пробы, образы, планирование |
| `kubectl logs <имя> --previous` | логи предыдущего (упавшего) контейнера |
| `kubectl get deploy <имя> -o yaml` | полный манифест, включая пробы и env |
| `kubectl edit deploy <имя>` | правка манифеста прямо в кластере |

## Почитать заранее

- [Kubernetes: Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) — что делает каждая проба и чем readiness отличается от liveness.
- [Kubernetes: Deployments — Rolling Update и rollout status](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#rolling-update-deployment) — почему раскатка может остановиться на середине.
- [kubectl describe: Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/) — как читать Events.
