'use client'

import { memo } from 'react'
import type { ICellRendererParams } from 'ag-grid-community'
import { Clock, Lock } from 'lucide-react'
import { Pill } from '../../primitives/Pill'
import { Skeleton } from '../../primitives/Skeleton'
import { publishActionModel, type PublishActionValue } from './publishAction'

/**
 * The sheet's **Action** cell (build shape v2, 2026-10-04): how Publish sends this row. The default, Partial update, is
 * QUIET — muted text, no pill — so a column of defaults reads as nothing to do; a waiting Full update is an info pill
 * and a waiting Delete a danger pill, each with a clock glyph. A row not on the channel (new, or deleted by Nexus)
 * reads "[Full update]" (no glyph: a create is always sent whole; quiet when its Status leaves it out). `p.value` is a
 * `PublishActionValue`; `undefined` = not read yet (skeleton). The column owns the editor (`SelectPanelEditor` + `sendModeEditorOptions`), the tooltip
 * (`publishActionModel(value).tooltip`) and `editable`; the cell only draws, and a screen reader hears one sentence.
 */
export const PublishActionCell = memo(function PublishActionCell(p: ICellRendererParams) {
  if (!p.data) return null
  return <PublishActionView value={p.value as PublishActionValue | undefined} />
})

export interface PublishActionViewProps {
  value: PublishActionValue | undefined
  /** The clock for "today 10:42" vs "on 3 Oct, 10:42". Default: now. */
  now?: number
}

/** The cell's content without AG Grid — the catalog or the Publish review can show the same thing. */
export function PublishActionView({ value, now }: PublishActionViewProps) {
  const model = publishActionModel(value, now)
  if (model.kind === 'loading') {
    return (
      <span className="nds-action-cell is-loading">
        <Skeleton width={84} height={16} radius="var(--nds-radius-pill)" />
        <span className="nds-vh">{model.ariaLabel}</span>
      </span>
    )
  }
  return (
    <span className={`nds-action-cell is-${model.kind}`}>
      <span className="nds-selling-visual" aria-hidden="true">
        {model.pill
          ? model.pill.glyph === 'none'
            ? <Pill tone={model.pill.tone} className="nds-selling-pill">{model.pill.label}</Pill>
            : <Pill tone={model.pill.tone} className="nds-selling-pill" icon={<Clock size={11} strokeWidth={2.5} aria-hidden="true" />}>{model.pill.label}</Pill>
          : <span className="nds-action-quiet">{model.label}</span>}
        {model.aside && <span className="nds-selling-aside">{model.aside}</span>}
        {model.locked && <Lock size={11} strokeWidth={2.25} className="nds-selling-lock" aria-hidden="true" />}
      </span>
      <span className="nds-vh">{model.ariaLabel}</span>
    </span>
  )
}
