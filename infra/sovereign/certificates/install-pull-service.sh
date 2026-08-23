#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || {
  echo "certificate pull service installation must run as root" >&2
  exit 77
}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pull_config=${T3_PULL_CONFIG:-/etc/t3-sovereign/pull.env}
[ -r "$pull_config" ] || {
  echo "create the root-only pull configuration at $pull_config" >&2
  exit 66
}
[ "$(stat -c '%u %a' "$pull_config")" = '0 600' ] || {
  echo "pull configuration must be owned by root and mode 600" >&2
  exit 77
}

install -d -m 700 /usr/local/libexec/t3-sovereign
for tool in \
  install-certificate.sh \
  pull-and-distribute-certificate.sh \
  validate-certificate.sh
do
  install -m 700 "$script_dir/$tool" "/usr/local/libexec/t3-sovereign/$tool"
done

cat > /etc/systemd/system/t3-sovereign-certificate-pull.service <<'EOF'
[Unit]
Description=Pull and distribute the sovereign T3 TLS certificate
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/t3-sovereign/pull-and-distribute-certificate.sh
EOF

cat > /etc/systemd/system/t3-sovereign-certificate-pull.timer <<'EOF'
[Unit]
Description=Check for a new sovereign T3 TLS certificate

[Timer]
OnBootSec=5m
OnUnitActiveSec=15m
RandomizedDelaySec=2m
Persistent=true

[Install]
WantedBy=timers.target
EOF

chmod 644 \
  /etc/systemd/system/t3-sovereign-certificate-pull.service \
  /etc/systemd/system/t3-sovereign-certificate-pull.timer
systemctl daemon-reload
systemctl enable --now t3-sovereign-certificate-pull.timer
systemctl list-timers t3-sovereign-certificate-pull.timer --no-pager
