#!/usr/bin/env bash
set -euo pipefail

umask 077

config_file=${SOVEREIGN_BACKUP_SOURCE_CONFIG:-$HOME/.config/sovereign-backup/source.env}
recipient_certificate=${SOVEREIGN_BACKUP_RECIPIENT_CERT:-$HOME/.config/sovereign-backup/recipient.pem}

if [[ ! -f $config_file ]] || [[ ! -f $recipient_certificate ]]; then
  echo 'Sovereign backup source configuration is incomplete.' >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$config_file"
source_id=${SOVEREIGN_BACKUP_SOURCE_ID:-}
if [[ ! $source_id =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo 'SOVEREIGN_BACKUP_SOURCE_ID must be a lowercase backup identifier.' >&2
  exit 1
fi

lock_file=${XDG_RUNTIME_DIR:-/tmp}/sovereign-backup-control-plane-${UID}.lock
exec 9>"$lock_file"
if ! flock -n 9; then
  echo 'A control-plane backup export is already running.' >&2
  exit 1
fi

work_directory=$(mktemp -d /tmp/sovereign-control-plane-backup.XXXXXX)
cleanup() {
  set +e
  if [[ $work_directory == /tmp/sovereign-control-plane-backup.* ]]; then
    find "$work_directory" -depth -mindepth 1 -delete >/dev/null 2>&1
    rmdir "$work_directory" >/dev/null 2>&1
  fi
  unset account_database_url relay_database_url
}
trap cleanup EXIT

resolve_one() {
  local description=$1
  shift
  local matches=()
  mapfile -t matches < <(docker ps -q "$@")
  if [[ ${#matches[@]} -ne 1 ]]; then
    printf 'Expected one running %s container; found %s.\n' "$description" "${#matches[@]}" >&2
    return 1
  fi
  printf '%s\n' "${matches[0]}"
}

database_container=$(resolve_one t3-postgres --filter 'label=coolify.resourceName=t3-postgres')
account_container=$(resolve_one account --filter 'label=com.docker.compose.service=account')
relay_container=$(resolve_one relay --filter 'label=com.docker.compose.service=relay')

database_health=$(docker inspect "$database_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
if [[ $database_health != healthy ]]; then
  printf 'PostgreSQL must be healthy before backup; current state: %s.\n' "$database_health" >&2
  exit 1
fi

account_database_url=$(docker exec "$account_container" node -p 'process.env.T3_ACCOUNT_DATABASE_URL')
relay_database_url=$(docker exec "$relay_container" node -p 'process.env.T3_RELAY_DATABASE_URL')
account_database_host=$(docker exec "$account_container" node -e 'process.stdout.write(new URL(process.env.T3_ACCOUNT_DATABASE_URL).hostname)')
relay_database_host=$(docker exec "$relay_container" node -e 'process.stdout.write(new URL(process.env.T3_RELAY_DATABASE_URL).hostname)')
database_container_name=$(docker inspect "$database_container" --format '{{.Name}}')
database_container_name=${database_container_name#/}

if [[ $account_database_host != "$relay_database_host" ]] ||
  [[ $account_database_host != "$database_container_name" ]]; then
  echo 'Account, relay, and PostgreSQL do not identify the same private container.' >&2
  exit 1
fi

dump_database() {
  local database_url=$1
  local output_file=$2
  docker exec -e DATABASE_URL="$database_url" "$database_container" \
    sh -c 'exec pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl' >"$output_file"
  test -s "$output_file"
  docker exec -i "$database_container" pg_restore --list <"$output_file" >/dev/null
}

database_manifest() {
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

dump_database "$account_database_url" "$work_directory/account.dump"
dump_database "$relay_database_url" "$work_directory/relay.dump"
database_manifest "$account_database_url" "$work_directory/account.manifest"
database_manifest "$relay_database_url" "$work_directory/relay.manifest"

created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
database_image=$(docker inspect "$database_container" --format '{{.Config.Image}}')
account_image=$(docker inspect "$account_container" --format '{{.Config.Image}}')
relay_image=$(docker inspect "$relay_container" --format '{{.Config.Image}}')
{
  printf 'format_version=1\n'
  printf 'backup_type=control-plane\n'
  printf 'source_id=%s\n' "$source_id"
  printf 'created_at=%s\n' "$created_at"
  printf 'source_host=%s\n' "$(hostname -f 2>/dev/null || hostname)"
  printf 'database_image=%s\n' "$database_image"
  printf 'account_image=%s\n' "$account_image"
  printf 'relay_image=%s\n' "$relay_image"
} >"$work_directory/metadata.env"

(
  cd "$work_directory"
  sha256sum account.dump relay.dump account.manifest relay.manifest metadata.env >SHA256SUMS
  tar --create --gzip --file - \
    metadata.env SHA256SUMS account.dump relay.dump account.manifest relay.manifest
) | openssl cms -encrypt -binary -aes-256-gcm -outform DER "$recipient_certificate"
