'use client'

import { memo } from 'react'
import type { ICellRendererParams } from 'ag-grid-community'
import { Clock, Lock } from 'lucide-react'
import { Pill } from '../../primitives/Pill'
import { Skeleton } from '../../primitives/Skeleton'
import { sellingStatusModel, type SellingPillMeta, type SellingStatusValue } from './sellingStatus'

/**
 * A selling state as a pill — the ONLY way to draw one: a dot for a live state, a clock glyph for a value waiting for
 * Publish, so "waiting" never rests on a colour alone (WCAG 1.4.1). A new row's choice nobody set on it has no glyph:
 * the "new" mark beside it says what it is. Pill tones keep text at 7:1 in both themes.
 */
export function SellingStatePill({ pill }: { pill: SellingPillMeta }) {
  if (pill.glyph === 'clock') {
    return <Pill tone={pill.tone} className="nds-selling-pill" icon={<Clock size={11} strokeWidth={2.5} aria-hidden="true" />}>{pill.label}</Pill>
  }
  if (pill.glyph === 'none') return <Pill tone={pill.tone} className="nds-selling-pill">{pill.label}</Pill>
  return <Pill tone={pill.tone} className="nds-selling-pill" dot>{pill.label}</Pill>
}

/**
 * The sheet's **Status** cell (build shape v2, 2026-10-04): the live selling state, or the target waiting for Publish
 * with the live state beside it ("[clock Inactive] now Active"); on a new row, what Publish creates it as ("[Active] new"). `p.value` is a `SellingStatusValue`; `undefined` = not
 * read yet (skeleton). The column owns the editor (`SelectPanelEditor` + `statusEditorOptions`), the tooltip
 * (`tooltipValueGetter` → `sellingStatusModel(value).tooltip`) and `editable` (`.editable`); the cell only draws.
 *
 * A screen reader hears one sentence ("Status: Active. Inactive is waiting for Publish, set by Awais today 10:42."):
 * the visual parts are `aria-hidden` and the sentence sits in `.nds-vh`. The cell is never painted; an inactive ROW
 * carries the row-start mark instead (`rowCarriesInactiveMark`, `SELLING_ROW_MARK_CLASS`).
 */
export const SellingStatusCell = memo(function SellingStatusCell(p: ICellRendererParams) {
  if (!p.data) return null
  return <SellingStatusView value={p.value as SellingStatusValue | undefined} />
})

export interface SellingStatusViewProps {
  value: SellingStatusValue | undefined
  /** The clock for "today 10:42" vs "on 3 Oct, 10:42". Default: now. */
  now?: number
}

/** The cell's content without AG Grid — the catalog, a review table or a drawer can show the same thing. */
export function SellingStatusView({ value, now }: SellingStatusViewProps) {
  const model = sellingStatusModel(value, now)
  if (model.kind === 'loading') {
    return (
      <span className="nds-selling-cell is-loading">
        <Skeleton width={72} height={16} radius="var(--nds-radius-pill)" />
        <span className="nds-vh">{model.ariaLabel}</span>
      </span>
    )
  }
  return (
    <span className={`nds-selling-cell is-${model.kind}`}>
      <span className="nds-selling-visual" aria-hidden="true">
        <SellingStatePill pill={model.pill} />
        {model.aside && <span className="nds-selling-aside">{model.aside}</span>}
        {model.locked && <Lock size={11} strokeWidth={2.25} className="nds-selling-lock" aria-hidden="true" />}
      </span>
      <span className="nds-vh">{model.ariaLabel}</span>
    </span>
  )
}
