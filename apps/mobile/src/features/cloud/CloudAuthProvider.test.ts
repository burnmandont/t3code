import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  activateCloudRelayAccount,
  deactivateCloudRelayAccount,
  signInSovereignMobileAccount,
  signOutSovereignMobileAccount,
} from "./CloudAuthProvider";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";

vi.mock("expo-auth-session", () => ({
  AuthRequest: vi.fn(),
  ResponseType: { Code: "code" },
  exchangeCodeAsync: vi.fn(),
  makeRedirectUri: vi.fn(),
  refreshAsync: vi.fn(),
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
}));

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

vi.mock("./publicConfig", () => ({
  resolveCloudPublicConfig: vi.fn(() => ({
    oauth: { issuer: null, clientId: null, resource: null, redirectScheme: null },
    clerk: { publishableKey: null },
    relay: { url: null },
  })),
  resolveCloudIdentityConfig: vi.fn(() => ({ provider: "disabled" })),
  resolveRelayClerkTokenOptions: vi.fn(),
}));

vi.mock("../agent-awareness/remoteRegistration", () => ({
  setAgentAwarenessRelayTokenProvider: vi.fn(),
  unregisterAgentAwarenessDeviceForCurrentUser: vi.fn(),
}));

afterEach(() => {
  deactivateCloudRelayAccount();
  vi.clearAllMocks();
});

describe("CloudAuthProvider relay account isolation", () => {
  it("clears relay and agent-awareness credentials before cleanup can fail", async () => {
    const tokenProvider = async () => "account-1-token";
    activateCloudRelayAccount("account-1", tokenProvider);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");

    deactivateCloudRelayAccount();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(vi.mocked(setAgentAwarenessRelayTokenProvider)).toHaveBeenLastCalledWith(null);
    await cleanup;
  });

  it("deregisters an account switch with the immutable previous access token", async () => {
    let userId: string | null = "account-1";
    const departures: Array<{ readonly userId: string; readonly accessToken: string }> = [];
    const client = {
      snapshot: () => ({ isSignedIn: userId !== null, userId }),
      getToken: async () => (userId ? `${userId}-token` : null),
      signIn: async () => {
        userId = "account-2";
        return { isSignedIn: true, userId };
      },
      clear: async () => {
        userId = null;
      },
    };

    const next = await signInSovereignMobileAccount(client, (departure) => {
      departures.push(departure);
    });

    expect(next).toEqual({ isSignedIn: true, userId: "account-2" });
    expect(departures).toEqual([{ userId: "account-1", accessToken: "account-1-token" }]);
  });

  it("does not deregister the current account when native sign-in is cancelled", async () => {
    const departure = vi.fn();
    const client = {
      snapshot: () => ({ isSignedIn: true, userId: "account-1" }),
      getToken: async () => "account-1-token",
      signIn: async () => ({ isSignedIn: true, userId: "account-1" }),
      clear: async () => undefined,
    };

    await signInSovereignMobileAccount(client, departure);

    expect(departure).not.toHaveBeenCalled();
  });

  it("captures the departing credential before clearing local sign-in state", async () => {
    let userId: string | null = "account-1";
    const departure = vi.fn();
    const client = {
      snapshot: () => ({ isSignedIn: userId !== null, userId }),
      getToken: async () => (userId ? "account-1-token" : null),
      signIn: async () => ({ isSignedIn: userId !== null, userId }),
      clear: async () => {
        userId = null;
      },
    };

    const next = await signOutSovereignMobileAccount(client, departure);

    expect(next).toEqual({ isSignedIn: false, userId: null });
    expect(departure).toHaveBeenCalledWith({
      userId: "account-1",
      accessToken: "account-1-token",
    });
  });
});
