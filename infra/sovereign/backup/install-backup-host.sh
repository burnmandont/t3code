#!/usr/bin/env bash
set -euo pipefail

umask 077

if [[ $EUID -ne 0 ]]; then
  echo 'Run install-backup-host.sh as root.' >&2
  exit 1
fi

script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
install_root=/usr/local/libexec/sovereign-backup
config_root=/etc/sovereign-backup
backup_root=/var/lib/sovereign-backups
unit_root=/etc/systemd/system
backup_install_root=/var/lib/sovereign-backup-install-backups
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_install_directory=$backup_install_root/$timestamp

for required_file in \
  pull-backups.sh \
  prune-backups.sh \
  validate-backup-set.sh \
  run-backup-cycle.sh \
  sovereign-backup.service \
  sovereign-backup.timer; do
  if [[ ! -f $script_directory/$required_file ]]; then
    printf 'Installer input is missing %s.\n' "$required_file" >&2
    exit 1
  fi
done

install -d -m 700 "$config_root" "$backup_root" "$backup_install_directory"
install -d -m 755 "$install_root"

for existing in \
  "$install_root/pull-backups.sh" \
  "$install_root/prune-backups.sh" \
  "$install_root/validate-backup-set.sh" \
  "$install_root/run-backup-cycle.sh" \
  "$unit_root/sovereign-backup.service" \
  "$unit_root/sovereign-backup.timer"; do
  if [[ -e $existing ]]; then
    cp -a "$existing" "$backup_install_directory/$(basename "$existing")"
  fi
done

for script in pull-backups.sh prune-backups.sh validate-backup-set.sh run-backup-cycle.sh; do
  install -m 700 "$script_directory/$script" "$install_root/$script"
done
install -m 644 "$script_directory/sovereign-backup.service" "$unit_root/sovereign-backup.service"
install -m 644 "$script_directory/sovereign-backup.timer" "$unit_root/sovereign-backup.timer"

if [[ ! -f $config_root/recipient-key.pem ]]; then
  openssl req -x509 -newkey rsa:4096 -nodes -sha256 -days 3650 \
    -subj '/CN=Sovereign backup recovery key' \
    -keyout "$config_root/recipient-key.pem" \
    -out "$config_root/recipient.pem" >/dev/null 2>&1
  chmod 600 "$config_root/recipient-key.pem"
  chmod 644 "$config_root/recipient.pem"
fi
if [[ ! -f $config_root/destination.env ]]; then
  printf 'SOVEREIGN_BACKUP_ROOT=%q\nSOVEREIGN_BACKUP_MAXIMUM_AGE_SECONDS=25200\n' \
    "$backup_root" >"$config_root/destination.env"
  chmod 600 "$config_root/destination.env"
fi
if [[ ! -f $config_root/sources.tsv ]]; then
  install -m 600 /dev/null "$config_root/sources.tsv"
fi

systemctl daemon-reload
if systemctl is-enabled sovereign-backup.timer >/dev/null 2>&1; then
  timer_state=enabled
else
  timer_state=disabled
fi
printf 'Installed backup host files; timer state preserved as %s. Previous files: %s\n' \
  "$timer_state" "$backup_install_directory"
