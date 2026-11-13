'use client'

import type { ReactNode } from 'react'
import { Field } from '@nexus/ui/components'
import { ReviewChangesModal, Textarea } from '../../../../lib/i18n/ds-parts'
import type { Translate } from '../../../../lib/i18n/messages'
import { bulkLines, itemWords, reasonProblem, REASON_MAX, STRATEGIES } from '../model'
import type { BulkState, MpsActions } from '../view-model'
import { Listbox } from '../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

/**
 * Change strategy for N (design planning.mps sec:strategy "Bulk change with ReviewChangesModal"): the ticked items read again
 * first (the review's "now" is what they are at this moment), the strategy to give them and an optional reason above the table,
 * the items that change (old → new) and those already so (left out of the save), Save = ONE bulk command (all or nothing; a row
 * changed since is refused in words), then Done with Undo (each item back to what it was).
 */
export function BulkStrategy({ bulk, actions, t }: { bulk: BulkState; actions?: MpsActions; t: Translate }) {
  const { changing, already } = bulkLines(bulk.items, bulk.next)
  const reasonHeld = reasonProblem(bulk.reason)
  const lead: ReactNode =
    bulk.phase === 'done' ? undefined : (
      <div className="fw-mps-bulk">
        <Field label={t('bulk.to')}>
          <Listbox size="sm" ariaLabel={t('bulk.to')} value={bulk.next} options={STRATEGIES.map((strategy) => ({ value: strategy, label: t(`strategy.${strategy}`) }))} onChange={(value) => actions?.onBulkNext?.(value as (typeof STRATEGIES)[number])} disabled={bulk.phase === 'saving'} />
        </Field>
        <Field label={t('bulk.reason')} hint={t('bulk.reasonHint', { max: REASON_MAX })}>
          <Textarea value={bulk.reason} maxLength={REASON_MAX * 2} rows={2} onChange={(event) => actions?.onBulkReason?.(event.target.value)} disabled={bulk.phase === 'saving'} />
        </Field>
        {already.length > 0 && bulk.phase !== 'reading' && <p className="fw-mps-hint">{t('bulk.already', { count: already.length })}</p>}
        <p className="fw-mps-hint">{t('bulk.hint')}</p>
      </div>
    )
  const results =
    bulk.phase === 'done' && bulk.answer
      ? Object.fromEntries(
          bulk.answer.changes.map((change) => {
            const item = bulk.items.find((entry) => entry.item.id === change.itemId)
            const id = item ? item.item.id : change.itemId
            return [id, bulk.undone ? { ok: true, words: t('bulk.undoneLine'), verb: t('bulk.undoneVerb') } : { ok: true, words: change.change === 'UNCHANGED' ? t('bulk.unchangedLine') : t('bulk.savedLine', { strategy: t(`strategy.${change.to}`) }) }]
          }),
        )
      : null
  const state =
    bulk.phase === 'reading'
      ? ({ phase: 'reading' } as const)
      : bulk.phase === 'failed'
        ? ({ phase: 'failed', error: t(bulk.problem ?? 'refusal.failed') } as const)
        : bulk.phase === 'saving'
          ? ({ phase: 'saving' } as const)
          : results
            ? ({ phase: 'done', results } as const)
            : ({ phase: 'ready' } as const)
  return (
    <ReviewChangesModal
      open
      onClose={() => (bulk.phase === 'saving' ? undefined : actions?.onBulkClose?.())}
      changes={changing.map((line) => ({ id: line.item.item.id, where: itemWords(line.item), what: t('col.strategy'), now: t(`strategy.${line.now}`), next: t(`strategy.${line.next}`) }))}
      state={state}
      title={t('bulk.title', { count: bulk.ids.length })}
      summary={t('bulk.summary')}
      {...(bulk.phase !== 'reading' ? { metrics: [{ label: t('bulk.metric.changing'), value: String(changing.length) }, { label: t('bulk.metric.already'), value: String(already.length) }] } : {})}
      problems={bulk.problem && bulk.phase === 'ready' ? [t(bulk.problem)] : []}
      saveLabel={t('bulk.save', { count: changing.length })}
      onSave={() => actions?.onBulkSave?.()}
      onRetry={() => actions?.onBulkRetry?.()}
      {...(bulk.phase === 'done' && !bulk.undone && bulk.answer && bulk.answer.changed > 0 ? { onUndo: () => actions?.onBulkUndo?.(), undoing: bulk.undoing } : {})}
      onDone={() => actions?.onBulkClose?.()}
      lead={lead}
      leadHeld={reasonHeld ? t(reasonHeld) : null}
      size="lg"
    />
  )
}
