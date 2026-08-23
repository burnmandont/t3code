import { useAuth, useClerk, useUser } from "@clerk/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  SOVEREIGN_APP_CALLBACK_PATH,
  SOVEREIGN_CONNECT_OAUTH_SCOPES,
} from "@t3tools/shared/connectAuth";

import { isElectron } from "../env";
import { resolveClerkSignInProps } from "../components/clerk/authRedirect";
import { resolveRelayClerkTokenOptions, type CloudIdentityConfig } from "./publicConfig";
import { makeSovereignAuthClient } from "./sovereignAuth";

export interface CloudAuthSession {
  readonly provider: "clerk" | "sovereign" | "disabled";
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly accountLabel: string | null;
  readonly accountEmail: string | null;
  readonly accountName: string | null;
  readonly accountManagementUrl: string | null;
  readonly authorizationUrl: string | null;
  readonly getToken: () => Promise<string | null>;
  readonly signIn: (returnUrl?: string) => void;
  readonly switchAccount: (returnUrl?: string) => void;
  readonly signOut: () => Promise<{ readonly revoked: boolean }>;
}

const disabledCloudAuthSession: CloudAuthSession = {
  provider: "disabled",
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  accountLabel: null,
  accountEmail: null,
  accountName: null,
  accountManagementUrl: null,
  authorizationUrl: null,
  getToken: async () => null,
  signIn: () => undefined,
  switchAccount: () => undefined,
  signOut: async () => ({ revoked: true }),
};

const CloudAuthContext = createContext<CloudAuthSession>(disabledCloudAuthSession);

export function useCloudAuth(): CloudAuthSession {
  return useContext(CloudAuthContext);
}

export function ClerkCloudAuthProvider({ children }: { readonly children: ReactNode }) {
  const {
    getToken: getClerkToken,
    isLoaded,
    isSignedIn,
    userId,
  } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const clerk = useClerk();
  const { user } = useUser();
  const getToken = useCallback(
    () => getClerkToken(resolveRelayClerkTokenOptions()),
    [getClerkToken],
  );
  const signIn = useCallback(
    (returnUrl = window.location.href) => {
      clerk.openSignIn(resolveClerkSignInProps(returnUrl, isElectron));
    },
    [clerk],
  );
  const signOut = useCallback(async () => {
    await clerk.signOut();
    return { revoked: true };
  }, [clerk]);
  const switchAccount = useCallback(
    (returnUrl = window.location.href) => {
      void clerk
        .signOut()
        .then(() => clerk.openSignIn(resolveClerkSignInProps(returnUrl, isElectron)));
    },
    [clerk],
  );
  const value = useMemo<CloudAuthSession>(
    () => ({
      provider: "clerk",
      isLoaded,
      isSignedIn: Boolean(isSignedIn),
      userId: userId ?? null,
      accountLabel: user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null,
      accountEmail: user?.primaryEmailAddress?.emailAddress ?? null,
      accountName: user?.fullName ?? user?.username ?? null,
      accountManagementUrl: null,
      authorizationUrl: null,
      getToken,
      signIn,
      switchAccount,
      signOut,
    }),
    [getToken, isLoaded, isSignedIn, signIn, signOut, switchAccount, user, userId],
  );

  return <CloudAuthContext.Provider value={value}>{children}</CloudAuthContext.Provider>;
}

function BrowserSovereignCloudAuthProvider({
  config,
  children,
}: {
  readonly config: Extract<CloudIdentityConfig, { readonly provider: "sovereign" }>;
  readonly children: ReactNode;
}) {
  const rendererBaseUrl = `${window.location.protocol}//${window.location.host}`;
  const redirectUri = `${rendererBaseUrl}${SOVEREIGN_APP_CALLBACK_PATH}`;
  const client = useMemo(
    () =>
      makeSovereignAuthClient(
        {
          appOrigin: window.location.origin,
          appProtocol: window.location.protocol,
          appHost: window.location.host,
          authorizationEndpoint: `${config.issuer}/oauth2/authorize`,
          tokenEndpoint: `${config.issuer}/oauth2/token`,
          userInfoEndpoint: `${config.issuer}/oauth2/userinfo`,
          revocationEndpoint: `${config.issuer}/oauth2/revoke`,
          clientId: config.clientId,
          redirectUri,
          resource: config.resource,
          scopes: SOVEREIGN_CONNECT_OAUTH_SCOPES,
        },
        {
          tokenStorage: window.localStorage,
          transactionStorage: window.sessionStorage,
          fetch: window.fetch.bind(window),
          crypto: window.crypto,
        },
      ),
    [config.clientId, config.issuer, config.resource, redirectUri],
  );
  const [session, setSession] = useState(() => ({
    isLoaded: false,
    ...client.snapshot(),
  }));
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (window.location.pathname === SOVEREIGN_APP_CALLBACK_PATH) {
        try {
          const returnUrl = await client.completeSignIn(window.location.href);
          window.location.replace(returnUrl);
          return;
        } catch {
          client.clear();
          window.history.replaceState(null, "", `${rendererBaseUrl}/`);
        }
      } else {
        await client.getToken();
        try {
          await client.getUserInfo();
        } catch (cause) {
          console.warn("[t3-connect] Could not refresh sovereign account identity", cause);
        }
      }
      if (!cancelled) setSession({ isLoaded: true, ...client.snapshot() });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, rendererBaseUrl]);

  const getToken = useCallback(async () => {
    const token = await client.getToken();
    if (!token) setSession({ isLoaded: true, ...client.snapshot() });
    return token;
  }, [client]);
  const signIn = useCallback(
    (returnUrl = window.location.href) => {
      void client
        .beginSignIn(returnUrl)
        .then((authorizationUrl) => {
          setAuthorizationUrl(authorizationUrl);
          window.location.assign(authorizationUrl);
        })
        .catch((cause: unknown) => {
          console.error("[t3-connect] Could not start sovereign sign-in", cause);
        });
    },
    [client],
  );
  const signOut = useCallback(async () => {
    const result = await client.signOut();
    setAuthorizationUrl(null);
    setSession({ isLoaded: true, ...client.snapshot() });
    return result;
  }, [client]);
  const switchAccount = useCallback(
    (returnUrl = window.location.href) => {
      void client.signOut().then(() =>
        client.beginSignIn(returnUrl, { prompt: "login" }).then((url) => {
          setAuthorizationUrl(url);
          window.location.assign(url);
        }),
      );
    },
    [client],
  );
  const accountManagementUrl = new URL("/sign-in", config.issuer).toString();
  const value = useMemo<CloudAuthSession>(
    () => ({
      provider: "sovereign",
      ...session,
      accountLabel: session.email ?? session.name ?? session.userId,
      accountEmail: session.email,
      accountName: session.name,
      accountManagementUrl,
      authorizationUrl,
      getToken,
      signIn,
      switchAccount,
      signOut,
    }),
    [accountManagementUrl, authorizationUrl, getToken, session, signIn, signOut, switchAccount],
  );

  if (!session.isLoaded) return null;
  return <CloudAuthContext.Provider value={value}>{children}</CloudAuthContext.Provider>;
}

