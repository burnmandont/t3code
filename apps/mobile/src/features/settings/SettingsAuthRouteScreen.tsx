import { StackActions, useNavigation } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useCallback, useLayoutEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";

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
  const { isLoaded, isSignedIn, signIn, signOut } = useMobileCloudAuth();
  const [busy, setBusy] = useState(false);
  const perform = useCallback(
    async (operation: "sign-in" | "sign-out") => {
      if (busy) return;
      setBusy(true);
      try {
        if (operation === "sign-in") await signIn();
        else await signOut();
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

  return (
    <>
      <NativeStackScreenOptions options={{ title: isSignedIn ? "Account" : "Sign in" }} />
      <View collapsable={false} className="flex-1 justify-center bg-sheet px-6">
        <View className="gap-5 rounded-[24px] bg-card p-6">
          <View className="gap-2">
            <Text className="text-2xl font-t3-bold text-foreground">
              {isSignedIn ? "Sovereign T3 account" : "Sign in to T3 Code"}
            </Text>
            <Text className="text-base leading-normal text-foreground-muted">
              {isSignedIn
                ? "This device is authenticated by your self-hosted account service."
                : "Continue in the secure system browser to authenticate with your self-hosted account service."}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={!isLoaded || busy}
            onPress={() => void perform(isSignedIn ? "sign-out" : "sign-in")}
            className="min-h-12 items-center justify-center rounded-full bg-foreground px-5 active:opacity-80 disabled:opacity-50"
          >
            {busy ? (
              <ActivityIndicator color="black" />
            ) : (
              <Text className="text-base font-t3-bold text-background">
                {isSignedIn ? "Sign out" : "Continue to sign in"}
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </>
  );
}
