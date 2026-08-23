import { registerRootComponent } from "expo";
import * as Notifications from "expo-notifications";
import "react-native-gesture-handler";
import { LogBox } from "react-native";
import { featureFlags } from "react-native-screens";

import App from "./src/App";

// iOS suppresses an incoming alert while the app is foregrounded unless the
// notification-center delegate explicitly requests presentation. T3's agent
// notifications remain useful while the app is open (for example, when work
// finishes in another environment), so preserve the same banner/list/sound
// behavior in every app state.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Required for react-native-screens' iOS FormSheet sizing fix when a nested
// native stack is rendered inside a non-fitToContents formSheet.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

registerRootComponent(App);
