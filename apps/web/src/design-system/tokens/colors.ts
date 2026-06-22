/**
 * Color tokens — the canonical H10 palette.
 *
 * Three tiers (see ../docs/TOKENS.md):
 *   palette   → raw ramps (primitive). Not consumed directly by components.
 *   color     → semantic roles (text/surface/border/primary/status). Use THESE.
 *   badge     → component tokens for the program/targeting chips.
 *
 * Values are the curated canon distilled from the ~251 hex literals in the ads
 * stylesheets (most are near-duplicate drift — see ../studies/01-color-drift.md).
 * Frequencies in comments are occurrences across the four ads CSS files.
 *
 * Kept in sync with ../styles/tokens.css (same values as CSS vars). JS consumers
 * that need a real color (e.g. Recharts) import from here; CSS uses var(--h10-*).
 * TODO(Phase 7): generate tokens.css from this file to remove the hand-sync.
 */

// ── Tier 1: primitive ramps ─────────────────────────────────────────

export const palette = {
  white: '#ffffff', // 337×

  /** Brand blue. 600 is THE primary (383×). */
  blue: {
    50: '#eef5ff', // 28× selected/hover wash
    100: '#e7f0fd', // 11× soft fill
    200: '#cfe0fb', //  4× ghost-button border
    600: '#1f6fde', // 383× primary
    700: '#1a60c4', // 15× primary hover
    800: '#134da3', //  6× dark / auto-targeting
    900: '#0a4ba8', //  2× status-pill "ok" text
  },

  /** Cool slate neutral ramp — text, surfaces, borders. */
  grey: {
    25: '#f7f9fb', // 48× raised/hover surface, table header
    50: '#f4f6f9', // 22× app canvas
    75: '#f1f4f8', // 73× hover surface
    100: '#eef1f5', // 88× sunken / neutral pill
    150: '#e6e9ee', // 115× subtle border
    200: '#d8dde4', // 96× default border
    300: '#c2c9d3', // 48× strong border / disabled text
    400: '#aeb6c2', // 45× placeholder / disabled
    450: '#98a2b3', // 44× muted glyph
    500: '#8a93a1', // 207× tertiary text / icons
    600: '#5b6573', // 178× secondary text
    700: '#3a4452', // 71× control text
    800: '#2b3440', // 57× menu/option text
    900: '#1c2530', // 324× primary text
  },

  /** Rail surface is a hair cooler than canvas (measured off H10). */
  railBg: '#f1f3f5', // 20×
  railBorder: '#e3e7ec', // 26×

  green: {
    soft: '#dcfce7',
    500: '#1e9e62', // live dot
    600: '#15a34a', // 13× success action
    700: '#15803d', // execution-history success
  },
  red: {
    soft: '#fde8e8',
    500: '#e5484d', // 15× danger / nav badge
    600: '#d4493f', // 12× danger hover
    700: '#c0392b', // execution-history fail
  },
  amber: {
    soft: '#fdf3d3', // status-pill "warn" bg
    600: '#b87503',
    700: '#c2410c',
    text: '#9a6700', // status-pill "warn" text
  },
  /** Manual targeting + Sponsored-Products chip. */
  purple: { bg: '#f3e8ff', 600: '#7400bc', 700: '#6d28d9' },
  /** Sponsored Display chip. */
  cyan: { bg: '#e0f2fe', 700: '#0e7490' },

  /** Amazon brand mark. */
  amazon: '#232f3e', // 8×
} as const

// ── Tier 2: semantic roles (consume these) ──────────────────────────

export const color = {
  // text
  text: palette.grey[900],
  text2: palette.grey[600],
  text3: palette.grey[500],
  textDisabled: palette.grey[400],
  textInverse: palette.white,
  textLink: palette.blue[600],

  // surface
  bg: palette.grey[50],
  surface: palette.white,
  surfaceRaised: palette.grey[25],
  surfaceSunken: palette.grey[100],
  washPrimary: palette.blue[50],
  railBg: palette.railBg,

  // border
  border: palette.grey[200],
  borderSubtle: palette.grey[150],
  borderStrong: palette.grey[300],
  railBorder: palette.railBorder,

  // primary
  primary: palette.blue[600],
  primaryHover: palette.blue[700],
  primaryDark: palette.blue[800],
  primarySoft: palette.blue[100],
  primaryGhostBorder: palette.blue[200],

  // status (soft surface / solid / strong text)
  successSoft: palette.green.soft,
  success: palette.green[600],
  successStrong: palette.green[700],
  live: palette.green[500],
  dangerSoft: palette.red.soft,
  danger: palette.red[500],
  dangerStrong: palette.red[700],
  warningSoft: palette.amber.soft,
  warning: palette.amber[600],
  warningStrong: palette.amber[700],
  infoSoft: palette.blue[100],
  info: palette.blue[600],

  amazon: palette.amazon,
} as const

/** Status-pill triples (text / bg), as used by .h10-pill. */
export const pill = {
  ok: { fg: palette.blue[900], bg: '#d2e6fc' },
  warn: { fg: palette.amber.text, bg: palette.amber.soft },
  arch: { fg: '#6b7480', bg: palette.grey[100] },
} as const

// ── Tier 3: component tokens — program / targeting chips ─────────────

export const badge = {
  sp: { fg: palette.purple[700], bg: palette.purple.bg }, // Sponsored Products
  sd: { fg: palette.cyan[700], bg: palette.cyan.bg }, //     Sponsored Display
  sb: { fg: palette.amber[700], bg: '#fef3c7' }, //          Sponsored Brands
  targetingAuto: palette.blue[800], //                       "A"
  targetingManual: palette.purple[600], //                   "M"
} as const

export type SemanticColor = keyof typeof color
