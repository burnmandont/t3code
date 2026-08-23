import assert from "node:assert/strict";
import test from "node:test";

import { createAppleReleaseDispatch } from "./dispatch-apple-release.mjs";

test("creates an immutable Apple release dispatch", () => {
  assert.deepEqual(
    createAppleReleaseDispatch({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      desktopVersion: "0.0.3300102",
      iosBuildNumber: "100102",
    }),
    {
      event_type: "sovereign_apple_release",
      client_payload: {
        commit_sha: "0123456789abcdef0123456789abcdef01234567",
        desktop_version: "0.0.3300102",
        ios_build_number: "100102",
      },
    },
  );
});

test("rejects mutable refs and invalid Apple versions", () => {
  assert.throws(
    () =>
      createAppleReleaseDispatch({
        commitSha: "master",
        desktopVersion: "0.0.3300102",
        iosBuildNumber: "100102",
      }),
    /commit SHA/u,
  );
  assert.throws(
    () =>
      createAppleReleaseDispatch({
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        desktopVersion: "latest",
        iosBuildNumber: "100102",
      }),
    /version/u,
  );
  assert.throws(
    () =>
      createAppleReleaseDispatch({
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        desktopVersion: "0.0.3300102",
        iosBuildNumber: "0",
      }),
    /build number/u,
  );
});
