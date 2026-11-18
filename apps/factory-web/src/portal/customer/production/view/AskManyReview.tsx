'use client'

import { Banner, Field } from '@nexus/ui/components'
import type { ReviewPanelChange, ReviewPanelResult } from '@nexus/ui/patterns'
import { Select } from '@nexus/ui/primitives'
import { ReviewChangesModal, Textarea } from '../../../../lib/i18n/ds-parts'
import type { BulkAskKind } from '../bulk/api'
import type { AskForm, AskRow } from '../bulk/ask-model'
import type { RowResult } from '../bulk/model'
import { useProductionPageWords } from '../words'
import '../production.css'

/**
 * F-PR-23b — Ask N on My production (Ask ▾: pause, cancel, resume — the kinds the customer's limits open; urgent is asked only through
 * Mark urgent): the DS ReviewChangesModal with the ask's own fields above the table (a pause says why; a cancel picks one of the
 * reasons offered), ONE table that names every picked order with what will happen — asked of us, with its impact once read (what is
 * frozen, the cost, what a pause means), or why it cannot be asked now —, one primary button that counts the orders asked, then a
 * result per row and Undo (what still waits for our answer is withdrawn). We answer each request.
 */

export interface AskManyReviewModel {
  readonly kind: BulkAskKind
  readonly title: string
  /** The one line under the title (one request per order; we answer each one). */
  readonly lead: string
  readonly rows: readonly AskRow[]
  readonly form: AskForm
  /** CANCEL: the reasons the company offers (in the person's language). */
  readonly reasons: readonly { readonly code: string; readonly label: string; readonly needsNote: boolean }[]
  /** What the fields miss, in words (shown under the field), or null. */
  readonly formProblem: string | null
  readonly phase: 'ready' | 'saving' | 'done'
  readonly results: Readonly<Record<string, RowResult>> | null
  readonly doneLine: { readonly line: string; readonly tone: 'success' | 'warning' | 'danger' } | null
  readonly save: string
  readonly held: string | null
  readonly problem: string | null
  readonly undo: { readonly busy: boolean } | null
}

export interface AskManyReviewActions {
  onReason?: (text: string) => void
  onReasonCode?: (code: string) => void
  onSave?: () => void
  onUndo?: () => void
  onClose?: () => void
}

export function AskManyReview({ model, actions }: { model: AskManyReviewModel; actions?: AskManyReviewActions }) {
  const { t } = useProductionPageWords()
  const saving = model.phase === 'saving'
  const changes: ReviewPanelChange[] = model.rows.map((row) => ({ id: row.id, where: row.name, what: t(`bulk.ask.what.${model.kind}`), now: row.now, next: row.next, ...(row.note ? { note: row.note } : {}) }))
  const results: Record<string, ReviewPanelResult> = {}
  for (const [id, result] of Object.entries(model.results ?? {})) results[id] = { ok: result.ok, words: result.words, tone: result.tone }
  const state = model.phase === 'done' ? ({ phase: 'done', results } as const) : saving ? ({ phase: 'saving' } as const) : ({ phase: 'ready' } as const)
  const reason = model.reasons.find((entry) => entry.code === model.form.reasonCode) ?? null
  const wordsLabel = model.kind === 'HOLD' ? t('bulk.ask.field.why') : reason?.needsNote ? t('bulk.ask.field.noteNeeded') : t('bulk.ask.field.note')
  const lead = (
    <div className="fw-pprod-bulk-lead">
      {model.problem ? <Banner tone="danger" title={model.problem} /> : null}
      <p className="fw-pprod-sub">{model.lead}</p>
      {model.kind === 'CANCEL' ? (
        <Field label={t('bulk.ask.field.reason')} required error={model.formProblem && !reason ? model.formProblem : undefined}>
          <Select value={model.form.reasonCode} disabled={saving} onChange={(event) => actions?.onReasonCode?.(event.target.value)}>
            <option value="">{t('bulk.ask.field.reasonPick')}</option>
            {model.reasons.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label={wordsLabel} hint={t('bulk.ask.field.hint')} required={model.kind === 'HOLD' || !!reason?.needsNote} error={model.formProblem && (model.kind !== 'CANCEL' || reason) ? model.formProblem : undefined}>
        <Textarea value={model.form.reason} rows={3} readOnly={saving} onChange={(event) => actions?.onReason?.(event.target.value)} />
      </Field>
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
      summary={t('bulk.ask.summary')}
      saveLabel={model.save}
      onSave={() => actions?.onSave?.()}
      leadHeld={model.held}
      lead={lead}
      {...(model.undo ? { onUndo: () => actions?.onUndo?.(), undoing: model.undo.busy } : {})}
      {...(model.doneLine ? { doneLine: model.doneLine } : {})}
      onDone={() => actions?.onClose?.()}
      labels={{ undo: t('bulk.review.undo'), undoing: t('bulk.review.undoing'), where: t('bulk.review.where'), what: t('bulk.ask.whatColumn'), done: t('bulk.review.done') }}
    />
  )
}
