import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider as ElectronClerkProvider } from "@clerk/electron/react";
import { ClerkProvider } from "@clerk/react";
import type { ReactNode } from "react";

import { isElectron } from "../env";
import { clerkAppearance } from "../components/clerk/clerkAppearance";
import { ClerkCloudAuthProvider } from "./ClerkCloudAuthProvider";
import { ManagedRelayAuthProvider } from "./managedAuth";
import type { CloudIdentityConfig } from "./publicConfig";

export default function ClerkCloudRoot({
  config,
  children,
}: {
  readonly config: Extract<CloudIdentityConfig, { readonly provider: "clerk" }>;
  readonly children: ReactNode;
}) {
  const electronClerkUi = { __internal_clerkUIVersion: "1.30.5-canary.v20260819050620" };
  const content = (
    <ClerkCloudAuthProvider>
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkCloudAuthProvider>
  );

  if (isElectron) {
    return (
      <ElectronClerkProvider
        {...electronClerkUi}
        appearance={clerkAppearance}
        passkeys={passkeys}
        publishableKey={config.publishableKey}
      >
        {content}
      </ElectronClerkProvider>
    );
  }

  return (
    <ClerkProvider appearance={clerkAppearance} publishableKey={config.publishableKey}>
      {content}
    </ClerkProvider>
  );
}
