#!/usr/bin/env bash
set -euo pipefail

TOPDIR="/opt/seafile"
INSTALL_DIR=""
SHARED_ROOT="/shared/seafile"
CONF_DIR="$SHARED_ROOT/conf"
MARKER_FILE="$SHARED_ROOT/.webservices-init-complete"
OVERLAY_FILE="/seahub_settings_overlay.py"
OVERLAY_BEGIN="# BEGIN webservices seahub overlay"
OVERLAY_END="# END webservices seahub overlay"
SEAHUB_SCRIPT=""
SEAHUB_MANAGE_PY=""

log() {
  printf '[seafile-runtime] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

require_path() {
  local path="$1"
  [ -e "$path" ] || die "missing required Seafile path: $path"
}

resolve_install_dir() {
  local candidate

  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    INSTALL_DIR="$candidate"
  done < <(find "$TOPDIR" -maxdepth 1 -mindepth 1 -type d -name 'seafile-server-*' | sort)

  [ -n "$INSTALL_DIR" ] || die "unable to locate Seafile install dir under $TOPDIR"

  SEAHUB_SCRIPT="$INSTALL_DIR/seahub.sh"
  SEAHUB_MANAGE_PY="$INSTALL_DIR/seahub/manage.py"
}

wait_for_mysql() {
  log "Waiting for MariaDB at ${SEAFILE_MYSQL_DB_HOST}:${SEAFILE_MYSQL_DB_PORT}..."
  python3 - <<'PY'
import os
import sys
import time

import pymysql

host = os.environ["SEAFILE_MYSQL_DB_HOST"]
port = int(os.environ.get("SEAFILE_MYSQL_DB_PORT", "3306"))
user = os.environ["SEAFILE_MYSQL_DB_USER"]
password = os.environ["SEAFILE_MYSQL_DB_PASSWORD"]

last_error = None
for _ in range(180):
    try:
        conn = pymysql.connect(host=host, port=port, user=user, passwd=password)
        conn.close()
        sys.exit(0)
    except Exception as exc:
        last_error = exc
        time.sleep(1)

print(f"Timed out waiting for MariaDB: {last_error}", file=sys.stderr)
sys.exit(1)
PY
}

ensure_shared_links() {
  local name source_path target_path

  for name in conf seafile-data seahub-data pro-data; do
    source_path="$SHARED_ROOT/$name"
    target_path="$TOPDIR/$name"
    if [ -e "$source_path" ] || [ -L "$source_path" ]; then
      rm -rf "$target_path"
      ln -s "$source_path" "$target_path"
    fi
  done

  mkdir -p "$SHARED_ROOT/logs"
  rm -rf "$TOPDIR/logs"
  ln -s "$SHARED_ROOT/logs" "$TOPDIR/logs"
}

list_existing_shared_paths() {
  local name

  for name in conf seafile-data seahub-data pro-data; do
    if [ -e "$SHARED_ROOT/$name" ] || [ -L "$SHARED_ROOT/$name" ]; then
      printf '%s\n' "$SHARED_ROOT/$name"
    fi
  done
}

list_database_schema_counts() {
  python3 - <<'PY'
import os

import pymysql

host = os.environ["SEAFILE_MYSQL_DB_HOST"]
port = int(os.environ.get("SEAFILE_MYSQL_DB_PORT", "3306"))
user = os.environ["SEAFILE_MYSQL_DB_USER"]
password = os.environ["SEAFILE_MYSQL_DB_PASSWORD"]
schemas = [
    os.environ["SEAFILE_MYSQL_DB_CCNET_DB_NAME"],
    os.environ["SEAFILE_MYSQL_DB_SEAFILE_DB_NAME"],
    os.environ["SEAFILE_MYSQL_DB_SEAHUB_DB_NAME"],
]

conn = pymysql.connect(host=host, port=port, user=user, passwd=password)
with conn.cursor() as cur:
    for schema in schemas:
        cur.execute(
            """
            SELECT 1
            FROM information_schema.schemata
            WHERE schema_name = %s
            LIMIT 1
            """,
            (schema,),
        )
        if cur.fetchone() is None:
            continue
        cur.execute(
            """
            SELECT COUNT(*)
            FROM information_schema.tables
            WHERE table_schema = %s
            """,
            (schema,),
        )
        count = int(cur.fetchone()[0])
        print(f"{schema}={count}")
conn.close()
PY
}

schema_count_for() {
  local target_schema="$1"
  local schema_count

  mapfile -t schema_counts < <(list_database_schema_counts)
  for schema_count in "${schema_counts[@]}"; do
    case "$schema_count" in
      "$target_schema"=*)
        printf '%s\n' "${schema_count#*=}"
        return 0
        ;;
    esac
  done

  return 1
}

