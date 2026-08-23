import {
  CircleUserRoundIcon,
  Link2Icon,
  LogInIcon,
  LogOutIcon,
  RefreshCwIcon,
  SettingsIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useCloudAuth } from "../../cloud/auth";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { SovereignSignOutDialog } from "./SovereignSignOutDialog";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

declare const __T3CODE_BUILD_SOVEREIGN__: boolean;

const sovereignBuild =
  typeof __T3CODE_BUILD_SOVEREIGN__ !== "undefined" && __T3CODE_BUILD_SOVEREIGN__;

const ClerkSidebarAvatar = sovereignBuild ? null : lazy(() => import("./ClerkSidebarAvatar"));

export function T3ConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarSignIn />;
}

export function T3ConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarAvatar />;
}

function ConfiguredT3ConnectSidebarAvatar() {
  const { accountLabel, accountName, isLoaded, isSignedIn, provider, switchAccount } =
    useCloudAuth();
  const navigate = useNavigate();
  const [signOutOpen, setSignOutOpen] = useState(false);

  if (!isLoaded || !isSignedIn) return null;

  if (provider === "sovereign") {
    return (
      <>
        <DropdownMenu>
          <SidebarMenu className="w-auto shrink-0">
            <SidebarMenuItem>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    size="icon"
                    className="size-9! shrink-0"
                    title={accountLabel ? `Account: ${accountLabel}` : "Sovereign Relay account"}
                  />
                }
              >
                <CircleUserRoundIcon />
                <span className="sr-only">Open Sovereign Relay account menu</span>
              </DropdownMenuTrigger>
            </SidebarMenuItem>
          </SidebarMenu>
          <DropdownMenuContent side="top" align="start" className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="space-y-0.5">
                <div className="truncate text-foreground">
                  {accountName ?? "Sovereign Relay account"}
                </div>
                {accountLabel ? <div className="truncate font-normal">{accountLabel}</div> : null}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void navigate({ to: "/settings/profile" })}>
              <SettingsIcon />
              Account settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void navigate({ to: "/settings/connections" })}>
              <Link2Icon />
              Connections
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => switchAccount()}>
              <RefreshCwIcon />
              Switch account
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setSignOutOpen(true)}>
              <LogOutIcon />
              Sign out…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <SovereignSignOutDialog open={signOutOpen} onOpenChange={setSignOutOpen} />
      </>
    );
  }

  if (!ClerkSidebarAvatar) return null;
  return (
    <Suspense fallback={null}>
      <ClerkSidebarAvatar />
    </Suspense>
  );
}

function ConfiguredT3ConnectSidebarSignIn() {
  const { authorizationUrl, isLoaded, isSignedIn } = useCloudAuth();
  const { authPrompt, openAuthPrompt } = useT3ConnectAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          {authorizationUrl ? (
            <SidebarMenuButton render={<a href={authorizationUrl} />}>
              <LogInIcon />
              <span>Continue Sovereign Relay sign-in</span>
            </SidebarMenuButton>
          ) : (
            <SidebarMenuButton onClick={openAuthPrompt}>
              <LogInIcon />
              <span>Sign in to Sovereign Relay</span>
            </SidebarMenuButton>
          )}
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
