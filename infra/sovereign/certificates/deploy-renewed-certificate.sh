#!/bin/sh
set -eu

# The edge cannot initiate SSH into the second proxy, and we deliberately do
# not expose that port. Install locally; the second proxy's timer pulls this
# release outbound and then distributes it over the private LAN to Traefik.
exec /usr/local/libexec/t3-sovereign/install-certificate.sh nginx \
  /var/lib/t3-sovereign/acme/fullchain.pem \
  /var/lib/t3-sovereign/acme/privkey.pem
