#!/bin/sh
set -eu
umask 077

config_file=${T3_PULL_CONFIG:-/etc/t3-sovereign/pull.env}
[ -r "$config_file" ] || {
  echo "certificate pull configuration is not readable: $config_file" >&2
  exit 66
}

# shellcheck disable=SC1090
. "$config_file"
: "${T3_SSH_CONFIG:?T3_SSH_CONFIG is required}"
: "${T3_EDGE_SSH:?T3_EDGE_SSH is required}"
: "${T3_COOLIFY_SSH:?T3_COOLIFY_SSH is required}"

script_root=/usr/local/libexec/t3-sovereign
validator=$script_root/validate-certificate.sh
installer=$script_root/install-certificate.sh
work_dir=$(mktemp -d /var/tmp/t3-certificate-pull.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

edge_capabilities=$(ssh -F "$T3_SSH_CONFIG" -o BatchMode=yes "$T3_EDGE_SSH" capabilities)
[ "$edge_capabilities" = 't3-sovereign-certificate-exporter' ] || {
  echo "edge is not the expected forced-command certificate exporter" >&2
  exit 77
}

coolify_capabilities=$(ssh -F "$T3_SSH_CONFIG" -o BatchMode=yes "$T3_COOLIFY_SSH" capabilities)
[ "$coolify_capabilities" = 't3-sovereign-certificate-receiver traefik' ] || {
  echo "Coolify is not the expected forced-command Traefik receiver" >&2
  exit 77
}

ssh -F "$T3_SSH_CONFIG" -o BatchMode=yes "$T3_EDGE_SSH" fetch > "$work_dir/frame"

{
  IFS=' ' read -r certificate_bytes key_bytes
  for byte_count in "$certificate_bytes" "$key_bytes"; do
    case "$byte_count" in
      ''|*[!0-9]*)
        echo "invalid certificate exporter frame" >&2
        exit 65
        ;;
    esac
  done
  if [ "$certificate_bytes" -gt 1048576 ] || [ "$key_bytes" -gt 65536 ]; then
    echo "certificate exporter frame exceeds its size limit" >&2
    exit 65
  fi

  dd bs=1 count="$certificate_bytes" of="$work_dir/fullchain.pem" status=none
  dd bs=1 count="$key_bytes" of="$work_dir/privkey.pem" status=none
  dd bs=1 count=1 of="$work_dir/extra" status=none || true
} < "$work_dir/frame"

[ ! -s "$work_dir/extra" ] || {
  echo "certificate exporter frame has trailing data" >&2
  exit 65
}
chmod 644 "$work_dir/fullchain.pem"
chmod 600 "$work_dir/privkey.pem"
"$validator" "$work_dir/fullchain.pem" "$work_dir/privkey.pem"

fingerprint=$(
  openssl x509 -in "$work_dir/fullchain.pem" -noout -fingerprint -sha256 |
    cut -d= -f2 |
    tr -d ':' |
    tr 'A-F' 'a-f'
)

current_second=$(
  openssl x509 \
    -in /etc/nginx/tls/t3-sovereign/current/fullchain.pem \
    -noout -fingerprint -sha256 2>/dev/null |
    cut -d= -f2 |
    tr -d ':' |
    tr 'A-F' 'a-f' || true
)
current_traefik=$(
  openssl s_client \
    -connect 10.0.0.80:443 \
    -servername code.moondiner.com \
    </dev/null 2>/dev/null |
    openssl x509 -noout -fingerprint -sha256 |
    cut -d= -f2 |
    tr -d ':' |
    tr 'A-F' 'a-f' || true
)

if [ "$current_second" = "$fingerprint" ] && [ "$current_traefik" = "$fingerprint" ]; then
  echo "certificate $fingerprint is already active on Traefik and the second proxy"
  exit 0
fi

if [ "$current_traefik" != "$fingerprint" ]; then
  certificate_bytes=$(wc -c < "$work_dir/fullchain.pem" | tr -d ' ')
  key_bytes=$(wc -c < "$work_dir/privkey.pem" | tr -d ' ')
  {
    printf '%s %s\n' "$certificate_bytes" "$key_bytes"
    cat "$work_dir/fullchain.pem" "$work_dir/privkey.pem"
  } | ssh -F "$T3_SSH_CONFIG" -o BatchMode=yes "$T3_COOLIFY_SSH" install
fi

# Require Traefik to present the new release before the second Nginx tier is
# reloaded. Both connections stay private on this LAN hop.
attempt=1
observed=
while [ "$attempt" -le 30 ]; do
  observed=$(
    openssl s_client \
      -connect 10.0.0.80:443 \
      -servername code.moondiner.com \
      </dev/null 2>/dev/null |
      openssl x509 -noout -fingerprint -sha256 |
      cut -d= -f2 |
      tr -d ':' |
      tr 'A-F' 'a-f' || true
  )
  [ "$observed" = "$fingerprint" ] && break
  sleep 1
  attempt=$((attempt + 1))
done
[ "$observed" = "$fingerprint" ] || {
  echo "Traefik did not present certificate $fingerprint" >&2
  exit 75
}

if [ "$current_second" != "$fingerprint" ]; then
  "$installer" nginx "$work_dir/fullchain.pem" "$work_dir/privkey.pem"
fi
echo "certificate $fingerprint is active on Traefik and the second proxy"
