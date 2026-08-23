#!/usr/bin/env bash
set -euo pipefail

umask 077

started_at=$SECONDS
drill_id="t3-sovereign-restore-drill-$$"
network_name="$drill_id"
database_name="$drill_id-postgres"
account_name="$drill_id-account"
relay_name="$drill_id-relay"
work_directory=$(mktemp -d /tmp/t3-sovereign-full-restore.XXXXXX)
retained_backup_directory=${SOVEREIGN_RETAINED_BACKUP_DIRECTORY:-}
backup_source=fresh-production-dump

database_started=0
account_started=0
relay_started=0
network_created=0

cleanup() {
  set +e
  case $relay_name in
    t3-sovereign-restore-drill-*-relay)
      if [[ $relay_started == 1 ]]; then docker rm --force "$relay_name" >/dev/null 2>&1; fi
      ;;
  esac
  case $account_name in
    t3-sovereign-restore-drill-*-account)
      if [[ $account_started == 1 ]]; then docker rm --force "$account_name" >/dev/null 2>&1; fi
      ;;
  esac
  case $database_name in
    t3-sovereign-restore-drill-*-postgres)
      if [[ $database_started == 1 ]]; then docker rm --force "$database_name" >/dev/null 2>&1; fi
      ;;
  esac
  case $network_name in
    t3-sovereign-restore-drill-*)
      if [[ $network_created == 1 ]]; then docker network rm "$network_name" >/dev/null 2>&1; fi
      ;;
  esac
  if [[ $work_directory == /tmp/t3-sovereign-full-restore.* ]]; then
    rm -f \
      "$work_directory/account.dump" \
      "$work_directory/relay.dump" \
      "$work_directory/account.original" \
      "$work_directory/account.restored" \
      "$work_directory/relay.original" \
      "$work_directory/relay.restored" \
      "$work_directory/account.env" \
      "$work_directory/relay.env"
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
    printf 'Expected one running %s container; found %s\n' "$description" "${#matches[@]}" >&2
    return 1
  fi
  printf '%s\n' "${matches[0]}"
}

production_database=$(resolve_one t3-postgres --filter 'label=coolify.resourceName=t3-postgres')
production_account=$(resolve_one account --filter 'label=com.docker.compose.service=account')
production_relay=$(resolve_one relay --filter 'label=com.docker.compose.service=relay')