function DesktopSovereignCloudAuthProvider({
  config,
  children,
}: {
  readonly config: Extract<CloudIdentityConfig, { readonly provider: "sovereign" }>;
  readonly children: ReactNode;
}) {
  const bridge = window.desktopBridge?.sovereignAuth;
  const [session, setSession] = useState({
    isLoaded: false,
    isSignedIn: false,
    userId: null as string | null,
    email: null as string | null,
    name: null as string | null,
  });
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) {
      setSession({ isLoaded: true, isSignedIn: false, userId: null, email: null, name: null });
      return;
    }
    let cancelled = false;
    const applySnapshot = (snapshot: {
      readonly isSignedIn: boolean;
      readonly userId: string | null;
      readonly email: string | null;
      readonly name: string | null;
    }) => {
      if (!cancelled) setSession({ isLoaded: true, ...snapshot });
    };
    const unsubscribe = bridge.onStateChange(applySnapshot);
    void bridge
      .getSnapshot()
      .then(applySnapshot)
      .catch((cause: unknown) => {
        console.error("[t3-connect] Could not load sovereign desktop session", cause);
        applySnapshot({ isSignedIn: false, userId: null, email: null, name: null });
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  const getToken = useCallback(async () => {
    if (!bridge) return null;
    const token = await bridge.getToken();
    if (!token)
      setSession({ isLoaded: true, isSignedIn: false, userId: null, email: null, name: null });
    return token;
  }, [bridge]);
  const signIn = useCallback(
    (returnUrl = window.location.href) => {
      if (!bridge) return;
      void bridge
        .beginSignIn({ returnUrl })
        .then(async (authorizationUrl) => {
          setAuthorizationUrl(authorizationUrl);
          const opened = await window.desktopBridge?.openExternal(authorizationUrl);
          if (!opened) throw new Error("The system browser could not be opened.");
        })
        .catch((cause: unknown) => {
          console.error("[t3-connect] Could not start sovereign desktop sign-in", cause);
        });
    },
    [bridge],
  );
  const signOut = useCallback(async () => {
    if (!bridge) return { revoked: true };
    const result = await bridge.signOut();
    setAuthorizationUrl(null);
    setSession({ isLoaded: true, isSignedIn: false, userId: null, email: null, name: null });
    return result;
  }, [bridge]);
  const switchAccount = useCallback(
    (returnUrl = window.location.href) => {
      if (!bridge) return;
      void bridge.signOut().then(() =>
        bridge.beginSignIn({ returnUrl, prompt: "login" }).then(async (url) => {
          setAuthorizationUrl(url);
          await window.desktopBridge?.openExternal(url);
        }),
      );
    },
    [bridge],
  );
  const value = useMemo<CloudAuthSession>(
    () => ({
      provider: "sovereign",
      ...session,
      accountLabel: session.email ?? session.name ?? session.userId,
      accountEmail: session.email,
      accountName: session.name,
      accountManagementUrl: new URL("/sign-in", config.issuer).toString(),
      authorizationUrl,
      getToken,
      signIn,
      switchAccount,
      signOut,
    }),
    [authorizationUrl, config.issuer, getToken, session, signIn, signOut, switchAccount],
  );

  if (!session.isLoaded) return null;
  return <CloudAuthContext.Provider value={value}>{children}</CloudAuthContext.Provider>;
}

export function SovereignCloudAuthProvider({
  config,
  children,
}: {
  readonly config: Extract<CloudIdentityConfig, { readonly provider: "sovereign" }>;
  readonly children: ReactNode;
}) {
  return isElectron ? (
    <DesktopSovereignCloudAuthProvider config={config}>
      {children}
    </DesktopSovereignCloudAuthProvider>
  ) : (
    <BrowserSovereignCloudAuthProvider config={config}>
      {children}
    </BrowserSovereignCloudAuthProvider>
  );
}
