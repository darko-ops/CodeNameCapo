/**
 * Widget assets (Spec §10) — served by the app. The HTML/JS are authored as
 * standalone files in src/widget/ (no template-literal escaping) and embedded
 * into assets.generated.ts at build time by scripts/bundle-assets.mjs, so they
 * are compiled-in strings with NO runtime filesystem access. This is what lets
 * the same code run on a serverless host (Vercel) where sibling files aren't on
 * disk next to the bundled function.
 *
 * After editing any src/widget/*.html or embed.js, run `npm run bundle:assets`.
 */
export { WIDGET_HTML, EMBED_JS, DEMO_HTML, DASHBOARD_HTML } from "./assets.generated.js";
