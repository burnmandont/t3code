#!/usr/bin/env bash
set -euo pipefail

umask 077

config_file=${SOVEREIGN_BACKUP_DESTINATION_CONFIG:-/etc/sovereign-backup/destination.env}
sources_file=${SOVEREIGN_BACKUP_SOURCES_FILE:-/etc/sovereign-backup/sources.tsv}
# shellcheck source=/dev/null
source "$config_file"
backup_root=${SOVEREIGN_BACKUP_ROOT:-/var/lib/sovereign-backups}
recipient_certificate=${SOVEREIGN_BACKUP_RECIPIENT_CERT:-/etc/sovereign-backup/recipient.pem}
recipient_private_key=${SOVEREIGN_BACKUP_RECIPIENT_KEY:-/etc/sovereign-backup/recipient-key.pem}
maximum_age_seconds=${SOVEREIGN_BACKUP_MAXIMUM_AGE_SECONDS:-25200}
now=$(date -u +%s)
source_count=0
declare -A seen_sources=()

while IFS=$'\t' read -r source_id _; do
  if [[ -z $source_id ]] || [[ ${source_id:0:1} == '#' ]]; then
    continue
  fi
  source_count=$((source_count + 1))
  if [[ ! $source_id =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] ||
    [[ -n ${seen_sources[$source_id]:-} ]]; then
    printf 'Invalid or duplicate backup source identifier: %s\n' "$source_id" >&2
    exit 1
  fi
  seen_sources[$source_id]=1
  source_directory=$backup_root/$source_id
  if [[ ! -d $source_directory ]] || [[ -L $source_directory ]]; then
    printf 'No retained backup directory exists for %s.\n' "$source_id" >&2
    exit 1
  fi
  newest=$(find "$source_directory" -maxdepth 1 -type f \
    -name "$source_id-????????T??????Z.cms" -printf '%f\n' | sort -r | head -n 1)
  if [[ -z $newest ]]; then
    printf 'No retained backup exists for %s.\n' "$source_id" >&2
    exit 1
  fi

  backup_file=$source_directory/$newest
  checksum_file=$backup_file.sha256
  if [[ ! -f $checksum_file ]] || [[ -L $checksum_file ]]; then
    printf 'Encrypted checksum is missing for %s.\n' "$backup_file" >&2
    exit 1
  fi
  (
    cd "$source_directory"
    sha256sum --check --status "${checksum_file##*/}"
  )
  metadata=$(openssl cms -decrypt -binary -inform DER \
    -in "$backup_file" \
    -recip "$recipient_certificate" \
    -inkey "$recipient_private_key" |
    tar --extract --gzip --to-stdout --file - metadata.env)
  if ! grep -Fqx "source_id=$source_id" <<<"$metadata"; then
    printf 'Backup metadata does not match source %s.\n' "$source_id" >&2
    exit 1
  fi
  created_at=$(sed -n 's/^created_at=//p' <<<"$metadata")
  if [[ ! $created_at =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
    printf 'Backup metadata has an invalid creation time for %s.\n' "$source_id" >&2
    exit 1
  fi
  created_epoch=$(date -u -d "$created_at" +%s)
  age=$((now - created_epoch))
  if ((age < 0 || age > maximum_age_seconds)); then
    printf 'Newest backup for %s is outside the freshness limit: %s seconds.\n' "$source_id" "$age" >&2
    exit 1
  fi
  printf 'Backup freshness passed: source=%s age_seconds=%s file=%s\n' "$source_id" "$age" "$backup_file"
done <"$sources_file"

if ((source_count == 0)); then
  echo 'No Sovereign backup sources are configured.' >&2
  exit 1
fi
