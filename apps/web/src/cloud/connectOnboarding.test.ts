import { describe, expect, it } from "vite-plus/test";

import {
  connectOnboardingPublishActionLabel,
  DEFAULT_CONNECT_ONBOARDING_PUBLISH_SELECTION,
  shouldPublishConnectOnboardingSelection,
} from "./connectOnboarding";

describe("connect onboarding publication consent", () => {
  it("defaults to a client-only desktop that publishes nothing", () => {
    expect(DEFAULT_CONNECT_ONBOARDING_PUBLISH_SELECTION).toEqual({
      exposeEnvironment: false,
      publishAgentActivity: false,
    });
    expect(
      shouldPublishConnectOnboardingSelection(DEFAULT_CONNECT_ONBOARDING_PUBLISH_SELECTION),
    ).toBe(false);
    expect(connectOnboardingPublishActionLabel(DEFAULT_CONNECT_ONBOARDING_PUBLISH_SELECTION)).toBe(
      "Continue without publishing",
    );
  });

  it.each([
    { exposeEnvironment: true, publishAgentActivity: false },
    { exposeEnvironment: false, publishAgentActivity: true },
    { exposeEnvironment: true, publishAgentActivity: true },
  ])("requires explicit publication consent for $selection", (selection) => {
    expect(shouldPublishConnectOnboardingSelection(selection)).toBe(true);
    expect(connectOnboardingPublishActionLabel(selection)).toBe("Publish and continue");
  });
});
