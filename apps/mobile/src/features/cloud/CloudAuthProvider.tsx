import { ManagedRelay, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  getComposerCloudAccountId,
  restoreCloudComposerDrafts,
} from "../../state/use-composer-drafts";
import {
  releaseAgentAwarenessRelayTokenProvider,
  setAgentAwarenessRelayTokenProvider,
  unregisterAgentAwarenessDeviceForCurrentUser,
} from "../agent-awareness/remoteRegistration";
import { clearConnectOnboardingRequest, requestConnectOnboarding } from "./connectOnboarding";
import {
  type CloudIdentityConfig,
  resolveCloudIdentityConfig,
  resolveCloudPublicConfig,
} from "./publicConfig";
import { makeSovereignMobileAuthClient } from "./sovereignMobileAuth";
import { removeCloudEnvironments } from "./cloud-drafts";

export interface MobileCloudAuthSession {
  readonly provider: "sovereign" | "disabled";
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly accountLabel: string | null;
  readonly accountEmail: string | null;
  readonly accountName: string | null;
  readonly accountManagementUrl: string | null;
  readonly getToken: () => Promise<string | null>;
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<{ readonly revoked: boolean }>;
}

const disabledCloudAuthSession: MobileCloudAuthSession = {
  provider: "disabled",
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  accountLabel: null,
  accountEmail: null,
  accountName: null,
  accountManagementUrl: null,
  getToken: async () => null,
  signIn: async () => undefined,
  signOut: async () => ({ revoked: true }),
};

const MobileCloudAuthContext = createContext<MobileCloudAuthSession>(disabledCloudAuthSession);

export function useMobileCloudAuth(): MobileCloudAuthSession {
  return useContext(MobileCloudAuthContext);
}

function resetManagedRelayTokenCache() {
  return settleAsyncResult(() =>
    runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
    ),
  );
}

type SovereignMobileSignInClient = Pick<
  ReturnType<typeof makeSovereignMobileAuthClient>,
  "getToken" | "signIn" | "snapshot"
>;
type SovereignMobileSignOutClient = Pick<
  ReturnType<typeof makeSovereignMobileAuthClient>,
  "getToken" | "signOut" | "snapshot"
>;

interface SovereignAccountDeparture {
  readonly userId: string;
  readonly accessToken: string;
}

/**
 * Captures the departing account credential before native OAuth can replace it.
 * A cancelled sign-in leaves the current account untouched and emits no cleanup.
 */
export async function signInSovereignMobileAccount(
  client: SovereignMobileSignInClient,
  onAccountDeparture: (departure: SovereignAccountDeparture) => void,
) {
  const previous = client.snapshot();
  const previousAccessToken = previous.userId ? await client.getToken() : null;
  const next = await client.signIn();
  if (previous.userId && previous.userId !== next.userId && previousAccessToken) {
    onAccountDeparture({ userId: previous.userId, accessToken: previousAccessToken });
  }
  return next;
}

/** Revokes and clears authorization, then schedules best-effort server teardown. */
export async function signOutSovereignMobileAccount(
  client: SovereignMobileSignOutClient,
  onAccountDeparture: (departure: SovereignAccountDeparture) => void,
) {
  const previous = client.snapshot();
  const previousAccessToken = previous.userId ? await client.getToken() : null;
  const result = await client.signOut();
  if (previous.userId && previousAccessToken) {
    onAccountDeparture({ userId: previous.userId, accessToken: previousAccessToken });
  }
  return result;
}

function queueAgentAwarenessDeviceUnregistration(departure: SovereignAccountDeparture): void {
  const fixedTokenProvider = async () => departure.accessToken;
  void (async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(unregisterAgentAwarenessDeviceForCurrentUser(fixedTokenProvider)),
    );
    reportAtomCommandResult(result, {
      label: `cloud account device cleanup (${departure.userId})`,
    });
  })();
}

export function deactivateCloudRelayAccount(): void {
  setAgentAwarenessRelayTokenProvider(null);
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateCloudRelayAccount(
  accountId: string,
  tokenProvider: () => Promise<string | null>,
): void {
  setAgentAwarenessRelayTokenProvider(tokenProvider, accountId);
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken: tokenProvider,
  });
}

