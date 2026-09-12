/**
 * AGW — the ads console's grid, as a theme VARIANT of the engine's.
 *
 * `workspaceGridTheme` (theme/theme.ts) is the DS grid: semantic tokens, dark-aware, the look of
 * /products/next. The ads console is a different, older look — Helium 10's Ad Manager, transcribed
 * into `workspace-grid.css` over four months — and the Owner's instruction for this programme is
 * that it stays that look. The component roles in `tokens/workspace.ts` bind the
 * established advertising palette; neither this theme nor its stylesheet reads primitive ramps.
 * Everything the variant does NOT state — the header partitions, popup
 * shadow, radii — is the engine's, which is what "headers excepted" means.
 *
 * `checkboxCheckedShapeImage` is the legacy tick, byte for byte (`workspace-grid.css` CBN.2h.9):
 * the balance rule there — a centred SVG glyph, never a hand-placed rotated border — is what AG's
 * Theming API does natively, so the shape is handed to it as an image.
 */
import { workspaceGridTheme } from '../theme/theme'

const TICK = "<svg xmlns='http://www.w3.org/2000/svg' width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'><path d='M5 12.5l4.5 4.5L19 7'/></svg>"
const DASH = "<svg xmlns='http://www.w3.org/2000/svg' width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.2' stroke-linecap='round'><path d='M6 12h12'/></svg>"

export const adsWorkspaceTheme = workspaceGridTheme.withParams({
  // --- type: `.nds-wsgrid table { font-size: base }` · `tbody td { color: grey-800; weight 500 }` ---
  fontSize: 'var(--nds-font-size-base)',
  foregroundColor: 'var(--nds-wsgrid-text)',
  cellFontWeight: 500,
  // --- header: `thead th { background: grey-25; color: wsgrid-head-fg; 11.5px/700; border-bottom: grey-200 }` ---
  headerBackgroundColor: 'var(--nds-wsgrid-surface-raised)',
  headerTextColor: 'var(--nds-wsgrid-head-fg)',
  headerFontSize: 'var(--nds-font-size-xs-plus)',
  headerFontWeight: 700,
  headerRowBorder: { style: 'solid', width: 1, color: 'var(--nds-wsgrid-frame-border)' },
  // --- ground and rules: `.nds-wsgrid { background: white }` · `tbody td { border-bottom: grey-150 }` ---
  backgroundColor: 'var(--nds-wsgrid-surface)',
  chromeBackgroundColor: 'var(--nds-wsgrid-surface)',
  borderColor: 'var(--nds-wsgrid-border)',
  // --- rows: `tr:hover { imgup-surface }` · `tr.on { blue-50 }` · `tr.h10-am-total td { grey-25; 700 }` ---
  rowHoverColor: 'var(--nds-imgup-surface)',
  selectedRowBackgroundColor: 'var(--nds-wsgrid-selection-bg)',
  pinnedRowBackgroundColor: 'var(--nds-wsgrid-surface-raised)',
  pinnedRowFontWeight: 700,
  // --- the frozen column's rule: `td.nm.fz { border-right: wsgrid-rule }` (the shadow is in workspace.css) ---
  pinnedColumnBorder: { style: 'solid', width: 1, color: 'var(--nds-wsgrid-rule)' },
  // --- the card draws the frame (`.nds-wsgrid { border: grey-200; radius 12 }`); AG's root draws none ---
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  // --- spacing: `td { padding: 12px 14px }` — the vertical 12 is the row height's, set by NexusGrid ---
  cellHorizontalPadding: 14,
  // --- controls: the 20px rounded checkbox (CBN.2h.9/2h.10), `accent-color: blue-600` ---
  accentColor: 'var(--nds-wsgrid-accent)',
  checkboxBorderRadius: 5,
  checkboxBorderWidth: 1.5,
  checkboxUncheckedBackgroundColor: 'var(--nds-wsgrid-surface)',
  checkboxUncheckedBorderColor: 'var(--nds-wsgrid-control-border)',
  checkboxCheckedBackgroundColor: 'var(--nds-wsgrid-accent)',
  checkboxCheckedBorderColor: 'var(--nds-wsgrid-accent)',
  checkboxCheckedShapeColor: 'var(--nds-wsgrid-on-accent)',
  checkboxCheckedShapeImage: { svg: TICK },
  checkboxIndeterminateBackgroundColor: 'var(--nds-wsgrid-accent)',
  checkboxIndeterminateBorderColor: 'var(--nds-wsgrid-accent)',
  checkboxIndeterminateShapeColor: 'var(--nds-wsgrid-on-accent)',
  checkboxIndeterminateShapeImage: { svg: DASH },
})
