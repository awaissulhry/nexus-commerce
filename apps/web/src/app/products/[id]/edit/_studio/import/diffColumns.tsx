'use client'

/**
 * IO.1 — the diff as a `NexusGrid`, drawn with the SHEET's own cell vocabulary.
 *
 * 🔴 The requirement (#492, D15.4) is not "a grid that shows a diff". It is that **a refused cell
 * reads refused and a would-pin cell reads pinned** — the same red, the same ✎, the same tooltip an
 * operator already knows from the sheet. So nothing here invents a treatment:
 *
 *   `nds-cell-is-refused`   is the class `roundTripClassRules` puts on a rejected save
 *                           (`grid.css:474`, tokens `--nds-grid-refused-bg/-ring`)
 *   `nds-cell-is-pinned`    is the class `provenanceClassRules` puts on a pinned cell
 *   `ProvenanceMark`        is the sheet's own ✎ glyph, not a lookalike
 *   `EmptyValue`            is the sheet's own em-dash for a blank
 *
 * A second vocabulary for one idea is the inconsistency the design rules exist to prevent, and here
 * it would be worse than inconsistent: an operator who has learned that red means "the server said
 * no" must not meet a different red that means "the server will say no".
 *
 * The one thing this file adds is the CSS-module class `.cellChanged`, because the sheet HAS no
 * state for "about to change" — nothing in the sheet is ever in that condition. It is scoped to
 * this module (not a global `nds-` class) precisely so it cannot leak into the sheet's vocabulary,
 * and it is deliberately the quietest of the three: a change is the expected case, and 412 shouting
 * cells would bury the 7 refusals that actually need a decision.
 */
import { memo } from 'react'

import { EmptyValue, ProvenanceMark, type ColDef, type ICellRendererParams, type ValueGetterParams } from '@/design-system/grid'

import { readCellVerdict, type ImportDiffColumn, type ImportDiffRow } from './contract'
import { cellDestination, diffCellTooltip, labelCell, rowUnmatchedReason } from './diffModel'

import styles from './import.module.css'

/** What one grid row holds. The diff row itself, plus the two things the grid needs precomputed. */
export interface DiffGridRow {
  row: ImportDiffRow
  /** `${aliasKey || 'primary'}:${productId}`, or null when the alias could not be resolved. */
  rowId: string | null
  /** Non-null when this row cannot be applied — rendered as the reason, never as a missing line. */
  unmatched: string | null
}

export function toGridRows(rows: readonly ImportDiffRow[], compose: (r: ImportDiffRow) => string | null): DiffGridRow[] {
  return rows.map((row) => ({ row, rowId: compose(row), unmatched: rowUnmatchedReason(row) }))
}

/**
 * The identity cell: SKU, the file line it came from, and — when the row cannot be applied — why.
 *
 * The unmatched reason lives ON the row rather than in a footnote, because a row an operator scrolls
 * past is a row they will assume is being written. `reference_disabled_control_cannot_explain` is
 * the same rule for controls; a row that will be skipped has to say so where it is.
 */
const IdentityCell = memo(function IdentityCell(p: ICellRendererParams<DiffGridRow>) {
  const data = p.data
  if (!data) return null
  return (
    <span className={styles.identity}>
      <span className={styles.identitySku}>{data.row.sku}</span>
      {data.row.line != null && <span className={styles.identityLine}>line {data.row.line}</span>}
      {data.unmatched && (
        <span className={styles.identityUnmatched} title={data.unmatched}>
          not applied
        </span>
      )}
    </span>
  )
})

/**
 * One diff cell: `before → after`, or the plain value when nothing changes.
 *
 * 🔴 Both ends are labelled through the sheet's `optionLabel` (in `labelCell`) — never one end.
 * Rendering `PK → Italy` would describe a change from a code to a name, which is not the change
 * being made, and it is the shape a half-applied labeller produces.
 *
 * 🔴 An empty end renders as the sheet's `EmptyValue`, not as nothing. Under `blankCells: 'clear'`
 * the `after` end being empty IS the operation — a value about to be destroyed — and drawing it as
 * whitespace makes the most destructive cell in the file the least visible one.
 */
