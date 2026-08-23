#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
edge_ssh=${T3_EDGE_SSH:-linodeproxy}
second_ssh=${T3_SECOND_PROXY_SSH:-inprimary}
coolify_ssh=${T3_COOLIFY_SSH:-third}
failed=0

check_file() {
  label=$1
  target=$2
  local_file=$3
  remote_file=$4

  local_hash=$(sha256sum "$local_file" | cut -d' ' -f1)
  remote_hash=$(ssh -o BatchMode=yes "$target" "sha256sum '$remote_file'" | cut -d' ' -f1)

  if [ "$local_hash" = "$remote_hash" ]; then
    echo "ok: $label ($local_hash)"
  else
    echo "drift: $label" >&2
    echo "  repository: $local_hash" >&2
    echo "  live:       $remote_hash" >&2
    failed=1
  fi
}

check_file \
  edge \
  "$edge_ssh" \
  "$script_dir/edge.nginx.conf" \
  /etc/nginx/conf.d/sovereign.moondiner.conf
check_file \
  edge-sshd \
  "$edge_ssh" \
  "$script_dir/edge-sshd-hardening.conf" \
  /etc/ssh/sshd_config.d/20-t3-sovereign-hardening.conf
check_file \
  second \
  "$second_ssh" \
  "$script_dir/second.nginx.conf" \
  /etc/nginx/conf.d/t3-sovereign.conf
check_file \
  traefik-tls \
  "$coolify_ssh" \
  "$script_dir/traefik-tls.yaml" \
  /data/coolify/proxy/dynamic/t3-sovereign-tls.yaml

exit "$failed"
