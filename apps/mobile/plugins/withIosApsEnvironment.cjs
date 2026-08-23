"use strict";

const { withEntitlementsPlist } = require("expo/config-plugins");

module.exports = function withIosApsEnvironment(config, { environment }) {
  if (environment !== "development" && environment !== "production") {
    throw new Error("withIosApsEnvironment requires development or production.");
  }

  return withEntitlementsPlist(config, (modConfig) => {
    // expo-widgets currently writes `development` unconditionally when push
    // support is enabled. This mod is registered before expo-widgets so Expo's
    // reverse same-mod ordering runs it afterward and restores the variant's
    // actual signing environment.
    modConfig.modResults["aps-environment"] = environment;
    return modConfig;
  });
};
