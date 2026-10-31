/**
 * Density tiers — how big a whole screen's controls, type and touch targets are (`--nds-density-*`).
 *
 * A SECOND axis, next to the grid's row density (`tokens/grid.ts`: compact / cozy / spacious, an operator preference for
 * a grid's rows). This one is chosen by who uses the screen, and with what hands:
 *
 *   standard     the office console as it is today — every existing page. The default. Its values are the console's own
 *                sizes (the control heights `--nds-control-h-sm/-md`, the field's 11 px padding, the field label, the
 *                metric figure, the 15 px control icons, the 2 px focus outline 1 px off); `targetMin` is WCAG 2.2 AA's
 *                24 px (2.5.8).
 *   comfortable  partner portal and link pages, phone first: controls 40–44 px, targets at least 44 px, body 16 px
 *                (16, not 15: a phone browser zooms the page into a field whose text is under 16 px).
 *   floor        Android tablets on a factory floor, landscape, gloved hands: nothing under 48 px, controls 56 px,
 *                primary actions 64 px, body 18 px, counts in 40 px numerals, and 48 px between separate targets
 *                (8 mm on a 10-inch 1280 × 800 tablet, about 6 CSS px per mm).
 *   display      (D26, B-W2b-28) wall screens: the line TV read from across the floor, not touched. Body 32 px, labels
 *                24 px, numerals 96 px, icons 48 px. On a 55-inch 1920 × 1080 TV one CSS px is about 0.63 mm, so the body's
 *                em is about 20 mm (read at 5 m and more) and a numeral about 60 mm (read across a hall). Kept OUT of
 *                `DENSITIES` / `DensityName` on purpose — see "The display tier" below.
 *
 * ## How a subtree switches tier
 *
 * `data-density="comfortable"` (or `floor`, or `standard` to step back) on any element. The generated tokens CSS declares
 * the standard values on `:root` and each tier's values under `[data-density='…']`, so the tier's numbers inherit down
 * that element's subtree. `DensityProvider` (`lib/density.tsx`) sets the attribute AND tells TypeScript consumers the
 * tier's numbers (a lucide icon's `size`). A portal (Modal, Popover) renders into `<body>`, outside the subtree: a screen
 * that is all one tier also sets the attribute on its root element (`densityAttrs`).
 *
 * ## Why nothing existing can change
 *
 * 🔴 A tier redefines ONLY `--nds-density-*` tokens — never `--nds-font-size-base`, `--nds-control-h-*` or any other
 * existing token — so a tier can change only what reads `--nds-density-*`. Today nothing does: no existing component,
 * and no existing page, draws differently, even inside a tier. A component opts in by reading them. `density.vitest.test.ts`
 * holds the names (and that no colour is among them).
 *
 * No colour here either: a tier is dimensions only, so every contrast pair the contrast guard measures, light and dark,
 * holds in every tier unchanged.
 *
 * ## Built from the existing scales
 *
 * A value that an existing token already holds is written as that token (`var(--nds-space-48)`, `var(--nds-font-size-lg)`,
 * `var(--nds-radius-2xl)`); a value no scale holds is a px literal (56, 64, 44, the 16 px body, icons, focus widths).
 * The numbers below are what TypeScript reads; the test checks every token reference resolves to exactly that number.
 *
 * ## The display tier (D26, B-W2b-28)
 *
 * A fourth tier for wall screens, with its own exports (`DISPLAY_DENSITY`, `displayDensityTokens`, `displayDensityCss`,
 * `displayDensityAttrs`) and its own block, emitted after the floor block (`[data-density='display']`). It is NOT a
 * member of `DENSITIES` / `DensityName` / `isDensityName`: those name the tiers a person works in, and existing code maps
 * over them (the Commerce catalog draws one card per tier from a `Record<DensityName, …>`), so adding a member would
 * change what that code draws and type-checks. Nothing reads `--nds-density-*` inside `display` unless a screen opts in
 * with `displayDensityAttrs()` on its root, so no existing page can change.
 */

export interface DensityCssVar {
  section?: string
  name: string
  value: string
}

/** A number in px, or a number that an existing token already holds (written as that token in the CSS). */
type Dim = number | { readonly token: string; readonly px: number }

const tok = (token: string, px: number): Dim => ({ token, px })

