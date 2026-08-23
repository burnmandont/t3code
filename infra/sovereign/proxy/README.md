# Sovereign proxy and certificate operations

This directory is the source of truth for the T3-specific configuration on
all three TLS proxy tiers:

| Repository file            | Live host                   | Live path                                               |
| -------------------------- | --------------------------- | ------------------------------------------------------- |
| `edge.nginx.conf`          | public edge (`linodeproxy`) | `/etc/nginx/conf.d/sovereign.moondiner.conf`            |
| `edge-sshd-hardening.conf` | public edge (`linodeproxy`) | `/etc/ssh/sshd_config.d/20-t3-sovereign-hardening.conf` |
| `second.nginx.conf`        | second proxy (`inprimary`)  | `/etc/nginx/conf.d/t3-sovereign.conf`                   |
| `traefik-tls.yaml`         | Coolify host (`third`)      | `/data/coolify/proxy/dynamic/t3-sovereign-tls.yaml`     |

`source.moondiner.com` is deliberately not in this repository. Its unrelated
server block remains in `/etc/nginx/conf.d/moondiner.com.conf` on the second
proxy. The shared `third_https` upstream remains in
`/etc/nginx/conf.d/00-upstreams.conf` on that host.

The first installation of `second.nginx.conf` uses
`install-nginx-config.sh second` to extract the historical source-only block
from the old combined file. Every install is backed up below
`/etc/nginx/t3-sovereign-backups`, tested with `nginx -t`, and reloaded only
after validation. Failed tests or reloads restore the preceding file.

Run the drift check from an administrator workstation with the three SSH
aliases configured:

```sh
infra/sovereign/proxy/check-drift.sh
```

The script compares SHA-256 hashes and exits nonzero if a live T3 file differs
from the repository. It does not modify any host.

## Public application boundary

The edge applies separate request buckets to the restricted control plane,
linked environments, and the FRPC control handshake. `connect.moondiner.com`
is not a general reverse proxy: only `/~!frp` with a WebSocket upgrade reaches
FRPS port 7000. The wildcard host remains the data path for linked
environments. The second proxy repeats this path and upgrade enforcement, so a
future edge regression does not expose arbitrary FRPS control-listener paths.

Host guards reject requests that enter a T3 virtual host with an unexpected
hostname. Forwarding headers are overwritten at the edge and are trusted only
from the enumerated edge addresses at the second proxy. Do not replace those
fixed trust boundaries with `$proxy_add_x_forwarded_for` on an Internet-facing
hop.

The edge also owns the explicit HTTP and HTTPS `default_server`. Unknown SNI or
Host values return 421 rather than inheriting whichever unrelated virtual host
happened to load first. Before installing that catch-all on another host, use
`nginx -T` to confirm that no independently managed configuration already
claims `default_server` on ports 80 or 443.

Both proxy tiers use `t3_sanitized` JSON access logs. The format records `$uri`
but never `$request`, `$request_uri`, request headers, or referrers. This is a
security boundary: OAuth callback codes are query parameters and must not be
copied into routine proxy logs.

## Account recovery boundary

The account hostname is designed to be public for passkey authentication,
OAuth authorization, session handling, and discovery. Email/password remains
enabled only as an operator recovery mechanism. Both Nginx tiers independently
classify every Better Auth route that can consume, create, change, reset, or
verify a password and return 403 unless the restored client address is one of
the fixed operator addresses.

The edge overwrites forwarding headers. The second proxy applies `real_ip` only
to the enumerated edge addresses before evaluating the same operator boundary.
This ordering is essential: never evaluate a client-supplied forwarding header
directly, and never remove the second-tier copy of the boundary merely because
the edge already enforces it.

The hosted web, account passkey/OAuth routes, and relay are publicly reachable.
Only email/password routes retain the operator source boundary. The second
proxy independently rejects every control-plane request whose original TCP
peer is not an enumerated edge address; this prevents direct access from
bypassing edge rate limits or forwarding-header normalization. Retain the
route classifier, operator address map, trusted-edge peer check, Connect
edge-only allowlists, rate limits, Host guards, and all internal-port firewall
rules.

## Edge host policy

The public edge intentionally keeps SSH reachable from arbitrary networks so
administrative access still works while travelling. SSH is key-only, including
for root; password and keyboard-interactive authentication are disabled. The
shorter pre-authentication limits reduce the cost of unauthenticated connection
floods without affecting established sessions.

Install the versioned SSH policy and normalize firewalld with:

```sh
./install-edge-host-policy.sh ./edge-sshd-hardening.conf
```

