#!/bin/sh
set -eu

[ "$#" -eq 1 ] || {
  echo "usage: $0 PUBLIC_KEY_FILE" >&2
  exit 64
}
[ "$(id -u)" -eq 0 ] || {
  echo "SSH access removal must run as root" >&2
  exit 77
}

public_key_file=$1
[ -s "$public_key_file" ] || {
  echo "public key is missing or empty: $public_key_file" >&2
  exit 66
}

key_body=$(awk 'NR == 1 { print $2 }' "$public_key_file")
case "$key_body" in
  ''|*[!A-Za-z0-9+/=]*)
    echo "invalid SSH public key" >&2
    exit 65
    ;;
esac

authorized_keys=/root/.ssh/authorized_keys
matches=$(awk -v key_body="$key_body" 'index($0, key_body) { count++ } END { print count + 0 }' "$authorized_keys")
[ "$matches" -eq 1 ] || {
  echo "expected exactly one authorized_keys entry, found $matches" >&2
  exit 73
}

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=$authorized_keys.t3-sovereign-$timestamp
temporary=$authorized_keys.$$
cp -a "$authorized_keys" "$backup"
awk -v key_body="$key_body" '!index($0, key_body) { print }' "$authorized_keys" > "$temporary"
chmod 600 "$temporary"
mv -f "$temporary" "$authorized_keys"

echo "removed SSH access; backup: $backup"
