import { ExternalLinkIcon, Link2Icon, LogInIcon, LogOutIcon, RefreshCwIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useCloudAuth } from "../../cloud/auth";
import { isElectron } from "../../env";
import { SovereignSignOutDialog } from "../clerk/SovereignSignOutDialog";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function ProfileSettings() {
  const auth = useCloudAuth();
  const navigate = useNavigate();
  const [signOutOpen, setSignOutOpen] = useState(false);

  const manageAuthentication = async () => {
    if (!auth.accountManagementUrl) return;
    if (isElectron) {
      await window.desktopBridge?.openExternal(auth.accountManagementUrl);
      return;
    }
    window.open(auth.accountManagementUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Account" id="account">
        {auth.isSignedIn ? (
          <>
            <SettingsRow
              title={auth.accountName ?? auth.accountEmail ?? "T3 Connect account"}
              description="The account currently used by this browser or desktop client."
              status={auth.accountEmail ?? undefined}
            />
            <SettingsRow
              title="Account ID"
              description="Stable sovereign identity used to own environments and connections."
              status={<span className="break-all font-mono">{auth.userId}</span>}
            />
            <SettingsRow
              title="Identity provider"
              description="Authentication authority for this client."
              status={
                auth.provider === "sovereign" ? "Self-hosted sovereign account service" : "Clerk"
              }
              control={
                auth.accountManagementUrl ? (
                  <Button size="sm" variant="outline" onClick={() => void manageAuthentication()}>
                    <ExternalLinkIcon />
                    Manage authentication
                  </Button>
                ) : undefined
              }
            />
            <SettingsRow
              title="Current client"
              description="The application instance holding this account session."
              status={isElectron ? "Desktop app" : "Browser"}
            />
            <SettingsRow
              title="Remote environments"
              description="Review linked machines, their status, and revoke access."
              control={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void navigate({ to: "/settings/connections" })}
                >
                  <Link2Icon />
                  Connections
                </Button>
              }
            />
            <SettingsRow
              title="Switch account"
              description="Sign out of this client and require an explicit account selection."
              control={
                <Button size="sm" variant="outline" onClick={() => auth.switchAccount()}>
                  <RefreshCwIcon />
                  Switch account
                </Button>
              }
            />
            <SettingsRow
              title="Sign out"
              description="Revoke this client's session without stopping or unlinking remote environments."
              control={
                <Button
                  size="sm"
                  variant="destructive-outline"
                  onClick={() => setSignOutOpen(true)}
                >
                  <LogOutIcon />
                  Sign out…
                </Button>
              }
            />
          </>
        ) : (
          <SettingsRow
            title="Not signed in"
            description="Sign in to view and connect remote environments owned by your account."
            control={
              <Button size="sm" onClick={() => auth.signIn()}>
                <LogInIcon />
                Sign in
              </Button>
            }
          />
        )}
      </SettingsSection>
      <SovereignSignOutDialog open={signOutOpen} onOpenChange={setSignOutOpen} />
    </SettingsPageContainer>
  );
}
