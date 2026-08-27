import {
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import {
  Discovery,
  managedRelaySessionAtom,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  activateManagedRelayAuthentication,
  deactivateManagedRelayAuthentication,
  ManagedRelayAuthProvider,
  readManagedRelayClerkToken,
  relayRoutesToReconcile,
} from "./managedAuth";

const mocks = vi.hoisted(() => ({
  auth: {
    getToken: async () => "account-1-token" as string | null,
    isLoaded: true,
    isSignedIn: false,
    userId: null as string | null,
  },
  removeRelayEnvironments: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
  registerEnvironment: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly kind?: string }) =>
    atom.kind === "discovery" ? Discovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE : new Map(),
}));

vi.mock("./auth", () => ({
  useCloudAuth: () => mocks.auth,
}));

vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  },
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly kind?: string }) =>
    command.kind === "register" ? mocks.registerEnvironment : mocks.removeRelayEnvironments,
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  reportAtomCommandResult: vi.fn(),
  settleAsyncResult: async (operation: () => Promise<unknown>) => {
    await operation();
    return { _tag: "Success", value: undefined };
  },
  settlePromise: async (operation: () => Promise<unknown>) => {
    await operation();
    return { _tag: "Success", value: undefined };
  },
}));

vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    register: { kind: "register" },
    removeRelayEnvironments: { kind: "remove" },
    routesValueAtom: { kind: "routes" },
  },
}));

vi.mock("../state/relay", () => ({
  relayEnvironmentDiscovery: { stateValueAtom: { kind: "discovery" } },
}));

afterEach(() => {
  deactivateManagedRelayAuthentication();
  vi.clearAllMocks();
  Object.assign(mocks.auth, {
    getToken: async () => "account-1-token",
    isLoaded: true,
    isSignedIn: false,
    userId: null,
  });
  vi.unstubAllGlobals();
});

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};
  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }
  set textContent(_value: string) {
    this.childNodes = [];
  }
  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  createElement(name: string) {
    return new TestNode(name, this);
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function mountManagedAuth() {
  const document = new TestNode("#document", null, 9);
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: TestNode });
  vi.stubGlobal("HTMLIFrameElement", TestNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div") as unknown as Element);
  return {
    render: () => act(() => root.render(createElement(ManagedRelayAuthProvider, null))),
    unmount: () => act(() => root.unmount()),
  };
}

async function settleTransitions() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const environmentId = EnvironmentId.make("environment-1");
const relayEnvironment = {
  environmentId,
  label: "Development",
  endpoint: {
    httpBaseUrl: "https://development.example.test",
    wsBaseUrl: "wss://development.example.test",
    providerKind: "cloudflare_tunnel" as const,
  },
  linkedAt: "2026-08-27T00:00:00.000Z",
};
const discovery = {
  ...Discovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
  environments: new Map([
    [
      environmentId,
      {
        environment: relayEnvironment,
        availability: "online" as const,
        status: Option.none(),
        error: Option.none(),
      },
    ],
  ]),
};

describe("managed relay route reconciliation", () => {
  it("restores Relay beside an existing SSH route for the same environment", () => {
    const ssh = new SshConnectionTarget({
      environmentId,
      label: "Development",
      connectionId: "ssh:environment-1",
    });
    const routes = new Map<string, ReadonlyArray<ConnectionCatalogEntry>>([
      [environmentId, [{ target: ssh, profile: Option.none() }]],
    ]);

    expect(relayRoutesToReconcile(discovery, routes).map((entry) => entry.target)).toEqual([
      new RelayConnectionTarget({ environmentId, label: "Development" }),
    ]);
  });

  it("does not auto-save an unrelated discovered environment", () => {
    expect(relayRoutesToReconcile(discovery, new Map())).toEqual([]);
  });

  it("does not duplicate an existing Relay route", () => {
    const relay = new RelayConnectionTarget({ environmentId, label: "Development" });
    const routes = new Map<string, ReadonlyArray<ConnectionCatalogEntry>>([
      [environmentId, [{ target: relay, profile: Option.none() }]],
    ]);

    expect(relayRoutesToReconcile(discovery, routes)).toEqual([]);
  });
});

describe("managed relay authentication", () => {
  it("keeps definitively signed-out startup free of relay state", async () => {
    setManagedRelaySession(appAtomRegistry, {
      accountId: "stale-account",
      readClerkToken: async () => "stale-token",
    });
    const mounted = mountManagedAuth();
    try {
      await mounted.render();
      await settleTransitions();
      expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
      expect(mocks.removeRelayEnvironments).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  });

  it("removes relay state on explicit sign-out", async () => {
    Object.assign(mocks.auth, { isSignedIn: true, userId: "account-1" });
    const mounted = mountManagedAuth();
    try {
      await mounted.render();
      await settleTransitions();
      mocks.removeRelayEnvironments.mockClear();
      Object.assign(mocks.auth, { isSignedIn: false, userId: null });
      await mounted.render();
      await settleTransitions();
      expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
      expect(mocks.removeRelayEnvironments).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  });

  it("cleans account A before activating account B for discovery", async () => {
    Object.assign(mocks.auth, { isSignedIn: true, userId: "account-a" });
    const mounted = mountManagedAuth();
    try {
      await mounted.render();
      await settleTransitions();
      Object.assign(mocks.auth, { getToken: async () => "account-b-token", userId: "account-b" });
      await mounted.render();
      await settleTransitions();
      expect(mocks.removeRelayEnvironments).toHaveBeenCalledOnce();
      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-b");
    } finally {
      await mounted.unmount();
    }
  });

  it("clears all token access synchronously before account cleanup can fail", async () => {
    activateManagedRelayAuthentication("account-1", async () => "account-1-token");
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
    expect(await readManagedRelayClerkToken()).toBe("account-1-token");

    deactivateManagedRelayAuthentication();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(await readManagedRelayClerkToken()).toBeNull();
    await cleanup;
  });

  it("replaces an existing account session atomically", () => {
    setManagedRelaySession(appAtomRegistry, {
      accountId: "account-1",
      readClerkToken: async () => "account-1-token",
    });

    activateManagedRelayAuthentication("account-2", async () => "account-2-token");

    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-2");
  });
});
