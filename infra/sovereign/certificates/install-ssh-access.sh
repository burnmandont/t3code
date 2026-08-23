#!/bin/sh
set -eu

usage() {
  echo "usage: $0 export|traefik PUBLIC_KEY_FILE" >&2
  exit 64
}

[ "$#" -eq 2 ] || usage
[ "$(id -u)" -eq 0 ] || {
  echo "SSH access installation must run as root" >&2
  exit 77
}

access_kind=$1
public_key_file=$2
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

[ -s "$public_key_file" ] || {
  echo "public key is missing or empty: $public_key_file" >&2
  exit 66
}
ssh-keygen -l -f "$public_key_file" >/dev/null

public_key=$(awk 'NR == 1 { print $1 " " $2 }' "$public_key_file")
case "$public_key" in
  ssh-ed25519\ *) ;;
  *)
    echo "a dedicated Ed25519 public key is required" >&2
    exit 65
    ;;
esac

install -d -m 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

if grep -Fq "$public_key" /root/.ssh/authorized_keys; then
  echo "refusing to reuse a public key already present in authorized_keys" >&2
  exit 73
fi

case "$access_kind" in
  export)
    install -d -m 700 /usr/local/libexec/t3-sovereign
    install -m 700 \
      "$script_dir/export-certificate.sh" \
      "$script_dir/validate-certificate.sh" \
      /usr/local/libexec/t3-sovereign/
    restriction='restrict,command="/usr/local/libexec/t3-sovereign/export-certificate.sh"'
    ;;
  traefik)
    install -d -m 700 /usr/local/libexec/t3-sovereign
    install -m 700 \
      "$script_dir/install-certificate.sh" \
      "$script_dir/receive-certificate.sh" \
      "$script_dir/validate-certificate.sh" \
      /usr/local/libexec/t3-sovereign/
    restriction='restrict,command="/usr/local/libexec/t3-sovereign/receive-certificate.sh traefik"'
    ;;
  *)
    usage
    ;;
esac

printf '%s %s\n' "$restriction" "$public_key" >> /root/.ssh/authorized_keys
echo "installed $access_kind access for $(ssh-keygen -lf "$public_key_file")"
