#!/usr/bin/env bash
set -euo pipefail

umask 077

resolve_one() {
  local description=$1
  shift
  local matches=()
  mapfile -t matches < <(docker ps -q "$@")
  if [[ ${#matches[@]} -ne 1 ]]; then
    printf 'Expected one running %s container; found %s\n' "$description" "${#matches[@]}" >&2
    return 1
  fi
  printf '%s\n' "${matches[0]}"
}

database_container=$(resolve_one t3-postgres --filter 'label=coolify.resourceName=t3-postgres')
account_container=$(resolve_one account --filter 'label=com.docker.compose.service=account')
relay_container=$(resolve_one relay --filter 'label=com.docker.compose.service=relay')

account_database_url=$(
  docker exec "$account_container" node -p 'process.env.T3_ACCOUNT_DATABASE_URL'
)
relay_database_url=$(
  docker exec "$relay_container" node -p 'process.env.T3_RELAY_DATABASE_URL'
)
account_database_host=$(
  docker exec "$account_container" \
    node -e 'process.stdout.write(new URL(process.env.T3_ACCOUNT_DATABASE_URL).hostname)'
)
relay_database_host=$(
  docker exec "$relay_container" \
    node -e 'process.stdout.write(new URL(process.env.T3_RELAY_DATABASE_URL).hostname)'
)
database_container_name=$(docker inspect "$database_container" --format '{{.Name}}')
database_container_name=${database_container_name#/}

if [[ $account_database_host != "$relay_database_host" ]] ||
  [[ $account_database_host != "$database_container_name" ]]; then
  echo 'Account, relay, and the resolved Coolify database do not identify one container.' >&2
  exit 1
fi

database_health=$(
  docker inspect "$database_container" \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
)
if [[ $database_health != healthy ]]; then
  printf 'PostgreSQL must be healthy before validation; current state: %s\n' "$database_health" >&2
  exit 1
fi

database_volume=$(
  docker inspect "$database_container" \
    --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}'
)
if [[ -z $database_volume ]]; then
  echo 'PostgreSQL has no named volume at /var/lib/postgresql/data.' >&2
  exit 1
fi

work_directory=$(mktemp -d /tmp/t3-sovereign-restore.XXXXXX)
account_restore_database="t3_restore_account_$$"
relay_restore_database="t3_restore_relay_$$"
account_restore_created=0
relay_restore_created=0

cleanup() {
  set +e
  if [[ $account_restore_created == 1 ]]; then
    docker exec -e RESTORE_DATABASE="$account_restore_database" "$database_container" \
      sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" dropdb --if-exists --username "$POSTGRES_USER" "$RESTORE_DATABASE"' \
      >/dev/null 2>&1
  fi
  if [[ $relay_restore_created == 1 ]]; then
    docker exec -e RESTORE_DATABASE="$relay_restore_database" "$database_container" \
      sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" dropdb --if-exists --username "$POSTGRES_USER" "$RESTORE_DATABASE"' \
      >/dev/null 2>&1
  fi
  if [[ $work_directory == /tmp/t3-sovereign-restore.* ]]; then
    rm -f \
      "$work_directory/account.dump" \
      "$work_directory/relay.dump" \
      "$work_directory/account.original" \
      "$work_directory/account.restored" \
      "$work_directory/relay.original" \
      "$work_directory/relay.restored"
    rmdir "$work_directory" >/dev/null 2>&1
  fi
  unset account_database_url relay_database_url
}
trap cleanup EXIT

dump_database() {
  local database_url=$1
  local output_file=$2
  docker exec -e DATABASE_URL="$database_url" "$database_container" \
    sh -c 'exec pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl' >"$output_file"
  test -s "$output_file"
  docker exec -i "$database_container" pg_restore --list <"$output_file" >/dev/null
}

create_restore_database() {
  local database_name=$1
  docker exec -e RESTORE_DATABASE="$database_name" "$database_container" \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" createdb --username "$POSTGRES_USER" "$RESTORE_DATABASE"'
}

restore_database() {
  local database_name=$1
  local input_file=$2
  docker exec -i -e RESTORE_DATABASE="$database_name" "$database_container" \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --exit-on-error --no-owner --no-acl --username "$POSTGRES_USER" --dbname "$RESTORE_DATABASE"' \
    <"$input_file"
}

manifest_for_url() {
  local database_url=$1
  local output_file=$2
  docker exec -i -e DATABASE_URL="$database_url" "$database_container" \
    sh -c 'psql "$DATABASE_URL" -X -A -t' >"$output_file" <<'SQL'
SELECT format(
  'SELECT %L || ''|'' || count(*)::text FROM %I.%I;',
  schemaname || '.' || tablename,
  schemaname,
  tablename
)
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename
\gexec
SQL
}

manifest_for_restore() {
  local database_name=$1
  local output_file=$2
  docker exec -i -e RESTORE_DATABASE="$database_name" "$database_container" \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql --username "$POSTGRES_USER" --dbname "$RESTORE_DATABASE" -X -A -t' \
    >"$output_file" <<'SQL'
SELECT format(
  'SELECT %L || ''|'' || count(*)::text FROM %I.%I;',
  schemaname || '.' || tablename,
  schemaname,
  tablename
)
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename
\gexec
SQL
}

echo 'Creating and validating account logical dump.'
dump_database "$account_database_url" "$work_directory/account.dump"
echo 'Creating and validating relay logical dump.'
dump_database "$relay_database_url" "$work_directory/relay.dump"

create_restore_database "$account_restore_database"
account_restore_created=1
create_restore_database "$relay_restore_database"
relay_restore_created=1

restore_database "$account_restore_database" "$work_directory/account.dump"
restore_database "$relay_restore_database" "$work_directory/relay.dump"

manifest_for_url "$account_database_url" "$work_directory/account.original"
manifest_for_restore "$account_restore_database" "$work_directory/account.restored"
manifest_for_url "$relay_database_url" "$work_directory/relay.original"
manifest_for_restore "$relay_restore_database" "$work_directory/relay.restored"

diff -u "$work_directory/account.original" "$work_directory/account.restored"
diff -u "$work_directory/relay.original" "$work_directory/relay.restored"

account_table_count=$(wc -l <"$work_directory/account.original" | tr -d ' ')
relay_table_count=$(wc -l <"$work_directory/relay.original" | tr -d ' ')
account_dump_bytes=$(wc -c <"$work_directory/account.dump" | tr -d ' ')
relay_dump_bytes=$(wc -c <"$work_directory/relay.dump" | tr -d ' ')

printf 'Restore validation passed: account_tables=%s account_bytes=%s relay_tables=%s relay_bytes=%s volume=%s\n' \
  "$account_table_count" \
  "$account_dump_bytes" \
  "$relay_table_count" \
  "$relay_dump_bytes" \
  "$database_volume"
