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
import { SOVEREIGN_CONNECT_OAUTH_SCOPES } from "@t3tools/shared/connectAuth";

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
  readonly getToken: () => Promise<string | null>;
  readonly signIn: (returnUrl?: string) => void;
  readonly signOut: () => Promise<void>;
}

const disabledCloudAuthSession: CloudAuthSession = {
  provider: "disabled",
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  accountLabel: null,
  getToken: async () => null,
  signIn: () => undefined,
  signOut: async () => undefined,
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
  }, [clerk]);
  const value = useMemo<CloudAuthSession>(
    () => ({
      provider: "clerk",
      isLoaded,
      isSignedIn: Boolean(isSignedIn),
      userId: userId ?? null,
      accountLabel: user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null,
      getToken,
      signIn,
      signOut,
    }),
    [getToken, isLoaded, isSignedIn, signIn, signOut, user, userId],
  );

  return <CloudAuthContext.Provider value={value}>{children}</CloudAuthContext.Provider>;
}

export function SovereignCloudAuthProvider({
  config,
  children,
}: {
  readonly config: Extract<CloudIdentityConfig, { readonly provider: "sovereign" }>;
  readonly children: ReactNode;
}) {
  const rendererBaseUrl = `${window.location.protocol}//${window.location.host}`;
  const redirectUri = `${rendererBaseUrl}/oauth/callback`;
  const client = useMemo(
    () =>
      makeSovereignAuthClient(
        {
          appOrigin: window.location.origin,
          appProtocol: window.location.protocol,
          appHost: window.location.host,
          authorizationEndpoint: `${config.issuer}/oauth2/authorize`,
          tokenEndpoint: `${config.issuer}/oauth2/token`,
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (window.location.pathname === "/oauth/callback") {
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
          window.location.assign(authorizationUrl);
        })
        .catch((cause: unknown) => {
          console.error("[t3-connect] Could not start sovereign sign-in", cause);
        });
    },
    [client],
  );
  const signOut = useCallback(async () => {
    client.clear();
    setSession({ isLoaded: true, ...client.snapshot() });
  }, [client]);
  const value = useMemo<CloudAuthSession>(
    () => ({
      provider: "sovereign",
      ...session,
      accountLabel: session.userId,
      getToken,
      signIn,
      signOut,
    }),
    [getToken, session, signIn, signOut],
  );

  if (!session.isLoaded) return null;
  return <CloudAuthContext.Provider value={value}>{children}</CloudAuthContext.Provider>;
}
