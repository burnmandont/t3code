import type { DesktopAppBranding } from "@t3tools/contracts";
import { formatAppDisplayName } from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding?.() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" ||
  hostedAppChannel === "nightly" ||
  hostedAppChannel === "sovereign"
    ? hostedAppChannel
    : null;
export const HOSTED_APP_CHANNEL_LABEL =
  HOSTED_APP_CHANNEL === "nightly"
    ? "Nightly"
    : HOSTED_APP_CHANNEL === "latest" || HOSTED_APP_CHANNEL === "sovereign"
      ? "Latest"
      : null;
export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? "Sovereign";
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ??
  HOSTED_APP_CHANNEL_LABEL ??
  (import.meta.env.DEV ? "Dev" : "Alpha");
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ??
  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
/** Server runtime closure this client was built to manage. Empty until the
    release pipeline supplies content-derived runtime identities. */
export const TARGET_SERVER_RUNTIME_ID =
  import.meta.env.T3CODE_TARGET_SERVER_RUNTIME_ID?.trim() || null;
