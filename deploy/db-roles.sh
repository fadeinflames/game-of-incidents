#!/usr/bin/env bash
# Creates or updates the PostgreSQL role the web container connects as, from WEB_DB_USER / WEB_DB_PASSWORD
# in .env. Called by scripts/deploy.sh after the migrations; safe to run again (the password is re-applied, the grants are
# re-stated). Without WEB_DB_PASSWORD it does nothing: web then uses the owner role, as before.
# Usage on the host: ./deploy/db-roles.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}
# only these two settings are read from .env, and the password travels on the stdin of psql, not on a command line
setting() { grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' || true; }
role=$(setting WEB_DB_USER)
password=$(setting WEB_DB_PASSWORD)

if [ -z "$password" ]; then
  # docker-compose.yml takes the user from WEB_DB_USER alone: a user without a password would make web log in as that
  # user with the owner's password and fail after the restart
  [ -z "$role" ] || { echo "db-roles: WEB_DB_USER is set but WEB_DB_PASSWORD is not: set both in .env, or remove WEB_DB_USER"; exit 1; }
  echo "db-roles: WEB_DB_PASSWORD is not set in .env: web connects as the owner role (see docker-compose.yml)"
  exit 0
fi
[ -n "$role" ] || { echo "db-roles: WEB_DB_PASSWORD is set but WEB_DB_USER is not: set both in .env (e.g. WEB_DB_USER=wom_web)"; exit 1; }
# the pair goes into a connection URL and into SQL: refuse anything that would need quoting
case "$role" in
  *[!a-z0-9_]*|[0-9]*|wom|postgres) echo "db-roles: WEB_DB_USER must be lower-case letters, digits and _, not start with a digit, and differ from wom and postgres"; exit 1 ;;
esac
case "$password" in
  *[!A-Za-z0-9._~-]*) echo "db-roles: WEB_DB_PASSWORD may contain only letters, digits and . _ ~ - (it is part of a URL): generate one with 'openssl rand -hex 24'"; exit 1 ;;
esac
[ "${#password}" -ge 16 ] || { echo "db-roles: WEB_DB_PASSWORD is shorter than 16 characters"; exit 1; }

# `exec -e NAME` without a value is not guaranteed to pass the host's value on, and an empty password would silently clear
# the role's password: the value is validated above (no quote or backslash can be in it), so it is set by the script itself
{ printf '\\set web_password '"'"'%s'"'"'\n' "$password"; cat deploy/db-roles.sql; } | \
  docker compose exec -T db psql -U wom -d wom -v ON_ERROR_STOP=1 -v "web_role=$role" -q
echo "db-roles: role $role is in place (writes User, Session, Scenario, ScenarioSubmission; reads the rest)"
