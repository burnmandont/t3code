import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  clearChunkReloadGuard: vi.fn(),
  hasCloudPublicConfig: vi.fn(),
  render: vi.fn(),
  resolveCloudIdentityConfig: vi.fn(),
  routerLoad: vi.fn(async () => undefined),
}));

vi.mock("react-dom/client", () => ({
  default: {
    createRoot: () => ({ render: mocks.render }),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createBrowserHistory: () => ({}),
  createHashHistory: () => ({}),
}));

vi.mock("./AppRoot", () => ({ AppRoot: "app-root" }));
vi.mock("./cloud/auth", () => ({ SovereignCloudAuthProvider: "sovereign-cloud-auth" }));
vi.mock("./cloud/managedAuth", () => ({ ManagedRelayAuthProvider: "managed-relay-auth" }));
vi.mock("./cloud/publicConfig", () => ({
  hasCloudPublicConfig: mocks.hasCloudPublicConfig,
  resolveCloudIdentityConfig: mocks.resolveCloudIdentityConfig,
}));
vi.mock("./components/clerk/BrowserManagedAuthShell", () => ({
  default: "browser-managed-auth-shell",
}));
vi.mock("./env", () => ({ isElectron: false }));
vi.mock("./lib/chunkReloadGuard", () => ({
  clearChunkReloadGuard: mocks.clearChunkReloadGuard,
  reloadOnceForChunkLoadError: () => false,
}));
vi.mock("./router", () => ({ getRouter: () => ({ load: mocks.routerLoad }) }));

function requireElement<
  Props extends { readonly children?: ReactNode } = {
    readonly children?: ReactNode;
  },
>(node: ReactNode) {
  expect(isValidElement(node)).toBe(true);
  if (!isValidElement<Props>(node)) {
    throw new Error("Expected a React element.");
  }
  return node;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("application auth bootstrap", () => {
  it("mounts Sovereign auth and managed Relay discovery for Sovereign builds", async () => {
    mocks.hasCloudPublicConfig.mockReturnValue(true);
    mocks.resolveCloudIdentityConfig.mockReturnValue({
      provider: "sovereign",
      issuer: "https://auth.example.test",
      clientId: "t3-code",
      resource: "https://relay.example.test",
    });
    const rootElement = {};
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    vi.stubGlobal("document", {
      getElementById: (id: string) => (id === "root" ? rootElement : null),
    });

    const { startup } = await import("./main");
    await startup;

    expect(mocks.routerLoad).toHaveBeenCalledOnce();
    expect(mocks.render).toHaveBeenCalledOnce();
    const strictMode = requireElement(mocks.render.mock.calls[0]?.[0]);
    const sovereignAuth = requireElement(strictMode.props.children);
    expect(sovereignAuth.type).toBe("sovereign-cloud-auth");
    const managedRelay = requireElement(sovereignAuth.props.children);
    expect(managedRelay.type).toBe("managed-relay-auth");
    const app = requireElement(managedRelay.props.children);
    expect(app.type).toBe("app-root");
  });

  it("retains the lazy managed auth shell for Clerk builds", async () => {
    mocks.hasCloudPublicConfig.mockReturnValue(true);
    mocks.resolveCloudIdentityConfig.mockReturnValue({
      provider: "clerk",
      publishableKey: "pk_test_example",
    });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    vi.stubGlobal("document", { getElementById: () => ({}) });

    const { startup } = await import("./main");
    await startup;

    const strictMode = requireElement(mocks.render.mock.calls[0]?.[0]);
    const managedAuth = requireElement<{
      readonly children?: ReactNode;
      readonly publishableKey: string;
    }>(strictMode.props.children);
    expect(managedAuth.type).toBe("browser-managed-auth-shell");
    expect(managedAuth.props.publishableKey).toBe("pk_test_example");
    expect(requireElement(managedAuth.props.children).type).toBe("app-root");
  });

  it("mounts the app directly when managed cloud auth is not configured", async () => {
    mocks.hasCloudPublicConfig.mockReturnValue(false);
    mocks.resolveCloudIdentityConfig.mockReturnValue(null);
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    vi.stubGlobal("document", { getElementById: () => ({}) });

    const { startup } = await import("./main");
    await startup;

    const strictMode = requireElement(mocks.render.mock.calls[0]?.[0]);
    expect(requireElement(strictMode.props.children).type).toBe("app-root");
  });
});
