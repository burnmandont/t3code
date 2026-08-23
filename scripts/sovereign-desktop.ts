#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - This CLI validates configuration and writes actionable status to the terminal.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { loadRepoEnv } from "./lib/public-config.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const REQUIRED_PUBLIC_VALUES = [
  "T3CODE_OAUTH_ISSUER",
  "T3CODE_OAUTH_CLIENT_ID",
  "T3CODE_OAUTH_RESOURCE",
  "T3CODE_RELAY_URL",
  "VITE_HOSTED_APP_URL",
] as const;

const REQUIRED_HTTPS_URLS = [
  "T3CODE_OAUTH_ISSUER",
  "T3CODE_OAUTH_RESOURCE",
  "T3CODE_RELAY_URL",
  "VITE_HOSTED_APP_URL",
] as const;

const FORBIDDEN_EXTERNAL_SERVICE_VALUES = [
  "T3CODE_CLERK_PUBLISHABLE_KEY",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "T3CODE_CLERK_JWT_TEMPLATE",
  "VITE_CLERK_JWT_TEMPLATE",
  "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_MOBILE_OTLP_TRACES_URL",
  "T3CODE_MOBILE_OTLP_TRACES_DATASET",
  "T3CODE_MOBILE_OTLP_TRACES_TOKEN",
  "EXPO_PUBLIC_OTLP_TRACES_URL",
  "EXPO_PUBLIC_OTLP_TRACES_DATASET",
  "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
  "VITE_RELAY_OTLP_TRACES_URL",
  "VITE_RELAY_OTLP_TRACES_DATASET",
  "VITE_RELAY_OTLP_TRACES_TOKEN",
] as const;

export function validateSovereignDesktopEnvironment(env: Environment): readonly string[] {
  const errors: string[] = [];
  const missingValues = REQUIRED_PUBLIC_VALUES.filter((name) => !env[name]?.trim());

  if (missingValues.length > 0) {
    errors.push(`Missing required public configuration: ${missingValues.join(", ")}.`);
  }

  for (const name of REQUIRED_HTTPS_URLS) {
    const value = env[name]?.trim();
    if (!value) continue;

    try {
      const url = new URL(value);
      if (url.protocol !== "https:") {
        errors.push(`${name} must use HTTPS; received ${value}.`);
      }
      if (url.username || url.password) {
        errors.push(`${name} must not contain credentials.`);
      }
    } catch {
      errors.push(`${name} must be a valid absolute URL; received ${value}.`);
    }
  }

  const externalValues = FORBIDDEN_EXTERNAL_SERVICE_VALUES.filter((name) => env[name]?.trim());
  if (externalValues.length > 0) {
    errors.push(
      `External identity and telemetry configuration must remain unset: ${externalValues.join(", ")}.`,
    );
  }

  if (env.VITE_REMOTE_FAVICONS?.trim() !== "0") {
    errors.push("VITE_REMOTE_FAVICONS must be 0 so clients do not request third-party favicons.");
  }

  return errors;
}

function printConfiguration(env: Environment, t3Home: string): void {
  console.log("Sovereign desktop configuration is valid.");
  console.log(`  issuer: ${env.T3CODE_OAUTH_ISSUER}`);
  console.log(`  relay: ${env.T3CODE_RELAY_URL}`);
  console.log(`  hosted app: ${env.VITE_HOSTED_APP_URL}`);
  console.log(`  T3 home: ${t3Home}`);
  console.log("  local publication: controlled in the app and disabled by default");
}

async function main(): Promise<number> {
  const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== "--check");
  if (unexpectedArguments.length > 0) {
    console.error(
      `Unknown argument(s): ${unexpectedArguments.join(", ")}. Only --check is supported.`,
    );
    return 2;
  }

  const env = loadRepoEnv({ repoRoot });
  const t3Home = NodePath.join(repoRoot, ".t3");
  const errors = validateSovereignDesktopEnvironment(env);

  if (errors.length > 0) {
    console.error("Sovereign desktop configuration is invalid:");
    for (const error of errors) console.error(`  - ${error}`);
    console.error(
      "Copy infra/sovereign/client.env.example to .env.local, adjust its public URLs, and try again.",
    );
    return 1;
  }

  printConfiguration(env, t3Home);
  if (process.argv.includes("--check")) return 0;

  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(repoRoot, "scripts/dev-runner.ts"), "dev:desktop", "--home-dir", t3Home],
    {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: "inherit",
    },
  );

  return await new Promise<number>((resolve) => {
    child.once("error", (error) => {
      console.error(`Could not start the sovereign desktop client: ${error.message}`);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        console.error(`Sovereign desktop client stopped by ${signal}.`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (import.meta.main) {
  process.exitCode = await main();
}
