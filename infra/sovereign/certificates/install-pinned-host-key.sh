#!/bin/sh
set -eu

usage() {
  echo "usage: $0 t3-edge|t3-coolify SSH_HOST_PUBLIC_KEY" >&2
  exit 64
}

[ "$#" -eq 2 ] || usage
[ "$(id -u)" -eq 0 ] || {
  echo "host-key installation must run as root" >&2
  exit 77
}

host_alias=$1
host_key_file=$2
case "$host_alias" in
  t3-edge|t3-coolify) ;;
  *) usage ;;
esac

[ -s "$host_key_file" ] || {
  echo "SSH host public key is missing or empty: $host_key_file" >&2
  exit 66
}
ssh-keygen -l -f "$host_key_file"

host_key=$(awk 'NR == 1 { print $1 " " $2 }' "$host_key_file")
case "$host_key" in
  ssh-ed25519\ *) ;;
  *)
    echo "an Ed25519 SSH host public key is required" >&2
    exit 65
    ;;
esac

key_root=${T3_DISTRIBUTION_KEY_ROOT:-/etc/t3-sovereign/ssh}
known_hosts=$key_root/known_hosts
install -d -m 700 "$key_root"
touch "$known_hosts"
chmod 600 "$known_hosts"

temporary=$known_hosts.$$
awk -v host_alias="$host_alias" '$1 != host_alias { print }' "$known_hosts" > "$temporary"
printf '%s %s\n' "$host_alias" "$host_key" >> "$temporary"
chmod 600 "$temporary"
mv -f "$temporary" "$known_hosts"

echo "pinned $host_alias as $(ssh-keygen -lf "$host_key_file")"
