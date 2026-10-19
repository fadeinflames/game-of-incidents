# Разбор: Схема ушла вперёд

## Что было сломано

Миграция `0007_rename_total_to_amount` сделала всё в одном шаге: добавила `amount_cents`, скопировала данные и **удалила** `total_cents`. Релиз `2.0.0`, который читает `amount_cents`, не поднялся: ему нужна переменная `BILLING_CURRENCY`, которую забыли добавить в манифест. CD‑система откатила Deployment на `1.9.4`. Откат вернул код, но не схему: `1.9.4` делает `SELECT … total_cents FROM invoices` и получает `column "total_cents" does not exist`. Health‑проба базу не трогает, поэтому поды `Ready`, а клиенты получают 500.

## Как это диагностируется

1. `kubectl rollout history deploy/billing-api` — ревизии «release 2.0.0 (multi-currency)» и «argocd: rollback to 1.9.4 after failed sync».
2. `kubectl logs deploy/billing-api --tail=20` — `column "total_cents" does not exist`.
3. `kubectl get jobs` и `kubectl logs job/migrate-2-0-0` — `ALTER TABLE invoices DROP COLUMN total_cents`.
4. `kubectl exec postgres-0 -- psql -U billing -d billing -c '\d invoices'` — есть `amount_cents`, нет `total_cents`.
5. Почему не поднялся 2.0.0. Под этой ревизии удалён откатом, и его логи пропали вместе с ним. `kubectl rollout history deploy/billing-api --revision=2` покажет шаблон: `APP_VERSION=2.0.0`, переменной `BILLING_CURRENCY` нет. Текст ошибки можно получить, выкатив ревизию ещё раз: `kubectl rollout undo deploy/billing-api --to-revision=2`, затем `kubectl get pods` и `kubectl logs <новый под>` — «BILLING_CURRENCY is required since 2.0.0». Это безопасно: у Deployment `maxUnavailable: 0`, старые поды работают, пока новый не станет Ready. Если дальше идёшь путём A, верни `1.9.4` командой `kubectl rollout undo deploy/billing-api`, иначе под `2.0.0` так и останется падать рядом с рабочими.

## Эталонное решение

Путь A, схема назад к коду (быстрый, безопасный):

```bash
kubectl exec -i postgres-0 -- psql -U billing -d billing -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE invoices ADD COLUMN total_cents bigint;
UPDATE invoices SET total_cents = amount_cents;
ALTER TABLE invoices ALTER COLUMN amount_cents DROP NOT NULL;

CREATE FUNCTION invoices_sync_amount() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_cents IS NULL THEN NEW.amount_cents := NEW.total_cents; END IF;
  IF NEW.total_cents IS NULL THEN NEW.total_cents := NEW.amount_cents; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER invoices_sync_amount BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_sync_amount();
SQL
```

Первых двух команд мало. Миграция поставила `amount_cents NOT NULL`, а `1.9.4` при создании счёта заполняет только `total_cents`: чтение оживёт, а `POST /invoices` продолжит отдавать 500. Третья команда снимает это ограничение, и её достаточно, чтобы грейдер засчитал решение.

Триггер нужен для следующего шага: он держит оба столбца синхронными, пока живут обе версии кода. Без него счета, созданные `1.9.4`, останутся с пустым `amount_cents`, и `2.0.0` после выкатки покажет их без суммы.

Путь B, код вперёд к схеме:

```bash
kubectl set env deploy/billing-api BILLING_CURRENCY=RUB APP_VERSION=2.0.0
kubectl rollout status deploy/billing-api
```

Грейдер принимает оба: он сравнивает то, что отдаёт API, с тем, что лежит в базе, и проверяет чтение и запись.

## Ловушки

- `kubectl rollout restart` или ещё один `undo`: код тот же, столбца всё так же нет.
- Переименовать `amount_cents` обратно в `total_cents`: `1.9.4` оживёт, но следующая попытка выкатить `2.0.0` начнёт с той же миграции и снова уронит прод.
- `DROP TABLE` + пересоздание «по схеме 1.9.4»: данные потеряны, грейдер это увидит по числу исходных счетов.
- Удалить под `postgres-0` «чтобы он поднялся чистым»: том пода временный, база вернётся с исходными данными без свежих записей, а грейдер ищет запись, сделанную после выкатки (контрольный счёт).

## Чему учит

- Откат Deployment не откатывает миграции. Схема живёт отдельно от кода, и у неё должен быть свой план отката.
- Expand → migrate → contract: новый столбец добавляют в одном релизе, старый удаляют в следующем, когда ни одна работающая версия его не читает. Удалять и переименовывать в одной миграции нельзя.
- Пайплайн «миграция, потом приложение» обязан уметь остановиться после неудачной раскатки так, чтобы старая версия продолжала работать.
- Health‑проба, не трогающая зависимости, покажет `Ready` на мёртвом сервисе. Хотя бы readiness должна делать лёгкий запрос к базе.

## Почитать

- [Expand and contract pattern (Martin Fowler, ParallelChange)](https://martinfowler.com/bliki/ParallelChange.html)
- [PostgreSQL: ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html)
- [Kubernetes: Rolling Back a Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#rolling-back-a-deployment)
- [Argo CD: Sync Phases and Waves (PreSync hooks для миграций)](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)