required_paths_are_complete() {
  local missing=()
  local path

  for path in \
    "$CONF_DIR" \
    "$SHARED_ROOT/seafile-data" \
    "$SHARED_ROOT/seahub-data" \
    "$CONF_DIR/seafile.conf" \
    "$CONF_DIR/seafdav.conf" \
    "$CONF_DIR/seahub_settings.py"; do
    [ -e "$path" ] || missing+=("$path")
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    log "Missing required Seafile paths: $(printf '%s ' "${missing[@]}")"
    return 1
  fi

  return 0
}

verify_required_paths() {
  required_paths_are_complete || die "missing required Seafile paths"
}

database_schema_is_complete() {
  python3 - <<'PY'
import os
import sys

import pymysql

host = os.environ["SEAFILE_MYSQL_DB_HOST"]
port = int(os.environ.get("SEAFILE_MYSQL_DB_PORT", "3306"))
user = os.environ["SEAFILE_MYSQL_DB_USER"]
password = os.environ["SEAFILE_MYSQL_DB_PASSWORD"]

checks = [
    (os.environ["SEAFILE_MYSQL_DB_CCNET_DB_NAME"], "EmailUser"),
    (os.environ["SEAFILE_MYSQL_DB_SEAFILE_DB_NAME"], "Repo"),
    (os.environ["SEAFILE_MYSQL_DB_SEAFILE_DB_NAME"], "SystemInfo"),
    (os.environ["SEAFILE_MYSQL_DB_SEAHUB_DB_NAME"], "django_migrations"),
    (os.environ["SEAFILE_MYSQL_DB_SEAHUB_DB_NAME"], "notifications_notification"),
]

conn = pymysql.connect(host=host, port=port, user=user, passwd=password)
missing = []
with conn.cursor() as cur:
    for database, table in checks:
        cur.execute(
            """
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = %s AND table_name = %s
            LIMIT 1
            """,
            (database, table),
        )
        if cur.fetchone() is None:
            missing.append(f"{database}.{table}")
conn.close()

if missing:
    print("Missing Seafile schema tables: " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)
PY
}

verify_database_schema() {
  database_schema_is_complete || die "Seafile database schema is incomplete"
}

database_schemas_are_empty() {
  local schema_count

  mapfile -t schema_counts < <(list_database_schema_counts)
  if [ "${#schema_counts[@]}" -eq 0 ]; then
    return 1
  fi

  for schema_count in "${schema_counts[@]}"; do
    case "$schema_count" in
      *=0) ;;
      *)
        return 1
        ;;
    esac
  done

  return 0
}

core_database_schemas_are_empty() {
  local ccnet_count
  local seafile_count

  ccnet_count="$(schema_count_for "$SEAFILE_MYSQL_DB_CCNET_DB_NAME" || true)"
  seafile_count="$(schema_count_for "$SEAFILE_MYSQL_DB_SEAFILE_DB_NAME" || true)"

  [ -z "$ccnet_count" ] || [ "$ccnet_count" = "0" ] || return 1
  [ -z "$seafile_count" ] || [ "$seafile_count" = "0" ] || return 1
  return 0
}

