/**
 * Typography tokens — H10 type system.
 *
 * H10 is dense: a 10–18px hot zone with hero sizes (22/27) reserved for page
 * titles + counters. The font is the app's Inter (`var(--font-sans)`), rendered
 * with the heavier default smoothing (NOT `antialiased`) — captured as
 * `fontSmoothing` so the migration preserves H10's deliberately bolder text.
 */

export const fontFamily = {
  sans: "var(--font-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
} as const

/** Deliberate: H10 sets `-webkit-font-smoothing: auto` to render text heavier
 *  than the app-wide `antialiased`. This is a design choice, not a bug. */
export const fontSmoothing = 'auto' as const

/** px sizes seen across the ads stylesheets, named by role. */
export const fontSize = {
  nano: '9px', //     grid micro-badges (.nds-wsgrid td.nm .badge/.pb) — hub #617
  micro: '10px', //   tiny labels, badges, group headers
  microPlus: '10.5px', // grid name-cell marks/tags + .nds-scopebar-label — hub #617
  xs: '11px', //      kbd, sub-labels
  xsPlus: '11.5px', // sub-text, modal hints
  sm: '12px', //      dense secondary
  smPlus: '12.5px', // secondary text, legends
  base: '13px', //    body, table cells, controls (the workhorse)
  basePlus: '13.5px', // subtitles
  mdMinus: '14px', //  .nds-btn.lg, .nds-nstep button, empty-state + accordion titles — hub #617
  md: '15px', //      nav items, modal titles
  lg: '18px', //      section headings (h3)
  xl: '22px', //      page stub h1
  '2xl': '27px', //   page header h1
} as const

export const fontWeight = {
  normal: 400, //     ordinary running text — the step below `medium`. The scale started at 500, so
  //                  any surface wrapping normal-weight content in a DS control had no way to say
  //                  "not emphasised" without a literal (hub #633).
  medium: 500, // body
  semibold: 600, // labels, controls
  bold: 700, // headings
  extrabold: 800, // page titles, brand, badges
} as const

export const letterSpacing = {
  tight: '-0.02em', // page titles, brand mark
  snug: '-0.01em', // section headings
  wide: '0.03em', // uppercase group labels
  wider: '0.04em', // uppercase eyebrows
} as const

export const lineHeight = {
  tight: 1.2,
  snug: 1.45, // tooltips
  normal: 1.5, // help text
} as const
