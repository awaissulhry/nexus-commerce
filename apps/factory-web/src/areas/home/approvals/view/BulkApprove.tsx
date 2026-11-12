'use client'

import { ReviewChangesModal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { DEPTH_NS, type InboxActions, type InboxViewModel } from '../model'
import type { InboxRow } from '../inbox'

/**
 * "Approve 3 price changes" (B-W2b-307; design home.approvals pop:bulk-approve): a ReviewChangesModal over the ticked
 * requests of ONE kind with no signature meaning. Each is re-read first (the re-check per row): a current one is listed
 * "Waiting → Approved"; one that changed, was decided meanwhile or is no longer mine is left out with the reason. Approve N
 * approves the current ones one by one (each still refused STALE by the engine if it moved in between), and the done
 * screen says what became of each.
 */
export function BulkApproveDialog({ model, rows, actions, kindWords }: { model: InboxViewModel; rows: readonly InboxRow[]; actions?: InboxActions; kindWords: (row: InboxRow) => string }) {
  const t = useT(DEPTH_NS)
  const dialog = model.dialog
  if (dialog?.kind !== 'bulk') return null
  const lines = dialog.lines
  const kind = rows[0] ? kindWords(rows[0]) : ''
  const current = (lines ?? []).filter((line) => line.leftOut === null)
  const leftOut = (lines ?? []).filter((line) => line.leftOut !== null)
  const raw = lines === null && dialog.state.phase === 'ready' ? ({ phase: 'reading' } as const) : dialog.state
  // The container keeps each result's words as a key of this page: said here in the person's language.
  const state =
    raw.phase === 'done'
      ? { phase: 'done' as const, results: Object.fromEntries(Object.entries(raw.results).map(([key, result]) => [key, { ...result, words: t(result.ok ? 'bulk.approved' : result.words) }])) }
      : raw.phase === 'failed'
        ? { phase: 'failed' as const, error: t('bulk.failed') }
        : raw
  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t('bulk.title', { count: rows.length, kind })}
      summary={t('bulk.summary')}
      changes={current.map((line) => ({ id: line.key, where: line.label, what: line.summary, now: t('bulk.now'), next: t('bulk.next') }))}
      problems={model.offline ? [t('inbox.held.offline')] : []}
      saveLabel={t('bulk.approve', { count: current.length, kind })}
      ackLabel={t('bulk.ack')}
      lead={
        leftOut.length > 0 ? (
          <div className="fw-apv-review">
            <p className="fw-apv-h">{t('bulk.leftOut', { count: leftOut.length })}</p>
            <ul className="fw-apv-list">
              {leftOut.map((line) => (
                <li key={line.key}>
                  {line.label} — {t(line.leftOut!)}
                </li>
              ))}
            </ul>
          </div>
        ) : undefined
      }
      state={state}
      onSave={() => actions?.onBulkConfirm?.()}
      onRetry={() => actions?.onBulk?.(dialog.keys)}
      doneVerb={t('bulk.doneVerb')}
      size="lg"
    />
  )
}
