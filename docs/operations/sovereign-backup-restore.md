# Sovereign backup and restore

PostgreSQL contains the sovereign account and relay control-plane state. A
backup is not valid merely because `pg_dump` exited zero: it must be readable,
restorable into an isolated database, and comparable with its source.

The repository includes a non-destructive production validation script:

```bash
infra/sovereign/postgres/validate-logical-restore.sh
```

Run it on the Coolify deployment host in a deployment-free window. It:

1. resolves exactly one account, relay, and Coolify `t3-postgres` container;
2. proves both services point to that private, healthy, named-volume database;
3. creates custom-format logical dumps of `t3_account` and `t3_relay`;
4. validates both dump catalogs;
5. restores them into uniquely named temporary databases;
6. compares every public table's source and restored row count;
7. drops only the temporary databases and removes only its temporary files.

It never restarts PostgreSQL, changes a production database, publishes port
5432, or prints a database URL/password. The temporary dumps are mode 600 and
are removed even when validation fails.

The stronger application-compatibility exercise is:

```bash
infra/sovereign/postgres/validate-full-restore.sh
```

It performs the same dump and row-count validation against a fresh PostgreSQL
container running on an internal-only Docker network with tmpfs storage. It
maps the restored databases to dedicated account and relay roles, runs the
exact deployed migrations and account-client provisioning, then boots isolated
account and relay containers and checks account health, OIDC discovery, JWKS,
and relay health. APNs is forcibly disabled, no ports are published, and the
network has no external route. PID-scoped container and network names plus
strict cleanup guards prevent the drill from targeting production resources.

Run both validators from the versioned production commit on the Coolify host.
The short validator is appropriate for the monthly automated proof. Run the
full validator after schema changes, upstream integrations that add migrations,
PostgreSQL upgrades, and at least quarterly.

## What PostgreSQL backup covers

- users, sessions, passkeys, OAuth clients, grants, and signing-key records;
- relay account/environment links and managed endpoint allocations;
- environment connector credentials and DPoP replay state;
- mobile registrations, APNs delivery state, and retained agent activity.

It does **not** cover a remote environment's projects, repositories, provider
credentials, local settings, or durable thread/event database. Those live in
that environment's T3 home and project directories. Each remote environment
therefore needs a separate filesystem backup and restore drill. Control-plane
PostgreSQL plus the remote T3 homes are jointly required for full recovery.

On each remote environment, validate the critical T3 home independently:

```bash
infra/sovereign/runtime/validate-remote-home-restore.sh
```

The validator uses SQLite's online backup API while the supervised service is
running, packages the resulting database with the environment identity,
settings, attachments, and encrypted secret files, extracts the archive into
an isolated temporary directory, runs `PRAGMA integrity_check`, and compares
every SQLite table count plus a cryptographic secret-file manifest. It never
stops the service or starts a duplicate connector. Signed runtime versions,
managed FRPC binaries, caches, and logs are excluded because they are
reproducible or nonessential; project repositories require their own normal
filesystem or Git backup policy.

## Durable backup policy

The temporary restore validators are not a backup-retention system. Sovereign
therefore pulls encrypted recovery points to a separate backup host with the
scripts under `infra/sovereign/backup`. The source-side forced command creates
either PostgreSQL custom dumps plus table manifests or an online SQLite home
snapshot. It encrypts the complete archive with authenticated AES-256-GCM CMS
before writing a byte to SSH. The production hosts contain only the public
recipient certificate; the backup host retains the private recovery key.

Each source has a separate Ed25519 pull identity. Its `authorized_keys` entry
disables agent, port, X11, and PTY forwarding and ignores the requested command
in favor of one low-priority exporter. A compromised source therefore has no
credential with which to list, overwrite, or delete retained copies. SSH host
keys are pinned; password fallback and trust-on-first-use are disabled.

The backup-host timer runs at `00:15`, `06:15`, `12:15`, and `18:15` UTC with
no randomized delay. It is persistent across reboots. Every cycle validates
the authenticated envelope and source metadata before an atomic rename, keeps
all six-hour points for 48 hours, then 14 daily, 8 weekly, and 12 monthly
points. A cycle fails unless every configured source has a decryptable point
created within 7 hours. `Nice=10`, idle-class I/O scheduling, `CPUWeight=20`,
and `IOWeight=10` keep backup work subordinate to interactive and service I/O.

For a small sovereign installation, the starting policy is:

- logical backup every 6 hours;
- retain 14 daily, 8 weekly, and 12 monthly recovery points;
- encrypt before data leaves the database host;
- keep encryption/decryption material outside the database host and repository;
- make the destination append-only or versioned for the retention window;
- run the isolated restore validator monthly and after every PostgreSQL major
  version or schema/migration change.

The current first destination is the separate Coolify control host. This
closes the production-host-loss gap, but because it is a same-site recovery
point it does not protect against site loss. Replicate the already encrypted
`.cms` objects to a second site or offline medium before claiming site-loss
recovery.

