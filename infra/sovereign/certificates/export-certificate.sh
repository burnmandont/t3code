#!/bin/sh
set -eu

certificate_root=${T3_EDGE_CERTIFICATE_ROOT:-/etc/nginx/tls/t3-sovereign/current}
fullchain=$certificate_root/fullchain.pem
private_key=$certificate_root/privkey.pem
validator=${T3_CERTIFICATE_VALIDATOR:-/usr/local/libexec/t3-sovereign/validate-certificate.sh}

case "${SSH_ORIGINAL_COMMAND:-}" in
  capabilities)
    echo 't3-sovereign-certificate-exporter'
    exit 0
    ;;
  fetch) ;;
  *)
    echo "unsupported certificate exporter command" >&2
    exit 77
    ;;
esac

"$validator" "$fullchain" "$private_key" >/dev/null

certificate_bytes=$(wc -c < "$fullchain" | tr -d ' ')
key_bytes=$(wc -c < "$private_key" | tr -d ' ')
printf '%s %s\n' "$certificate_bytes" "$key_bytes"
cat "$fullchain" "$private_key"
