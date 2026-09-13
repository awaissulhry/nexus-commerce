/**
 * GDS — the two non-scalar cells (AM.1 §A.3 rows 3–4). One renderer per shape, used by master's
 * `withMark` and the channel's `CascadeCell` alike, so a list or a measure reads the same on every scope.
 *
 * list    → chips for the first values + "+N" (§A.3: "count + first values, full list in the tooltip";
 *           the tooltip line is `shapeTooltipLine`, composed by the column's getter)
 * measure → `1.2 kg` (the symbol; the unit's word stays in the tooltip)
 *
 * 🔴 The list chip's class is `nds-cell-listchip`, NEVER `nds-cell-chip` (Owner, 2026-09-05: every
 * value read "N." where "Non applicabile" should). `.nds-cell-chip` is the identity/targeting BADGE
 * in grid.css — a fixed 20×20 box — and sharing its name meant sharing its size. Guarded by
 * `listChipAndItalicClip.vitest.test.ts`.
 */
import { TokenChip } from '../../primitives'

import { asMeasure, formatMeasure, listLabelOf, listSummary, unitSymbol, type CellShape } from './shapeFormat'

export function ListChipValue({ value, shown = 2, labelOf }: { value: unknown; shown?: number; labelOf?: (item: string) => string }) {
  const s = listSummary(value, shown)
  if (s.total === 0) return null
  return (
    <span className="nds-cell-list" aria-label={`${s.total} ${s.total === 1 ? 'value' : 'values'}`}>
      {s.shown.map((item, i) => (
        <TokenChip key={`${i}:${item}`} className="nds-cell-listchip">
          {labelOf ? labelOf(item) : item}
        </TokenChip>
      ))}
      {s.more > 0 && <span className="nds-cell-list-more">+{s.more}</span>}
    </span>
  )
}

export function MeasureCellValue({ value }: { value: unknown }) {
  const m = asMeasure(value)
  if (m.value === null && m.unit === null) return null
  return (
    <span className="nds-cell-measure">
      <span className="v">{m.value === null ? '—' : formatMeasure({ value: m.value, unit: null })}</span>
      {m.unit && (
        <span className="u" aria-label={m.unit}>
          {unitSymbol(m.unit)}
        </span>
      )}
    </span>
  )
}

/** The dispatcher both renderers call; a scalar falls through to its string. */
export function ShapeValue({ shape, value, optionLabels }: { shape: CellShape | undefined; value: unknown; optionLabels?: Record<string, string> }) {
  if (shape === 'list') return <ListChipValue value={value} labelOf={listLabelOf({ optionLabels })} />
  if (shape === 'measure') return <MeasureCellValue value={value} />
  return <>{value == null ? '' : String(value)}</>
}
