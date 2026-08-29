/**
 * The authoritative ORDERED list of CSS custom properties emitted to
 * styles/tokens.css. This is the single source of truth for tokens.css —
 * `tools/generate-tokens-css.mts` reads this and writes the stylesheet.
 *
 * Hex values come from ./colors (palette/pill/badge) so colour is defined ONCE.
 * Spacing and type sizes come from ./spacing and ./typography for the same
 * reason — before 2026-08-24 those scales existed ONLY as TypeScript, so a
 * stylesheet had no way to reference a padding or a font size and every one of
 * them was written raw (63 distinct spacing values, 36 font sizes, measured).
 * Tier-2 roles are `var(--…)` reference strings (no hex to duplicate). Radius /
 * shadow / structural / type / the dark block are literals here (their only home).
 */
import { palette, pill, badge } from './colors'
import { space } from './spacing'
import { fontSize, fontWeight } from './typography'
import { gridVars, gridVarsDark } from './grid'

export interface CssVar {
  /** when set, a section-comment is emitted before this row */
  section?: string
  name: string
  value: string
}

/** `px12` -> `12`, `xsPlus` -> `xs-plus`, `2xl` -> `2xl`. */
const kebab = (k: string): string =>
  k.replace(/^px/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

const spacingVars: ReadonlyArray<CssVar> = Object.entries(space).map(([k, v], i) => ({
  ...(i === 0 ? { section: 'Dimension: spacing (scale lives in tokens/spacing.ts)' } : {}),
  name: `--nds-space-${kebab(k)}`,
  value: v,
}))

const typeVars: ReadonlyArray<CssVar> = [
  ...Object.entries(fontSize).map(([k, v], i) => ({
    ...(i === 0 ? { section: 'Dimension: type scale (tokens/typography.ts)' } : {}),
    name: `--nds-font-size-${kebab(k)}`,
    value: v,
  })),
  ...Object.entries(fontWeight).map(([k, v], i) => ({
    ...(i === 0 ? { section: 'Dimension: type weight' } : {}),
    name: `--nds-font-weight-${kebab(k)}`,
    value: String(v),
  })),
]

export const cssVars: ReadonlyArray<CssVar> = [
  // ── Tier 1: primitive ramps ──────────────────────────────────────
  { section: 'Tier 1: primitive ramps', name: '--nds-white', value: palette.white },

  { name: '--nds-blue-50', value: palette.blue[50] },
  { name: '--nds-blue-100', value: palette.blue[100] },
  { name: '--nds-blue-200', value: palette.blue[200] },
  { name: '--nds-blue-600', value: palette.blue[600] },
  { name: '--nds-blue-700', value: palette.blue[700] },
  { name: '--nds-blue-800', value: palette.blue[800] },
  { name: '--nds-blue-900', value: palette.blue[900] },

  { name: '--nds-grey-25', value: palette.grey[25] },
  { name: '--nds-grey-50', value: palette.grey[50] },
  { name: '--nds-grey-75', value: palette.grey[75] },
  { name: '--nds-grey-100', value: palette.grey[100] },
  { name: '--nds-grey-150', value: palette.grey[150] },
  { name: '--nds-grey-200', value: palette.grey[200] },
  { name: '--nds-grey-300', value: palette.grey[300] },
  { name: '--nds-grey-400', value: palette.grey[400] },
  { name: '--nds-grey-450', value: palette.grey[450] },
  { name: '--nds-grey-500', value: palette.grey[500] },
  { name: '--nds-grey-600', value: palette.grey[600] },
  { name: '--nds-grey-700', value: palette.grey[700] },
  { name: '--nds-grey-800', value: palette.grey[800] },
  { name: '--nds-grey-900', value: palette.grey[900] },

  { name: '--nds-rail-surface', value: palette.railBg },
  { name: '--nds-rail-line', value: palette.railBorder },

  // Rail-specific colours, dedicated so the app-wide rail can follow theme
  // without shifting the general --nds-text-* roles used elsewhere. Light
  // values; the dark block overrides them, and .h10-shell pins them light for
  // the deliberately-light standalone shells (ads cockpit + /products/next).
  // Hand-lived in tokens.css from 2026-06-29 (99746dbe8) until TECH_DEBT #62
  // ported them here — hex literals like the ImageUpload washes below.
  { section: 'Rail palette (theme-following; .h10-shell pins light)', name: '--nds-rail-text', value: '#4a5462' },
  { name: '--nds-rail-text-2', value: '#5b6573' },
  { name: '--nds-rail-text-strong', value: '#1c2530' },
  { name: '--nds-rail-icon', value: '#8a93a1' },
  { name: '--nds-rail-chev', value: '#98a2b3' },
  { name: '--nds-rail-item-hover', value: '#e6eaf0' },
  { name: '--nds-rail-item-hover-2', value: '#f1f4f8' },
  { name: '--nds-rail-chip-bg', value: '#e8ebf0' },
  { name: '--nds-rail-chip-active-bg', value: '#dce8fb' },
  { name: '--nds-rail-chip-active-fg', value: '#1f6fde' },
  { name: '--nds-rail-ft', value: '#aeb6c2' },

  { name: '--nds-green-soft', value: palette.green.soft },
  { name: '--nds-green-500', value: palette.green[500] },
  { name: '--nds-green-600', value: palette.green[600] },
  { name: '--nds-green-700', value: palette.green[700] },
  { name: '--nds-red-soft', value: palette.red.soft },
  { name: '--nds-red-500', value: palette.red[500] },
  { name: '--nds-red-600', value: palette.red[600] },
  { name: '--nds-red-700', value: palette.red[700] },
  { name: '--nds-amber-soft', value: palette.amber.soft },
  { name: '--nds-amber-600', value: palette.amber[600] },
  { name: '--nds-amber-700', value: palette.amber[700] },
  { name: '--nds-amber-text', value: palette.amber.text },
  { name: '--nds-purple-bg', value: palette.purple.bg },
  { name: '--nds-purple-600', value: palette.purple[600] },
  { name: '--nds-purple-700', value: palette.purple[700] },
  { name: '--nds-cyan-bg', value: palette.cyan.bg },
  { name: '--nds-cyan-700', value: palette.cyan[700] },
  { name: '--nds-amazon', value: palette.amazon },

  { name: '--nds-shadow-rgb', value: '20 28 38' },
  { name: '--nds-focus-rgb', value: '31 111 222' },

  // ── Tier 2: semantic roles (components consume these) ─────────────
  { section: 'Tier 2: semantic roles', name: '--nds-text', value: 'var(--nds-grey-900)' },
  { name: '--nds-text-2', value: 'var(--nds-grey-600)' },
  // #7e8796, was #8a93a1. --nds-text-3 is the ICON tier, so its floor is 3:1 — and it cleared that
  // on a white card (3.10) while missing it on the ads console's own ground (#f4f6f9, 2.87) and on
  // --nds-surface-sunken (2.74). Same shape as --nds-primary being 4.79 on a card and 4.42 on the
  // shell: one token, one ground either side of the line. #7e8796 is the SMALLEST move that clears
  // 3:1 on all three (3.62 / 3.35 / 3.20), so nothing shifts more than it must. The dark override
  // is untouched and already clears 4.62-5.20.
  { name: '--nds-text-3', value: '#7e8796' },
  { name: '--nds-text-strong', value: 'var(--nds-grey-700)' },
  { name: '--nds-text-disabled', value: 'var(--nds-grey-400)' },
  { name: '--nds-text-inverse', value: 'var(--nds-white)' },
  // NOT --nds-blue-600. Measured 2026-08-25: #1f6fde is 4.79:1 on a white card but only 4.42:1 on
  // the ads console's own ground (.h10-shell #f4f6f9) and 4.50:1 on --nds-surface-sunken — i.e.
  // a link that passes AA inside a card and fails it the moment the card is removed. #1a60c4 is
  // 5.98 / 5.52 / 5.62 on those three, clearing AA on every ground a link actually appears on.
  // It is not a new colour: .h10-ar-lnk already shipped it for exactly this reason.
  { name: '--nds-text-link', value: '#1a60c4' },

  { name: '--nds-bg', value: 'var(--nds-grey-50)' },
  { name: '--nds-surface', value: 'var(--nds-white)' },
  { name: '--nds-surface-raised', value: 'var(--nds-grey-25)' },
  { name: '--nds-surface-sunken', value: 'var(--nds-grey-100)' },
  { name: '--nds-surface-hover', value: 'var(--nds-grey-75)' },
  { name: '--nds-wash-primary', value: 'var(--nds-blue-50)' },
  { name: '--nds-rail-bg', value: 'var(--nds-rail-surface)' },

  { name: '--nds-border', value: 'var(--nds-grey-200)' },
  { name: '--nds-border-subtle', value: 'var(--nds-grey-150)' },
  { name: '--nds-border-strong', value: 'var(--nds-grey-300)' },
  { name: '--nds-rail-border', value: 'var(--nds-rail-line)' },

  { name: '--nds-primary', value: 'var(--nds-blue-600)' },
  { name: '--nds-primary-hover', value: 'var(--nds-blue-700)' },
  { name: '--nds-primary-dark', value: 'var(--nds-blue-800)' },
  { name: '--nds-primary-soft', value: 'var(--nds-blue-100)' },
  { name: '--nds-primary-ghost-border', value: 'var(--nds-blue-200)' },

  { name: '--nds-success-soft', value: 'var(--nds-green-soft)' },
  { name: '--nds-success', value: 'var(--nds-green-600)' },
  { name: '--nds-success-strong', value: 'var(--nds-green-700)' },
  { name: '--nds-live', value: 'var(--nds-green-500)' },
  { name: '--nds-danger-soft', value: 'var(--nds-red-soft)' },
  { name: '--nds-danger', value: 'var(--nds-red-500)' },
  // #a3211a, not --nds-red-700 (#c0392b). White on red-700 is 5.44:1, but this console measured
  // its own two dangerous actions DARKER for exactly this reason — #b3261e (6.54:1) on the plan
  // delete and #a3342b (6.81:1) on the undo-commit — so neither could convert without lowering
  // contrast, which is forbidden. #a3211a is 7.53:1 and clears both. It is used as a FILL (white
  // on it) and as TEXT (it on white) in eight DS rules; darkening raises contrast in both.
  { name: '--nds-danger-strong', value: '#a3211a' },
  // #fff6e8, decoupled from --nds-amber-soft, so the warning pair IS the stale pair below. A
  // literal on a semantic token is the shape this file already uses for the -text tier: derived
  // from a contrast requirement, not from a ramp position.
  { name: '--nds-warning-soft', value: '#fff6e8' },
  { name: '--nds-warning', value: 'var(--nds-amber-600)' },
  { name: '--nds-warning-strong', value: 'var(--nds-amber-700)' },
  { name: '--nds-info-soft', value: 'var(--nds-blue-100)' },
  { name: '--nds-info', value: 'var(--nds-blue-600)' },
  // The info tone had soft + line but no `strong`: `--status-info-strong` reached past the
  // semantic tier straight to the ramp (`--nds-blue-700`), which is the one thing component
  // CSS may not do (token-guard check B). Named here so the tone family is complete and the
  // 9.0b substitution has a legal target, like every other tone.
  { name: '--nds-info-strong', value: 'var(--nds-blue-700)' },

  // ── status TEXT — the tier this system was missing ───────────────────────────────────────────
  // Every tone had `-soft` (a background) and `-strong` (a fill/border), and nothing for TEXT ON
  // that soft background. So the ads console computed its own and wrote the ratios into ads.css
  // ("#8a5316 on #fff6e8 is 5.89:1 — computed, not guessed"). Measured 2026-08-25, on each tone's
  // own `-soft`:
  //
  //            -strong today            these
  //   success  4.57  ✓                  5.40  ✓
  //   warning  3.39  ✗ FAILS AA         5.69  ✓
  //   danger   4.63  ✓                  6.27  ✓
  //   info     5.20  ✓                  8.39  ✓
  //
  // The warning row is why this is a fix and not a tidy-up: `--nds-warning` on
  // `--nds-warning-soft` is 3.39:1, so anyone using the system as intended today ships
  // inaccessible warning text. The console was not diverging from the design system here — it hit
  // a gap and solved it correctly, three years of ratios ahead of the tokens.
  //
  // LITERAL values, not `var(--nds-*-800)`, and deliberately. These were derived from a contrast
  // requirement, not from a ramp position: #10457f is 17.7 ΔE from the existing --nds-blue-800,
  // so folding it into the ramp would move 74 declarations visibly to satisfy a naming
  // convention. A semantic token carrying its own computed value is the honest shape — the same
  // one --nds-rail-* already uses.
  // ── the missing AA step in the text ramp ─────────────────────────────────────────────────────
  // Measured 2026-08-25, on white: --nds-text 15.48 ✓ · --nds-text-2 5.91 ✓ · --nds-text-3 3.10 ✗.
  // WCAG AA needs 4.5:1 under 18.66px, so the ramp jumps from comfortable straight to failing
  // with nothing usable in between — and 18 DS components were using text-3 at 9–12.5px.
  //
  // #667080 is 5.01:1 and is not invented: the ads console computed it and used it 207 times,
  // noting "measured in the deployed DOM, not estimated". Same story as the status -text tier —
  // the console hit a gap in this system and filled it correctly.
  // #626c7b, was #667080. The -muted tier is TEXT, floor 4.5, and it cleared that on white (5.01)
  // and on the shell (4.62) while missing it on --nds-surface-sunken (4.42) — a ground this
  // system defines itself. Third token found that way, which is the real finding: whatever check
  // produced these pairs was run against WHITE ONLY. #626c7b is the smallest move that clears 4.5
  // on every ground (5.32 / 4.91 / 4.69 / 4.82).
  { name: '--nds-text-muted', value: '#626c7b' },
  // #146034, was #14724d. Third instance of the same finding in one sweep: an engaged GREEN
  // toggle measured #146034 on #e7f4ec = 6.74:1 while the DS pair was 5.40:1, so it could not
  // convert without losing contrast. Darkening only the TEXT clears it at 6.95:1 on the existing
  // --nds-success-soft, so the wash does not move.
  { name: '--nds-success-text', value: '#146034' },
  // #6d3f10, was #8a5316. Same story as the -text tier one tier up, one more turn: four spellings
  // of a "this view is stale, click to reload" chip measured #6d3f10 on #fff6e8 = 8.27:1, while
  // Button variant="warning" was 5.69:1 — so four call sites of ONE concept could not converge
  // without losing contrast. The console computed the better number again; the DS adopts it.
  { name: '--nds-warning-text', value: '#6d3f10' },
  // The tone palettes ship soft/text/strong but no BORDER step, so a tinted warning control had
  // nowhere to land — this is `.bp-btn.warn`'s measured #f0d9a8, tokenised. A tint's hairline is
  // decorative, so the number does not move; the TEXT is what rose (5.66 -> 5.69).
  { name: '--nds-warning-border', value: '#f0d9a8' },
  // "Stale" had FIVE browns across the ads console — #8a5316, #6d3f10, #7a4512, #7a5b00 and a
  // red — for one meaning. This is the darkest measured value, so adopting it everywhere only
  // ever RAISES contrast: 5.89 → 8.27 on the stale badge, 7.29 → 8.27 on the feed banner.
  // Now an ALIAS: the warning pair above was darkened to exactly this, so "stale" and "warning"
  // stopped being two colours for one meaning. Kept as a name because the surfaces read better
  // for it, but there is one value.
  { name: '--nds-stale-text', value: 'var(--nds-warning-text)' },
  // Inline-note severities, one pair each. Values are the HIGHEST-contrast variant found among
  // the six that existed, so adopting them raises contrast everywhere and lowers it nowhere:
  // error 6.24/9.16/9.23 → 9.23, caution 5.79/5.89/6.63 → 6.63.
  { name: '--nds-note-error-bg', value: '#fdf0ef' },
  { name: '--nds-note-error-fg', value: '#7a2018' },
  { name: '--nds-note-error-icon', value: '#b3261e' },
  { name: '--nds-note-warn-bg', value: '#fdf6e3' },
  { name: '--nds-note-warn-fg', value: '#6b5514' },
  { name: '--nds-note-warn-icon', value: '#8a6d1f' },
  // The note trios shipped bg/fg/icon but no BORDER, so an amber- or red-hairline control (white
  // fill, tinted outline — the "accept this conflict" affordance) had to keep a raw literal or
  // drop the cue. A session dropped the cue, which is the worse outcome: the affordance is the
  // border. #e0d4a8 is `.h10-rep-tbl .mini`'s measured amber; #eec9c4 is the red at the same
  // remove from its own fill. Hairlines are decorative, so these carry no contrast requirement —
  // they exist so the cue does not have to be abandoned.
  { name: '--nds-note-warn-border', value: '#e0d4a8' },
  { name: '--nds-note-error-border', value: '#eec9c4' },
  { name: '--nds-danger-text', value: '#9c2f2a' },
  { name: '--nds-info-text', value: '#10457f' },

  // status pills
  // TONAL — a tinted fill with a tinted border and dark tinted text. Tier 2, because two
  // different components want exactly this treatment: a FilterChip's engaged state and a Button
  // that is neither primary nor plain (`.acr-gg-reset`). Naming it by tone would be wrong — it is
  // not "success", it is "selected/secondary emphasis" — so it is named for what it looks like.
  // blue-900 on blue-50 measures 7.41:1. NOT blue-600, which is 4.36:1 and what `.hl-fchip.on`
  // shipped: under AA.
  { section: 'Tonal', name: '--nds-tonal-bg', value: 'var(--nds-blue-50)' },
  { name: '--nds-tonal-border', value: 'var(--nds-blue-200)' },
  { name: '--nds-tonal-fg', value: 'var(--nds-blue-900)' },
  // FilterChip's engaged state IS the tonal treatment; kept as its own names so the chip can
  // diverge later without touching every tonal surface.
  { name: '--nds-fchip-on-bg', value: 'var(--nds-tonal-bg)' },
  { name: '--nds-fchip-on-border', value: 'var(--nds-tonal-border)' },
  { name: '--nds-fchip-on-fg', value: 'var(--nds-tonal-fg)' },
  { section: 'status pills (tone-named: success/warning/neutral/danger)', name: '--nds-pill-success-fg', value: 'var(--nds-blue-900)' },
  { name: '--nds-pill-success-bg', value: pill.ok.bg },
  // --nds-warning-text, not --nds-amber-text: the amber text tier is #9a6700 and measures
  // 4.39:1 on this pill's own background — under AA, on a pill whose entire job is to be read.
  // The warning tier is 7.99:1 on it.
  { name: '--nds-pill-warning-fg', value: 'var(--nds-warning-text)' },
  { name: '--nds-pill-warning-bg', value: 'var(--nds-amber-soft)' },
  // --nds-text-2, not pill.arch.fg (#6b7480): that measures 4.18:1 on this pill's background,
  // under AA. --nds-text-2 is 5.22:1 and is the tier the rest of the system already uses for
  // secondary text.
  { name: '--nds-pill-neutral-fg', value: 'var(--nds-text-2)' },
  { name: '--nds-pill-neutral-bg', value: 'var(--nds-grey-100)' },
  // NOT --nds-danger-strong: `.dark` overrides that to #f79289 while --nds-danger-soft stays
  // light, so the dark danger pill was #f79289 on #fde8e8 — 1.9:1, illegible. --nds-danger-text
  // has no dark override: 6.27:1 in BOTH themes (was 4.63 light / 1.9 dark).
  { name: '--nds-pill-danger-fg', value: 'var(--nds-danger-text)' },
  // ── WorkspaceGrid (tier 3) ─────────────────────────────────────────────────────
  // Arrived with the grid in WG.3e. Kept as component tokens rather than snapped to the
  // nearest ramp entry: the nearest is 2.4–44.1 away in RGB, and in this codebase a colour
  // far from the palette has repeatedly turned out to be a contrast ratio somebody computed.
  // A substitution may only ever RAISE contrast, so these keep their measured values.
  { name: '--nds-wsgrid-head-fg', value: '#475467' }, // column header text
  { name: '--nds-wsgrid-dot', value: '#cbd2db' }, // inactive state dot in the name cell
  { name: '--nds-wsgrid-icon-muted', value: '#b6bdc8' }, // pin and bulb glyphs in the name cell
  { name: '--nds-wsgrid-badge-sb-fg', value: '#b45309' }, // Sponsored Brands badge text
  { name: '--nds-wsgrid-tag-auto', value: '#4f46e5' }, // AUTO targeting tag
  { name: '--nds-wsgrid-tag-manual', value: '#7c3aed' }, // MANUAL targeting tag
  { name: '--nds-wsgrid-pb-bg', value: '#2f3a4a' }, // placement badge ground
  { name: '--nds-wsgrid-pb-border', value: '#cfd6de' }, // placement badge edge
  { name: '--nds-wsgrid-rule', value: '#d0d5dd' }, // frozen-column and checkbox-column rules
  { name: '--nds-wsgrid-drag-ring', value: '#2f6bff' }, // the ring on a header being dragged
  { name: '--nds-pill-danger-bg', value: 'var(--nds-danger-soft)' },

  // ── Tier 3: program / targeting chips ────────────────────────────
  { section: 'Tier 3: program / targeting chips', name: '--nds-badge-sp-fg', value: 'var(--nds-purple-700)' },
  { name: '--nds-badge-sp-bg', value: 'var(--nds-purple-bg)' },
  { name: '--nds-badge-sd-fg', value: 'var(--nds-cyan-700)' },
  { name: '--nds-badge-sd-bg', value: 'var(--nds-cyan-bg)' },
  { name: '--nds-badge-sb-fg', value: 'var(--nds-amber-700)' },
  { name: '--nds-badge-sb-bg', value: badge.sb.bg },
  { name: '--nds-targeting-auto', value: 'var(--nds-blue-800)' },
  { name: '--nds-targeting-manual', value: 'var(--nds-purple-600)' },

  // ImageUpload component tokens (bespoke washes — exact legacy values, were raw hex)
  { name: '--nds-imgup-surface', value: '#f7faff' },
  { name: '--nds-imgup-hover', value: '#f0f6ff' },
  { name: '--nds-imgup-drag', value: '#e9f2ff' },
  { name: '--nds-imgup-spin-track', value: '#cdd5df' },
  { name: '--nds-imgup-err', value: '#cc1100' },

  // Tooltip bubbles. Both are deliberately THEME-INVARIANT — they point at the
  // raw ramps, which the `.dark` block never redefines, so a tip keeps its own
  // contrast instead of inverting with the canvas. The values they replace were
  // foreign Tailwind slate hexes (#1e293b / #e2e8f0 / #28313d) hardcoded in
  // primitives.css; snapped onto the nearest H10 ramp step 2026-08-24 (max
  // delta 4/255 per channel — below a JND, and on-system).
  { name: '--nds-tooltip-light-bg', value: 'var(--nds-white)' },
  { name: '--nds-tooltip-light-fg', value: 'var(--nds-grey-900)' },
  { name: '--nds-tooltip-light-border', value: 'var(--nds-grey-150)' },
  { name: '--nds-tooltip-light-fg-2', value: 'var(--nds-grey-600)' },
  { name: '--nds-tip-bg', value: 'var(--nds-grey-800)' },
  { name: '--nds-tip-fg', value: 'var(--nds-white)' },

  // ── Radius ───────────────────────────────────────────────────────
  // ── Layering ────────────────────────────────────────────────────────────────────────────────
  // There was no z scale: every DS z-index was a bare literal, and they did not agree with the
  // app's. Measured 2026-08-25 — the DS backdrop was 60 while the ads console's own overlays run
  // to 1200/1201 and 1300/1301, so a DS Modal opened from inside one rendered BEHIND it, and
  // converting a hand-rolled modal to the DS one dropped it twenty layers.
  //
  // The bands sit above the app's highest (1301) so a converted surface always wins, and stay
  // ordered among themselves. Popover is ABOVE modal on purpose: a Listbox opened inside a Modal
  // must escape it, and a page-level popover is never open while a modal has focus.
  { section: 'Layering', name: '--nds-z-sticky', value: '5' },
  { name: '--nds-z-actionbar', value: '20' },
  { name: '--nds-z-rail', value: '50' },
  { name: '--nds-z-overlay', value: '1400' },
  { name: '--nds-z-modal', value: '1410' },
  { name: '--nds-z-popover', value: '1450' },
  { name: '--nds-z-toast', value: '1600' },
  { name: '--nds-z-tooltip', value: '1700' },
  { section: 'Radius', name: '--nds-radius-pill', value: '4px' },
  { name: '--nds-radius-sm', value: '6px' },
  { name: '--nds-radius-md', value: '7px' },
  { name: '--nds-radius-lg', value: '8px' },
  { name: '--nds-radius-xl', value: '10px' },
  { name: '--nds-radius-2xl', value: '12px' },
  { name: '--nds-radius-3xl', value: '14px' },
  // A full capsule — toggles, progress bars, icon buttons. NOT `--nds-radius-pill` (4px), which is
  // the status-pill rounded rect. The DS was writing 999px as a literal 9 times and the ads
  // console 75 more; neither could say it meant the same shape.
  { name: '--nds-radius-full', value: '999px' },
  { name: '--nds-radius-round', value: '999px' },

  // ── Elevation + focus ────────────────────────────────────────────
  { section: 'Elevation + focus', name: '--nds-shadow-card', value: '0 6px 22px rgb(var(--nds-shadow-rgb) / 0.16)' },
  { name: '--nds-shadow-menu', value: '0 12px 30px rgb(var(--nds-shadow-rgb) / 0.16)' },
  { name: '--nds-shadow-pop', value: '0 16px 40px rgb(var(--nds-shadow-rgb) / 0.2)' },
  { name: '--nds-shadow-modal', value: '0 18px 48px rgb(var(--nds-shadow-rgb) / 0.28)' },
  { name: '--nds-shadow-rail', value: '8px 0 30px rgb(var(--nds-shadow-rgb) / 0.13)' },
  { name: '--nds-shadow-tip', value: '0 10px 26px rgb(var(--nds-shadow-rgb) / 0.3)' },
  { name: '--nds-focus-ring', value: '0 0 0 2px rgb(var(--nds-focus-rgb) / 0.12)' },

  // ── Structural dimensions ────────────────────────────────────────
  { section: 'Structural dimensions', name: '--nds-rail-collapsed', value: '66px' },
  { name: '--nds-rail-expanded', value: '344px' },
  { name: '--nds-row-nav', value: '46px' },
  { name: '--nds-icon-zone', value: '50px' },

  // ── Type ─────────────────────────────────────────────────────────
  { section: 'Type', name: '--nds-font-sans', value: "var(--font-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  { name: '--nds-font-smoothing', value: 'auto' },

  // ── Platform-semantic aliases ────────────────────────────────────────
  //
  // 🔴 DS stylesheets DO NOT consume these. `token-guard` check D enforces it.
  //
  // This tier is published for APP CSS only. Eleven of these names — --text-*,
  // --surface-* and --border-* — are ALSO defined by globals.css (`:root`) and
  // ads.css (`.h10-shell`) as space-separated RGB CHANNELS, because Tailwind
  // composes them as `rgb(var(--x) / <alpha-value>)`. Custom properties resolve
  // from the nearest defining ANCESTOR, not by source order, so inside the shell
  // those definitions shadow these and `background: var(--surface-card)` becomes
  // `background: 255 255 255` — invalid at computed-value time, silently dropped.
  // 285 DS declarations were dead that way until Phase 9.0b moved every one of
  // them onto the DS-owned `--nds-*` tier (docs/PHASE-9-0B-TOKEN-FORM.md).
  //
  // The tier is KEPT rather than deleted: --color-primary and the --status-*
  // family are NOT contested (nothing else defines them) and app stylesheets
  // depend on them — reporting.css alone has 47 uses, plus trust.css and
  // /products/next. Deleting the tier would break ~70 app declarations to fix a
  // problem the guard already prevents.
  //
  // If you add a name here, first `grep -rn -- "--<name>:" apps/web/src/app`.
  // If globals.css or ads.css already defines it, adding it is a landmine, not a
  // fix — that is why --surface-raised is deliberately absent.
  // ── Tier 3: grid (GDS) ───────────────────────────────────────────
  // The AG-Grid-based design-system grid's own tokens, defined once in ./grid.ts so the
  // TypeScript numbers a page hands AG (row height, header height, widths) and the CSS custom
  // properties the theme binds are the same table. Every colour is a semantic role, so the
  // .dark block below needs no grid entry.
  ...gridVars,

  { section: 'Platform-semantic aliases', name: '--text-primary', value: 'var(--nds-text)' },
  { name: '--text-secondary', value: 'var(--nds-text-2)' },
  { name: '--text-tertiary', value: 'var(--nds-text-3)' },
  { name: '--text-disabled', value: 'var(--nds-text-disabled)' },
  { name: '--text-link', value: 'var(--nds-text-link)' },
  { name: '--surface-canvas', value: 'var(--nds-bg)' },
  { name: '--surface-card', value: 'var(--nds-surface)' },
  { name: '--surface-sunken', value: 'var(--nds-surface-sunken)' },
  { name: '--border-default', value: 'var(--nds-border)' },
  { name: '--border-subtle', value: 'var(--nds-border-subtle)' },
  { name: '--border-strong', value: 'var(--nds-border-strong)' },
  { name: '--color-primary', value: 'var(--nds-primary)' },
  { name: '--color-primary-soft', value: 'var(--nds-primary-soft)' },
  { name: '--status-success-soft', value: 'var(--nds-success-soft)' },
  { name: '--status-success-line', value: 'var(--nds-success)' },
  { name: '--status-success-strong', value: 'var(--nds-success-strong)' },
  { name: '--status-warning-soft', value: 'var(--nds-warning-soft)' },
  { name: '--status-warning-line', value: 'var(--nds-warning)' },
  { name: '--status-warning-strong', value: 'var(--nds-warning-strong)' },
  { name: '--status-danger-soft', value: 'var(--nds-danger-soft)' },
  { name: '--status-danger-line', value: 'var(--nds-danger)' },
  { name: '--status-danger-strong', value: 'var(--nds-danger-strong)' },
  { name: '--status-info-soft', value: 'var(--nds-info-soft)' },
  { name: '--status-info-line', value: 'var(--nds-info)' },
  { name: '--status-info-strong', value: 'var(--nds-info-strong)' },

  // ── Dimension: spacing + type ────────────────────────────────────
  // Derived from ./spacing and ./typography rather than restated here, so each
  // scale is still defined exactly once: `px12` -> `--nds-space-12`,
  // `xsPlus` -> `--nds-font-size-xs-plus`.
  //
  // These are theme-invariant, so they are emitted to :root only and never to
  // the .dark block — a padding does not change with the canvas.
  ...spacingVars,
  ...typeVars,
]

/** Dark-mode overrides (the `.dark` block). Provisional inversions; their only home. */
export const cssVarsDark: ReadonlyArray<CssVar> = [
  { name: '--nds-text', value: '#e7ebf1' },
  { name: '--nds-text-2', value: '#aab6c2' },
  { name: '--nds-text-3', value: '#8a94a6' },
  { name: '--nds-text-disabled', value: '#5b6b7b' },
  { name: '--nds-text-inverse', value: '#14223a' },

  { name: '--nds-bg', value: '#14223a' },
  { name: '--nds-surface', value: '#18263b' },
  { name: '--nds-surface-raised', value: '#1f2c3d' },
  { name: '--nds-surface-sunken', value: '#1a2330' },
  { name: '--nds-rail-bg', value: '#18263b' },

  // ── the dark palette, measured 2026-08-26 ────────────────────────────────────────────────────
  // The dark block overrode 29 tokens out of ~240, so most washes and fills kept their LIGHT
  // value on a dark canvas: 28 DS rules measured below AA after the aliases below were applied.
  // Every value here was chosen against its ACTUAL usage, not picked to look right in isolation.
  //
  // --nds-primary is the constrained one: it is a FILL carrying --nds-text-inverse AND is used as
  // TEXT on --nds-surface, so one value has to clear both. #6d9ee8 gives 5.84 and 5.59.
  // Deliberately NOT #8ab6f0, which would clear both more comfortably but IS --nds-text-link —
  // reusing it makes "primary" and "link" the same colour in dark and different in light.
  { name: '--nds-primary', value: '#6d9ee8' },
  { name: '--nds-primary-soft', value: '#1c2f4d' },      // link on it 6.42
  { name: '--nds-wash-primary', value: '#182a44' },      // link on it 6.90
  { name: '--nds-pill-neutral-bg', value: '#26323f' },   // text-2 on it 6.32
  { name: '--nds-success-soft', value: '#173a2c' },      // success-strong on it 8.14
  { name: '--nds-danger-soft', value: '#3a1c1c' },       // danger-strong on it 6.92
  { name: '--nds-danger-text', value: '#ef9c93' },       // on surface 7.14
  { name: '--nds-targeting-auto', value: '#7fd4b0' },    // text-inverse on it 9.05
  { name: '--nds-targeting-manual', value: '#c9a86a' },  // text-inverse on it 7.04
  { name: '--nds-imgup-surface', value: '#1a2330' },     // text-muted on it 7.67
  { name: '--nds-imgup-drag', value: '#1c2f4d' },        // text-link on it 6.42
  // The -text tier is DARK by construction (it exists to be read on a light wash), so on a dark
  // wash it is dark-on-dark: success-text measured 1.64:1 on the new --nds-success-soft. In dark
  // the -strong tier is the readable one — this block already chose those values to be AA on the
  // dark canvas — so -text aliases to it. --nds-stale-text follows --nds-warning-text and needs
  // no entry of its own.
  { name: '--nds-success-text', value: 'var(--nds-success-strong)' },   // 8.14 on success-soft
  { name: '--nds-warning-text', value: 'var(--nds-warning-strong)' },   // 7.24 on warning-soft
  // warning-soft had no dark value, so a "warning" surface rendered a LIGHT amber wash on a dark
  // canvas — a contrast PASS that is still a visual bug, and the reason a ratio check alone is
  // not enough.
  { name: '--nds-warning-soft', value: '#3a2e12' },
  // The status pills carry their own bg tokens, which had no dark value — so once the -text tier
  // aliased to -strong (light) above, a warning pill was light-on-light at 1.66:1. These three
  // mirror the tone washes.
  { name: '--nds-pill-warning-bg', value: '#3a2e12' },
  // BLUE, not green. This console's success pill is blue — "ok = blue Enabled" is the convention
  // pillTone.ts documents, and the LIGHT value is #d2e6fc with a blue-900 foreground. Mirroring
  // the tone NAME to green would have made the same pill green in dark and blue in light.
  { name: '--nds-pill-success-bg', value: '#1c2f4d' },
  { name: '--nds-pill-success-fg', value: 'var(--nds-text-link)' },   // 6.42 on it
  { name: '--nds-pill-danger-bg', value: '#3a1c1c' },
  // 🔴 These four ALIAS a token that .dark overrides, and must therefore be re-declared HERE.
  // A custom property whose value is `var(X)` resolves in the scope where it is DECLARED, not
  // where it is used: declared on :root, `--nds-pill-warning-fg: var(--nds-warning-text)`
  // computes to the LIGHT #6d3f10 on :root and then inherits that literal into .dark. Overriding
  // --nds-warning-text in .dark never reaches it. Measured in-browser: the warning pill was
  // 1.50:1, the neutral pill 2.21:1 and the danger pill 2.09:1 — while a static resolver that
  // assumed lazy resolution reported all three as passing.
  { name: '--nds-pill-warning-fg', value: 'var(--nds-warning-text)' },
  { name: '--nds-pill-neutral-fg', value: 'var(--nds-text-2)' },
  { name: '--nds-pill-danger-fg', value: 'var(--nds-danger-text)' },
  { name: '--nds-stale-text', value: 'var(--nds-warning-text)' },
  //
  // NOT overridden on purpose: --nds-white and --nds-grey-100, which workspace-grid.css uses as
  // BACKGROUNDS. A ramp step is an absolute colour — a dark "white" would make every other
  // consumer shift silently. Those two rules need repointing to a semantic surface instead.

  // Three tokens that had NO dark value, so they kept their LIGHT one on a dark canvas.
  // Measured 2026-08-26 across every DS rule setting both a token colour and a token background:
  //
  //   --nds-surface-hover   stayed #f1f4f8, so `--nds-text` on it was 1.08:1 in EIGHT rules —
  //                         a hover state that erases its own label. → surface-raised, 11.81:1
  //   --nds-text-strong     stayed #3a4452 on a dark surface: 1.54:1  → --nds-text, 12.73:1
  //   --nds-text-muted      stayed #667080: 3.04:1                    → --nds-text-2, 7.38:1
  //
  // Aliases to values this block already chose, not new colours — nothing is invented here.
  { name: '--nds-surface-hover', value: 'var(--nds-surface-raised)' },
  { name: '--nds-text-strong', value: 'var(--nds-text)' },
  { name: '--nds-text-muted', value: 'var(--nds-text-2)' },

  { name: '--nds-border', value: '#2f3a4a' },
  { name: '--nds-border-subtle', value: '#26323f' },
  { name: '--nds-border-strong', value: '#46505f' },
  { name: '--nds-rail-border', value: '#26323f' },

  // Tone + link roles on a dark canvas. The light values (--nds-amber-700 /
  // --nds-red-700 / --nds-green-700 / --nds-blue-600) measure 2.94:1 - 3.18:1
  // against the dark surfaces — all below AA. Measured in-browser 2026-08-19;
  // every value below measures >= 4.5:1 on --nds-surface / --nds-surface-raised.
  // These lived as `.dark .nds-acct*` hex overrides in components.css until
  // 2026-08-24: a DS-wide gap patched per-component, so any NEW component
  // inherited the sub-AA value. Fixed at the token tier, which is its only home.
  { section: 'Dark tone + link roles (AA on the dark canvas)', name: '--nds-success-strong', value: '#6ee7a8' },
  { name: '--nds-warning-strong', value: '#f0b46a' },
  { name: '--nds-danger-strong', value: '#f79289' },
  { name: '--nds-text-link', value: '#8ab6f0' },

  // Dark rail palette (consumed only when the rail is NOT under .h10-shell —
  // i.e. the app-wide rail; standalone shells pin these light).
  { section: 'Dark rail palette (app-wide rail only; shells pin light)', name: '--nds-rail-text', value: '#aab6c2' },
  { name: '--nds-rail-text-2', value: '#97a3b1' },
  { name: '--nds-rail-text-strong', value: '#e7ebf1' },
  { name: '--nds-rail-icon', value: '#8a94a6' },
  { name: '--nds-rail-chev', value: '#6f7b8b' },
  { name: '--nds-rail-item-hover', value: '#223247' },
  { name: '--nds-rail-item-hover-2', value: '#1d2a3c' },
  { name: '--nds-rail-chip-bg', value: '#243345' },
  { name: '--nds-rail-chip-active-bg', value: '#1d3a5f' },
  { name: '--nds-rail-chip-active-fg', value: '#cfe1fb' },
  { name: '--nds-rail-ft', value: '#6f7b8b' },

  // ── grid aliases, re-declared so they resolve against the dark tier (tokens/grid.ts) ──
  ...gridVarsDark,
]
