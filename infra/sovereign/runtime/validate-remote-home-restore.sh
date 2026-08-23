#!/usr/bin/env bash
set -euo pipefail

umask 077

started_at=$SECONDS
t3code_home=${T3CODE_HOME:-$HOME/.local/state/t3-sovereign}
userdata_directory="$t3code_home/userdata"
source_database="$userdata_directory/state.sqlite"
work_directory=$(mktemp -d /tmp/t3-sovereign-home-restore.XXXXXX)
snapshot_database="$work_directory/state.sqlite"
staging_directory="$work_directory/staging"
restore_directory="$work_directory/restored"
archive_path="$work_directory/t3-home-critical.tar.gz"

cleanup() {
  set +e
  if [[ $work_directory == /tmp/t3-sovereign-home-restore.* ]]; then
    find "$work_directory" -depth -mindepth 1 -delete >/dev/null 2>&1
    rmdir "$work_directory" >/dev/null 2>&1
  fi
}
trap cleanup EXIT

if [[ ! -f $source_database ]]; then
  printf 'T3 SQLite database not found at %s.\n' "$source_database" >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
  service_state=$(systemctl --user is-active t3code.service 2>/dev/null || true)
else
  service_state=unknown
fi

sqlite_manifest() {
  local database=$1
  local output_file=$2
  local table escaped_table row_count
  : >"$output_file"
  while IFS= read -r table; do
    escaped_table=${table//\"/\"\"}
    row_count=$(sqlite3 "$database" "SELECT count(*) FROM \"$escaped_table\";")
    printf '%s|%s\n' "$table" "$row_count" >>"$output_file"
  done < <(
    sqlite3 "$database" \
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;"
  )
}

critical_count() {
  local database=$1
  local table=$2
  if sqlite3 "$database" \
    "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = '$table';" |
    grep -qx 1; then
    sqlite3 "$database" "SELECT count(*) FROM \"$table\";"
  else
    printf '0\n'
  fi
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

echo 'Creating a transactionally consistent T3 SQLite snapshot.'
sqlite3 "$source_database" ".timeout 10000" ".backup '$snapshot_database'"
test -s "$snapshot_database"
if [[ $(sqlite3 "$snapshot_database" 'PRAGMA integrity_check;') != ok ]]; then
  echo 'The SQLite snapshot failed its integrity check.' >&2
  exit 1
fi

mkdir -p "$staging_directory/userdata" "$restore_directory"
install -m 600 "$snapshot_database" "$staging_directory/userdata/state.sqlite"

for relative_path in \
  environment-id \
  keybindings.json \
  server-runtime.json \
  settings.json; do
  if [[ -e $userdata_directory/$relative_path ]]; then
    cp -a "$userdata_directory/$relative_path" "$staging_directory/userdata/$relative_path"
  fi
done

for relative_directory in attachments secrets; do
  if [[ -d $userdata_directory/$relative_directory ]]; then
    cp -a "$userdata_directory/$relative_directory" "$staging_directory/userdata/$relative_directory"
  fi
done

tar --create --gzip --file "$archive_path" --directory "$staging_directory" userdata
chmod 600 "$archive_path"
tar --list --gzip --file "$archive_path" >/dev/null
tar --extract --gzip --file "$archive_path" --directory "$restore_directory"

restored_database="$restore_directory/userdata/state.sqlite"
test -s "$restored_database"
if [[ $(sqlite3 "$restored_database" 'PRAGMA integrity_check;') != ok ]]; then
  echo 'The restored T3 SQLite database failed its integrity check.' >&2
  exit 1
fi

sqlite_manifest "$snapshot_database" "$work_directory/source.manifest"
sqlite_manifest "$restored_database" "$work_directory/restored.manifest"
diff -u "$work_directory/source.manifest" "$work_directory/restored.manifest"

if [[ -f $userdata_directory/environment-id ]]; then
  cmp "$userdata_directory/environment-id" "$restore_directory/userdata/environment-id"
fi
secret_manifest "$staging_directory/userdata/secrets" "$work_directory/source-secrets.manifest"
secret_manifest "$restore_directory/userdata/secrets" "$work_directory/restored-secrets.manifest"
cmp "$work_directory/source-secrets.manifest" "$work_directory/restored-secrets.manifest"

table_count=$(wc -l <"$work_directory/source.manifest" | tr -d ' ')
project_count=$(critical_count "$restored_database" projection_projects)
thread_count=$(critical_count "$restored_database" projection_threads)
message_count=$(critical_count "$restored_database" projection_thread_messages)
event_count=$(critical_count "$restored_database" orchestration_events)
if [[ -d $restore_directory/userdata/secrets ]]; then
  secret_count=$(find "$restore_directory/userdata/secrets" -type f | wc -l | tr -d ' ')
else
  secret_count=0
fi
archive_bytes=$(wc -c <"$archive_path" | tr -d ' ')
elapsed_seconds=$((SECONDS - started_at))

printf 'Remote home restore passed: service=%s tables=%s projects=%s threads=%s messages=%s events=%s secrets=%s archive_bytes=%s elapsed_seconds=%s\n' \
  "$service_state" \
  "$table_count" \
  "$project_count" \
  "$thread_count" \
  "$message_count" \
  "$event_count" \
  "$secret_count" \
  "$archive_bytes" \
  "$elapsed_seconds"
