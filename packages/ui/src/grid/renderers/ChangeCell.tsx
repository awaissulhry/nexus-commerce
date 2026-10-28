'use client'

/**
 * GDS — before → after (gap G1, the approvals grid, 2026-10-05).
 *
 *   <ChangeValue changes={[{ label: 'Price', from: '€49.90', to: '€44.90' }]} more={2} />        a drawer, a list
 *   { colId: 'change', headerName: 'Change', ...changeColumn<Row>('change') }                     a grid column
 *
 * The old value is muted, an arrow, the new value is emphasised. `from: null` draws "→ €44.90" (a new value),
 * `to: null` draws "€49.90 → removed". The drawn part is `aria-hidden`; a screen reader hears ONE sentence per line
 * from `changeValue.ts` ("Price: from €49.90 to €44.90"), never "Price €49.90 €44.90" read off the glyphs.
 *
 * `compact` is the grid row: one line, the first change only, then "+N more"; it ellipsizes inside the column and
 * never widens it. The full list is the column's tooltip (`changeColumn` sets `tooltipValueGetter`): a renderer
 * never claims `title` (`cellTooltip.ts`). Styles: `.nds-change*` in `styles/components.css` — global, because the
 * plain component is used outside grids.
 */
import { memo } from 'react'
import { ArrowRight } from 'lucide-react'
import type { ICellRendererParams } from 'ag-grid-community'

import { EmptyValue } from './cells'
import { asChangeValueData, changeAccessibleText, changeKind, changeMoreCount, type ChangeLine, type ChangeValueData } from './changeValue'

export interface ChangeValueProps extends ChangeValueData {
  /** One line (the first change, then "+N more") — for a grid row. Default false: every line, wrapping. */
  compact?: boolean
  /** Leave out the "Price:" labels when a neighbouring column already names the change. Screen readers still hear them. */
  hideLabels?: boolean
  className?: string
}

const Arrow = () => <ArrowRight size={12} strokeWidth={2.25} className="nds-change-arrow" aria-hidden />

function Line({ line, hideLabel }: { line: ChangeLine; hideLabel?: boolean }) {
  const kind = changeKind(line)
  return (
    <span className={`nds-change-line nds-change-${kind}`}>
      {!hideLabel && line.label.trim() && <span className="nds-change-label">{line.label}:</span>}
      {kind === 'changed' && <><span className="nds-change-from">{line.from}</span><Arrow /><span className="nds-change-to">{line.to}</span></>}
      {kind === 'added' && <><Arrow /><span className="nds-change-to">{line.to}</span></>}
      {kind === 'removed' && <><span className="nds-change-from">{line.from}</span><Arrow /><span className="nds-change-gone">removed</span></>}
      {kind === 'unchanged' && <><span className="nds-change-to">{line.to}</span> <span className="nds-change-gone">unchanged</span></>}
      {kind === 'empty' && <span className="nds-change-gone">no value</span>}
    </span>
  )
}

/** Before → after, for any surface. Renders nothing when there is nothing to show — the host decides what an absent change reads as. */
export const ChangeValue = memo(function ChangeValue({ changes, more, compact = false, hideLabels, className }: ChangeValueProps) {
  const data: ChangeValueData = { changes, more }
  const extra = changeMoreCount(data, compact)
  if (changes.length === 0 && extra === 0) return null
  const shown = compact ? changes.slice(0, 1) : changes
  return (
    <span className={`nds-change${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}>
      <span className="nds-change-lines" aria-hidden="true">
        {shown.map((line, i) => <Line key={`${i}:${line.label}`} line={line} hideLabel={hideLabels} />)}
        {extra > 0 && <span className="nds-change-more">{shown.length === 0 ? `${extra} change${extra === 1 ? '' : 's'}` : `+${extra} more`}</span>}
      </span>
      <span className="nds-vh">{changeAccessibleText(data)}</span>
    </span>
  )
})

export interface ChangeCellParams {
  /** Default TRUE in a grid (one line per row). Pass false for an `autoHeight` column that lists every change. */
  compact?: boolean
  hideLabels?: boolean
}

/**
 * The grid adapter. The cell VALUE is `ChangeLine[]` or `{ changes, more }` (a `valueGetter` builds it from the
 * row); anything else, or no change at all, is the grid's dash.
 */
export const ChangeCell = memo(function ChangeCell(p: ICellRendererParams & ChangeCellParams) {
  const data = asChangeValueData(p.value)
  if (!data || (data.changes.length === 0 && !data.more)) return <EmptyValue />
  return <ChangeValue changes={data.changes} more={data.more} compact={p.compact ?? true} hideLabels={p.hideLabels} />
})
