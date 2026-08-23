#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_PUBLIC_ICON_OVERRIDES,
  MARKETING_PUBLIC_ICON_OVERRIDES,
} from "./lib/brand-assets.ts";
import { encodePngIco, readPngDimensions, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";
import {
  decorateSovereignIcon,
  flattenSovereignIcon,
  renderSovereignMarkPng,
  type SovereignIconBadge,
} from "./lib/sovereign-icon.ts";

interface VariantOutputs {
  readonly ios: string;
  readonly macos: string;
  readonly universal: string;
  readonly appleTouch: string;
  readonly favicon16: string;
  readonly favicon32: string;
  readonly faviconIco: string;
  readonly windowsIco: string;
  readonly mobileIos: string;
  readonly mobileUniversal: string;
}

interface IconVariant {
  readonly label: string;
  readonly source: string;
  readonly macosSource: string;
  readonly badge?: SovereignIconBadge;
  readonly outputs: VariantOutputs;
}

export class IconExportFileSystemError extends Schema.TaggedErrorClass<IconExportFileSystemError>()(
  "IconExportFileSystemError",
  {
    operation: Schema.Literals([
      "resolve-repository-root",
      "check-path",
      "read-file",
      "make-directory",
      "make-temp-file",
      "write-file",
      "rename-file",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Icon export file-system operation '${this.operation}' failed for ${this.path}.`;
  }
}

export class IconExportSourceMissingError extends Schema.TaggedErrorClass<IconExportSourceMissingError>()(
  "IconExportSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing icon source: ${this.sourcePath}`;
  }
}

export class IconExportRenditionError extends Schema.TaggedErrorClass<IconExportRenditionError>()(
  "IconExportRenditionError",
  {
    sourcePath: Schema.String,
    outputPath: Schema.String,
    expectedSize: Schema.Int,
    actualWidth: Schema.optional(Schema.Int),
    actualHeight: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const actual =
      this.actualWidth === undefined || this.actualHeight === undefined
        ? "an invalid PNG"
        : `${this.actualWidth}x${this.actualHeight}`;
    return `Icon source produced ${actual}; expected ${this.expectedSize}x${this.expectedSize} for ${this.sourcePath}.`;
  }
}

export class IconExportEncodingError extends Schema.TaggedErrorClass<IconExportEncodingError>()(
  "IconExportEncodingError",
  {
    variant: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode ICO renditions for the ${this.variant} icon.`;
  }
}

export class IconExportAssetsStaleError extends Schema.TaggedErrorClass<IconExportAssetsStaleError>()(
  "IconExportAssetsStaleError",
  {
    paths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Generated icon assets are stale:\n${this.paths.map((path) => `- ${path}`).join("\n")}`;
  }
}

const ICON_VARIANTS: ReadonlyArray<IconVariant> = [
  {
    label: "development",
    source: BRAND_ASSET_PATHS.productionRasterIconDirectory,
    macosSource: BRAND_ASSET_PATHS.productionMacRasterIconPng,
    badge: "DEV",
    outputs: {
      ios: BRAND_ASSET_PATHS.developmentIosIconPng,
      macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
      universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
      appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
      mobileIos: BRAND_ASSET_PATHS.developmentMobileIosIconPng,
      mobileUniversal: BRAND_ASSET_PATHS.developmentMobileUniversalIconPng,
    },
  },
  {
    label: "preview",
    source: BRAND_ASSET_PATHS.productionRasterIconDirectory,
    macosSource: BRAND_ASSET_PATHS.productionMacRasterIconPng,
    badge: "PREVIEW",
    outputs: {
      ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
      macos: BRAND_ASSET_PATHS.nightlyMacIconPng,
      universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
      mobileIos: BRAND_ASSET_PATHS.nightlyMobileIosIconPng,
      mobileUniversal: BRAND_ASSET_PATHS.nightlyMobileUniversalIconPng,
    },
  },
  {
    label: "production",
    source: BRAND_ASSET_PATHS.productionRasterIconDirectory,
    macosSource: BRAND_ASSET_PATHS.productionMacRasterIconPng,
    outputs: {
      ios: BRAND_ASSET_PATHS.productionIosIconPng,
      macos: BRAND_ASSET_PATHS.productionMacIconPng,
      universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
      mobileIos: BRAND_ASSET_PATHS.productionMobileIosIconPng,
      mobileUniversal: BRAND_ASSET_PATHS.productionMobileUniversalIconPng,
    },
  },
];

const RepositoryRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
  Effect.mapError(
    (cause) =>
      new IconExportFileSystemError({
        operation: "resolve-repository-root",
        path: new URL("..", import.meta.url).pathname,
        cause,
      }),
  ),
);

const readRasterIcon = Effect.fn("iconExport.readRasterIcon")(function* (
  sourceDirectory: string,
  sourcePath: string,
  size: number,
  fileName = `${size}.png`,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const renditionPath = path.join(sourceDirectory, fileName);
  const contents = yield* fs.readFile(renditionPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "read-file",
          path: renditionPath,
          cause,
        }),
    ),
  );
  const buffer = Buffer.from(contents);
  const dimensions = yield* Effect.try({
    try: () => readPngDimensions(buffer),
    catch: (cause) =>
      new IconExportRenditionError({
        sourcePath,
        outputPath: renditionPath,
        expectedSize: size,
        cause,
      }),
  });
  if (dimensions.width !== size || dimensions.height !== size) {
    return yield* new IconExportRenditionError({
      sourcePath,
      outputPath: renditionPath,
      expectedSize: size,
      actualWidth: dimensions.width,
      actualHeight: dimensions.height,
    });
  }
  return buffer;
});

