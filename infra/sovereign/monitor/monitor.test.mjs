import assert from "node:assert/strict";
import test from "node:test";

import {
  committedStateFor,
  loadMonitorConfiguration,
  parseManagedHosts,
  runProbe,
  transitionFor,
} from "./monitor.mjs";

test("accepts only direct children of the sovereign Connect zone", () => {
  const connectUrl = new URL("https://connect.moondiner.com");
  assert.deepEqual(
    parseManagedHosts("prod-123.connect.moondiner.com,prod-123.connect.moondiner.com", connectUrl),
    ["prod-123.connect.moondiner.com"],
  );
  assert.throws(
    () => parseManagedHosts("connect.moondiner.com", connectUrl),
    /one-label children/u,
  );
  assert.throws(
    () => parseManagedHosts("nested.prod-123.connect.moondiner.com", connectUrl),
    /one-label children/u,
  );
});

test("rejects query-bearing webhook URLs so secrets never enter request logs", () => {
  assert.throws(
    () =>
      loadMonitorConfiguration({
        T3_MONITOR_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook?token=secret",
      }),
    /query-free/u,
  );
});

test("reports bounded check names and failure codes", async () => {
  const configuration = loadMonitorConfiguration({
    T3_MONITOR_MANAGED_HOSTS: "prod-123.connect.moondiner.com",
  });
  const fetchImplementation = async (url) =>
    url.hostname.startsWith("prod-")
      ? Response.json({ message: "offline" }, { status: 503 })
      : Response.json({ ok: true });

  const result = await runProbe(configuration, {
    fetchImplementation,
    websocketCheck: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.at(-1), {
    name: "managed_environment_1",
    ok: false,
    reason: "unexpected_status",
  });
  assert.equal(JSON.stringify(result).includes("prod-123"), false);
});

test("alerts only on the first failure and subsequent recovery", () => {
  assert.equal(transitionFor(undefined, true), undefined);
  assert.equal(transitionFor(undefined, false), "failed");
  assert.equal(transitionFor(false, false), undefined);
  assert.equal(transitionFor(false, true), "recovered");
  assert.equal(transitionFor(true, true), undefined);
});

test("requires consecutive failures before committing an unhealthy state", () => {
  assert.equal(committedStateFor(undefined, false, 1, 2), undefined);
  assert.equal(committedStateFor(undefined, false, 2, 2), false);
  assert.equal(committedStateFor(true, false, 1, 2), true);
  assert.equal(committedStateFor(true, false, 2, 2), false);
  assert.equal(committedStateFor(false, true, 0, 2), true);
});
