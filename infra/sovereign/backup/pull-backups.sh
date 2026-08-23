#!/usr/bin/env bash
set -euo pipefail

umask 077

config_file=${SOVEREIGN_BACKUP_DESTINATION_CONFIG:-/etc/sovereign-backup/destination.env}
sources_file=${SOVEREIGN_BACKUP_SOURCES_FILE:-/etc/sovereign-backup/sources.tsv}
if [[ ! -f $config_file ]] || [[ ! -f $sources_file ]]; then
  echo 'Sovereign backup destination configuration is incomplete.' >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$config_file"
backup_root=${SOVEREIGN_BACKUP_ROOT:-/var/lib/sovereign-backups}
recipient_certificate=${SOVEREIGN_BACKUP_RECIPIENT_CERT:-/etc/sovereign-backup/recipient.pem}
recipient_private_key=${SOVEREIGN_BACKUP_RECIPIENT_KEY:-/etc/sovereign-backup/recipient-key.pem}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
overall_status=0
source_count=0
declare -A seen_sources=()

if [[ ! -d $backup_root ]] || [[ -L $backup_root ]]; then
  printf 'Backup root must be an existing, non-symlink directory: %s\n' "$backup_root" >&2
  exit 1
fi

while IFS=$'\t' read -r source_id ssh_user ssh_host ssh_port identity_file known_hosts_file extra; do
  if [[ -z $source_id ]] || [[ ${source_id:0:1} == '#' ]]; then
    continue
  fi
  source_count=$((source_count + 1))
  if [[ -n ${extra:-} ]] || [[ ! $source_id =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] ||
    [[ -z $ssh_user ]] || [[ -z $ssh_host ]] || [[ ! $ssh_port =~ ^[0-9]+$ ]] ||
    [[ ! -f $identity_file ]] || [[ ! -f $known_hosts_file ]] ||
    [[ -n ${seen_sources[$source_id]:-} ]]; then
    printf 'Invalid backup source row for %s.\n' "$source_id" >&2
    overall_status=1
    continue
  fi
  seen_sources[$source_id]=1

  source_directory=$backup_root/$source_id
  install -d -m 700 "$source_directory"
  temporary_file=$source_directory/.${source_id}-${timestamp}.cms.partial
  final_file=$source_directory/${source_id}-${timestamp}.cms
  rm -f -- "$temporary_file"

  printf 'Pulling encrypted backup for %s.\n' "$source_id"
  if timeout 45m ssh -n \
    -o BatchMode=yes \
    -o ConnectTimeout=15 \
    -o IdentitiesOnly=yes \
    -o PasswordAuthentication=no \
    -o ServerAliveCountMax=3 \
    -o ServerAliveInterval=30 \
    -o StrictHostKeyChecking=yes \
    -o "UserKnownHostsFile=$known_hosts_file" \
    -i "$identity_file" \
    -p "$ssh_port" \
    -- "$ssh_user@$ssh_host" export-backup >"$temporary_file"; then
    if [[ ! -s $temporary_file ]] ||
      ! openssl cms -decrypt -binary -inform DER \
        -in "$temporary_file" \
        -recip "$recipient_certificate" \
        -inkey "$recipient_private_key" |
        tar --list --gzip --file - >/dev/null; then
      printf 'Encrypted backup validation failed for %s.\n' "$source_id" >&2
      rm -f -- "$temporary_file"
      overall_status=1
      continue
    fi
    chmod 600 "$temporary_file"
    mv "$temporary_file" "$final_file"
    (
      cd "$source_directory"
      sha256sum "${final_file##*/}" >"${final_file##*/}.sha256"
    )
    printf 'Retained encrypted backup for %s at %s.\n' "$source_id" "$final_file"
  else
    printf 'Backup pull failed for %s.\n' "$source_id" >&2
    rm -f -- "$temporary_file"
    overall_status=1
  fi
done <"$sources_file"

if ((source_count == 0)); then
  echo 'No Sovereign backup sources are configured.' >&2
  exit 1
fi

exit "$overall_status"
