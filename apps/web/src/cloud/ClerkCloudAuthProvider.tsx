import { useAuth, useClerk, useUser } from "@clerk/react";
import { useCallback, useMemo, type ReactNode } from "react";

import { isElectron } from "../env";
import { resolveClerkSignInProps } from "../components/clerk/authRedirect";
import { CloudAuthContext, type CloudAuthSession } from "./auth";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

export function ClerkCloudAuthProvider({ children }: { readonly children: ReactNode }) {
  const {
    getToken: getClerkToken,
    isLoaded,
    isSignedIn,
    userId,
  } = useAuth({ treatPendingAsSignedOut: false });
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
