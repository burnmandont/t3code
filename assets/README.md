# Brand icons

Development and preview use Icon Composer projects as their sources of truth:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`

Production uses the committed PNG renditions in `prod/sovereign-logo/`. The directory contains the
original Sovereign logo at 1024px and the smaller sizes needed for native and web icon generation.
Keeping those source renditions in the repository ensures a future icon export cannot restore the
upstream T3 mark.

Run `vp run icons:export` from the repository root to regenerate the tracked iOS, Linux, Windows,
macOS production, and web assets. The development web exports are also copied to `apps/web/public`
for the local-development browser favicon and splash screen. Run `vp run icons:check` to verify that
the generated assets and public copies match their sources without changing files.

When only production branding changed, use `vp run icons:export:production`. This path reads the
committed raster source directly and does not require Icon Composer. Its non-mutating counterpart is
`vp run icons:check:production`.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

Icon Composer's command-line exporter does not expose the `macOS pre-Tahoe` preset. A plain
command-line `macOS` export is full bleed and is not suitable for the desktop app, so the export
script intentionally leaves the development and preview macOS PNGs unchanged and prints a reminder
after every run. The production macOS PNG is generated from `prod/sovereign-logo/macos-1024.png`, whose
opaque icon body uses the same classic safe area.

After changing an Icon Composer project, open it in Icon Composer and export the macOS PNG with exactly these settings:

- Platform: `macOS pre-Tahoe`
- Appearance: `Default`
- Size: `1024pt`
- Scale: `1×`

Save the two exports to:

- `dev/app-icon.icon` -> `dev/blueprint-macos-1024.png`
- `nightly/app-icon.icon` -> `nightly/nightly-macos-1024.png`

The result must be a 1024×1024 PNG with the classic macOS safe area: the opaque icon body is 824×824, inset 100 pixels on every side, with only the native Icon Composer shadow extending into the surrounding transparent canvas.

To have Codex perform the native exports, paste this prompt into a task opened at the repository root:

```text
Use [@Computer](plugin://computer-use@openai-bundled) and the Icon Composer app to export the development and preview macOS app icons in this repository.

For each project below, use Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, and Scale: 1×, then save the PNG to the exact destination:

- assets/dev/app-icon.icon -> assets/dev/blueprint-macos-1024.png
- assets/nightly/app-icon.icon -> assets/nightly/nightly-macos-1024.png

Do not resize, composite, or otherwise post-process the exported PNGs.

Verify every result is 1024×1024 and has the classic macOS safe area: an 824×824 opaque body inset 100px on every side, with only Icon Composer's native shadow extending beyond it.
```

Do not edit generated PNG or ICO files directly. To change production branding, replace the
renditions in `prod/sovereign-logo/`, including the dedicated safe-area macOS source, and rerun the
exporter.
