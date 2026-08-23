#!/bin/sh
set -eu
umask 077

usage() {
  echo "usage: $0 nginx|traefik" >&2
  exit 64
}

[ "$#" -eq 1 ] || usage
target_kind=$1
case "$target_kind" in
  nginx|traefik) ;;
  *) usage ;;
esac

case "${SSH_ORIGINAL_COMMAND:-}" in
  capabilities)
    echo "t3-sovereign-certificate-receiver $target_kind"
    exit 0
    ;;
  install) ;;
  *)
    echo "unsupported certificate receiver command" >&2
    exit 77
    ;;
esac

IFS=' ' read -r certificate_bytes key_bytes
for byte_count in "$certificate_bytes" "$key_bytes"; do
  case "$byte_count" in
    ''|*[!0-9]*)
      echo "invalid certificate receiver frame" >&2
      exit 65
      ;;
  esac
done

if [ "$certificate_bytes" -gt 1048576 ] || [ "$key_bytes" -gt 65536 ]; then
  echo "certificate receiver frame exceeds its size limit" >&2
  exit 65
fi

work_dir=$(mktemp -d /var/tmp/t3-certificate-receiver.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

dd bs=1 count="$certificate_bytes" of="$work_dir/fullchain.pem" status=none
dd bs=1 count="$key_bytes" of="$work_dir/privkey.pem" status=none

extra_byte=$work_dir/extra
dd bs=1 count=1 of="$extra_byte" status=none || true
if [ -s "$extra_byte" ]; then
  echo "certificate receiver frame has trailing data" >&2
  exit 65
fi

chmod 644 "$work_dir/fullchain.pem"
chmod 600 "$work_dir/privkey.pem"

installer=${T3_CERTIFICATE_INSTALLER:-/usr/local/libexec/t3-sovereign/install-certificate.sh}
[ -x "$installer" ] || {
  echo "certificate installer is not installed" >&2
  exit 69
}

"$installer" \
  "$target_kind" \
  "$work_dir/fullchain.pem" \
  "$work_dir/privkey.pem"
