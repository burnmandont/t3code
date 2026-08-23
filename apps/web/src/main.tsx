import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { SovereignCloudAuthProvider } from "./cloud/auth";
import { hasCloudPublicConfig, resolveCloudIdentityConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";

declare const __T3CODE_BUILD_SOVEREIGN__: boolean;

const sovereignBuild =
  typeof __T3CODE_BUILD_SOVEREIGN__ !== "undefined" && __T3CODE_BUILD_SOVEREIGN__;

const ClerkCloudRoot = sovereignBuild ? null : React.lazy(() => import("./cloud/ClerkCloudRoot"));

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const identityConfig = resolveCloudIdentityConfig();

const app = <AppRoot router={router} />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {identityConfig?.provider === "sovereign" && hasCloudPublicConfig() ? (
      <SovereignCloudAuthProvider config={identityConfig}>
        <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
      </SovereignCloudAuthProvider>
    ) : identityConfig?.provider === "clerk" && hasCloudPublicConfig() && ClerkCloudRoot ? (
      <React.Suspense fallback={null}>
        <ClerkCloudRoot config={identityConfig}>{app}</ClerkCloudRoot>
      </React.Suspense>
    ) : (
      app
    )}
  </React.StrictMode>,
);