const DiffCell = memo(function DiffCell(p: ICellRendererParams<DiffGridRow> & { colKey: string; column?: ImportDiffColumn }) {
  const cell = p.data?.row.cells?.[p.colKey]
  /*
   * 🔴 NOT `<EmptyValue title="…" />`. The DS type refused that, and the refusal was right.
   *
   * `EmptyValueProps` is a union: a `title` may only ride a `measuredZero: true`, because that
   * component's whole job is to distinguish a value MEASURED as zero from one nobody measured
   * (#313). A column the file did not carry for this row is neither — it is the third state, and
   * borrowing the measured-zero slot to explain it would make the diff assert a measurement it
   * never took. So this renders its own marker with its own sentence.
   */
  if (!cell) {
    return (
      <span className={styles.absentCell} title="This column was not in the file for this row, so nothing here changes.">
        not in file
      </span>
    )
  }

  const verdict = readCellVerdict(cell)
  const { before, after } = labelCell(cell, p.column)

  if (verdict === 'unchanged') {
    return before === '' ? <EmptyValue /> : <span className="nds-cell-value-text">{before}</span>
  }

  /*
   * No `title` here: the COLUMN's `tooltipValueGetter` owns the sentence now (#562), and a native
   * title beside AG's tooltip renders both — two panels describing one cell, one of them styled by
   * the browser. One source, `diffCellTooltip`, shared by both surfaces.
   */
  return (
    <span className={styles.diffCell}>
      <span className={styles.diffBefore}>{before === '' ? <EmptyValue /> : before}</span>
      <span className={styles.diffArrow} aria-hidden>→</span>
      <span className={styles.diffAfter}>{after === '' ? <EmptyValue /> : after}</span>
      {/* The sheet's own ✎, so a pin in the diff and a pin in the sheet are visibly the same fact. */}
      {verdict === 'changed' && cell.pins && <ProvenanceMark provenance="pinned" from="the layer above" />}
    </span>
  )
})

/**
 * The value AG sorts, filters and exports on.
 *
 * The `after` label for a change, the current value for an unchanged cell — i.e. what the sheet
 * would hold once this diff is applied. Sorting a diff by "what it will become" is the only
 * ordering that means anything; sorting by the rendered `a → b` string sorts by the old value with
 * extra steps.
 */
function diffValue(p: ValueGetterParams<DiffGridRow>, colKey: string, column?: ImportDiffColumn): string {
  const cell = p.data?.row.cells?.[colKey]
  if (!cell) return ''
  const { before, after } = labelCell(cell, column)
  return readCellVerdict(cell) === 'unchanged' ? before : after
}

/**
 * `cellClassRules` in the sheet's vocabulary.
 *
 * 🔴 An unmatched ROW greys every cell in it. Without that, a row whose alias could not be resolved
 * shows six confident-looking changes that are never going to be written — the diff would be
 * describing an apply that does not happen, which is the precise dishonesty D15.4 exists to stop.
 */
function diffCellClassRules(colKey: string) {
  const verdictOf = (p: { data?: DiffGridRow }): ReturnType<typeof readCellVerdict> | null => {
    const cell = p.data?.row.cells?.[colKey]
    return cell ? readCellVerdict(cell) : null
  }
  return {
    'nds-cell-is-refused': (p: { data?: DiffGridRow }) => verdictOf(p) === 'refused',
    'nds-cell-is-pinned': (p: { data?: DiffGridRow }) => {
      const cell = p.data?.row.cells?.[colKey]
      return !!cell && readCellVerdict(cell) === 'changed' && cell.pins
    },
    [styles.cellChanged]: (p: { data?: DiffGridRow }) => verdictOf(p) === 'changed',
    [styles.cellSkipped]: (p: { data?: DiffGridRow }) => !!p.data?.unmatched,
  }
}