The installer validates and reloads sshd before it changes firewalld. The
public zone retains only the named `ssh`, `http`, and `https` services (plus the
standard DHCPv6 client service); redundant raw-port and Cockpit allowances are
removed. Verify a fresh key-only SSH connection before ending the installation
session. A provider Cloud Firewall remains the outer network boundary.

## Certificate layout

The same ECDSA certificate must cover all of these names:

- `code.moondiner.com`
- `auth.moondiner.com`
- `relay.moondiner.com`
- `connect.moondiner.com`
- `*.connect.moondiner.com`

Nginx reads an atomically switched release at:

```text
/etc/nginx/tls/t3-sovereign/current/fullchain.pem
/etc/nginx/tls/t3-sovereign/current/privkey.pem
```

Traefik reads the equivalent paths inside its certificate bind mount:

```text
/traefik/certs/t3-sovereign/current/fullchain.pem
/traefik/certs/t3-sovereign/current/privkey.pem
```

`install-certificate.sh` validates the PEM documents, key match, exact names,
wildcard behavior, literal wildcard SAN, and remaining validity before it
advances `current`. Nginx changes require a successful configuration test and
reload. Traefik's watched dynamic file is replaced only after both new files
are present, so the proxy reloads the pair without a container restart.

The second proxy's `pull-and-distribute-certificate.sh` deploys in dependency
order:

1. acme.sh installs the renewed certificate on the public edge;
2. the second proxy pulls it over outbound SSH;
3. the second proxy installs it on Traefik over the private LAN;
4. the second Nginx proxy installs it locally.

The edge cannot initiate SSH into the second proxy, and the automation does not
open that port. The pull timer runs every 15 minutes. It verifies the expected
certificate fingerprint at Traefik before reloading the second Nginx tier. A
partial run is safe: the old and new certificates cover the same names and
overlap in validity.

## Certificate issuance decision

The managed-environment wildcard requires DNS validation. Do not use the
Namecheap API for unattended issuance: its account API key has no documented
per-command, per-domain, or per-record scope, and `setHosts` replaces the whole
host-record set. An IPv4 allowlist constrains where the key can be used, not
what the key can do.

The current production certificate therefore remains manually issued. Renew
it with manual DNS-01 before its renewal threshold, validate it with
`validate-certificate.sh`, and install it on the edge with
`install-certificate.sh nginx`. The active second-proxy pull timer carries a
new validated edge release to the remaining tiers within 15 minutes.

Acceptable unattended replacements are:

1. delegate only the required ACME challenge names with CNAME or NS records to
   a validation-specific authoritative zone whose credential cannot modify
   production DNS; or
2. use DNS-PERSIST-01 with a dedicated ACME account once production CA support
   is explicitly verified.

The pinned acme.sh client remains installed for either future design. Do not
activate a DNS provider plugin until its credential boundary has been reviewed.
Never commit an ACME account directory or certificate private key.

### Restricted pull transport

Renewal uses two dedicated Ed25519 keys rather than an administrator key:

- a second-to-edge key forced to a read-only certificate exporter;
- a second-to-Coolify key, sent only over the private LAN, forced to the
  Traefik certificate receiver.

Run `generate-pull-keys.sh` once on the second proxy. Transfer only the two
`.pub` files to an administrator workstation. Stage the complete certificate
script directory plus the appropriate public key on each destination, then
run these commands locally on those hosts:

```sh
# On the public edge:
./install-ssh-access.sh export edge-export.pub

# On the Coolify host:
./install-ssh-access.sh traefik coolify-install.pub
```

Obtain each destination's `/etc/ssh/ssh_host_ed25519_key.pub` through the
existing trusted administrator connection and install it on the second proxy:

```sh
./install-pinned-host-key.sh t3-edge edge-ssh-host-ed25519.pub
./install-pinned-host-key.sh t3-coolify coolify-ssh-host-ed25519.pub
```

The exporter accepts only `capabilities` or `fetch`. The receiver accepts only
`capabilities` or `install`; installation reads one size-bounded binary frame,
validates the certificate, and calls a fixed installer mode. No remote shell,
SCP, forwarding, agent forwarding, X11 forwarding, PTY, or user rc is available
to either key.

From the second proxy, verify both restrictions and routes without sending a
certificate:

```sh
ssh -F /etc/t3-sovereign/ssh/config t3-cert-edge capabilities
ssh -F /etc/t3-sovereign/ssh/config t3-cert-coolify capabilities
```

The responses must be exactly `t3-sovereign-certificate-exporter` and
`t3-sovereign-certificate-receiver traefik`. The pull script refuses to move
certificate material if either preflight response differs.
