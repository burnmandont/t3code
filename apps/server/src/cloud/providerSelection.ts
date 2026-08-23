type Environment = Readonly<Record<string, string | undefined>>;

export function resolveSovereignProviderSelection(
  buildSelection: boolean | undefined,
  env: Environment = process.env,
): boolean {
  if (buildSelection !== undefined) return buildSelection;

  return Boolean(
    env.T3CODE_BUILD_NEUTRAL_PUBLIC_RUNTIME === "1" ||
    env.T3CODE_OAUTH_ISSUER?.trim() ||
    env.T3CODE_OAUTH_CLIENT_ID?.trim() ||
    env.T3CODE_OAUTH_RESOURCE?.trim(),
  );
}
