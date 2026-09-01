import Constants from "expo-constants";
import { Image } from "expo-image";
import { View } from "react-native";

import { useUniwindTheme } from "../lib/useUniwindTheme";
import { AppText as Text } from "./AppText";

const appVariant = Constants.expoConfig?.extra?.appVariant;
// Keep runtime assets inside apps/mobile. Metro can watch monorepo-root files,
// but its development asset URL for an image above projectRoot uses an
// unstable relative-path query that expo-image resolves as /apps/mobile/dev.
// The app icon remains variant-specific through app.config.ts; this in-app
// mark deliberately uses the portable monochrome asset and theme colors.
const BRAND_MARK_SOURCE = require("../../assets/sovereign-mark.png");
const DEFAULT_STAGE_LABEL =
  appVariant === "development" ? "Dev" : appVariant === "preview" ? "Preview" : "Alpha";

export function BrandMark(props: { readonly compact?: boolean; readonly stageLabel?: string }) {
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;
  const stageLabel = props.stageLabel ?? DEFAULT_STAGE_LABEL;
  const theme = useUniwindTheme();
  const markBackgroundColor = theme["--color-foreground"];
  const markForegroundColor = theme["--color-background"];

  return (
    <View className="flex-row items-center gap-3">
      <View
        className="items-center justify-center overflow-hidden"
        style={{
          width: iconSize,
          height: iconSize,
          borderRadius: compact ? 10 : 14,
          backgroundColor: markBackgroundColor,
        }}
      >
        <Image
          source={BRAND_MARK_SOURCE}
          accessibilityIgnoresInvertColors
          contentFit="contain"
          style={{
            width: iconSize,
            height: iconSize,
            tintColor: markForegroundColor,
          }}
        />
      </View>
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-lg font-t3-bold tracking-[-0.4px] text-foreground">Sovereign</Text>
          <View className="rounded-full bg-subtle px-2 py-1">
            <Text className="text-3xs font-t3-bold tracking-[1.1px] uppercase text-foreground-muted">
              {stageLabel}
            </Text>
          </View>
        </View>
        {!compact ? (
          <Text className="text-xs font-medium text-foreground-muted">
            Mobile control surface for your live coding environments
          </Text>
        ) : null}
      </View>
    </View>
  );
}
