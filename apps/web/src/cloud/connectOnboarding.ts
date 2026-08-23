import * as Schema from "effect/Schema";

/**
 * Accounts that opted out of the post-sign-in T3 Connect onboarding wizard
 * ("Don't show this again"). The wizard otherwise shows on every sign-in,
 * since sign-out clears the connected environments.
 */
export const CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY = "t3code:connect-onboarding-opt-out:v1";

export const ConnectOnboardingOptOutSchema = Schema.Struct({
  optOutAccounts: Schema.Array(Schema.String),
});

export type ConnectOnboardingOptOutState = typeof ConnectOnboardingOptOutSchema.Type;

export const EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE: ConnectOnboardingOptOutState = {
  optOutAccounts: [],
};

export interface ConnectOnboardingPublishSelection {
  readonly exposeEnvironment: boolean;
  readonly publishAgentActivity: boolean;
}

export const DEFAULT_CONNECT_ONBOARDING_PUBLISH_SELECTION = {
  exposeEnvironment: false,
  publishAgentActivity: false,
} as const satisfies ConnectOnboardingPublishSelection;

export function shouldPublishConnectOnboardingSelection(
  selection: ConnectOnboardingPublishSelection,
): boolean {
  return selection.exposeEnvironment || selection.publishAgentActivity;
}

export function connectOnboardingPublishActionLabel(
  selection: ConnectOnboardingPublishSelection,
): string {
  return shouldPublishConnectOnboardingSelection(selection)
    ? "Publish and continue"
    : "Continue without publishing";
}
