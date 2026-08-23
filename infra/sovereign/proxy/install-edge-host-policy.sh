#!/bin/sh
set -eu

usage() {
  echo "usage: $0 VERSIONED_SSHD_CONFIG" >&2
  exit 64
}

[ "$#" -eq 1 ] || usage
[ "$(id -u)" -eq 0 ] || {
  echo "edge host policy installation must run as root" >&2
  exit 77
}

versioned_config=$1
[ -s "$versioned_config" ] || {
  echo "SSH configuration is missing or empty: $versioned_config" >&2
  exit 66
}

command -v firewall-cmd >/dev/null 2>&1 || {
  echo "firewalld is required" >&2
  exit 69
}
firewall-cmd --state >/dev/null

live_config=/etc/ssh/sshd_config.d/20-t3-sovereign-hardening.conf
backup_root=/etc/ssh/t3-sovereign-backups
backup_dir=$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-$$
install -d -m 700 "$backup_dir"

had_live_config=false
if [ -e "$live_config" ]; then
  cp -a "$live_config" "$backup_dir/20-t3-sovereign-hardening.conf"
  had_live_config=true
fi

rollback_sshd() {
  if [ "$had_live_config" = true ]; then
    cp -a "$backup_dir/20-t3-sovereign-hardening.conf" "$live_config"
  else
    rm -f "$live_config"
  fi
  /usr/sbin/sshd -t && systemctl reload sshd || true
}

install -o root -g root -m 600 "$versioned_config" "$live_config"
if ! /usr/sbin/sshd -t; then
  rollback_sshd
  echo "sshd rejected the versioned policy; rolled back" >&2
  exit 78
fi
if ! systemctl reload sshd; then
  rollback_sshd
  echo "sshd could not reload the versioned policy; rolled back" >&2
  exit 78
fi

# Named services are the single source of truth. Remove the historical,
# redundant raw-port allowances without closing any of these ports.
for service in ssh http https; do
  if ! firewall-cmd --permanent --zone=public --query-service="$service" >/dev/null; then
    firewall-cmd --permanent --zone=public --add-service="$service" >/dev/null
  fi
  if ! firewall-cmd --zone=public --query-service="$service" >/dev/null; then
    firewall-cmd --zone=public --add-service="$service" >/dev/null
  fi
done

for port in 22/tcp 80/tcp 443/tcp; do
  if firewall-cmd --permanent --zone=public --query-port="$port" >/dev/null; then
    firewall-cmd --permanent --zone=public --remove-port="$port" >/dev/null
  fi
  if firewall-cmd --zone=public --query-port="$port" >/dev/null; then
    firewall-cmd --zone=public --remove-port="$port" >/dev/null
  fi
done

for scope in runtime permanent; do
  if [ "$scope" = permanent ]; then
    scope_flag=--permanent
  else
    scope_flag=
  fi

  if firewall-cmd $scope_flag --zone=public --query-service=cockpit >/dev/null; then
    firewall-cmd $scope_flag --zone=public --remove-service=cockpit >/dev/null
  fi
done

echo "installed edge SSH/firewall policy; backup: $backup_dir"
firewall-cmd --zone=public --list-all
