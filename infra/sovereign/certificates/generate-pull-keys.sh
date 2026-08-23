#!/bin/sh
set -eu
umask 077

[ "$(id -u)" -eq 0 ] || {
  echo "certificate pull key generation must run as root" >&2
  exit 77
}

key_root=${T3_PULL_KEY_ROOT:-/etc/t3-sovereign/ssh}
install -d -m 700 /etc/t3-sovereign "$key_root"

for key_name in edge-export coolify-install; do
  key_path=$key_root/$key_name
  if [ ! -e "$key_path" ]; then
    ssh-keygen \
      -q \
      -t ed25519 \
      -N '' \
      -C "t3-certificate-$key_name" \
      -f "$key_path"
  fi
  chmod 600 "$key_path"
  chmod 644 "$key_path.pub"
done

cat > "$key_root/config" <<EOF
Host t3-cert-edge
    HostName 45.79.202.71
    User root
    IdentityFile $key_root/edge-export
    IdentitiesOnly yes
    HostKeyAlias t3-edge
    UserKnownHostsFile $key_root/known_hosts
    StrictHostKeyChecking yes

Host t3-cert-coolify
    HostName 10.0.0.80
    User root
    IdentityFile $key_root/coolify-install
    IdentitiesOnly yes
    HostKeyAlias t3-coolify
    UserKnownHostsFile $key_root/known_hosts
    StrictHostKeyChecking yes
EOF
chmod 600 "$key_root/config"

echo "Generated dedicated certificate pull keys."
echo "Install these public keys with install-ssh-access.sh:"
echo "  edge exporter:    $key_root/edge-export.pub"
echo "  Coolify receiver: $key_root/coolify-install.pub"
echo "Pin both destination host keys with install-pinned-host-key.sh."
