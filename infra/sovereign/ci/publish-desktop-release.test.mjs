import assert from "node:assert/strict";
import test from "node:test";

import {
  readDesktopManifestVersion,
  selectDesktopReleaseAssets,
} from "./publish-desktop-release.mjs";

test("selects a complete desktop updater release", () => {
  assert.deepEqual(
    selectDesktopReleaseAssets([
      "T3-Code-0.0.1-arm64.dmg",
      "T3-Code-0.0.1-arm64.dmg.blockmap",
      "T3-Code-0.0.1-arm64.zip",
      "T3-Code-0.0.1-arm64.zip.blockmap",
      "latest-mac.yml",
      "ignored.txt",
    ]),
    [
      "T3-Code-0.0.1-arm64.dmg",
      "T3-Code-0.0.1-arm64.dmg.blockmap",
      "T3-Code-0.0.1-arm64.zip",
      "T3-Code-0.0.1-arm64.zip.blockmap",
      "latest-mac.yml",
    ],
  );
});

test("rejects incomplete updater releases", () => {
  assert.throws(() => selectDesktopReleaseAssets(["latest-mac.yml", "app.zip"]), /DMG/u);
  assert.throws(() => selectDesktopReleaseAssets(["latest-mac.yml", "app.dmg"]), /ZIP/u);
  assert.throws(() => selectDesktopReleaseAssets(["app.dmg", "app.zip"]), /latest-mac/u);
});

test("reads quoted and unquoted updater manifest versions", () => {
  assert.equal(readDesktopManifestVersion("version: 0.0.3300102\nfiles:\n"), "0.0.3300102");
  assert.equal(readDesktopManifestVersion("version: '0.0.3300102'\nfiles:\n"), "0.0.3300102");
  assert.equal(readDesktopManifestVersion('version: "0.0.3300102"\nfiles:\n'), "0.0.3300102");
  assert.throws(() => readDesktopManifestVersion("files:\n"), /no desktop version/u);
});