### Operations

On the backup host, the durable files are:

- `/etc/sovereign-backup`: recipient key, pinned host keys, pull identities,
  and the source registry;
- `/var/lib/sovereign-backups/<source-id>`: encrypted recovery points and
  encrypted-file checksums;
- `/usr/local/libexec/sovereign-backup`: the versioned pull, retention, and
  freshness scripts.

Use the service directly for a pre-deployment recovery point and verify the
timer without restarting an application service:

```bash
sudo systemctl start sovereign-backup.service
sudo /usr/local/libexec/sovereign-backup/validate-backup-set.sh
systemctl list-timers sovereign-backup.timer --no-pager
```

Install or update source exporters with
`infra/sovereign/backup/install-source-exporter.sh`; it makes a timestamped
copy of every replaced file. Install destination code with
`infra/sovereign/backup/install-backup-host.sh`; it preserves the recipient
key, source registry, retained objects, and the timer's enabled state. The
destination installer deliberately does not enable a new timer. Populate and
verify all sources, run one manual cycle, and complete retained-copy restores
before the first `systemctl enable --now sovereign-backup.timer`.

For a retained remote-home proof, decrypt one `.cms` object on the backup host
into a mode-600 temporary archive and run:

```bash
infra/sovereign/backup/validate-retained-remote-home.sh remote-home.tar.gz
```

For a retained control-plane proof, decrypt and extract one object into a
temporary directory on the deployment host, then run:

```bash
SOVEREIGN_RETAINED_BACKUP_DIRECTORY=/tmp/retained-control-plane \
  infra/sovereign/postgres/validate-full-restore.sh
```

Keep the CMS private key on the backup host during these drills; stream the
decrypted archive through an authenticated operator SSH session and remove the
temporary plaintext immediately afterward. Never copy the private recovery key
to a production source.

## Recovery dependencies outside the dumps

Retain encrypted, offline copies of:

- the CMS backup recipient private key and certificate;
- `T3_ACCOUNT_SECRET`;
- the relay signing private/public key pair;
- PostgreSQL role passwords or a documented rotation procedure;
- the exact fork commit and Compose/proxy configurations;
- TLS private keys until automated reissuance is proven;
- the remote environments' T3 home encryption/credential material.

Losing the relay signing key invalidates established relay trust even if all
database rows restore correctly. Never put populated environment files or key
material into Git.

## Full restore drill

The temporary validator proves logical database recoverability, but a disaster
exercise should also prove application recovery:

1. run `validate-full-restore.sh` to create a clean, private PostgreSQL 17
   instance, restore both dumps with ownership mapped to the intended roles,
   run checked migrations, and prove isolated account/relay health plus
   OIDC/JWKS;
2. use a private client namespace to verify account login, environment
   ownership, and connector authorization without exposing the isolated stack
   publicly;
3. restore one remote T3 home and open a known durable thread;
4. record actual recovery time and update the RTO/RPO.

Do not first discover the encryption key, object-store credential, database
role mapping, or remote T3 home location during an incident.

## Production validation

The first complete database and remote-home restore pass ran on 2026-08-11
from sovereign commit `6ad0d07ff71d3571e8379ea0f9c94050d690dd18` after the controlled
v0.0.33 upstream integration:

- the short in-cluster validator restored and compared 10 account tables and
  10 relay tables in 6.55 seconds;
- the full isolated validator restored 41,526-byte and 30,109-byte logical
  dumps into fresh PostgreSQL 17 tmpfs storage, ran the exact deployed
  migrations/provisioning, and booted healthy isolated account and relay
  containers in 16 seconds;
- the `development` remote stayed online while its critical T3 home was backed
  up and restored in 3 seconds; 17 SQLite tables, 3 projects, 4 threads, 61
  messages, 557 events, its environment identity, and 802 encrypted secret
  files matched;
- every temporary database, container, internal network, archive, and copied
  script was removed, and production health remained 200 for code, account,
  and relay.

These are component restore times with images and a replacement host already
available, not a complete site-loss RTO. Use a provisional one-hour disaster
RTO until clean-host provisioning, key recovery, proxy/TLS restoration, and a
private client login have also been timed.

The durable-backup audit initially found only local migration dumps and local
Coolify daily dumps, so the production-host-loss RPO was unbounded. On
2026-08-23 the separate backup-host schedule was activated for `control-plane`,
`development`, and `emaildev`. The first retained set passed authenticated
decryption and freshness checks. Both environment homes then passed SQLite
integrity, every-table row counts, environment identity, and secret-file
manifests. The retained control-plane point restored 10 account and 10 relay
tables into fresh PostgreSQL tmpfs, ran the exact deployed migrations and
provisioning, and booted healthy isolated account and relay services in 17
seconds without published ports.

That evidence bounds production-host-loss exposure to the six-hour schedule
and proves component restoration from retained copies. It does **not** prove
site-loss recovery, project-repository recovery, or a full clean-host RTO.
