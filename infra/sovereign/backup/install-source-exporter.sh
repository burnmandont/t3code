#!/usr/bin/env bash
set -euo pipefail

umask 077

usage() {
  echo 'Usage: install-source-exporter.sh <control-plane|remote-home> <source-id> <recipient-cert> <pull-public-key> [t3code-home]' >&2
}

if [[ $# -lt 4 ]] || [[ $# -gt 5 ]]; then
  usage
  exit 1
fi

source_kind=$1
source_id=$2
recipient_certificate=$3
pull_public_key=$4
t3code_home=${5:-}
script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

case $source_kind in
  control-plane)
    exporter_name=export-control-plane.sh
    if [[ -n $t3code_home ]]; then usage; exit 1; fi
    ;;
  remote-home)
    exporter_name=export-remote-home.sh
    if [[ -z $t3code_home ]] || [[ ! -d $t3code_home/userdata ]]; then
      printf 'Remote T3 home is missing userdata: %s\n' "$t3code_home" >&2
      exit 1
    fi
    ;;
  *) usage; exit 1 ;;
esac

if [[ ! $source_id =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] ||
  [[ ! -f $recipient_certificate ]] || [[ ! -f $pull_public_key ]] ||
  [[ ! -f $script_directory/$exporter_name ]]; then
  usage
  exit 1
fi
for required_tool in flock ionice nice openssl ssh-keygen; do
  command -v "$required_tool" >/dev/null 2>&1 || {
    printf 'Required tool is missing: %s\n' "$required_tool" >&2
    exit 1
  }
done
if [[ $source_kind == control-plane ]]; then
  command -v docker >/dev/null 2>&1 || { echo 'Docker is required.' >&2; exit 1; }
else
  command -v sqlite3 >/dev/null 2>&1 || { echo 'sqlite3 is required.' >&2; exit 1; }
fi

read -r public_key_type public_key_body _ <"$pull_public_key"
if [[ $public_key_type != ssh-ed25519 ]] || [[ -z $public_key_body ]]; then
  echo 'Pull public key must be one Ed25519 key.' >&2
  exit 1
fi
ssh-keygen -lf "$pull_public_key" >/dev/null

install_root=$HOME/.local/lib/sovereign-backup
config_root=$HOME/.config/sovereign-backup
authorized_keys=$HOME/.ssh/authorized_keys
backup_root=$HOME/.local/state/sovereign-backup-install-backups
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_directory=$backup_root/$timestamp
install -d -m 700 "$install_root" "$config_root" "$HOME/.ssh" "$backup_directory"
touch "$authorized_keys"
chmod 600 "$authorized_keys"

for existing in "$install_root/$exporter_name" "$config_root/source.env" "$config_root/recipient.pem" "$authorized_keys"; do
  if [[ -e $existing ]]; then
    cp -a "$existing" "$backup_directory/$(basename "$existing")"
  fi
done

install -m 700 "$script_directory/$exporter_name" "$install_root/$exporter_name"
install -m 644 "$recipient_certificate" "$config_root/recipient.pem"
{
  printf 'SOVEREIGN_BACKUP_SOURCE_ID=%q\n' "$source_id"
  if [[ $source_kind == remote-home ]]; then
    printf 'T3CODE_HOME=%q\n' "$t3code_home"
  fi
} >"$config_root/source.env.new"
chmod 600 "$config_root/source.env.new"
mv "$config_root/source.env.new" "$config_root/source.env"

entry_marker=sovereign-backup-$source_id
existing_count=$(awk -v marker="$entry_marker" '$NF == marker { count++ } END { print count + 0 }' "$authorized_keys")
if ((existing_count > 1)); then
  printf 'Refusing to update %s duplicate authorized_keys entries.\n' "$existing_count" >&2
  exit 1
fi
awk -v marker="$entry_marker" '$NF != marker { print }' "$authorized_keys" >"$authorized_keys.new"
forced_command="exec nice -n 10 ionice -c 3 $install_root/$exporter_name"
printf '%s %s %s %s\n' \
  "no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding,command=\"$forced_command\"" \
  "$public_key_type" \
  "$public_key_body" \
  "$entry_marker" >>"$authorized_keys.new"
chmod 600 "$authorized_keys.new"
mv "$authorized_keys.new" "$authorized_keys"

printf 'Installed %s exporter for %s; previous files: %s\n' \
  "$source_kind" "$source_id" "$backup_directory"
