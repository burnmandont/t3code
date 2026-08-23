import { UserButton } from "@clerk/react";
import { ServerIcon, SmartphoneIcon } from "lucide-react";

import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";

export default function ClerkSidebarAvatar() {
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
        label="Sovereign Relay"
        labelIcon={<ServerIcon className="size-4" />}
        url="t3-connect"
      >
        <T3ConnectUserProfilePage />
      </UserButton.UserProfilePage>
    </UserButton>
  );
}
