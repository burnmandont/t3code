import { UserButton } from "@clerk/react";
import {
  CircleUserRoundIcon,
  Link2Icon,
  LogInIcon,
  LogOutIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
  SmartphoneIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

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
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";
import { SovereignSignOutDialog } from "./SovereignSignOutDialog";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

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
                    title={accountLabel ? `Account: ${accountLabel}` : "T3 Connect account"}
                  />
                }
              >
                <CircleUserRoundIcon />
                <span className="sr-only">Open T3 Connect account menu</span>
              </DropdownMenuTrigger>
            </SidebarMenuItem>
          </SidebarMenu>
          <DropdownMenuContent side="top" align="start" className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="space-y-0.5">
                <div className="truncate text-foreground">
                  {accountName ?? "T3 Connect account"}
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

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
        },
      }}
    >
      <UserButton.UserProfilePage
        label="Mobile clients"
        labelIcon={<SmartphoneIcon className="size-4" />}
        url="mobile-clients"
      >
        <MobileClientsUserProfilePage />
      </UserButton.UserProfilePage>
      <UserButton.UserProfilePage
        label="T3 Connect"
        labelIcon={<ServerIcon className="size-4" />}
        url="t3-connect"
      >
        <T3ConnectUserProfilePage />
      </UserButton.UserProfilePage>
    </UserButton>
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
              <span>Continue T3 Connect sign-in</span>
            </SidebarMenuButton>
          ) : (
            <SidebarMenuButton onClick={openAuthPrompt}>
              <LogInIcon />
              <span>Sign in to T3 Connect</span>
            </SidebarMenuButton>
          )}
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
