import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider as ElectronClerkProvider } from "@clerk/electron/react";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { ClerkCloudAuthProvider, SovereignCloudAuthProvider } from "./cloud/auth";
import { hasCloudPublicConfig, resolveCloudIdentityConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import { clerkAppearance } from "./components/clerk/clerkAppearance";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const identityConfig = resolveCloudIdentityConfig();

// First Clerk UI build containing https://github.com/clerk/javascript/pull/9500.
const electronClerkUI = {
  __internal_clerkUIVersion: "1.30.5-canary.v20260819050620",
};

const app = <AppRoot router={router} />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {identityConfig?.provider === "sovereign" && hasCloudPublicConfig() ? (
      <SovereignCloudAuthProvider config={identityConfig}>
        <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
      </SovereignCloudAuthProvider>
    ) : identityConfig?.provider === "clerk" && hasCloudPublicConfig() ? (
      isElectron ? (
        <ElectronClerkProvider
          {...electronClerkUI}
          appearance={clerkAppearance}
          publishableKey={identityConfig.publishableKey}
          passkeys={passkeys}
        >
          <ClerkCloudAuthProvider>
            <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
          </ClerkCloudAuthProvider>
        </ElectronClerkProvider>
      ) : (
        <ClerkProvider appearance={clerkAppearance} publishableKey={identityConfig.publishableKey}>
          <ClerkCloudAuthProvider>
            <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
          </ClerkCloudAuthProvider>
        </ClerkProvider>
      )
    ) : (
      app
    )}
  </React.StrictMode>,
);
