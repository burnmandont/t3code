import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";

const readBackupFile = (name) => NodeFS.readFileSync(new URL(name, import.meta.url), "utf8");

NodeTest.test("encrypts every source archive before it crosses SSH", () => {
  for (const exporter of ["export-control-plane.sh", "export-remote-home.sh"]) {
    const source = readBackupFile(exporter);
    NodeAssert.match(source, /openssl cms -encrypt -binary -aes-256-gcm -outform DER/u);
    NodeAssert.match(source, /recipient_certificate/u);
    NodeAssert.doesNotMatch(source, /recipient-key/u);
  }
});

NodeTest.test("pull identities cannot consume the source list or silently trust a host", () => {
  const source = readBackupFile("pull-backups.sh");
  NodeAssert.match(source, /timeout 45m ssh -n/u);
  NodeAssert.match(source, /StrictHostKeyChecking=yes/u);
  NodeAssert.match(source, /UserKnownHostsFile=/u);
  NodeAssert.match(source, /IdentitiesOnly=yes/u);
  NodeAssert.match(source, /PasswordAuthentication=no/u);
  NodeAssert.match(source, /seen_sources/u);
});

NodeTest.test("source installation grants only a low-I/O forced export command", () => {
  const source = readBackupFile("install-source-exporter.sh");
  NodeAssert.match(
    source,
    /no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding/u,
  );
  NodeAssert.match(source, /command=\\"\$forced_command\\"/u);
  NodeAssert.match(source, /nice -n 10 ionice -c 3/u);
});

NodeTest.test("the destination enforces the six-hour RPO and low-I/O policy", () => {
  const timer = readBackupFile("sovereign-backup.timer");
  const service = readBackupFile("sovereign-backup.service");
  const validator = readBackupFile("validate-backup-set.sh");
  NodeAssert.match(timer, /OnCalendar=\*-\*-\* 00,06,12,18:15:00 UTC/u);
  NodeAssert.match(timer, /Persistent=true/u);
  NodeAssert.doesNotMatch(timer, /RandomizedDelaySec/u);
  NodeAssert.match(service, /IOSchedulingClass=idle/u);
  NodeAssert.match(service, /IOWeight=10/u);
  NodeAssert.match(validator, /SOVEREIGN_BACKUP_MAXIMUM_AGE_SECONDS:-25200/u);
  NodeAssert.match(validator, /created_at/u);
});

NodeTest.test("retained control-plane input is checked before an isolated restore", () => {
  const source = NodeFS.readFileSync(
    new URL("../postgres/validate-full-restore.sh", import.meta.url),
    "utf8",
  );
  NodeAssert.match(source, /SOVEREIGN_RETAINED_BACKUP_DIRECTORY/u);
  NodeAssert.match(source, /sha256sum --check --strict SHA256SUMS/u);
  NodeAssert.match(source, /backup_source=retained-encrypted-recovery-point/u);
  NodeAssert.match(source, /docker network create --internal/u);
  NodeAssert.match(source, /--tmpfs \/var\/lib\/postgresql\/data/u);
});

NodeTest.test("retention keeps recent, daily, weekly, and monthly points", () => {
  const source = readBackupFile("prune-backups.sh");
  NodeAssert.match(source, /age <= 172800/u);
  NodeAssert.match(source, /daily_count < 14/u);
  NodeAssert.match(source, /weekly_count < 8/u);
  NodeAssert.match(source, /monthly_count < 12/u);
});
