#!/bin/sh
# tablemover CLI: the job's database accounts are readable by root only, so the command goes through sudo.
[ "$(id -u)" = 0 ] || exec sudo -n "$0" "$@"
case "${1:-}" in daemon) echo "tablemover: the service is managed by: service tablemover start|stop|restart" >&2; exit 2 ;; esac
exec /usr/bin/python3 /opt/tablemover/tablemover.py "$@"
