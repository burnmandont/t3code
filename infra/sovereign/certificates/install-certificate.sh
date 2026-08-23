#!/bin/sh
set -eu

usage() {
  echo "usage: $0 nginx|traefik FULLCHAIN_PEM PRIVATE_KEY_PEM" >&2
  exit 64
}

[ "$#" -eq 3 ] || usage

target_kind=$1
fullchain=$2
private_key=$3

if [ "$(id -u)" -ne 0 ]; then
  echo "certificate installation must run as root" >&2
  exit 77
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
validator=${T3_CERTIFICATE_VALIDATOR:-$script_dir/validate-certificate.sh}
[ -x "$validator" ] || validator=/usr/local/libexec/t3-sovereign/validate-certificate
[ -x "$validator" ] || {
  echo "certificate validator is not installed" >&2
  exit 69
}

"$validator" "$fullchain" "$private_key"

fingerprint=$(
  openssl x509 -in "$fullchain" -noout -fingerprint -sha256 |
    cut -d= -f2 |
    tr -d ':' |
    tr 'A-F' 'a-f'
)

case "$fingerprint" in
  ''|*[!0-9a-f]*)
    echo "could not derive the certificate fingerprint" >&2
    exit 65
    ;;
esac

install_release() {
  certificate_root=$1
  release_dir=$certificate_root/releases/$fingerprint

  install -d -m 700 "$certificate_root" "$certificate_root/releases" "$release_dir"
  install -m 644 "$fullchain" "$release_dir/fullchain.pem"
  install -m 600 "$private_key" "$release_dir/privkey.pem"

  "$validator" "$release_dir/fullchain.pem" "$release_dir/privkey.pem"

  old_target=
  if [ -L "$certificate_root/current" ]; then
    old_target=$(readlink "$certificate_root/current")
  elif [ -e "$certificate_root/current" ]; then
    echo "$certificate_root/current exists but is not a symbolic link" >&2
    exit 73
  fi

  next_link=$certificate_root/.current.$$
  rm -f "$next_link"
  ln -s "releases/$fingerprint" "$next_link"
  mv -Tf "$next_link" "$certificate_root/current"
}

rollback_release() {
  certificate_root=$1

  if [ -n "${old_target:-}" ]; then
    rollback_link=$certificate_root/.current.rollback.$$
    rm -f "$rollback_link"
    ln -s "$old_target" "$rollback_link"
    mv -Tf "$rollback_link" "$certificate_root/current"
  else
    rm -f "$certificate_root/current"
  fi
}

case "$target_kind" in
  nginx)
    certificate_root=${T3_NGINX_CERTIFICATE_ROOT:-/etc/nginx/tls/t3-sovereign}
    install_release "$certificate_root"

    if ! nginx -t; then
      rollback_release "$certificate_root"
      nginx -t || true
      echo "Nginx rejected the new certificate; restored the previous release" >&2
      exit 78
    fi

    if ! nginx -s reload; then
      rollback_release "$certificate_root"
      nginx -t && nginx -s reload || true
      echo "Nginx reload failed; restored the previous release" >&2
      exit 78
    fi
    ;;

  traefik)
    certificate_root=${T3_TRAEFIK_CERTIFICATE_ROOT:-/data/coolify/proxy/certs/t3-sovereign}
    dynamic_file=${T3_TRAEFIK_DYNAMIC_FILE:-/data/coolify/proxy/dynamic/t3-sovereign-tls.yaml}
    install_release "$certificate_root"

    dynamic_dir=$(dirname -- "$dynamic_file")
    install -d -m 700 "$dynamic_dir"
    dynamic_tmp=$dynamic_file.$$
    {
      echo 'tls:'
      echo '  certificates:'
      echo '    - certFile: /traefik/certs/t3-sovereign/current/fullchain.pem'
      echo '      keyFile: /traefik/certs/t3-sovereign/current/privkey.pem'
    } > "$dynamic_tmp"
    chmod 600 "$dynamic_tmp"
    mv -f "$dynamic_tmp" "$dynamic_file"

    # The Coolify proxy consumes this directory through Traefik's watched file
    # provider. Replacing the dynamic file causes a reload without restarting
    # the proxy or dropping active tunnels.
    ;;

  *)
    usage
    ;;
esac

echo "installed $target_kind certificate release $fingerprint"
