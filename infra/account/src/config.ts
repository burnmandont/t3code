export interface AccountConfiguration {
  readonly baseUrl: string;
  readonly basePath: string;
  readonly databaseUrl: string;
  readonly secret: string;
  readonly host: string;
  readonly port: number;
  readonly relayAudience: string;
  readonly trustedOrigins: ReadonlyArray<string>;
  readonly signupAllowedEmails: ReadonlyArray<string>;
  readonly passwordLoginEnabled: boolean;
}

function parseBasePath(value: string | undefined): string {
  const basePath = (value?.trim() || "/api/auth").replace(/\/+$/u, "");
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/u.test(basePath)) {
    throw new Error("T3_ACCOUNT_BASE_PATH must be an absolute URL path without a trailing slash.");
  }
  return basePath;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "4200");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("T3_ACCOUNT_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function parseOrigins(baseUrl: string, value: string | undefined): ReadonlyArray<string> {
  const origins = new Set([new URL(baseUrl).origin]);
  for (const entry of value?.split(",") ?? []) {
    const trimmed = entry.trim();
    if (trimmed) origins.add(new URL(trimmed).origin);
  }
  return [...origins];
}

function parseSignupAllowedEmails(value: string | undefined): ReadonlyArray<string> {
  return [
    ...new Set(
      (value?.split(",") ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("T3_ACCOUNT_PASSWORD_LOGIN_ENABLED must be a boolean.");
}
export function loadAccountConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): AccountConfiguration {
  const baseUrl = requiredEnvironment(environment, "T3_ACCOUNT_BASE_URL");
  const secret = requiredEnvironment(environment, "T3_ACCOUNT_SECRET");
  if (secret.length < 32) {
    throw new Error("T3_ACCOUNT_SECRET must contain at least 32 characters.");
  }
  return {
    baseUrl,
    basePath: parseBasePath(environment.T3_ACCOUNT_BASE_PATH),
    databaseUrl: requiredEnvironment(environment, "T3_ACCOUNT_DATABASE_URL"),
    secret,
    host: environment.T3_ACCOUNT_HOST?.trim() || "127.0.0.1",
    port: parsePort(environment.T3_ACCOUNT_PORT),
    relayAudience: requiredEnvironment(environment, "T3_ACCOUNT_RELAY_AUDIENCE"),
    trustedOrigins: parseOrigins(baseUrl, environment.T3_ACCOUNT_TRUSTED_ORIGINS),
    signupAllowedEmails: parseSignupAllowedEmails(environment.T3_ACCOUNT_ALLOWED_EMAILS),
    passwordLoginEnabled: parseBoolean(environment.T3_ACCOUNT_PASSWORD_LOGIN_ENABLED, true),
  };
}
