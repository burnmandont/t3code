import { StackActions, useNavigation } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useCallback, useLayoutEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { AppText as Text } from "../../components/AppText";
import { useMobileCloudAuth } from "../cloud/CloudAuthProvider";
import { hasCloudPublicConfig } from "../cloud/publicConfig";

export function SettingsAuthRouteScreen() {
  const navigation = useNavigation();

  useLayoutEffect(() => {
    if (!hasCloudPublicConfig()) {
      navigation.dispatch(StackActions.replace("SettingsContent"));
    }
  }, [navigation]);

  return hasCloudPublicConfig() ? <ConfiguredSettingsAuthRouteScreen /> : null;
}

function ConfiguredSettingsAuthRouteScreen() {
  return <SovereignSettingsAuthRouteScreen />;
}

function SovereignSettingsAuthRouteScreen() {
  const {
    accountEmail,
    accountManagementUrl,
    accountName,
    isLoaded,
    isSignedIn,
    signIn,
    signOut,
    userId,
  } = useMobileCloudAuth();
  const [busy, setBusy] = useState(false);
  const perform = useCallback(
    async (operation: "sign-in" | "sign-out") => {
      if (busy) return;
      setBusy(true);
      try {
        if (operation === "sign-in") await signIn();
        else {
          const result = await signOut();
          if (!result.revoked) {
            Alert.alert(
              "Signed out locally",
              "The account service could not confirm server-side token revocation. This device's local session was removed.",
            );
          }
        }
      } catch (cause) {
        Alert.alert(
          operation === "sign-in" ? "Sign in failed" : "Sign out failed",
          cause instanceof Error ? cause.message : "The account operation could not be completed.",
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, signIn, signOut],
  );

  const confirmSignOut = useCallback(() => {
    Alert.alert(
      "Sign out of Sovereign Relay?",
      "This revokes this device's session. Remote environments keep running and remain linked to the account.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => void perform("sign-out") },
      ],
    );
  }, [perform]);

  const manageAuthentication = useCallback(() => {
    if (accountManagementUrl) void WebBrowser.openBrowserAsync(accountManagementUrl);
  }, [accountManagementUrl]);

  return (
    <>
      <NativeStackScreenOptions options={{ title: isSignedIn ? "Account" : "Sign in" }} />
      <View collapsable={false} className="flex-1 justify-center bg-sheet px-6">
        <View className="gap-5 rounded-[24px] bg-card p-6">
          <View className="gap-2">
            <Text className="text-2xl font-t3-bold text-foreground">
              {isSignedIn
                ? (accountName ?? accountEmail ?? "Sovereign Sovereign account")
                : "Sign in to Sovereign"}
            </Text>
            <Text className="text-base leading-normal text-foreground-muted">
              {isSignedIn
                ? "This device is authenticated by your self-hosted account service."
                : "Continue in the secure system browser to authenticate with your self-hosted account service."}
            </Text>
            {isSignedIn && accountEmail ? (
              <Text className="text-base text-foreground">{accountEmail}</Text>
            ) : null}
            {isSignedIn && userId ? (
              <Text selectable className="text-xs text-foreground-muted">
                Account ID: {userId}
              </Text>
            ) : null}
          </View>
          {isSignedIn ? (
            <View className="gap-3">
              {accountManagementUrl ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={manageAuthentication}
                  className="min-h-12 items-center justify-center rounded-full border border-border px-5 active:opacity-70 disabled:opacity-50"
                >
                  <Text className="text-base font-t3-bold text-foreground">
                    Manage authentication
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void perform("sign-in")}
                className="min-h-12 items-center justify-center rounded-full border border-border px-5 active:opacity-70 disabled:opacity-50"
              >
                <Text className="text-base font-t3-bold text-foreground">Switch account</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={confirmSignOut}
                className="min-h-12 items-center justify-center rounded-full border border-danger-foreground/30 px-5 active:opacity-70 disabled:opacity-50"
              >
                {busy ? (
                  <ActivityIndicator />
                ) : (
                  <Text className="text-base font-t3-bold text-danger-foreground">Sign out</Text>
                )}
              </Pressable>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={!isLoaded || busy}
              onPress={() => void perform("sign-in")}
              className="min-h-12 items-center justify-center rounded-full bg-foreground px-5 active:opacity-80 disabled:opacity-50"
            >
              {busy ? (
                <ActivityIndicator color="black" />
              ) : (
                <Text className="text-base font-t3-bold text-background">Continue to sign in</Text>
              )}
            </Pressable>
          )}
        </View>
      </View>
    </>
  );
}