/** Every density token: the TS key, its CSS name, and what it sizes. */
export const DENSITY_TOKENS = {
  targetMin: { css: '--nds-density-target-min', role: 'the smallest touch target anything may have (its hit area, not its drawing)' },
  controlHSm: { css: '--nds-density-control-h-sm', role: 'a small control: toolbar buttons, chips, inline actions' },
  controlH: { css: '--nds-density-control-h', role: 'a control: button, field, select' },
  controlHPrimary: { css: '--nds-density-control-h-primary', role: "the screen's main action" },
  padX: { css: '--nds-density-pad-x', role: 'inline padding inside a control' },
  gap: { css: '--nds-density-gap', role: 'space between controls of one group' },
  targetGap: { css: '--nds-density-target-gap', role: 'clear space between separate touch targets' },
  radius: { css: '--nds-density-radius', role: 'corner radius of a control' },
  fontLabel: { css: '--nds-density-font-label', role: 'field labels and secondary text' },
  fontBody: { css: '--nds-density-font-body', role: 'body text and the text inside controls' },
  fontNumeral: { css: '--nds-density-font-numeral', role: 'a count or quantity read at a glance' },
  icon: { css: '--nds-density-icon', role: 'an icon inside a control' },
  focusW: { css: '--nds-density-focus-w', role: 'width of the focus outline' },
  focusOffset: { css: '--nds-density-focus-offset', role: 'gap between a control and its focus outline' },
} as const

export type DensityTokenKey = keyof typeof DENSITY_TOKENS

const SCALE = {
  standard: {
    targetMin: tok('--nds-space-24', 24),
    controlHSm: tok('--nds-control-h-sm', 28),
    controlH: tok('--nds-control-h-md', 30),
    controlHPrimary: tok('--nds-control-h-md', 30),
    padX: tok('--nds-space-11', 11),
    gap: tok('--nds-space-8', 8),
    targetGap: tok('--nds-space-8', 8),
    radius: tok('--nds-radius-lg', 8),
    fontLabel: tok('--nds-font-size-sm-plus', 12.5),
    fontBody: tok('--nds-font-size-base', 13),
    fontNumeral: tok('--nds-font-size-xl', 22),
    icon: 15,
    focusW: 2,
    focusOffset: 1,
  },
  comfortable: {
    targetMin: 44,
    controlHSm: tok('--nds-space-40', 40),
    controlH: 44,
    controlHPrimary: tok('--nds-space-48', 48),
    padX: tok('--nds-space-16', 16),
    gap: tok('--nds-space-12', 12),
    targetGap: tok('--nds-space-12', 12),
    radius: tok('--nds-radius-xl', 10),
    fontLabel: tok('--nds-font-size-md-minus', 14),
    fontBody: 16,
    fontNumeral: tok('--nds-font-size-2xl', 27),
    icon: 20,
    focusW: 3,
    focusOffset: 2,
  },
  floor: {
    targetMin: tok('--nds-space-48', 48),
    controlHSm: tok('--nds-space-48', 48),
    controlH: 56,
    controlHPrimary: 64,
    padX: tok('--nds-space-24', 24),
    gap: tok('--nds-space-16', 16),
    targetGap: tok('--nds-space-48', 48),
    radius: tok('--nds-radius-2xl', 12),
    fontLabel: 16,
    fontBody: tok('--nds-font-size-lg', 18),
    fontNumeral: 40,
    icon: 28,
    focusW: 3,
    focusOffset: 2,
  },
} as const satisfies Record<string, Record<DensityTokenKey, Dim>>

export type DensityName = keyof typeof SCALE

/**
 * The display tier's numbers (D26): the line TV, read from 3–10 m and not touched. Never smaller than the floor tier
 * (a display may still be a kiosk someone taps), with type sized for distance rather than for fingers.
 */
const DISPLAY_SCALE = {
  targetMin: tok('--nds-space-48', 48),
  controlHSm: 56,
  controlH: 64,
  controlHPrimary: 80,
  padX: tok('--nds-space-32', 32),
  gap: tok('--nds-space-24', 24),
  targetGap: tok('--nds-space-48', 48),
  radius: tok('--nds-radius-3xl', 14),
  fontLabel: 24,
  fontBody: 32,
  fontNumeral: 96,
  icon: 48,
  focusW: 4,
  focusOffset: 3,
} as const satisfies Record<DensityTokenKey, Dim>

/** The wall-screen tier's name (D26). Not a `DensityName`: see "The display tier" above. */
export const DISPLAY_DENSITY = 'display' as const
export type DisplayDensityName = typeof DISPLAY_DENSITY

