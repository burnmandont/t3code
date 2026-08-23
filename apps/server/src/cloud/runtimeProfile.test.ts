// @effect-diagnostics nodeBuiltinImport:off -- Exercises the standalone Node-compatible profile helpers.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";

import {
  controlPlaneEnvironment,
  normalizeEnvironmentLabel,
  parseControlPlaneProfile,
  readControlPlaneProfile,
  readEnvironmentLabel,
  writeControlPlaneProfile,
  writeEnvironmentLabel,
} from "./runtimeProfile.ts";

const profile = {
  schemaVersion: 1,
  origin: "https://code.example.test",
  hostedAppUrl: "https://code.example.test",
  oauthIssuer: "https://auth.example.test/api/auth",
  oauthClientId: "t3-code",
  oauthResource: "https://relay.example.test",
  relayUrl: "https://relay.example.test",
} as const;

it("validates one coherent control-plane discovery document", () => {
  expect(parseControlPlaneProfile(profile, profile.origin)).toEqual(profile);
  expect(controlPlaneEnvironment(profile)).toEqual({
    T3CODE_HOSTED_APP_URL: profile.hostedAppUrl,
    T3CODE_OAUTH_ISSUER: profile.oauthIssuer,
    T3CODE_OAUTH_CLIENT_ID: profile.oauthClientId,
    T3CODE_OAUTH_RESOURCE: profile.oauthResource,
    T3CODE_RELAY_URL: profile.relayUrl,
  });
});

it("rejects mixed origins and unsafe public endpoints", () => {
  expect(() =>
    parseControlPlaneProfile({ ...profile, hostedAppUrl: "https://other.example.test" }),
  ).toThrow(/must match/u);
  expect(() =>
    parseControlPlaneProfile({ ...profile, relayUrl: "http://relay.example.test" }),
  ).toThrow(/HTTPS/u);
  expect(() =>
    parseControlPlaneProfile({ ...profile, oauthIssuer: "https://user:pass@auth.example.test" }),
  ).toThrow(/credentials/u);
});

it("persists profiles and labels independently from the operating-system hostname", async () => {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-runtime-profile-"));
  try {
    await writeControlPlaneProfile(baseDir, profile);
    await writeEnvironmentLabel(baseDir, "  Atlas   worker  ");
    expect(await readControlPlaneProfile(baseDir)).toEqual(profile);
    expect(await readEnvironmentLabel(baseDir)).toBe("Atlas worker");
  } finally {
    await NodeFSP.rm(baseDir, { recursive: true, force: true });
  }
});

it("rejects empty, control-character, and oversized labels", () => {
  expect(() => normalizeEnvironmentLabel("   ")).toThrow(/empty/u);
  expect(() => normalizeEnvironmentLabel("bad\u0000label")).toThrow(/control/u);
  expect(() => normalizeEnvironmentLabel("x".repeat(101))).toThrow(/100/u);
});
