#!/bin/sh
set -eu

usage() {
  echo "usage: $0 FULLCHAIN_PEM PRIVATE_KEY_PEM [MINIMUM_VALID_SECONDS]" >&2
  exit 64
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage

fullchain=$1
private_key=$2
minimum_valid_seconds=${3:-604800}

case "$minimum_valid_seconds" in
  ''|*[!0-9]*)
    echo "minimum validity must be a non-negative integer" >&2
    exit 64
    ;;
esac

for command_name in openssl cmp mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "required command not found: $command_name" >&2
    exit 69
  }
done

[ -s "$fullchain" ] || {
  echo "certificate is missing or empty: $fullchain" >&2
  exit 66
}

[ -s "$private_key" ] || {
  echo "private key is missing or empty: $private_key" >&2
  exit 66
}

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/t3-certificate.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

openssl x509 -in "$fullchain" -noout >/dev/null
openssl pkey -in "$private_key" -check -noout >/dev/null

openssl x509 -in "$fullchain" -pubkey -noout > "$work_dir/certificate.pub"
openssl pkey -in "$private_key" -pubout > "$work_dir/private-key.pub"

if ! cmp -s "$work_dir/certificate.pub" "$work_dir/private-key.pub"; then
  echo "certificate and private key do not match" >&2
  exit 65
fi

for hostname in \
  code.moondiner.com \
  auth.moondiner.com \
  relay.moondiner.com \
  observe.moondiner.com \
  connect.moondiner.com \
  probe.connect.moondiner.com
do
  if ! openssl x509 -in "$fullchain" -noout -checkhost "$hostname" >/dev/null; then
    echo "certificate does not cover $hostname" >&2
    exit 65
  fi
done

# A probe hostname proves wildcard behavior, but require the literal wildcard
# SAN too so a one-off probe certificate can never pass this gate.
if ! openssl x509 -in "$fullchain" -noout -ext subjectAltName |
  grep -Fq 'DNS:*.connect.moondiner.com'
then
  echo "certificate is missing DNS:*.connect.moondiner.com" >&2
  exit 65
fi

if ! openssl x509 -in "$fullchain" -noout -checkend "$minimum_valid_seconds"; then
  echo "certificate expires in less than $minimum_valid_seconds seconds" >&2
  exit 65
fi

openssl x509 \
  -in "$fullchain" \
  -noout \
  -subject \
  -issuer \
  -startdate \
  -enddate \
  -fingerprint \
  -sha256