function RelayCloudAuthBridge(props: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useMobileCloudAuth();
  const removeRelayEnvironments = useAtomCommand(removeCloudEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const observedAccountRef = useRef<string | null | undefined>(undefined);
  const accountTransitionRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!isLoaded) return;

    const previousObservedAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;
    const isAccountTransition =
      previousObservedAccount !== undefined && previousObservedAccount !== nextAccount;
    if (isAccountTransition && nextAccount === null) clearConnectOnboardingRequest();

    const cleanUpAccount = async (accountId: string | null) => {
      const removal = await removeRelayEnvironments(accountId);
      if (removal._tag !== "Success") throw squashAtomCommandFailure(removal);
      const cleanup = [resetManagedRelayTokenCache()];
      const results = await Promise.all(cleanup);
      for (const result of results) {
        reportAtomCommandResult(result, { label: "cloud account cleanup" });
      }
    };
    const queueAccountCleanup = (accountId: string | null) => {
      const previousTransition = accountTransitionRef.current ?? Promise.resolve();
      accountTransitionRef.current = previousTransition
        .catch(() => {})
        .then(() => cleanUpAccount(accountId));
      return accountTransitionRef.current;
    };

    if (!isSignedIn || !userId) {
      deactivateCloudRelayAccount();
      if (previousObservedAccount !== null) {
        void settlePromise(() => queueAccountCleanup(previousObservedAccount ?? null)).then(
          (result) => {
            reportAtomCommandResult(result, { label: "cloud account cleanup" });
          },
        );
      }
      return;
    }

    const tokenProvider = getToken;
    const activateSession = () => {
      if (cancelled) return;
      activateCloudRelayAccount(userId, tokenProvider);
      if (isAccountTransition) requestConnectOnboarding(userId);
    };
    const activateAfterTransition = (transition: Promise<void>) => {
      const activation = (async () => {
        await transition;
        if (cancelled) return;
        const storedAccount = await getComposerCloudAccountId();
        if (storedAccount !== null && storedAccount !== userId) {
          await cleanUpAccount(storedAccount);
        }
        if (cancelled) return;
        await restoreCloudComposerDrafts(userId);
        activateSession();
      })();
      accountTransitionRef.current = activation;
      void settlePromise(() => activation).then((result) => {
        reportAtomCommandResult(result, { label: "cloud account activation" });
      });
    };
    if (
      previousObservedAccount !== undefined &&
      previousObservedAccount !== null &&
      previousObservedAccount !== userId
    ) {
      deactivateCloudRelayAccount();
      activateAfterTransition(queueAccountCleanup(previousObservedAccount));
    } else {
      // A failed disk write can be retried. The persisted account check above
      // still requires cleanup before activating a different account.
      activateAfterTransition((accountTransitionRef.current ?? Promise.resolve()).catch(() => {}));
    }

    return () => {
      cancelled = true;
    };
  }, [getToken, isLoaded, isSignedIn, removeRelayEnvironments, userId]);

  useEffect(
    () => () => {
      releaseAgentAwarenessRelayTokenProvider();
      setManagedRelaySession(appAtomRegistry, null);
    },
    [],
  );

  return props.children;
}

function SovereignCloudAuthSessionProvider({
  config,
  children,
}: {
  readonly config: Extract<CloudIdentityConfig, { readonly provider: "sovereign" }>;
  readonly children: ReactNode;
}) {
  const redirectUri = `${config.redirectScheme}://app/connect/account/callback`;
  const client = useMemo(
    () =>
      makeSovereignMobileAuthClient({
        issuer: config.issuer,
        clientId: config.clientId,
        resource: config.resource,
        redirectUri,
      }),
    [config.clientId, config.issuer, config.resource, redirectUri],
  );
  const [session, setSession] = useState({
    isLoaded: false,
    isSignedIn: false,
    userId: null as string | null,
    email: null as string | null,
    name: null as string | null,
  });

  useEffect(() => {
    let cancelled = false;
    void client.initialize().then(async () => {
      await client.getToken();
      try {
        await client.getUserInfo();
      } catch (cause) {
        console.warn("[t3-connect] Could not refresh sovereign mobile account identity", cause);
      }
      if (!cancelled) setSession({ isLoaded: true, ...client.snapshot() });
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const getToken = useCallback(async () => {
    const token = await client.getToken();
    setSession({ isLoaded: true, ...client.snapshot() });
    return token;
  }, [client]);
  const signIn = useCallback(async () => {
    const next = await signInSovereignMobileAccount(
      client,
      queueAgentAwarenessDeviceUnregistration,
    );
    setSession({ isLoaded: true, ...next });
  }, [client]);
  const signOut = useCallback(async () => {
    const next = await signOutSovereignMobileAccount(
      client,
      queueAgentAwarenessDeviceUnregistration,
    );
    const { revoked, ...snapshot } = next;
    setSession({ isLoaded: true, ...snapshot });
    return { revoked };
  }, [client]);
  const value = useMemo<MobileCloudAuthSession>(
    () => ({
      provider: "sovereign",
      ...session,
      accountLabel: session.email ?? session.name ?? (session.isSignedIn ? "Signed in" : null),
      accountEmail: session.email,
      accountName: session.name,
      accountManagementUrl: new URL("/sign-in", config.issuer).toString(),
      getToken,
      signIn,
      signOut,
    }),
    [config.issuer, getToken, session, signIn, signOut],
  );
  return <MobileCloudAuthContext value={value}>{children}</MobileCloudAuthContext>;
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  const config = resolveCloudPublicConfig();
  const identity = resolveCloudIdentityConfig(config);
  const isConfigured = identity.provider === "sovereign" && Boolean(config.relay.url);

  useEffect(() => {
    if (!isConfigured) deactivateCloudRelayAccount();
  }, [isConfigured]);

  if (!isConfigured || identity.provider !== "sovereign") {
    return (
      <MobileCloudAuthContext value={disabledCloudAuthSession}>
        {props.children}
      </MobileCloudAuthContext>
    );
  }

  return (
    <SovereignCloudAuthSessionProvider config={identity}>
      <RelayCloudAuthBridge>{props.children}</RelayCloudAuthBridge>
    </SovereignCloudAuthSessionProvider>
  );
}
