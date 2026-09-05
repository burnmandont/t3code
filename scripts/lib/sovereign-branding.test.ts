// @effect-diagnostics nodeBuiltinImport:off - Guard tests compare committed binary assets and repository paths directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { BRAND_ASSET_PATHS } from "./brand-assets.ts";
import { flattenSovereignIcon } from "./sovereign-icon.ts";

const repositoryRoot = NodePath.resolve(NodeURL.fileURLToPath(new URL("../..", import.meta.url)));

function read(relativePath: string): Buffer {
  return NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath));
}

function sha256(contents: Buffer): string {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

function assetFiles(relativeDirectory: string): ReadonlyArray<string> {
  const root = NodePath.join(repositoryRoot, relativeDirectory);
  const files: Array<string> = [];
  const visit = (directory: string): void => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(NodePath.relative(repositoryRoot, entryPath));
      }
    }
  };
  visit(root);
  return files;
}

describe("Sovereign branding assets", () => {
  it("keeps the approved production artwork byte-for-byte unchanged", () => {
    expect(sha256(read(BRAND_ASSET_PATHS.productionIosIconPng))).toBe(
      "bc7b4ac5e1806582f5316831b6700e69be2bda9043662a1d3c54cd288535edfc",
    );
    expect(sha256(read(BRAND_ASSET_PATHS.productionMacIconPng))).toBe(
      "5081f0179b6b242e4ae493e81fdfd08b9cab794452548149b44a6250e028179b",
    );
  });

  it("ships distinct Sovereign development and preview variants", () => {
    const production = read(BRAND_ASSET_PATHS.productionIosIconPng);
    const development = read(BRAND_ASSET_PATHS.developmentIosIconPng);
    const preview = read(BRAND_ASSET_PATHS.nightlyIosIconPng);
    expect(development.equals(production)).toBe(false);
    expect(preview.equals(production)).toBe(false);
    expect(preview.equals(development)).toBe(false);
  });

  it("mirrors generated branding into mobile, web, and marketing surfaces", () => {
    expect(
      read(BRAND_ASSET_PATHS.productionMobileIosIconPng).equals(
        flattenSovereignIcon(read(BRAND_ASSET_PATHS.productionIosIconPng)),
      ),
    ).toBe(true);
    expect(
      read("apps/web/public/apple-touch-icon.png").equals(
        read(BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng),
      ),
    ).toBe(true);
    expect(
      read("apps/marketing/public/apple-touch-icon.png").equals(
        read(BRAND_ASSET_PATHS.productionWebAppleTouchIconPng),
      ),
    ).toBe(true);
  });

  it("does not retain legacy T3 artwork or development asset names", () => {
    const files = [
      ...assetFiles("assets"),
      ...assetFiles("apps/mobile/assets"),
      ...assetFiles("apps/web/public"),
      ...assetFiles("apps/marketing/public"),
    ];
    expect(
      files.filter((path) =>
        /(?:blueprint-|nightly-(?:ios|macos|universal|web|windows)|T3Mark|android-(?:icon-mark|notification-icon)|assets\/prod\/logo\.svg|(?:apple-touch-icon|favicon-(?:16x16|32x32)|icon)\.webp$)/u.test(
          path,
        ),
      ),
    ).toEqual([]);
  });

  it("keeps Expo manifest icons inside the mobile project root", () => {
    const config = read("apps/mobile/app.config.ts").toString("utf8");
    expect(config).not.toContain("../../assets/");
    expect(config).toContain("fromMobileRoot");
  });

  it("keeps sovereign mobile artifacts out of the upstream app identity", () => {
    const config = read("apps/mobile/app.config.ts").toString("utf8");
    const runbook = read("docs/operations/sovereign-clients.md").toString("utf8");
    expect(config).toContain('slug: isSovereignBuild ? "sovereign" : "t3-code"');
    expect(config).toContain("package: androidPackage");
    expect(runbook).toContain("ios/SovereignDev.xcworkspace");
    expect(runbook).not.toContain("ios/T3CodeDev.xcworkspace");
  });
});
