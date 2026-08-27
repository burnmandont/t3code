import { managedRelaySessionAtom, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  activateManagedRelayAuthentication,
  deactivateManagedRelayAuthentication,
  ManagedRelayAuthProvider,
  readManagedRelayClerkToken,
} from "./managedAuth";

const mocks = vi.hoisted(() => ({
  auth: {
    getToken: async () => "account-1-token" as string | null,
    isLoaded: true,
    isSignedIn: false,
    userId: null as string | null,
  },
  removeRelayEnvironments: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
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
  useAtomCommand: () => mocks.removeRelayEnvironments,
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
    removeRelayEnvironments: {},
  },
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