/** The tiers, smallest first. */
export const DENSITIES = ['standard', 'comfortable', 'floor'] as const satisfies readonly DensityName[]

/** Outside any tier: the console's sizes, as every existing page has them. */
export const DEFAULT_DENSITY: DensityName = 'standard'

/** True for `'standard' | 'comfortable' | 'floor'` — for a value read from a URL, a setting or storage. */
export function isDensityName(value: unknown): value is DensityName {
  return typeof value === 'string' && (DENSITIES as readonly string[]).includes(value)
}

/**
 * The attribute that switches an element's subtree to a tier, for an element a page renders itself — the root of a
 * screen that is all one tier, so a Modal or Popover (portalled into `<body>`) follows it too. Plain (no React), so a
 * server layout can call it: `<html {...densityAttrs('floor')}>`.
 */
export function densityAttrs(value: DensityName): { 'data-density': DensityName } {
  return { 'data-density': value }
}

const pxOf = (d: Dim): number => (typeof d === 'number' ? d : d.px)
const cssOf = (d: Dim): string => (typeof d === 'number' ? `${d}px` : `var(${d.token})`)

const keys = Object.keys(DENSITY_TOKENS) as DensityTokenKey[]

/** The attribute that switches a wall screen's root to the display tier (D26): `<main {...displayDensityAttrs()}>`. */
export function displayDensityAttrs(): { 'data-density': DisplayDensityName } {
  return { 'data-density': DISPLAY_DENSITY }
}

/** Each tier's numbers in px — for TypeScript consumers that must hand over a number (an icon's `size`). */
export const densityTokens = Object.fromEntries(
  DENSITIES.map((d) => [d, Object.fromEntries(keys.map((k) => [k, pxOf(SCALE[d][k])]))]),
) as { readonly [D in DensityName]: { readonly [K in DensityTokenKey]: number } }

/** The token each value is written as in the CSS (`var(--nds-…)`), or its px literal. Read by the test and the catalog. */
export const densityCss = Object.fromEntries(
  DENSITIES.map((d) => [d, Object.fromEntries(keys.map((k) => [k, cssOf(SCALE[d][k])]))]),
) as { readonly [D in DensityName]: { readonly [K in DensityTokenKey]: string } }

/** The display tier's numbers in px (D26). */
export const displayDensityTokens = Object.fromEntries(keys.map((k) => [k, pxOf(DISPLAY_SCALE[k])])) as { readonly [K in DensityTokenKey]: number }

/** The display tier's values as written in the CSS (D26). */
export const displayDensityCss = Object.fromEntries(keys.map((k) => [k, cssOf(DISPLAY_SCALE[k])])) as { readonly [K in DensityTokenKey]: string }

const SECTION: { readonly [D in DensityName]: string } = {
  standard: 'Density: standard, the default (tokens/density.ts)',
  comfortable: 'Density: comfortable (portal and link pages)',
  floor: 'Density: floor (tablets on the factory floor)',
}

const varsOf = (d: DensityName): DensityCssVar[] =>
  keys.map((k, i) => ({ ...(i === 0 ? { section: SECTION[d] } : {}), name: DENSITY_TOKENS[k].css, value: densityCss[d][k] }))

/** The selector that switches a subtree to a tier. */
export const densitySelector = (d: DensityName): string => `[data-density='${d}']`

/**
 * One block per tier, emitted after `.dark` by `tools/generate-tokens-css.ts`. The standard block is also `:root`, so a
 * consumer outside any tier reads today's sizes, and a subtree inside a comfortable or floor screen can step back to them
 * with `data-density="standard"`. Blocks of their own: the existing `:root` block is not touched. The display tier's
 * block (D26) comes last, after the floor block, so the three earlier blocks stay byte-identical.
 */
export const densityBlocks: ReadonlyArray<{ selector: string; vars: ReadonlyArray<DensityCssVar> }> = [
  ...DENSITIES.map((d) => ({
    selector: d === 'standard' ? `:root, ${densitySelector(d)}` : densitySelector(d),
    vars: varsOf(d),
  })),
  {
    selector: `[data-density='${DISPLAY_DENSITY}']`,
    vars: keys.map((k, i) => ({
      ...(i === 0 ? { section: 'Density: display (wall screens, the line TV; D26)' } : {}),
      name: DENSITY_TOKENS[k].css,
      value: displayDensityCss[k],
    })),
  },
]