const renderVariant = Effect.fn("iconExport.renderVariant")(function* (
  repositoryRoot: string,
  variant: IconVariant,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(repositoryRoot, variant.source);
  const sourceExists = yield* fs.exists(sourcePath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "check-path",
          path: sourcePath,
          cause,
        }),
    ),
  );
  if (!sourceExists) {
    return yield* new IconExportSourceMissingError({ sourcePath: variant.source });
  }

  const renditionCache = new Map<string, Buffer>();
  const render = Effect.fn("iconExport.renderVariant.rendition")(function* (size: number) {
    const cacheKey = String(size);
    const cached = renditionCache.get(cacheKey);
    if (cached) return cached;

    const contents = decorateSovereignIcon(
      yield* readRasterIcon(sourcePath, variant.source, size),
      variant.badge,
    );
    renditionCache.set(cacheKey, contents);
    return contents;
  });

  const ios = yield* render(1024);
  const icoRenditions = yield* Effect.forEach(
    WINDOWS_ICON_SIZES,
    (size) => render(size).pipe(Effect.map((contents) => ({ size, contents }))),
    { concurrency: 1 },
  );
  const ico = yield* Effect.try({
    try: () => encodePngIco(icoRenditions),
    catch: (cause) => new IconExportEncodingError({ variant: variant.label, cause }),
  });

  const generated = new Map<string, Buffer>([
    [variant.outputs.ios, ios],
    [variant.outputs.universal, ios],
    [variant.outputs.mobileIos, flattenSovereignIcon(ios)],
    [variant.outputs.mobileUniversal, ios],
    [variant.outputs.appleTouch, yield* render(180)],
    [variant.outputs.favicon16, yield* render(16)],
    [variant.outputs.favicon32, yield* render(32)],
    [variant.outputs.faviconIco, ico],
    [variant.outputs.windowsIco, ico],
  ]);
  generated.set(
    variant.outputs.macos,
    decorateSovereignIcon(
      yield* readRasterIcon(sourcePath, variant.source, 1024, path.basename(variant.macosSource)),
      variant.badge,
    ),
  );
  return generated;
});

const writeAtomically = Effect.fn("iconExport.writeAtomically")(function* (
  repositoryRoot: string,
  relativePath: string,
  contents: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  const targetDirectory = path.dirname(targetPath);
  yield* fs.makeDirectory(targetDirectory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "make-directory",
          path: targetDirectory,
          cause,
        }),
    ),
  );
  const temporaryPath = yield* fs
    .makeTempFileScoped({
      directory: targetDirectory,
      prefix: ".t3-icon-export-",
      suffix: ".tmp",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new IconExportFileSystemError({
            operation: "make-temp-file",
            path: targetDirectory,
            cause,
          }),
      ),
    );
  yield* fs.writeFile(temporaryPath, contents).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "write-file",
          path: temporaryPath,
          cause,
        }),
    ),
  );
  yield* fs.rename(temporaryPath, targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "rename-file",
          path: targetPath,
          cause,
        }),
    ),
  );
});

