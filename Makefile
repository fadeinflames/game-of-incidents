# Game of Incidents — developer entry points. Point DOCKER_HOST at the sandbox daemon (a rootless one):
#   export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock
SHELL := /bin/bash
SCENARIO ?= scenarios/*/

.PHONY: help install db-up db-migrate seed scenarios regress lint dev-orchestrator dev-web test test-scripts verify typecheck e2e up down logs clean-sandboxes deploy

help:
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-18s %s\n", $$1, $$2}'

install: ## npm install for all workspaces
	npm install --no-audit --no-fund

db-up: ## start PostgreSQL only (for running services on the host)
	docker compose up -d db

db-migrate: ## generate Prisma client and apply migrations (uses DATABASE_URL from .env)
	set -a && source .env && set +a && npm -w @wom/db run generate && npm -w @wom/db run deploy

seed: ## demo user + every scenario folder under scenarios/ (dev only: refuses on a production host)
	set -a && source .env && set +a && \
	if [[ "$${COMPOSE_FILE:-}" == *docker-compose.prod.yml* || -n "$${WOM_DOMAIN:-}" ]]; then \
	  echo "make seed: refused, .env describes a production host. The seed creates the demo admin with a known password; ./scripts/deploy.sh seeds the catalog and the administrator from ADMIN_*."; exit 1; \
	fi && \
	npm -w @wom/db run seed

scenarios: ## build platform images (images/*) and the images of ALL scenarios (SCENARIO=scenarios/<name>/ for one) via wom scenario build
	for d in images/*/; do [ -f "$${d}Dockerfile" ] || continue; docker build -t "wom-$$(basename $$d):dev" "$$d" || exit 1; done
	npx wom scenario build $(SCENARIO)

regress: ## scenario regression via the CLI: fresh -> failed, solve -> passed, hardening probes
	npx wom scenario test $(SCENARIO)

dev-orchestrator: ## run the orchestrator on the host (port 3080)
	set -a && source .env && set +a && PORT=3080 DOCKER_SOCKET=$${DOCKER_SOCKET_PATH} npm -w @wom/orchestrator run dev

dev-web: ## run the web app on the host (port 3000)
	set -a && source .env && set +a && ORCHESTRATOR_URL=http://127.0.0.1:3080 COOKIE_SECURE=false npm -w @wom/web run dev

typecheck: ## tsc for every workspace that has a typecheck script
	npm run typecheck

test: ## unit + integration tests (TEST_DATABASE_URL, else DATABASE_URL; refuses a database without "test" in its name)
	set -a && source .env && set +a && \
	if [[ -n "$${TEST_DATABASE_URL:-}" ]]; then export DATABASE_URL="$$TEST_DATABASE_URL"; fi && \
	db_name="$${DATABASE_URL:-}" && db_name="$${db_name%%\?*}" && db_name="$${db_name##*/}" && \
	if [[ -n "$${DATABASE_URL:-}" && ! "$$db_name" =~ [Tt][Ee][Ss][Tt] && "$${WOM_TEST_ALLOW_ANY_DB:-}" != 1 ]]; then \
	  echo "make test: refused, DATABASE_URL points at database \"$$db_name\" (no \"test\" in the name). The tests write to it, run the reconciler and kill sessions: on a real host that means live sessions. Set TEST_DATABASE_URL in .env to a separate database (e.g. .../wom_test)."; exit 1; \
	fi && \
	WOM_TEST_REQUIRE_DB=1 npm -w @wom/orchestrator test

test-scripts: ## tests of deploy/ and scripts/ shell scripts against a fake docker (no Docker, no database)
	bash scripts/test/run.sh

verify: ## the gate before a deploy: disposable postgres, migrations, typecheck, ALL tests with WOM_TEST_REQUIRE_DB=1, bash -n + shellcheck (docker needed)
	bash scripts/verify.sh

e2e: ## Playwright critical path against a running stack (E2E_BASE_URL, default http://127.0.0.1:3000)
	cd apps/web && npx playwright test

up: ## full stack in containers (db, orchestrator, web)
	docker compose up -d --build

deploy: ## on the server: pull origin/main, build scenario images and stack, migrate, seed
	./scripts/deploy.sh

down: ## stop the stack (sandboxes are reconciled by the orchestrator, not by compose)
	docker compose down

logs: ## follow stack logs
	docker compose logs -f --tail=100

clean-sandboxes: ## emergency: remove every sandbox container/network of this daemon
	docker ps -aq --filter label=wom.platform=sandbox | xargs -r docker rm -f -v
	docker network ls -q --filter label=wom.platform=sandbox | xargs -r docker network rm

lint: ## lint every scenario folder (schema, files, scripts, hardening rules)
	npx wom scenario lint scenarios/*/
