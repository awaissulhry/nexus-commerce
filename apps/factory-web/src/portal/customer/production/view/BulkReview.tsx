'use client'

import { Banner, Field } from '@nexus/ui/components'
import type { ReviewPanelChange, ReviewPanelResult } from '@nexus/ui/patterns'
import { DateField, ReviewChangesModal } from '../../../../lib/i18n/ds-parts'
import type { ReviewRow, RowResult } from '../bulk/model'
import { useProductionPageWords } from '../words'
import '../production.css'

/**
 * F-PR-23a — the review before Send of a bulk mark or move on My production (17-web-r2 §1.5; the DS ReviewChangesModal: one line
 * under the title, ONE table that names every picked order — Order · Urgency · Now · New · Note —, one primary button that says
 * what it does, then a result per row and Undo). Mark urgent asks for a need-by date only when some orders are asked of us. While
 * sending, Esc and the backdrop do nothing; a send that did not go says so above the table and Send tries again (the same key).
 */

export interface BulkReviewModel {
  readonly title: string
  /** The one line under the title (what the quota allows now, or the rule). */
  readonly lead: string
  readonly rows: readonly ReviewRow[]
  /** The need-by date of the orders asked of us (null: none is asked). */
  readonly needBy: { readonly value: string; readonly min: string } | null
  readonly phase: 'ready' | 'saving' | 'done'
  /** After Send: one result per row. */
  readonly results: Readonly<Record<string, RowResult>> | null
  readonly doneLine: { readonly line: string; readonly tone: 'success' | 'warning' | 'danger' } | null
  readonly save: string
  /** Why Send waits, in words; null: it sends. */
  readonly held: string | null
  /** A send that did not go (Send tries again). */
  readonly problem: string | null
  /** Undo on the Done screen (null: nothing to undo, or undone already). */
  readonly undo: { readonly busy: boolean } | null
}

export interface BulkReviewActions {
  onNeedBy?: (day: string) => void
  onSave?: () => void
  onUndo?: () => void
  onClose?: () => void
}

export function BulkReview({ model, actions }: { model: BulkReviewModel; actions?: BulkReviewActions }) {
  const { t } = useProductionPageWords()
  const changes: ReviewPanelChange[] = model.rows.map((row) => ({ id: row.id, where: row.name, what: t('bulk.review.what'), now: row.now, next: row.next, ...(row.note ? { note: row.note } : {}) }))
  const results: Record<string, ReviewPanelResult> = {}
  for (const [id, result] of Object.entries(model.results ?? {})) results[id] = { ok: result.ok, words: result.words, tone: result.tone }
  const state = model.phase === 'done' ? ({ phase: 'done', results } as const) : model.phase === 'saving' ? ({ phase: 'saving' } as const) : ({ phase: 'ready' } as const)
  const lead = (
    <div className="fw-pprod-bulk-lead">
      {model.problem ? <Banner tone="danger" title={model.problem} /> : null}
      <p className="fw-pprod-sub">{model.lead}</p>
      {model.needBy ? (
        <Field label={t('bulk.review.needBy')} hint={t('bulk.review.needByHint')}>
          <DateField value={model.needBy.value} min={model.needBy.min} onChange={(value) => actions?.onNeedBy?.(value)} clearable />
        </Field>
      ) : null}
    </div>
  )
  return (
    <ReviewChangesModal
      open
      size="detail"
      onClose={() => actions?.onClose?.()}
      changes={changes}
      state={state}
      title={model.title}
      summary={t('bulk.review.summary')}
      saveLabel={model.save}
      onSave={() => actions?.onSave?.()}
      leadHeld={model.held}
      lead={lead}
      {...(model.undo ? { onUndo: () => actions?.onUndo?.(), undoing: model.undo.busy } : {})}
      {...(model.doneLine ? { doneLine: model.doneLine } : {})}
      onDone={() => actions?.onClose?.()}
      labels={{ undo: t('bulk.review.undo'), undoing: t('bulk.review.undoing'), where: t('bulk.review.where'), done: t('bulk.review.done') }}
    />
  )
}
