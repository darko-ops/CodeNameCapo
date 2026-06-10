/**
 * Widget assets (Spec §10). The chat UI and the script-tag loader are authored as
 * standalone files (no build step) and read from disk at serve time — this keeps
 * the browser code free of TS template-literal escaping and lets you edit the
 * widget without recompiling.
 *
 * Note: these are read relative to this module. `npm run serve` (tsx) loads them
 * from src/widget/. A `tsc` build would need these files copied alongside the
 * emitted JS (they are not .ts, so tsc won't move them) — serve via tsx, or add a
 * copy step to the build.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const WIDGET_HTML: string = readFileSync(join(here, "widget.html"), "utf8");
export const EMBED_JS: string = readFileSync(join(here, "embed.js"), "utf8");
/** Public playground / dogfood landing (Spec §15) — embeds the widget via the loader. */
export const DEMO_HTML: string = readFileSync(join(here, "demo.html"), "utf8");
/** Merchant WTP dashboard (Spec §11) — funnel, offer histogram, transcript viewer. */
export const DASHBOARD_HTML: string = readFileSync(join(here, "dashboard.html"), "utf8");
