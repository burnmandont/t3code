#!/usr/bin/env bash
set -euo pipefail

umask 077

if [[ $# -ne 1 ]] || [[ ! -f $1 ]] || [[ -L $1 ]]; then
  echo 'Usage: validate-retained-remote-home.sh <decrypted-remote-home.tar.gz>' >&2
  exit 1
fi

archive_path=$1
work_directory=$(mktemp -d /tmp/sovereign-retained-home-restore.XXXXXX)
cleanup() {
  set +e
  if [[ $work_directory == /tmp/sovereign-retained-home-restore.* ]]; then
    find "$work_directory" -depth -mindepth 1 -delete >/dev/null 2>&1
    rmdir "$work_directory" >/dev/null 2>&1
  fi
}
trap cleanup EXIT

if tar --list --gzip --file "$archive_path" |
  grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo 'The retained archive contains an unsafe path.' >&2
  exit 1
fi
tar --extract --gzip --file "$archive_path" --directory "$work_directory" --no-same-owner

for required in metadata.env SHA256SUMS sqlite.manifest secrets.manifest userdata.sha256 userdata/state.sqlite; do
  if [[ ! -f $work_directory/$required ]] || [[ -L $work_directory/$required ]]; then
    printf 'The retained archive is missing %s.\n' "$required" >&2
    exit 1
  fi
done

(
  cd "$work_directory"
  sha256sum --check --strict --status SHA256SUMS
  sha256sum --check --strict --status userdata.sha256
)
if ! grep -Fqx 'format_version=1' "$work_directory/metadata.env" ||
  ! grep -Fqx 'backup_type=remote-home' "$work_directory/metadata.env"; then
  echo 'The retained archive metadata is not a supported remote-home backup.' >&2
  exit 1
fi
if [[ $(sqlite3 "$work_directory/userdata/state.sqlite" 'PRAGMA integrity_check;') != ok ]]; then
  echo 'The retained SQLite database failed its integrity check.' >&2
  exit 1
fi

actual_sqlite_manifest=$work_directory/sqlite.actual
: >"$actual_sqlite_manifest"
while IFS= read -r table; do
  escaped_table=${table//\"/\"\"}
  row_count=$(sqlite3 "$work_directory/userdata/state.sqlite" "SELECT count(*) FROM \"$escaped_table\";")
  printf '%s|%s\n' "$table" "$row_count" >>"$actual_sqlite_manifest"
done < <(sqlite3 "$work_directory/userdata/state.sqlite" \
  "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;")
diff -u "$work_directory/sqlite.manifest" "$actual_sqlite_manifest"

actual_secrets_manifest=$work_directory/secrets.actual
if [[ -d $work_directory/userdata/secrets ]]; then
  (
    cd "$work_directory/userdata/secrets"
    find . -type f -print0 | sort -z | xargs -0 -r sha256sum
  ) >"$actual_secrets_manifest"
else
  : >"$actual_secrets_manifest"
fi
diff -u "$work_directory/secrets.manifest" "$actual_secrets_manifest"

source_id=$(sed -n 's/^source_id=//p' "$work_directory/metadata.env")
created_at=$(sed -n 's/^created_at=//p' "$work_directory/metadata.env")
table_count=$(wc -l <"$actual_sqlite_manifest" | tr -d ' ')
printf 'Retained remote-home restore passed: source=%s created_at=%s tables=%s\n' \
  "$source_id" "$created_at" "$table_count"
