# Brand icons

The committed Sovereign PNG renditions in `prod/sovereign-logo/` are the sole app-icon source of
truth. The production logo remains unchanged; the exporter derives the environment variants
deterministically:

- development uses the Sovereign logo with a gold `DEV` badge;
- preview/nightly uses the Sovereign logo with a green-and-gold `PREVIEW` badge;
- production copies the source bytes without decoration.

`prod/sovereign-logo/macos-1024.png` is the dedicated macOS safe-area source. The other numbered PNGs
provide the exact native, web, and Windows rendition sizes. The exporter also generates mobile-local
copies under `apps/mobile/assets/branding/`, the monochrome Sovereign companion mark, web development
assets, and the marketing-site icons. Mobile iOS copies flatten the approved artwork onto an opaque
black canvas so Expo never replaces transparent corners with white; the committed production source
bytes remain unchanged.

Run `vp run icons:export` from the repository root after changing the source renditions or decoration
logic. Run `vp run icons:check` for the non-mutating consistency check. The production-only variants
remain available as `vp run icons:export:production` and `vp run icons:check:production`.

Do not edit generated PNG or ICO files directly. To change production branding, replace the
renditions in `prod/sovereign-logo/`, including the dedicated safe-area macOS source, and rerun the
exporter.