export interface DiffColumnOptions {
  /** The keys to render, in the file's own order — `visibleColumnKeys` decides which. */
  keys: readonly string[]
  /** The columns contract (D15.14), for headers and `optionLabels`. */
  columns?: readonly ImportDiffColumn[]
  /** Fallback header when the contract does not describe a column the file carried. */
  headerFor?: (key: string) => string
}

/**
 * The diff grid's columns.
 *
 * The identity column is pinned left for the reason every sheet pins it: an operator scrolled three
 * columns right must still know which row they are reading. Everything else is the file's columns
 * in the file's order.
 */
export function buildDiffColumns(opts: DiffColumnOptions): ColDef<DiffGridRow>[] {
  const byKey = new Map((opts.columns ?? []).map((c) => [c.key, c]))

  const identity: ColDef<DiffGridRow> = {
    colId: 'identity',
    headerName: 'Row',
    pinned: 'left',
    width: 260,
    sortable: true,
    cellRenderer: IdentityCell,
    cellClass: 'nds-ag-cell',
    valueGetter: (p: ValueGetterParams<DiffGridRow>) => p.data?.row.sku ?? '',
  }

  const cells = opts.keys.map((key): ColDef<DiffGridRow> => {
    const column = byKey.get(key)
    return {
      colId: key,
      /*
       * The English label from the columns contract (D10), falling back to the key. A header that
       * silently reads `attr_material` where the sheet says "Material" would make the diff and the
       * sheet look like two different files.
       */
      /*
       * 🔴 A column that writes a LISTING says so in its own header (#577).
       *
       * The six prefixed fields appear on the MASTER sheet and route to the ChannelListing by name,
       * so "Title" and "Manufacturer" sit side by side in a master export while only one of them
       * can change what a buyer sees. The destination therefore rides the header, where it is read
       * before any cell in the column is.
       */
      headerName: (() => {
        const base = column?.label ?? opts.headerFor?.(key) ?? key
        // The COLUMN states where it writes (D15.16.4) — nothing here reads the field name.
        return cellDestination(column).target === 'channelListing' ? `${base} → listing` : base
      })(),
      width: 240,
      sortable: true,
      /*
       * 🔴 No `autoHeight`, and no `wrapText` with it (#562).
       *
       * `autoHeight` here was INERT: `RowAutoHeightModule` is not registered, and an unregistered
       * AG module fails silently — the column asked for a behaviour it never received and nothing
       * said so. Ruled out by design rather than registered: the diff is a review surface with
       * fixed-height rows like the sheet it mirrors. `wrapText` goes with it, because wrapped text
       * in a fixed-height row clips mid-line, which reads worse than a clean ellipsis.
       *
       * The full before/after therefore lives in the TOOLTIP, which is real now that
       * `TooltipModule` is registered (`modules.ts:49`, checked rather than assumed).
       */
      tooltipValueGetter: (prm: { data?: DiffGridRow }) => {
        const c = prm.data?.row.cells?.[key]
        return c ? diffCellTooltip(c, column) : 'This column was not in the file for this row.'
      },
      cellClass: 'nds-ag-cell',
      cellClassRules: diffCellClassRules(key),
      valueGetter: (p: ValueGetterParams<DiffGridRow>) => diffValue(p, key, column),
      cellRendererParams: { colKey: key, column },
      cellRenderer: DiffCell,
      headerTooltip: (() => {
        const dest = cellDestination(column)
        const where =
          dest.target === 'channelListing'
            ? `This column writes the channel listing, not the master record — the server routes it there whatever scope the file was exported from. If that listing is live, applying changes what buyers see.`
            : null
        const readOnly = column?.editable === false ? `${column.label} is read-only on this scope.` : null
        return [where, readOnly].filter(Boolean).join(' ') || undefined
      })(),
    }
  })

  return [identity, ...cells]
}

