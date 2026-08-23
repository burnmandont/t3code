import { UserButton } from "@clerk/react";
import { CircleUserRoundIcon, LogInIcon, ServerIcon, SmartphoneIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useCloudAuth } from "../../cloud/auth";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";
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
  const { accountLabel, isLoaded, isSignedIn, provider, signOut } = useCloudAuth();

  if (!isLoaded || !isSignedIn) return null;

  if (provider === "sovereign") {
    return (
      <SidebarMenu className="w-auto shrink-0">
        <SidebarMenuItem>
          <SidebarMenuButton
            className="size-9 px-0"
            title={accountLabel ? `Sign out ${accountLabel}` : "Sign out of T3 Connect"}
            onClick={() => void signOut()}
          >
            <CircleUserRoundIcon />
            <span className="sr-only">Sign out of T3 Connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
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