reset_seafile_database_schemas() {
  log "Resetting Seafile MariaDB schemas for clean bootstrap"
  python3 - <<'PY'
import os
import re
import sys

import pymysql

host = os.environ["SEAFILE_MYSQL_DB_HOST"]
port = int(os.environ.get("SEAFILE_MYSQL_DB_PORT", "3306"))
password = os.environ["INIT_SEAFILE_MYSQL_ROOT_PASSWORD"]
schemas = [
    os.environ["SEAFILE_MYSQL_DB_CCNET_DB_NAME"],
    os.environ["SEAFILE_MYSQL_DB_SEAFILE_DB_NAME"],
    os.environ["SEAFILE_MYSQL_DB_SEAHUB_DB_NAME"],
]
identifier = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
invalid = [schema for schema in schemas if identifier.fullmatch(schema) is None]
if invalid:
    print(
        "Invalid Seafile schema identifier(s) for DDL: " + ", ".join(invalid),
        file=sys.stderr,
    )
    sys.exit(1)

conn = pymysql.connect(
    host=host,
    port=port,
    user="root",
    passwd=password,
    autocommit=True,
)
with conn.cursor() as cur:
    for schema in schemas:
        cur.execute(f"DROP DATABASE IF EXISTS `{schema}`")
        cur.execute(f"CREATE DATABASE `{schema}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
conn.close()
PY
}

clear_generated_shared_state() {
  log "Clearing partial Seafile shared state"
  rm -f "$MARKER_FILE"
  rm -rf \
    "$SHARED_ROOT/conf" \
    "$SHARED_ROOT/ccnet" \
    "$SHARED_ROOT/seafile-data" \
    "$SHARED_ROOT/seahub-data" \
    "$SHARED_ROOT/pro-data"
}

repair_incomplete_marked_state_if_safe() {
  if required_paths_are_complete && core_database_schemas_are_empty; then
    log "Detected incomplete Seafile bootstrap with empty core schemas; repairing automatically"
    clear_generated_shared_state
    reset_seafile_database_schemas
    return 0
  fi

  die "Seafile marker exists but state is incomplete; refusing automatic repair of non-empty core schemas"
}

sync_overlay_into_settings() {
  local settings_file="$CONF_DIR/seahub_settings.py"
  local temp_file

  [ -f "$settings_file" ] || die "missing generated seahub_settings.py at $settings_file"
  [ -f "$OVERLAY_FILE" ] || die "missing rendered Seafile overlay at $OVERLAY_FILE"

  temp_file="$(mktemp)"
  awk -v begin="$OVERLAY_BEGIN" -v end="$OVERLAY_END" '
    $0 == begin { skipping = 1; next }
    $0 == end { skipping = 0; next }
    !skipping { print }
  ' "$settings_file" > "$temp_file"

  printf '\n%s\n' "$OVERLAY_BEGIN" >> "$temp_file"
  cat "$OVERLAY_FILE" >> "$temp_file"
  printf '\n%s\n' "$OVERLAY_END" >> "$temp_file"

  mv "$temp_file" "$settings_file"
}

run_seahub_migrations() {
  ensure_shared_links
  log "Running Seahub migrations"
  "$SEAHUB_SCRIPT" python-env python3 "$SEAHUB_MANAGE_PY" migrate --noinput
}

reconcile_admin_user() {
  local output_file

  output_file="$(mktemp)"
  if "$SEAHUB_SCRIPT" python-env python3 "$SEAHUB_MANAGE_PY" shell >"$output_file" 2>&1 <<'PY'
import os

from seahub.base.accounts import User
from seahub.profile.models import Profile

admin_email = os.environ["INIT_SEAFILE_ADMIN_EMAIL"].strip().lower()
admin_password = os.environ["INIT_SEAFILE_ADMIN_PASSWORD"]

profile = Profile.objects.filter(contact_email=admin_email).first()
if profile is None:
    user = User.objects.create_superuser(admin_email, admin_password)
else:
    user = User.objects.get(email=profile.user)

user.set_password(admin_password)
user.is_staff = True
user.is_active = True
user.save()

if not user.check_password(admin_password):
    raise RuntimeError("Seafile admin password verification failed")

print("WEBSERVICES_SEAFILE_ADMIN_RECONCILED")
PY
  then
    :
  fi

  if grep -q "WEBSERVICES_SEAFILE_ADMIN_RECONCILED" "$output_file"; then
    rm -f "$output_file"
    return 0
  fi

  rm -f "$output_file"
  return 1
}

start_admin_user_reconciler() {
  (
    local attempt

    for attempt in $(seq 1 120); do
      if reconcile_admin_user; then
        log "Seafile admin user reconciliation complete"
        exit 0
      fi
      sleep 2
    done

    log "ERROR: timed out reconciling Seafile admin user"
    exit 1
  ) &
}

seahub_is_running() {
  pgrep -f '[g]unicorn.*seahub' >/dev/null 2>&1
}

ensure_seahub_running() {
  (
    local attempt

    for attempt in $(seq 1 180); do
      if seahub_is_running; then
        log "Seahub process is running"
        exit 0
      fi

      if [ -x "$SEAHUB_SCRIPT" ]; then
        log "Seahub process missing; starting Seahub on port 8000"
        "$SEAHUB_SCRIPT" start 8000 || true
      fi

      sleep 2
    done

    log "ERROR: timed out waiting for Seahub process"
    exit 1
  ) &
}

bootstrap_fresh_state() {
  log "Bootstrapping fresh Seafile state via upstream init"
  (
    cd /scripts
    python3 - <<'PY'
from bootstrap import init_seafile_server

init_seafile_server()
PY
  )
}

adopt_complete_unmarked_state_if_present() {
  mapfile -t existing_paths < <(list_existing_shared_paths)
  mapfile -t schema_counts < <(list_database_schema_counts)

  if [ "${#existing_paths[@]}" -eq 0 ] && [ "${#schema_counts[@]}" -eq 0 ]; then
    return 1
  fi

  if ! required_paths_are_complete; then
    return 1
  fi

  if ! database_schema_is_complete; then
    return 1
  fi

  log "Found complete Seafile state without init marker; adopting it"
  sync_overlay_into_settings
  run_seahub_migrations
  verify_database_schema
  touch "$MARKER_FILE"
  log "Seafile state adoption complete"
  return 0
}

fail_if_partial_unmarked_state() {
  mapfile -t existing_paths < <(list_existing_shared_paths)
  mapfile -t schema_counts < <(list_database_schema_counts)

  if [ "${#existing_paths[@]}" -eq 0 ] && [ "${#schema_counts[@]}" -eq 0 ]; then
    return 0
  fi

  if [ "${#existing_paths[@]}" -eq 0 ] && database_schemas_are_empty; then
    log "Found only empty Seafile database schemas without shared state; treating as fresh bootstrap"
    return 0
  fi

  if [ "${#existing_paths[@]}" -eq 1 ] \
    && [ "${existing_paths[0]}" = "$SHARED_ROOT/seafile-data" ] \
    && database_schemas_are_empty; then
    log "Found only pre-mounted Seafile data storage with empty schemas; treating as fresh bootstrap"
    return 0
  fi

  if [ "${#existing_paths[@]}" -gt 0 ]; then
    log "Found existing shared Seafile paths without init marker:"
    printf '  %s\n' "${existing_paths[@]}" >&2
  fi

  if [ "${#schema_counts[@]}" -gt 0 ]; then
    log "Found existing Seafile database schemas without init marker:"
    printf '  %s\n' "${schema_counts[@]}" >&2
  fi

  die "refusing automatic repair of partial Seafile state; purge Seafile DB + volume state or repair manually"
}

ensure_initialized_state() {
  # Seafile initialization is a small state machine because upstream bootstrap
  # writes both filesystem state and MariaDB schemas. The webservices marker is
  # only trusted after both sides are complete:
  #
  # - marker + complete state: adopt and run migrations
  # - marker + incomplete empty core schemas: clear and rebuild safely
  # - complete unmarked state: adopt after validation
  # - empty DB schemas only: treat as fresh bootstrap
  # - any other partial state: stop and require operator repair/purge
  wait_for_mysql
  mkdir -p "$SHARED_ROOT" "$SHARED_ROOT/logs"

  if [ -f "$MARKER_FILE" ]; then
    log "Existing Seafile marker found; validating initialized state"
    if required_paths_are_complete && database_schema_is_complete; then
      sync_overlay_into_settings
      run_seahub_migrations
      verify_database_schema
      log "Seafile state validation complete"
      return 0
    fi

    repair_incomplete_marked_state_if_safe
  fi

  if adopt_complete_unmarked_state_if_present; then
    return 0
  fi

  fail_if_partial_unmarked_state
  bootstrap_fresh_state
  verify_required_paths
  sync_overlay_into_settings
  run_seahub_migrations
  verify_database_schema
  touch "$MARKER_FILE"
  log "Seafile initialization complete"
}

main() {
  resolve_install_dir
  ensure_initialized_state

  require_path "$MARKER_FILE"
  verify_required_paths
  ensure_shared_links
  ensure_seahub_running
  start_admin_user_reconciler

  exec /sbin/my_init -- /scripts/enterpoint.sh "$@"
}

main "$@"
