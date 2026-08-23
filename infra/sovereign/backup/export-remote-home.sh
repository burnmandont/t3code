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
t3code_home=${T3CODE_HOME:-$HOME/.local/state/t3-sovereign}
if [[ ! $source_id =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo 'SOVEREIGN_BACKUP_SOURCE_ID must be a lowercase backup identifier.' >&2
  exit 1
fi

userdata_directory=$t3code_home/userdata
source_database=$userdata_directory/state.sqlite
if [[ ! -f $source_database ]]; then
  printf 'T3 SQLite database not found at %s.\n' "$source_database" >&2
  exit 1
fi

lock_file=${XDG_RUNTIME_DIR:-/tmp}/sovereign-backup-remote-home-${UID}.lock
exec 9>"$lock_file"
if ! flock -n 9; then
  echo 'A remote-home backup export is already running.' >&2
  exit 1
fi

work_directory=$(mktemp -d /tmp/sovereign-remote-home-backup.XXXXXX)
staging_directory=$work_directory/staging
cleanup() {
  set +e
  if [[ $work_directory == /tmp/sovereign-remote-home-backup.* ]]; then
    find "$work_directory" -depth -mindepth 1 -delete >/dev/null 2>&1
    rmdir "$work_directory" >/dev/null 2>&1
  fi
}
trap cleanup EXIT

sqlite_manifest() {
  local database=$1
  local output_file=$2
  local table escaped_table row_count
  : >"$output_file"
  while IFS= read -r table; do
    escaped_table=${table//\"/\"\"}
    row_count=$(sqlite3 "$database" "SELECT count(*) FROM \"$escaped_table\";")
    printf '%s|%s\n' "$table" "$row_count" >>"$output_file"
  done < <(sqlite3 "$database" "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;")
}

secret_manifest() {
  local directory=$1
  local output_file=$2
  if [[ ! -d $directory ]]; then
    : >"$output_file"
    return
  fi
  (
    cd "$directory"
    find . -type f -print0 | sort -z | xargs -0 -r sha256sum
  ) >"$output_file"
}

mkdir -p "$staging_directory/userdata"
sqlite3 "$source_database" '.timeout 10000' ".backup '$staging_directory/userdata/state.sqlite'"
test -s "$staging_directory/userdata/state.sqlite"
if [[ $(sqlite3 "$staging_directory/userdata/state.sqlite" 'PRAGMA integrity_check;') != ok ]]; then
  echo 'The SQLite backup failed its integrity check.' >&2
  exit 1
fi

for relative_path in environment-id keybindings.json server-runtime.json settings.json; do
  if [[ -e $userdata_directory/$relative_path ]]; then
    cp -a "$userdata_directory/$relative_path" "$staging_directory/userdata/$relative_path"
  fi
done
for relative_directory in attachments secrets; do
  if [[ -d $userdata_directory/$relative_directory ]]; then
    cp -a "$userdata_directory/$relative_directory" "$staging_directory/userdata/$relative_directory"
  fi
done

sqlite_manifest "$staging_directory/userdata/state.sqlite" "$staging_directory/sqlite.manifest"
secret_manifest "$staging_directory/userdata/secrets" "$staging_directory/secrets.manifest"
{
  printf 'format_version=1\n'
  printf 'backup_type=remote-home\n'
  printf 'source_id=%s\n' "$source_id"
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'source_host=%s\n' "$(hostname -f 2>/dev/null || hostname)"
} >"$staging_directory/metadata.env"

(
  cd "$staging_directory"
  find userdata -type f -print0 | sort -z | xargs -0 sha256sum >userdata.sha256
  sha256sum metadata.env sqlite.manifest secrets.manifest userdata.sha256 >SHA256SUMS
  tar --create --gzip --file - \
    metadata.env SHA256SUMS sqlite.manifest secrets.manifest userdata.sha256 userdata
) | openssl cms -encrypt -binary -aes-256-gcm -outform DER "$recipient_certificate"
