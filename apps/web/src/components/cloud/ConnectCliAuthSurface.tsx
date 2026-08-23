import { useAuth, useClerk, useUser } from "@clerk/react";
import { encodeConnectAuthCode, readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildConnectCliOAuthAuthorizeUrl,
  connectCliSignInRedirectUrl,
  readConnectCliAuthState,
  readConnectCliCallbackResult,
  rememberConnectCliAuthState,
  resolveConnectCliOAuthConfig,
} from "../../cloud/connectCliAuth";
import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { AuthSurfaceShell } from "../auth/AuthSurfaceShell";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Button } from "../ui/button";

function ConnectCliAuthMessage({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <>
      {eyebrow ? (
        <p className="text-[10px] font-semibold tracking-[0.18em] text-blue-600 uppercase dark:text-blue-400">
          {eyebrow}
        </p>
      ) : null}
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}

const invalidLinkMessage = {
  eyebrow: "Authorization request",
  title: "This connect link is incomplete",
  description:
    "The link is missing its authorization request. Re-run `t3 connect` in your terminal and open the freshly printed URL.",
} as const;

/**
 * /connect is the URL the CLI prints for headless authorization and for Clerk
 * loopback authorization, where the hosted page must establish the session
 * before forwarding the preserved PKCE request.
 */
export function ConnectCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const config = resolveConnectCliOAuthConfig();

  if (config?.provider === "sovereign") {
    return <SovereignConnectCliAuthorizeSurface request={request} />;
  }
  return <ClerkConnectCliAuthorizeSurface request={request} />;
}

function SovereignConnectCliAuthorizeSurface({
  request,
}: {
  readonly request: ReturnType<typeof readConnectAuthorizeRequest>;
}) {
  const redirecting = useRef(false);
  const authorizeUrl = request ? buildConnectCliOAuthAuthorizeUrl(request) : null;

  useEffect(() => {
    if (!request || !authorizeUrl || redirecting.current) return;
    redirecting.current = true;
    rememberConnectCliAuthState(request.state);
    window.location.assign(authorizeUrl);
  }, [authorizeUrl, request]);

  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        {...(request
          ? {
              eyebrow: "Step 1 of 2 · Browser authorization",
              title: "Connecting your terminal",
              description: "Redirecting to your T3 account service…",
            }
          : invalidLinkMessage)}
      />
      {request && authorizeUrl ? (
        <a
          className="mt-6 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          href={authorizeUrl}
          onClick={() => rememberConnectCliAuthState(request.state)}
        >
          Continue to account
        </a>
      ) : null}
    </AuthSurfaceShell>
  );
}

function ClerkConnectCliAuthorizeSurface({
  request,
}: {
  readonly request: ReturnType<typeof readConnectAuthorizeRequest>;
}) {
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const signInOpened = useRef(false);
  const redirecting = useRef(false);

  const openSignIn = useCallback(() => {
    if (!request) {
      return;
    }
    // Clerk redirects to the authorize endpoint itself once sign-in completes,
    // so the callback's state check has to be armed before handing off.
    rememberConnectCliAuthState(request.state);
    clerk.openSignIn(
      resolveClerkSignInProps(
        connectCliSignInRedirectUrl(request, window.location.href),
        isElectron,
      ),
    );
  }, [clerk, request]);

  useEffect(() => {
    if (!request || !isLoaded || redirecting.current) {
      return;
    }
    if (!isSignedIn) {
      if (!signInOpened.current) {
        signInOpened.current = true;
        openSignIn();
      }
      return;
    }
    const authorizeUrl = buildConnectCliOAuthAuthorizeUrl(request);
    if (!authorizeUrl) {
      return;
    }
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
            ? "Redirecting to authorize T3 Connect for your CLI…"
            : "Sign in to continue authorizing T3 Connect for your CLI."
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

/** The issuer callback displays the one-time code entered in the waiting CLI. */
export function ConnectCliCallbackSurface() {
  return resolveConnectCliOAuthConfig()?.provider === "clerk" ? (
    <ClerkConnectCliCallbackSurface />
  ) : (
    <ConnectCliCallbackContent accountLabel={null} />
  );
}

function ClerkConnectCliCallbackSurface() {
  const { user } = useUser();
  const accountLabel = user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null;
  return <ConnectCliCallbackContent accountLabel={accountLabel} />;
}

function ConnectCliCallbackContent({ accountLabel }: { readonly accountLabel: string | null }) {
  const [result] = useState(readConnectCliCallbackResult);
  const [expectedState] = useState(readConnectCliAuthState);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "authentication code" });

  if (!result) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage
          eyebrow="Step 2 of 2 · Terminal handoff"
          title="Authorization did not complete"
          description="No authorization code was returned. Re-run `t3 connect` in your terminal and try again."
        />
      </AuthSurfaceShell>
    );
  }

  // Fail closed: the legitimate callback always lands in the same browser
  // that visited /connect (which recorded the state), so a missing or
  // mismatched state means this page was reached some other way — the CSRF
  // shape the state parameter exists to stop. Refuse to display a code.
  if (expectedState === null || expectedState !== result.state) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage
          eyebrow="Step 2 of 2 · Terminal handoff"
          title="This code belongs to a different request"
          description="This authorization response does not match a connect request started in this browser. Re-run `t3 connect` in your terminal and open the freshly printed URL in this browser."
        />
      </AuthSurfaceShell>
    );
  }

  const authCode = encodeConnectAuthCode(result);

  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        eyebrow="Step 2 of 2 · Terminal handoff"
        title="Almost connected"
        description={
          accountLabel
            ? `Enter this code in your waiting terminal to connect it as ${accountLabel}.`
            : "Enter this code in your waiting terminal to finish connecting."
        }
      />

      <div className="mt-6 overflow-hidden rounded-xl border border-border/80 bg-background/65">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
          <span className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            One-time authorization code
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">expires shortly</span>
        </div>
        <code
          className="block p-4 font-mono text-sm leading-relaxed break-all select-all"
          data-testid="connect-auth-code"
        >
          {authCode}
        </code>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button type="button" onClick={() => copyToClipboard(authCode)}>
          {isCopied ? "Copied!" : "Copy authorization code"}
        </Button>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        Only enter this code in a terminal session you started yourself. Anyone holding it can link
        their machine to your T3 Connect account while it is valid.
      </p>
    </AuthSurfaceShell>
  );
}
