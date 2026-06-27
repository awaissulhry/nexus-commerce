/**
 * The authoritative ORDERED list of CSS custom properties emitted to
 * styles/tokens.css. This is the single source of truth for tokens.css —
 * `tools/generate-tokens-css.mts` reads this and writes the stylesheet.
 *
 * Hex values come from ./colors (palette/pill/badge) so colour is defined ONCE.
 * Tier-2 roles are `var(--…)` reference strings (no hex to duplicate). Radius /
 * shadow / structural / type / the dark block are literals here (their only home).
 */
import { palette, pill, badge } from './colors'

export interface CssVar {
  /** when set, a section-comment is emitted before this row */
  section?: string
  name: string
  value: string
}

export const cssVars: ReadonlyArray<CssVar> = [
  // ── Tier 1: primitive ramps ──────────────────────────────────────
  { section: 'Tier 1: primitive ramps', name: '--h10-white', value: palette.white },

  { name: '--h10-blue-50', value: palette.blue[50] },
  { name: '--h10-blue-100', value: palette.blue[100] },
  { name: '--h10-blue-200', value: palette.blue[200] },
  { name: '--h10-blue-600', value: palette.blue[600] },
  { name: '--h10-blue-700', value: palette.blue[700] },
  { name: '--h10-blue-800', value: palette.blue[800] },
  { name: '--h10-blue-900', value: palette.blue[900] },

  { name: '--h10-grey-25', value: palette.grey[25] },
  { name: '--h10-grey-50', value: palette.grey[50] },
  { name: '--h10-grey-75', value: palette.grey[75] },
  { name: '--h10-grey-100', value: palette.grey[100] },
  { name: '--h10-grey-150', value: palette.grey[150] },
  { name: '--h10-grey-200', value: palette.grey[200] },
  { name: '--h10-grey-300', value: palette.grey[300] },
  { name: '--h10-grey-400', value: palette.grey[400] },
  { name: '--h10-grey-450', value: palette.grey[450] },
  { name: '--h10-grey-500', value: palette.grey[500] },
  { name: '--h10-grey-600', value: palette.grey[600] },
  { name: '--h10-grey-700', value: palette.grey[700] },
  { name: '--h10-grey-800', value: palette.grey[800] },
  { name: '--h10-grey-900', value: palette.grey[900] },

  { name: '--h10-rail-surface', value: palette.railBg },
  { name: '--h10-rail-line', value: palette.railBorder },

  { name: '--h10-green-soft', value: palette.green.soft },
  { name: '--h10-green-500', value: palette.green[500] },
  { name: '--h10-green-600', value: palette.green[600] },
  { name: '--h10-green-700', value: palette.green[700] },
  { name: '--h10-red-soft', value: palette.red.soft },
  { name: '--h10-red-500', value: palette.red[500] },
  { name: '--h10-red-600', value: palette.red[600] },
  { name: '--h10-red-700', value: palette.red[700] },
  { name: '--h10-amber-soft', value: palette.amber.soft },
  { name: '--h10-amber-600', value: palette.amber[600] },
  { name: '--h10-amber-700', value: palette.amber[700] },
  { name: '--h10-amber-text', value: palette.amber.text },
  { name: '--h10-purple-bg', value: palette.purple.bg },
  { name: '--h10-purple-600', value: palette.purple[600] },
  { name: '--h10-purple-700', value: palette.purple[700] },
  { name: '--h10-cyan-bg', value: palette.cyan.bg },
  { name: '--h10-cyan-700', value: palette.cyan[700] },
  { name: '--h10-amazon', value: palette.amazon },

  { name: '--h10-shadow-rgb', value: '20 28 38' },
  { name: '--h10-focus-rgb', value: '31 111 222' },

  // ── Tier 2: semantic roles (components consume these) ─────────────
  { section: 'Tier 2: semantic roles', name: '--h10-text', value: 'var(--h10-grey-900)' },
  { name: '--h10-text-2', value: 'var(--h10-grey-600)' },
  { name: '--h10-text-3', value: 'var(--h10-grey-500)' },
  { name: '--h10-text-strong', value: 'var(--h10-grey-700)' },
  { name: '--h10-text-disabled', value: 'var(--h10-grey-400)' },
  { name: '--h10-text-inverse', value: 'var(--h10-white)' },
  { name: '--h10-text-link', value: 'var(--h10-blue-600)' },

  { name: '--h10-bg', value: 'var(--h10-grey-50)' },
  { name: '--h10-surface', value: 'var(--h10-white)' },
  { name: '--h10-surface-raised', value: 'var(--h10-grey-25)' },
  { name: '--h10-surface-sunken', value: 'var(--h10-grey-100)' },
  { name: '--h10-surface-hover', value: 'var(--h10-grey-75)' },
  { name: '--h10-wash-primary', value: 'var(--h10-blue-50)' },
  { name: '--h10-rail-bg', value: 'var(--h10-rail-surface)' },

  { name: '--h10-border', value: 'var(--h10-grey-200)' },
  { name: '--h10-border-subtle', value: 'var(--h10-grey-150)' },
  { name: '--h10-border-strong', value: 'var(--h10-grey-300)' },
  { name: '--h10-rail-border', value: 'var(--h10-rail-line)' },

  { name: '--h10-primary', value: 'var(--h10-blue-600)' },
  { name: '--h10-primary-hover', value: 'var(--h10-blue-700)' },
  { name: '--h10-primary-dark', value: 'var(--h10-blue-800)' },
  { name: '--h10-primary-soft', value: 'var(--h10-blue-100)' },
  { name: '--h10-primary-ghost-border', value: 'var(--h10-blue-200)' },

  { name: '--h10-success-soft', value: 'var(--h10-green-soft)' },
  { name: '--h10-success', value: 'var(--h10-green-600)' },
  { name: '--h10-success-strong', value: 'var(--h10-green-700)' },
  { name: '--h10-live', value: 'var(--h10-green-500)' },
  { name: '--h10-danger-soft', value: 'var(--h10-red-soft)' },
  { name: '--h10-danger', value: 'var(--h10-red-500)' },
  { name: '--h10-danger-strong', value: 'var(--h10-red-700)' },
  { name: '--h10-warning-soft', value: 'var(--h10-amber-soft)' },
  { name: '--h10-warning', value: 'var(--h10-amber-600)' },
  { name: '--h10-warning-strong', value: 'var(--h10-amber-700)' },
  { name: '--h10-info-soft', value: 'var(--h10-blue-100)' },
  { name: '--h10-info', value: 'var(--h10-blue-600)' },

  // status pills
  { section: 'status pills', name: '--h10-pill-ok-fg', value: 'var(--h10-blue-900)' },
  { name: '--h10-pill-ok-bg', value: pill.ok.bg },
  { name: '--h10-pill-warn-fg', value: 'var(--h10-amber-text)' },
  { name: '--h10-pill-warn-bg', value: 'var(--h10-amber-soft)' },
  { name: '--h10-pill-arch-fg', value: pill.arch.fg },
  { name: '--h10-pill-arch-bg', value: 'var(--h10-grey-100)' },
  { name: '--h10-pill-err-fg', value: 'var(--h10-danger-strong)' },
  { name: '--h10-pill-err-bg', value: 'var(--h10-danger-soft)' },

  // ── Tier 3: program / targeting chips ────────────────────────────
  { section: 'Tier 3: program / targeting chips', name: '--h10-badge-sp-fg', value: 'var(--h10-purple-700)' },
  { name: '--h10-badge-sp-bg', value: 'var(--h10-purple-bg)' },
  { name: '--h10-badge-sd-fg', value: 'var(--h10-cyan-700)' },
  { name: '--h10-badge-sd-bg', value: 'var(--h10-cyan-bg)' },
  { name: '--h10-badge-sb-fg', value: 'var(--h10-amber-700)' },
  { name: '--h10-badge-sb-bg', value: badge.sb.bg },
  { name: '--h10-targeting-auto', value: 'var(--h10-blue-800)' },
  { name: '--h10-targeting-manual', value: 'var(--h10-purple-600)' },

  // ImageUpload component tokens (bespoke washes — exact legacy values, were raw hex)
  { name: '--h10-imgup-surface', value: '#f7faff' },
  { name: '--h10-imgup-hover', value: '#f0f6ff' },
  { name: '--h10-imgup-drag', value: '#e9f2ff' },
  { name: '--h10-imgup-spin-track', value: '#cdd5df' },
  { name: '--h10-imgup-err', value: '#cc1100' },

  // ── Radius ───────────────────────────────────────────────────────
  { section: 'Radius', name: '--h10-radius-pill', value: '4px' },
  { name: '--h10-radius-sm', value: '6px' },
  { name: '--h10-radius-md', value: '7px' },
  { name: '--h10-radius-lg', value: '8px' },
  { name: '--h10-radius-xl', value: '10px' },
  { name: '--h10-radius-2xl', value: '12px' },
  { name: '--h10-radius-3xl', value: '14px' },
  { name: '--h10-radius-round', value: '999px' },

  // ── Elevation + focus ────────────────────────────────────────────
  { section: 'Elevation + focus', name: '--h10-shadow-card', value: '0 6px 22px rgb(var(--h10-shadow-rgb) / 0.16)' },
  { name: '--h10-shadow-menu', value: '0 12px 30px rgb(var(--h10-shadow-rgb) / 0.16)' },
  { name: '--h10-shadow-pop', value: '0 16px 40px rgb(var(--h10-shadow-rgb) / 0.2)' },
  { name: '--h10-shadow-modal', value: '0 18px 48px rgb(var(--h10-shadow-rgb) / 0.28)' },
  { name: '--h10-shadow-rail', value: '8px 0 30px rgb(var(--h10-shadow-rgb) / 0.13)' },
  { name: '--h10-shadow-tip', value: '0 10px 26px rgb(var(--h10-shadow-rgb) / 0.3)' },
  { name: '--h10-focus-ring', value: '0 0 0 2px rgb(var(--h10-focus-rgb) / 0.12)' },

  // ── Structural dimensions ────────────────────────────────────────
  { section: 'Structural dimensions', name: '--h10-rail-collapsed', value: '66px' },
  { name: '--h10-rail-expanded', value: '344px' },
  { name: '--h10-row-nav', value: '46px' },
  { name: '--h10-icon-zone', value: '50px' },

  // ── Type ─────────────────────────────────────────────────────────
  { section: 'Type', name: '--h10-font-sans', value: "var(--font-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  { name: '--h10-font-smoothing', value: 'auto' },

  // ── Platform-semantic aliases (components consume THESE; bridge to globals.css) ──
  { section: 'Platform-semantic aliases', name: '--text-primary', value: 'var(--h10-text)' },
  { name: '--text-secondary', value: 'var(--h10-text-2)' },
  { name: '--text-tertiary', value: 'var(--h10-text-3)' },
  { name: '--text-disabled', value: 'var(--h10-text-disabled)' },
  { name: '--text-link', value: 'var(--h10-text-link)' },
  { name: '--surface-canvas', value: 'var(--h10-bg)' },
  { name: '--surface-card', value: 'var(--h10-surface)' },
  { name: '--surface-sunken', value: 'var(--h10-surface-sunken)' },
  { name: '--border-default', value: 'var(--h10-border)' },
  { name: '--border-subtle', value: 'var(--h10-border-subtle)' },
  { name: '--border-strong', value: 'var(--h10-border-strong)' },
  { name: '--color-primary', value: 'var(--h10-primary)' },
  { name: '--color-primary-soft', value: 'var(--h10-primary-soft)' },
  { name: '--status-success-soft', value: 'var(--h10-success-soft)' },
  { name: '--status-success-line', value: 'var(--h10-success)' },
  { name: '--status-success-strong', value: 'var(--h10-success-strong)' },
  { name: '--status-warning-soft', value: 'var(--h10-warning-soft)' },
  { name: '--status-warning-line', value: 'var(--h10-warning)' },
  { name: '--status-warning-strong', value: 'var(--h10-warning-strong)' },
  { name: '--status-danger-soft', value: 'var(--h10-danger-soft)' },
  { name: '--status-danger-line', value: 'var(--h10-danger)' },
  { name: '--status-danger-strong', value: 'var(--h10-danger-strong)' },
  { name: '--status-info-soft', value: 'var(--h10-info-soft)' },
  { name: '--status-info-line', value: 'var(--h10-info)' },
  { name: '--status-info-strong', value: 'var(--h10-blue-700)' },
]

/** Dark-mode overrides (the `.dark` block). Provisional inversions; their only home. */
export const cssVarsDark: ReadonlyArray<CssVar> = [
  { name: '--h10-text', value: '#e7ebf1' },
  { name: '--h10-text-2', value: '#aab6c2' },
  { name: '--h10-text-3', value: '#8a94a6' },
  { name: '--h10-text-disabled', value: '#5b6b7b' },
  { name: '--h10-text-inverse', value: '#14223a' },

  { name: '--h10-bg', value: '#14223a' },
  { name: '--h10-surface', value: '#18263b' },
  { name: '--h10-surface-raised', value: '#1f2c3d' },
  { name: '--h10-surface-sunken', value: '#1a2330' },
  { name: '--h10-rail-bg', value: '#18263b' },

  { name: '--h10-border', value: '#2f3a4a' },
  { name: '--h10-border-subtle', value: '#26323f' },
  { name: '--h10-border-strong', value: '#46505f' },
  { name: '--h10-rail-border', value: '#26323f' },
]
