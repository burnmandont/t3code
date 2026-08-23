import { useAuth, useClerk, useUser } from "@clerk/react";
import { useCallback, useEffect, useRef } from "react";

import {
  buildConnectCliOAuthAuthorizeUrl,
  connectCliSignInRedirectUrl,
  rememberConnectCliAuthState,
} from "../../cloud/connectCliAuth";
import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { AuthSurfaceShell } from "../auth/AuthSurfaceShell";
import { Button } from "../ui/button";
import {
  ConnectCliAuthMessage,
  ConnectCliCallbackContent,
  invalidLinkMessage,
} from "./ConnectCliAuthSurface";
import type { readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";

type ConnectAuthorizeRequest = ReturnType<typeof readConnectAuthorizeRequest>;

export function ClerkConnectCliAuthorizeSurface({
  request,
}: {
  readonly request: ConnectAuthorizeRequest;
}) {
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const signInOpened = useRef(false);
  const redirecting = useRef(false);

  const openSignIn = useCallback(() => {
    if (!request) return;
    rememberConnectCliAuthState(request.state);
    clerk.openSignIn(
      resolveClerkSignInProps(
        connectCliSignInRedirectUrl(request, window.location.href),
        isElectron,
      ),
    );
  }, [clerk, request]);

  useEffect(() => {
    if (!request || !isLoaded || redirecting.current) return;
    if (!isSignedIn) {
      if (!signInOpened.current) {
        signInOpened.current = true;
        openSignIn();
      }
      return;
    }
    const authorizeUrl = buildConnectCliOAuthAuthorizeUrl(request);
    if (!authorizeUrl) return;
    redirecting.current = true;
    rememberConnectCliAuthState(request.state);
    window.location.assign(authorizeUrl);
  }, [isLoaded, isSignedIn, openSignIn, request]);

  if (!request) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage {...invalidLinkMessage} />
      </AuthSurfaceShell>
    );
  }

  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        eyebrow={
          request.loopbackPort === undefined
            ? "Step 1 of 2 · Browser authorization"
            : "Browser authorization"
        }
        title="Connecting your terminal"
        description={
          isSignedIn
            ? "Redirecting to authorize Sovereign Relay for your CLI…"
            : "Sign in to continue authorizing Sovereign Relay for your CLI."
        }
      />
      {isLoaded && !isSignedIn ? (
        <div className="mt-6">
          <Button type="button" onClick={openSignIn}>
            Sign in
          </Button>
        </div>
      ) : null}
    </AuthSurfaceShell>
  );
}

export function ClerkConnectCliCallbackSurface() {
  const { user } = useUser();
  const accountLabel = user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null;
  return <ConnectCliCallbackContent accountLabel={accountLabel} />;
}