database_health=$(docker inspect "$production_database" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
if [[ $database_health != healthy ]]; then
  printf 'Production PostgreSQL must be healthy; current state: %s\n' "$database_health" >&2
  exit 1
fi

account_database_url=$(docker exec "$production_account" node -p 'process.env.T3_ACCOUNT_DATABASE_URL')
relay_database_url=$(docker exec "$production_relay" node -p 'process.env.T3_RELAY_DATABASE_URL')
account_database_host=$(
  docker exec "$production_account" \
    node -e 'process.stdout.write(new URL(process.env.T3_ACCOUNT_DATABASE_URL).hostname)'
)
relay_database_host=$(
  docker exec "$production_relay" \
    node -e 'process.stdout.write(new URL(process.env.T3_RELAY_DATABASE_URL).hostname)'
)
production_database_name=$(docker inspect "$production_database" --format '{{.Name}}')
production_database_name=${production_database_name#/}

if [[ $account_database_host != "$relay_database_host" ]] ||
  [[ $account_database_host != "$production_database_name" ]]; then
  echo 'Production account, relay, and PostgreSQL do not identify one private container.' >&2
  exit 1
fi

database_image_label=$(docker inspect "$production_database" --format '{{.Config.Image}}')
database_image=$(docker inspect "$production_database" --format '{{.Image}}')
account_image_label=$(docker inspect "$production_account" --format '{{.Config.Image}}')
account_image=$(docker inspect "$production_account" --format '{{.Image}}')
relay_image=$(docker inspect "$production_relay" --format '{{.Image}}')
if [[ $account_image != "$relay_image" ]]; then
  echo 'Production account and relay are not running the same control-plane image.' >&2
  exit 1
fi

admin_password=$(openssl rand -hex 24)
account_password=$(openssl rand -hex 24)
relay_password=$(openssl rand -hex 24)

dump_database() {
  local database_url=$1
  local output_file=$2
  docker exec -e DATABASE_URL="$database_url" "$production_database" \
    sh -c 'exec pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl' >"$output_file"
  test -s "$output_file"
  docker exec -i "$production_database" pg_restore --list <"$output_file" >/dev/null
}

manifest_for_url() {
  local database_url=$1
  local output_file=$2
  docker exec -i -e DATABASE_URL="$database_url" "$production_database" \
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

manifest_for_restored_database() {
  local database=$1
  local output_file=$2
  docker exec -i -e PGPASSWORD="$admin_password" "$database_name" \
    psql --username restore_admin --dbname "$database" -X -A -t >"$output_file" <<'SQL'
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

wait_for_container_health() {
  local container=$1
  local description=$2
  local port=$3
  local attempt
  for attempt in $(seq 1 60); do
    if docker exec "$container" node -e \
      "fetch('http://127.0.0.1:${port}/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf '%s did not become healthy.\n' "$description" >&2
  docker logs --tail 100 "$container" >&2
  return 1
}

echo 'Preparing logical dumps for the full isolated drill.'
if [[ -n $retained_backup_directory ]]; then
  if [[ ! -d $retained_backup_directory ]] || [[ -L $retained_backup_directory ]]; then
    printf 'Retained backup directory must be a non-symlink directory: %s\n' "$retained_backup_directory" >&2
    exit 1
  fi
  for required_file in \
    metadata.env \
    SHA256SUMS \
    account.dump \
    relay.dump \
    account.manifest \
    relay.manifest; do
    if [[ ! -f $retained_backup_directory/$required_file ]] ||
      [[ -L $retained_backup_directory/$required_file ]]; then
      printf 'Retained control-plane backup is missing %s.\n' "$required_file" >&2
      exit 1
    fi
  done
  if ! grep -Fqx 'format_version=1' "$retained_backup_directory/metadata.env" ||
    ! grep -Fqx 'backup_type=control-plane' "$retained_backup_directory/metadata.env"; then
    echo 'Retained control-plane backup metadata is unsupported.' >&2
    exit 1
  fi
  (
    cd "$retained_backup_directory"
    sha256sum --check --strict SHA256SUMS
  )
  install -m 600 "$retained_backup_directory/account.dump" "$work_directory/account.dump"
  install -m 600 "$retained_backup_directory/relay.dump" "$work_directory/relay.dump"
  install -m 600 "$retained_backup_directory/account.manifest" "$work_directory/account.original"
  install -m 600 "$retained_backup_directory/relay.manifest" "$work_directory/relay.original"
  docker exec -i "$production_database" pg_restore --list <"$work_directory/account.dump" >/dev/null
  docker exec -i "$production_database" pg_restore --list <"$work_directory/relay.dump" >/dev/null
  backup_source=retained-encrypted-recovery-point
  echo 'Using a retained control-plane recovery point for the full isolated drill.'
else
  dump_database "$account_database_url" "$work_directory/account.dump"
  dump_database "$relay_database_url" "$work_directory/relay.dump"
  manifest_for_url "$account_database_url" "$work_directory/account.original"
  manifest_for_url "$relay_database_url" "$work_directory/relay.original"
fi

docker network create --internal "$network_name" >/dev/null
network_created=1
if [[ $(docker network inspect "$network_name" --format '{{.Internal}}') != true ]]; then
  echo 'The drill network is not internal-only.' >&2
  exit 1
fi

docker run --detach \
  --name "$database_name" \
  --network "$network_name" \
  --network-alias restore-postgres \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=512m \
  --env POSTGRES_USER=restore_admin \
  --env POSTGRES_PASSWORD="$admin_password" \
  --env POSTGRES_DB=postgres \
  "$database_image" >/dev/null
database_started=1

for _ in $(seq 1 60); do
  if docker exec -e PGPASSWORD="$admin_password" "$database_name" \
    pg_isready --username restore_admin --dbname postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec -e PGPASSWORD="$admin_password" "$database_name" \
  pg_isready --username restore_admin --dbname postgres >/dev/null

docker exec -i \
  -e PGPASSWORD="$admin_password" \
  -e ACCOUNT_PASSWORD="$account_password" \
  -e RELAY_PASSWORD="$relay_password" \
  "$database_name" sh -c 'psql --username restore_admin --dbname postgres --set ON_ERROR_STOP=1 --set account_password="$ACCOUNT_PASSWORD" --set relay_password="$RELAY_PASSWORD"' <<'SQL'
CREATE ROLE t3_account LOGIN PASSWORD :'account_password';
CREATE ROLE t3_relay LOGIN PASSWORD :'relay_password';
CREATE DATABASE t3_account OWNER t3_account;
CREATE DATABASE t3_relay OWNER t3_relay;
SQL

docker exec -i -e PGPASSWORD="$admin_password" "$database_name" \
  pg_restore --exit-on-error --no-owner --no-acl --username restore_admin \
  --role t3_account --dbname t3_account <"$work_directory/account.dump"
docker exec -i -e PGPASSWORD="$admin_password" "$database_name" \
  pg_restore --exit-on-error --no-owner --no-acl --username restore_admin \
  --role t3_relay --dbname t3_relay <"$work_directory/relay.dump"

manifest_for_restored_database t3_account "$work_directory/account.restored"
manifest_for_restored_database t3_relay "$work_directory/relay.restored"
diff -u "$work_directory/account.original" "$work_directory/account.restored"
diff -u "$work_directory/relay.original" "$work_directory/relay.restored"

for ownership in t3_account:t3_account t3_relay:t3_relay; do
  restored_database=${ownership%%:*}
  expected_owner=${ownership#*:}
  unexpected_owner_count=$(
    docker exec -e PGPASSWORD="$admin_password" "$database_name" \
      psql --username restore_admin --dbname "$restored_database" -X -A -t \
      -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner <> '$expected_owner';"
  )
  if [[ $unexpected_owner_count != 0 ]]; then
    printf 'Restored %s contains tables not owned by %s.\n' "$restored_database" "$expected_owner" >&2
    exit 1
  fi
done

account_restore_url="postgresql://t3_account:${account_password}@restore-postgres:5432/t3_account"
relay_restore_url="postgresql://t3_relay:${relay_password}@restore-postgres:5432/t3_relay"

docker inspect "$production_account" --format '{{range .Config.Env}}{{println .}}{{end}}' |
  grep -Ev '^(T3_ACCOUNT_DATABASE_URL|T3_ACCOUNT_BASE_URL|T3_ACCOUNT_RELAY_AUDIENCE|T3_ACCOUNT_TRUSTED_ORIGINS|T3_ACCOUNT_HOST|T3_ACCOUNT_PORT|T3_APNS_ENABLED)=' \
    >"$work_directory/account.env"
cat >>"$work_directory/account.env" <<EOF
T3_ACCOUNT_DATABASE_URL=$account_restore_url
T3_ACCOUNT_BASE_URL=http://restore-account:4200
T3_ACCOUNT_RELAY_AUDIENCE=http://restore-relay:4100
T3_ACCOUNT_TRUSTED_ORIGINS=http://restore-client.invalid
T3_ACCOUNT_HOST=0.0.0.0
T3_ACCOUNT_PORT=4200
T3_APNS_ENABLED=false
EOF

docker inspect "$production_relay" --format '{{range .Config.Env}}{{println .}}{{end}}' |
  grep -Ev '^(T3_RELAY_DATABASE_URL|T3_RELAY_ISSUER|T3_RELAY_ALLOWED_ORIGINS|T3_RELAY_HOST|T3_RELAY_PORT|T3_OIDC_ISSUER|T3_OIDC_AUDIENCE|T3_OIDC_JWKS_URL|T3_MANAGED_ENDPOINT_BASE_DOMAIN|T3_MANAGED_ENDPOINT_NAMESPACE|T3_MANAGED_ENDPOINT_HTTP_SCHEME|T3_MANAGED_ENDPOINT_DIAL_ORIGIN|T3_FRPS_SERVER_ADDR|T3_FRPS_SERVER_PORT|T3_FRP_PLUGIN_HOST|T3_FRP_PLUGIN_PORT|T3_APNS_ENABLED)=' \
    >"$work_directory/relay.env"
cat >>"$work_directory/relay.env" <<EOF
T3_RELAY_DATABASE_URL=$relay_restore_url
T3_RELAY_ISSUER=http://restore-relay:4100
T3_RELAY_ALLOWED_ORIGINS=http://restore-client.invalid
T3_RELAY_HOST=0.0.0.0
T3_RELAY_PORT=4100
T3_OIDC_ISSUER=http://restore-account:4200/api/auth
T3_OIDC_AUDIENCE=http://restore-relay:4100
T3_OIDC_JWKS_URL=http://restore-account:4200/api/auth/jwks
T3_MANAGED_ENDPOINT_BASE_DOMAIN=restore.invalid
T3_MANAGED_ENDPOINT_NAMESPACE=drill
T3_MANAGED_ENDPOINT_HTTP_SCHEME=http
T3_MANAGED_ENDPOINT_DIAL_ORIGIN=http://127.0.0.1:1
T3_FRPS_SERVER_ADDR=127.0.0.1
T3_FRPS_SERVER_PORT=7000
T3_FRP_PLUGIN_HOST=127.0.0.1
T3_FRP_PLUGIN_PORT=4101
T3_APNS_ENABLED=false
EOF

echo 'Running exact deployed migrations and account provisioning against the isolated restore.'
docker run --rm --network "$network_name" --env-file "$work_directory/account.env" \
  "$account_image" node /app/account-migrate.mjs >/dev/null
docker run --rm --network "$network_name" --env-file "$work_directory/account.env" \
  "$account_image" node /app/account-provision.mjs >/dev/null
docker run --rm --network "$network_name" --env-file "$work_directory/relay.env" \
  "$relay_image" node /app/relay-migrate.mjs >/dev/null

docker run --detach \
  --name "$account_name" \
  --network "$network_name" \
  --network-alias restore-account \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --env-file "$work_directory/account.env" \
  "$account_image" node /app/account-server.mjs >/dev/null
account_started=1
wait_for_container_health "$account_name" 'Isolated account service' 4200

docker exec "$account_name" node -e \
  "Promise.all(['/api/auth/.well-known/openid-configuration','/api/auth/jwks'].map(path => fetch('http://127.0.0.1:4200' + path).then(r => { if (!r.ok) throw new Error(path + ':' + r.status) }))).catch(() => process.exit(1))"

docker run --detach \
  --name "$relay_name" \
  --network "$network_name" \
  --network-alias restore-relay \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --env-file "$work_directory/relay.env" \
  "$relay_image" /bin/sh /app/start-relay.sh >/dev/null
relay_started=1
wait_for_container_health "$relay_name" 'Isolated relay service' 4100

for container in "$database_name" "$account_name" "$relay_name"; do
  published_ports=$(docker inspect "$container" --format '{{json .HostConfig.PortBindings}}')
  if [[ $published_ports != null ]] && [[ $published_ports != '{}' ]]; then
    printf 'Drill container %s unexpectedly publishes ports: %s\n' "$container" "$published_ports" >&2
    exit 1
  fi
done

account_table_count=$(wc -l <"$work_directory/account.original" | tr -d ' ')
relay_table_count=$(wc -l <"$work_directory/relay.original" | tr -d ' ')
account_dump_bytes=$(wc -c <"$work_directory/account.dump" | tr -d ' ')
relay_dump_bytes=$(wc -c <"$work_directory/relay.dump" | tr -d ' ')
elapsed_seconds=$((SECONDS - started_at))

printf 'Full isolated restore passed: source=%s account_tables=%s account_bytes=%s relay_tables=%s relay_bytes=%s elapsed_seconds=%s database_image=%s control_image=%s\n' \
  "$backup_source" \
  "$account_table_count" \
  "$account_dump_bytes" \
  "$relay_table_count" \
  "$relay_dump_bytes" \
  "$elapsed_seconds" \
  "$database_image_label" \
  "$account_image_label"
