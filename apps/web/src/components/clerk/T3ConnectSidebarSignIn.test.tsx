import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("../../cloud/publicConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cloud/publicConfig")>()),
  hasCloudPublicConfig: () => true,
}));
vi.mock("../../cloud/auth", () => ({
  useCloudAuth: () => ({
    provider: "sovereign",
    isLoaded: true,
    isSignedIn: true,
    userId: "account-1",
    accountLabel: "sam@example.test",
    accountEmail: "sam@example.test",
    accountName: "Sam",
    accountManagementUrl: "https://auth.example.test/sign-in",
    authorizationUrl: null,
    getToken: vi.fn(),
    signIn: vi.fn(),
    switchAccount: vi.fn(),
    signOut: vi.fn(),
  }),
}));

import { SidebarProvider } from "../ui/sidebar";
import { T3ConnectSidebarAvatar } from "./T3ConnectSidebarSignIn";

describe("T3ConnectSidebarAvatar", () => {
  it("renders the sovereign account menu with valid Base UI structure", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <T3ConnectSidebarAvatar />
      </SidebarProvider>,
    );

    expect(html).toContain("Open T3 Connect account menu");
    expect(html).toContain("sam@example.test");
    expect(html).toContain("justify-center");
    expect(html).toContain("size-9!");
  });
});
