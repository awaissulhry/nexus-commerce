'use client'

import { memo } from 'react'
import type { ICellRendererParams } from 'ag-grid-community'
import { DetailPopover } from '../../components/DetailPopover'
import { ProgressBar } from '../../components/ProgressBar'
import { ProgressDetailCard } from './ProgressDetailCard'
import { progressDetailModel, progressPercent, progressTone, progressTriggerLabel, type ProgressAction, type ProgressValue } from './progress'

/**
 * What a progress column hands its cells. Every function is read when the card OPENS, never per render, so a column
 * of forty cells does not build forty cards.
 */
export interface ProgressCellParams {
  /** The column's scope, in words: "Shared product", "Amazon · IT". */
  scopeLabel: string
  /** The row the card is about — usually its SKU. */
  subjectOf?: (params: ICellRendererParams) => string | null
  /** What each field in the card can do: a column here (`goto`), another scope (`link`), or a sentence (`none`). */
  actionFor: (field: string, label: string, params: ICellRendererParams) => ProgressAction
  /** A `goto` was chosen: put the cursor in that cell — `landOnCell` from the engine. */
  onGoTo: (field: string, params: ICellRendererParams) => void
  /** One link under the list (the listings readiness page for this scope). */
  footerLink?: (params: ICellRendererParams) => { label: string; href: string } | null
}

/**
 * A PROGRESS cell (2026-09-26): the completeness meter — a bar in rule A's colour and its percentage — and, on hover
 * or click, the card that lists what is empty. Enter / Space on the cell opens it too (`cellDetailKeys` on the
 * column), Esc returns focus to the cell.
 *
 * `value == null` is NOT 0% and not green: nothing was computed for this row, so the bar is grey with `—`, and the
 * card says so (R-LX-9).
 */
export const ProgressCell = memo(function ProgressCell(p: ICellRendererParams & ProgressCellParams) {
  const value = (p.value as ProgressValue | null | undefined) ?? null
  if (!p.data) return null
  const tone = progressTone(value)
  const pct = progressPercent(value?.pct)
  const subject = p.subjectOf?.(p) ?? null
  const focusCell = () => { if (p.node?.rowIndex != null && p.column) p.api?.setFocusedCell(p.node.rowIndex, p.column) }
  return (
    <DetailPopover
      trigger={<ProgressBar tone={tone} value={pct} showValue className="nds-progress-cell" />}
      triggerLabel={progressTriggerLabel(p.scopeLabel, subject, value)}
      triggerClassName="nds-progress-trigger"
      panelClassName="nds-detailpop-scroll nds-progress-pop"
      label={`${p.scopeLabel} — what is missing${subject ? ` on ${subject}` : ''}`}
      returnFocus={focusCell}
    >
      {({ close }) => (
        <ProgressDetailCard
          model={progressDetailModel({ scopeLabel: p.scopeLabel, subject, value, now: Date.now(), actionFor: (field, label) => p.actionFor(field, label, p) })}
          onGoTo={field => p.onGoTo(field, p)}
          close={close}
          footerLink={p.footerLink?.(p) ?? null}
        />
      )}
    </DetailPopover>
  )
})
