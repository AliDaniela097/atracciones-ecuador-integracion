#!/bin/bash
# Uso (solo pruebas locales): scripts/hub-local.sh start|stop  — arranca el hub contra Postgres local con datos de prueba.
cd "$(dirname "$0")/.."
PID=/tmp/hub.pid
case "$1" in
  stop) [ -f $PID ] && kill $(cat $PID) 2>/dev/null; rm -f $PID; sleep 1;;
  start) $0 stop
    export MS_DB_BASE_URL='postgresql://postgres:postgres@localhost:5432/postgres' MS_EXPOSE_TOKENS=true MS_ADMIN_EMAIL=admin@test.ec MS_ADMIN_PASSWORD=Admin12345 MS_LOG_REQUESTS=false
    nohup node scripts/start-hub.mjs > /tmp/hub.log 2>&1 &
    echo $! > $PID; sleep ${2:-7};;
esac
