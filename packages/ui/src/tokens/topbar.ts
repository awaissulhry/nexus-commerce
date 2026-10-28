/**
 * TB — top bar tokens (tier 3, `--nds-topbar-*`).
 *
 * ONE table for every number and colour the app-wide top bar draws, so the bar and the rail
 * beneath it read as a single L-shaped piece of chrome instead of two surfaces that happen to
 * look similar.
 *
 * ── Why these alias CHROME ───────────────────────────────────────────────────────────────────
 *
 * "Blend with the sidebar" is a constraint, not a preference: the bar's ground, its rule and its
 * text must be the SAME values the rail resolves, or the corner where they meet shows a seam.
 * Both now read `--nds-chrome-*` (tokens/chrome.ts), so they are the same surface by
 * construction rather than by two palettes being kept in agreement.
 *
 * ── 🔴 What this replaced, so the trap is not re-introduced ──────────────────────────────────
 *
 * The first cut aliased `--nds-rail-*` and needed TWO extra mechanisms to work, both of which
 * are now gone:
 *
 *   • a `.dark` re-declaration of every alias, because `var()` resolves in the scope where it is
 *     DECLARED — `:root` computed the light rail colour and inherited that literal into `.dark`;
 *   • a `data-chrome="light"` escape hatch, because `.h10-shell` pinned the rail light for the
 *     ads cockpit and /products/next and the bar rendered ABOVE that element, out of the pin's
 *     reach.
 *
 * Both existed only because the bar was chasing a rail colour that differed per shell. Chrome is
 * one theme-independent palette, so neither is needed. If you find yourself adding a dark block
 * or a light pin to this file again, the alias underneath is probably wrong.
 */

export interface TopbarCssVar {
  section?: string
  name: string
  value: string
}

/**
 * Geometry.
 *
 * `brandW` is 66px because that is the COLLAPSED RAIL WIDTH (`.h10-rail { width: 66px }`, and
 * `.app-rail-host`'s `--rail-reserve` default), so the logo centres over the rail's icon column
 * below it. The brand cell draws NO right border — it had one briefly, on the theory that
 * continuing the line into the rail's border unified the L-shape; the operator read it as an
 * arbitrary partition inside a single surface (2026-08-31), which it was.
 *
 * `h` is 56px, not 66px: the bar is chrome, and 66px of permanent chrome on a data-dense grid
 * page costs a row. The brand cell is 66px WIDE inside a 56px-TALL bar; only the width has to
 * agree with the rail.
 */
export const topbarGeometry = {
  h: 56,
  brandW: 66,
  /** Height of the search field and the icon buttons — one shared floor, as GDS-3.1 established
   *  for the grid toolbar: a swap between controls of different heights ticks the bar. */
  slotH: 36,
  gap: 8,
} as const

const px = (n: number): string => `${n}px`

export const topbarVars: ReadonlyArray<TopbarCssVar> = [
  // ── geometry ──
  {
    section:
      'Tier 3: top bar (tokens/topbar.ts — geometry here; every colour aliases tokens/chrome.ts)',
    name: '--nds-topbar-h',
    value: px(topbarGeometry.h),
  },
  { name: '--nds-topbar-brand-w', value: px(topbarGeometry.brandW) },
  { name: '--nds-topbar-slot-h', value: px(topbarGeometry.slotH) },
  { name: '--nds-topbar-gap', value: px(topbarGeometry.gap) },

  // ── surfaces + rules ──
  // These alias `--nds-chrome-*` (tokens/chrome.ts), which are LITERALS and theme-independent.
  // That is what makes the bar and the rail one surface: there is a single palette now, not a
  // rail colour that changed per shell and a bar that tried to follow it.
  { name: '--nds-topbar-bg', value: 'var(--nds-chrome-bg)' },
  { name: '--nds-topbar-border', value: 'var(--nds-chrome-border)' },
  { name: '--nds-topbar-item-hover', value: 'var(--nds-chrome-item-hover)' },

  // ── type + icons ──
  { name: '--nds-topbar-fg', value: 'var(--nds-chrome-fg)' },
  { name: '--nds-topbar-fg-strong', value: 'var(--nds-chrome-fg-strong)' },
  { name: '--nds-topbar-icon', value: 'var(--nds-chrome-icon)' },

  // ── the search field ──
  { name: '--nds-topbar-field-bg', value: 'var(--nds-chrome-control-bg)' },
  { name: '--nds-topbar-field-border', value: 'var(--nds-chrome-control-border)' },
  { name: '--nds-topbar-field-fg', value: 'var(--nds-chrome-control-fg)' },
  { name: '--nds-topbar-field-placeholder', value: 'var(--nds-chrome-control-placeholder)' },
  { name: '--nds-topbar-field-radius', value: 'var(--nds-radius-md)' },
]

/**
 * No `.dark` block.
 *
 * Every colour above resolves to a `--nds-chrome-*` LITERAL, and chrome is theme-independent by
 * design — dark in light mode and dark in dark mode, because it frames the workspace rather than
 * being part of it. There is no dark-mode value to restate, which is why
 * `scripts/check-dark-alias-scope.mjs` has nothing to enforce here. The earlier rail-aliased
 * version of this file DID need one, and that requirement is exactly what this removes.
 */

/** Every emitted name — used by the TB conformance probe. */
export const TOPBAR_TOKEN_NAMES: ReadonlyArray<string> = topbarVars.map((v) => v.name)

export const topbar = { geometry: topbarGeometry } as const