const isCurrent = Effect.fn("iconExport.isCurrent")(function* (
  repositoryRoot: string,
  relativePath: string,
  expected: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  const exists = yield* fs.exists(targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "check-path",
          path: targetPath,
          cause,
        }),
    ),
  );
  if (!exists) return false;

  const actual = yield* fs.readFile(targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "read-file",
          path: targetPath,
          cause,
        }),
    ),
  );
  return Buffer.from(actual).equals(expected);
});

export const exportBrandIcons = Effect.fn("exportBrandIcons")(function* (
  checkOnly: boolean,
  productionOnly: boolean,
) {
  const repositoryRoot = yield* RepositoryRoot;
  const variants = productionOnly
    ? ICON_VARIANTS.filter((variant) => variant.label === "production")
    : ICON_VARIANTS;
  yield* Console.log("Exporting Sovereign icons from committed raster sources.");

  const generated = new Map<string, Buffer>();
  for (const variant of variants) {
    yield* Console.log(`Reading ${variant.label} from ${variant.source}...`);
    const variantAssets = yield* renderVariant(repositoryRoot, variant);
    for (const [relativePath, contents] of variantAssets) {
      generated.set(relativePath, contents);
    }
  }

  if (!productionOnly) {
    for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
      const sourceContents = generated.get(override.sourceRelativePath);
      if (sourceContents === undefined) {
        return yield* Effect.die(
          new Error(`Generated development web icon is missing: ${override.sourceRelativePath}`),
        );
      }
      generated.set(override.targetRelativePath, sourceContents);
    }
  }

  for (const override of MARKETING_PUBLIC_ICON_OVERRIDES) {
    const sourceContents = generated.get(override.sourceRelativePath);
    if (sourceContents === undefined) {
      return yield* Effect.die(
        new Error(`Generated production web icon is missing: ${override.sourceRelativePath}`),
      );
    }
    generated.set(override.targetRelativePath, sourceContents);
  }
  const productionIcon = generated.get(BRAND_ASSET_PATHS.productionIosIconPng);
  if (productionIcon === undefined) {
    return yield* Effect.die(new Error("Generated production app icon is missing."));
  }
  generated.set(BRAND_ASSET_PATHS.marketingIconPng, productionIcon);
  generated.set(
    BRAND_ASSET_PATHS.mobileMonochromeMarkPng,
    renderSovereignMarkPng(432, [0, 0, 0, 255]),
  );
  generated.set(
    BRAND_ASSET_PATHS.mobileNotificationMarkPng,
    renderSovereignMarkPng(96, [255, 255, 255, 255]),
  );

  if (checkOnly) {
    const stale = yield* Effect.filter(
      [...generated.entries()],
      ([relativePath, contents]) =>
        isCurrent(repositoryRoot, relativePath, contents).pipe(Effect.map((current) => !current)),
      { concurrency: "unbounded" },
    );
    if (stale.length > 0) {
      return yield* new IconExportAssetsStaleError({
        paths: stale.map(([relativePath]) => relativePath),
      });
    }
    yield* Console.log(`All ${generated.size} generated icon assets are current.`);
    return;
  }

  yield* Effect.forEach(
    generated,
    ([relativePath, contents]) => writeAtomically(repositoryRoot, relativePath, contents),
    { concurrency: 1, discard: true },
  );
  yield* Console.log(`Updated ${generated.size} generated icon assets.`);
});

export const exportBrandIconsCommand = Command.make(
  "export-brand-icons",
  {
    check: Flag.boolean("check").pipe(
      Flag.withDescription("Verify generated icon assets without modifying files."),
      Flag.withDefault(false),
    ),
    productionOnly: Flag.boolean("production-only").pipe(
      Flag.withDescription("Export only production raster assets."),
      Flag.withDefault(false),
    ),
  },
  ({ check, productionOnly }) => exportBrandIcons(check, productionOnly).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Export Sovereign development, preview, and production assets from committed raster sources.",
  ),
);

if (import.meta.main) {
  Command.run(exportBrandIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
