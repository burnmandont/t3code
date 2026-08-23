import { SOVEREIGN_APP_CALLBACK_PATH } from "@t3tools/shared/connectAuth";

const DESKTOP_CALLBACK_HOST = "app";

export function parseSovereignCallbackUrl(rawUrl: unknown, scheme: string): string | null {
  if (typeof rawUrl !== "string") return null;
  try {
    const url = new URL(rawUrl);
    return url.protocol === `${scheme}:` &&
      url.host === DESKTOP_CALLBACK_HOST &&
      url.pathname === SOVEREIGN_APP_CALLBACK_PATH
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function findSovereignCallbackUrl(
  commandLine: ReadonlyArray<unknown>,
  scheme: string,
): string | null {
  for (const argument of commandLine) {
    const callback = parseSovereignCallbackUrl(argument, scheme);
    if (callback !== null) return callback;
  }
  return null;
}

export function resolveProtocolRegistration(input: {
  readonly isDefaultApp: boolean;
  readonly executablePath: string;
  readonly commandLine: ReadonlyArray<string>;
}): { readonly path?: string; readonly args?: ReadonlyArray<string> } {
  const entryPath = input.commandLine[1];
  return input.isDefaultApp && entryPath ? { path: input.executablePath, args: [entryPath] } : {};
}
