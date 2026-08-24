declare const __T3CODE_BUILD_SOVEREIGN__: boolean;

export const isSovereignCliBuild =
  typeof __T3CODE_BUILD_SOVEREIGN__ !== "undefined" && __T3CODE_BUILD_SOVEREIGN__;

export const canonicalCliName = isSovereignCliBuild ? "sovereign" : "t3";

export const canonicalCliCommand = (subcommand: string): string =>
  `${canonicalCliName} ${subcommand}`;

export const canonicalBootstrapCliCommand = (subcommand: string): string =>
  isSovereignCliBuild ? canonicalCliCommand(subcommand) : `npx t3 ${subcommand}`;

export const canonicalServiceUpdateCommand = (): string =>
  isSovereignCliBuild ? canonicalCliCommand("service update") : "npx t3@latest service update";
