#!/bin/sh
set -eu

usage() {
  echo "usage: $0 edge|second VERSIONED_CONFIG" >&2
  exit 64
}

[ "$#" -eq 2 ] || usage
[ "$(id -u)" -eq 0 ] || {
  echo "Nginx configuration installation must run as root" >&2
  exit 77
}

target_kind=$1
versioned_config=$2
[ -s "$versioned_config" ] || {
  echo "configuration is missing or empty: $versioned_config" >&2
  exit 66
}

backup_root=/etc/nginx/t3-sovereign-backups
backup_dir=$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-$$
install -d -m 700 "$backup_dir"

rollback_edge() {
  cp -a "$backup_dir/edge.nginx.conf" /etc/nginx/conf.d/sovereign.moondiner.conf
  nginx -t && nginx -s reload || true
}

rollback_second() {
  cp -a "$backup_dir/moondiner.com.conf" /etc/nginx/conf.d/moondiner.com.conf
  if [ -e "$backup_dir/t3-sovereign.conf" ]; then
    cp -a "$backup_dir/t3-sovereign.conf" /etc/nginx/conf.d/t3-sovereign.conf
  else
    rm -f /etc/nginx/conf.d/t3-sovereign.conf
  fi
  nginx -t && nginx -s reload || true
}

case "$target_kind" in
  edge)
    live_config=/etc/nginx/conf.d/sovereign.moondiner.conf
    [ -s "$live_config" ] || {
      echo "expected live edge configuration is missing: $live_config" >&2
      exit 66
    }

    cp -a "$live_config" "$backup_dir/edge.nginx.conf"
    install -m 644 "$versioned_config" "$live_config"

    if ! nginx -t; then
      rollback_edge
      echo "Nginx rejected the versioned edge configuration; rolled back" >&2
      exit 78
    fi
    if ! nginx -s reload; then
      rollback_edge
      echo "Nginx could not reload the versioned edge configuration; rolled back" >&2
      exit 78
    fi
    ;;

  second)
    combined_config=/etc/nginx/conf.d/moondiner.com.conf
    t3_config=/etc/nginx/conf.d/t3-sovereign.conf
    [ -s "$combined_config" ] || {
      echo "expected second-proxy configuration is missing: $combined_config" >&2
      exit 66
    }

    cp -a "$combined_config" "$backup_dir/moondiner.com.conf"
    if [ -e "$t3_config" ]; then
      cp -a "$t3_config" "$backup_dir/t3-sovereign.conf"
    fi

    # The historical file placed source.moondiner.com first and appended the
    # five T3 virtual hosts. Extract exactly its first server block once; later
    # installs leave that unrelated virtual host untouched.
    if grep -Fq 'server_name code.moondiner.com;' "$combined_config"; then
      source_only=$backup_dir/source.moondiner.conf
      awk '
        !started {
          print
          if ($0 ~ /^server[[:space:]]*\{/) {
            started = 1
            depth = 1
          }
          next
        }
        {
          print
          line = $0
          opens = gsub(/\{/, "", line)
          line = $0
          closes = gsub(/\}/, "", line)
          depth += opens - closes
          if (depth == 0) exit
        }
      ' "$combined_config" > "$source_only"

      grep -Fq 'server_name source.moondiner.com;' "$source_only" || {
        echo "refusing to split an unexpected combined proxy file" >&2
        exit 65
      }
      if grep -Eq 'server_name (code|auth|relay|connect)[.]moondiner[.]com' "$source_only"; then
        echo "source-only extraction still contains a T3 virtual host" >&2
        exit 65
      fi
      install -m 644 "$source_only" "$combined_config"
    fi

    install -m 644 "$versioned_config" "$t3_config"

    if ! nginx -t; then
      rollback_second
      echo "Nginx rejected the versioned second-proxy configuration; rolled back" >&2
      exit 78
    fi
    if ! nginx -s reload; then
      rollback_second
      echo "Nginx could not reload the second-proxy configuration; rolled back" >&2
      exit 78
    fi
    ;;

  *)
    usage
    ;;
esac

echo "installed $target_kind Nginx configuration; backup: $backup_dir"
