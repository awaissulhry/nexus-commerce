/**
 * AGD — the DS DataGrid look, as a theme VARIANT of the engine's.
 *
 * The engine theme (`theme/theme.ts`) WAS measured from `.nds-grid` (GDS §3): ground `--nds-surface`,
 * header `--nds-surface-raised` / `--nds-text-strong` 11.5px 700, cell `--nds-text` 13px 500, row rule
 * `--nds-border-subtle`, header rule and frame `--nds-border`, hover raised, selected
 * `--nds-wash-primary`, totals raised 700, accent `--nds-primary`, radius `--nds-radius-2xl` — every one
 * the token the legacy `.nds-grid` rules bind. So the colours and fonts are the engine's, untouched.
 *
 * What differs is four CHROME params the legacy never drew:
 *   - `pinnedColumnBorder`: Quartz rules a line beside a pinned column; the legacy `td.sticky` has none,
 *     and `td.sticky-right` carries its own inset hairline (restated per cell in datagrid.css).
 *   - `pinnedRowBorder`: Quartz rules the pinned (totals) row with the row-rule token; the legacy
 *     `tr.totals td { border-top: 1px solid var(--nds-border) }` is the CELL's, one tier stronger.
 *   - `wrapperBorder` / `wrapperBorderRadius`: the frame is `.nds-grid-wrap`'s (components.css:1393),
 *     which the wrapper keeps; AG's root drawing one too measured as a double border on /products/next.
 */
import { workspaceGridTheme } from '../theme/theme'

export const dataGridTheme = workspaceGridTheme.withParams({
  pinnedColumnBorder: false,
  pinnedRowBorder: false,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
})
