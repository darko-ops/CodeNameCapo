# TheBouncr — Brand Assets & Claude Code Implementation Brief

Drop this whole folder into your repo (suggested: `apps/web/public/brand/` or `packages/brand/`),
then hand the prompt at the bottom to Claude Code.

## Contents

```
icons/
  bouncr-icon.svg        # full-color app icon (violet squircle + noir crossed-arms mark)
  favicon.svg            # favicon variant — arms thickened ~9% for legibility at 16–32px
  bouncr-mark-mono.svg   # single-color mark, uses currentColor (stamps, watermarks,
                         #   the "negotiated via Bouncr" close-screen mark)
  bouncr-wordmark.svg    # horizontal lockup: icon + "the" (steel) + "bouncr" (violet, bold)
css/
  bouncr-tokens.css      # brand colors as CSS custom properties
```

## Color system (the rules matter, not just the hex)

| Token | Hex | Use |
|---|---|---|
| `--bouncr-noir` | `#0B0B12` | base background, the knockout in the mark |
| `--bouncr-violet` | `#7C3AED` | primary brand, persona, the squircle |
| `--bouncr-violet-600` | `#8B5CF6` | hover states, lighter UI accents |
| `--bouncr-violet-900` | `#3B0F73` | violet text on light backgrounds |
| `--bouncr-mint` | `#34D399` | **RESERVED — only the deal-closed moment.** Do not use in nav, buttons, or the logo. Its scarcity is the point. |
| `--bouncr-violet-white` | `#F5F3FF` | text on noir |
| `--bouncr-steel` | `#A1A1AA` | muted/secondary text, the "the" in the wordmark |
| `--bouncr-wine` | `#9F1239` | rare — final-offer urgency only. **Never** next to a price or checkout CTA (reads as error). |

## Notes for whoever implements

- The mono mark uses `currentColor`, so set the color via CSS `color:` on a parent or inline `style="color:#fff"`. Default it to `--bouncr-violet-white` on dark, `--bouncr-violet` on light.
- The wordmark uses a system font stack so it renders without shipping a font file. If you adopt a brand typeface later, convert the `<text>` to outlined paths so the lockup is pixel-stable.
- App icon corners use `rx="24"` on a 100-unit canvas (~iOS squircle feel). For a true iOS `AppIcon.appiconset`, export PNGs from `bouncr-icon.svg` at the required sizes — the SVG is the source of truth.
- Keep the squircle as the icon fill (Spotify pattern): the violet tile IS the icon, the mark knocks out in noir. Don't put the mark on a transparent/noir background for the app icon — it loses the tile.

## Prompt to give Claude Code

> I've added brand assets under `brand/` (icons + `css/bouncr-tokens.css`). Please:
> 1. Import `bouncr-tokens.css` into the global stylesheet so the `--bouncr-*` variables are available app-wide.
> 2. Set `favicon.svg` as the site favicon (add the `<link rel="icon" type="image/svg+xml" href="...">`), with a PNG fallback generated at 32×32 and 180×180 (apple-touch-icon).
> 3. Replace the current logo in the top nav with `bouncr-wordmark.svg`.
> 4. Use `bouncr-mark-mono.svg` on the negotiation "deal closed" screen, tinted with `--bouncr-mint`, as the only place mint appears.
> 5. Generate the iOS `AppIcon.appiconset` PNGs from `bouncr-icon.svg` if there's a native target.
> Respect the color rules in `brand/README.md` — especially that mint is reserved for the deal-closed moment and wine never sits next to a price.
