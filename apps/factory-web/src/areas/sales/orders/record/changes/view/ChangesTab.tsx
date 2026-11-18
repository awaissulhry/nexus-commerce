'use client'

import { useState } from 'react'
import { GitCompare, Undo2 } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, SegmentedControl } from '@nexus/ui/primitives'
import { Timeline } from '../../../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { useProductionWords } from '../../../../../../lib/production/words'
import { money } from '../../../../quotes/model'
import type { Order } from '../../../api'
import { DECISION_TONE, NAMESPACE as DEPTH, putBackHeld, YES_TONE } from '../../../depth/model'
import { ChangesDepth } from '../../../changes-depth/view/ChangesDepth' // B-W2b-323
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { PartState } from '../../view/OrderRecordView'
import { DocumentsTab } from '../../view/DocumentsTab'
import { RequestsSection, StillToDo } from '../../view/RequestsSection'
import { HISTORY_CHIPS, historyFor, historyOf, type HistoryChip, type HistoryEntry } from '../model'

/**
 * F-SA-236 (sales page plan N2, N3, P5; 10-order-page §2.4) — Changes, one newest-first story:
 *
 *   Waiting on us · Waiting on the customer   the customer's open requests (the shared RequestCard) and what we asked them
 *   Confirmation & the customer's yes (#…)    the confirmation as a row opening in the thread's viewer, how the customer said yes
 *   History                                   requests asked and answered, amendments (the ONE `…/changes` read: priced or not; Before
 *                                             → after; Put back), confirmations made and sent — chips All · Requests · Amendments ·
 *                                             Confirmations
 *   What can still change                     the freeze panel (each field open, a priced change, or blocked, from which stage)
 *
 * SCR-107's amendments (B-W2a-50) are History's amendments; their before → after opens the compare dialog (its snapshots are read
 * when it opens — the page no longer reads the amendments twice).
 */
export function ChangesTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <div className="fw-so-stack">
      <RequestsSection order={order} model={model} actions={actions} />
      {/* F-SA-243: Still to do under each accepted change (#still-to-do: the band's "Open" lands here). */}
      <StillToDo order={order} model={model} />
      <section id="confirmation" className="fw-so-anchor" aria-labelledby="fw-so-confirmation-title">
        <DocumentsTab order={order} model={model} actions={actions} />
      </section>
      <History order={order} model={model} actions={actions} />
      {/* B-W2b-323: What can still change (the freeze panel) and the new yes a change waits for. */}
      <ChangesDepth order={order} model={model.depth} actions={actions?.depth} prefix={model.prefix} />
    </div>
  )
}

function History({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const w = useProductionWords()
  const locale = useLocale()
  const [chip, setChip] = useState<HistoryChip>('all')
  const changes = model.depth?.changes ?? null
  const amendments = model.amendments ?? null
  // The ONE changes read when the page has it; a design case or an older page draws the amendments read.
  const source = changes ?? amendments
  if (source && source.value === null) return <PartState problem={source.problem} label={t('changes.history.title')} onRetry={() => (changes ? actions?.depth?.onRetry?.('changes') : actions?.onRetryPart?.('amendments'))} />
  const entries = historyOf({
    requests: model.requests?.value ?? [],
    changes: changes?.value?.changes ?? null,
    amendments: changes ? null : (amendments?.value?.amendments ?? null),
    confirmation: model.depth?.confirmation?.value ?? null,
  })
  const shown = historyFor(entries, chip)
  const when = (at: string) => t('changes.when', { date: formatDate(at, { locale }), time: formatTime(at, { locale }) })
  const step = (entry: HistoryEntry) => {
    switch (entry.kind) {
      case 'requestAsked':
        return {
          tone: 'neutral' as const,
          label: t('changes.history.asked', { kind: w.t(`parts.request.kind.${entry.request.kind}`) }),
          detail: [when(entry.at), entry.request.askedBy ? t('changes.history.by', { name: entry.request.askedBy }) : null, entry.request.note ? `“${entry.request.note}”` : null].filter(Boolean).join(' · '),
        }
      case 'requestAnswered':
        return {
          tone: entry.request.status === 'ACCEPTED' ? ('success' as const) : entry.request.status === 'REFUSED' ? ('danger' as const) : ('neutral' as const),
          label: `${w.t(`parts.request.kind.${entry.request.kind}`)} · ${w.t(`parts.request.office.${entry.request.status}`)}`,
          detail: [when(entry.at), entry.request.answeredBy ? t('changes.history.by', { name: entry.request.answeredBy }) : null].filter(Boolean).join(' · '),
        }
      case 'amendment': {
        const lines = (['changed', 'added', 'removed'] as const).filter((kind) => entry.counts[kind] > 0).map((kind) => t(`changes.count.${kind.toUpperCase()}`, { count: entry.counts[kind] }))
        return {
          tone: entry.priced ? ('info' as const) : ('neutral' as const),
          label: (
            <span className="fw-so-inline">
              <strong>{t('changes.revision', { revision: entry.revision })}</strong>
              <span>{entry.reason}</span>
              {entry.priced && <Pill tone="info">{t('changes.history.priced')}</Pill>}
            </span>
          ),
          detail: (
            <span className="fw-so-inline">
              <span>{[when(entry.at), entry.by ? t('changes.history.by', { name: entry.by }) : null, lines.length > 0 ? lines.join(' · ') : t('changes.headerOnly'), lines.length > 0 ? t('changes.piecesMoved', { before: entry.counts.before, after: entry.counts.after }) : null, model.can.price && entry.money && entry.money.delta !== 0 ? `${entry.money.delta >= 0 ? '+' : '−'}${money(Math.abs(entry.money.delta), order.currency, locale)}` : null].filter(Boolean).join(' · ')}</span>
              <Button size="sm" variant="quiet" aria-label={t('changes.openOf', { revision: entry.revision })} onClick={() => actions?.onDialog?.({ kind: 'compare', amendmentId: entry.id })}>
                <GitCompare size={13} aria-hidden /> {t('changes.open')}
              </Button>
              {/* B-W2b-323 (SAL-219): a priced change's fee and extra deposit (price grain), the yes it waits for, the customer's answer. */}
              {entry.change?.priced && (
                <>
                  {model.can.price && entry.change.feeAmount ? <span className="fw-so-cell-sub">{d('pricedList.fee', { amount: money(entry.change.feeAmount, order.currency, locale) })}</span> : null}
                  {model.can.price && entry.change.deposit && entry.change.deposit.amount !== undefined ? (
                    <span className="fw-so-cell-sub">{d('pricedList.deposit', { amount: money(entry.change.deposit.amount, order.currency, locale), kind: d(`depositKind.${entry.change.deposit.kind}`), status: d(`depositStatus.${entry.change.deposit.status}`) })}</span>
                  ) : null}
                  <Pill tone={DECISION_TONE[entry.change.customer.decision]}>{d(`decision.${entry.change.customer.decision}`)}</Pill>
                  {entry.change.yes.state !== 'NOT_ASKED' && <Pill tone={YES_TONE[entry.change.yes.state]}>{d(`changeYes.state.${entry.change.yes.state}`)}</Pill>}
                  {entry.change.yes.state === 'TURNED_DOWN' && entry.change.yes.reason && <span className="fw-so-cell-sub">{d('changeYes.because', { reason: entry.change.yes.reason })}</span>}
                </>
              )}
              {entry.putBack && entry.change && (
                <Button size="sm" variant="quiet" heldReason={model.depth && putBackHeld(entry.change, model.depth.can) ? d(putBackHeld(entry.change, model.depth.can)!.key) : model.busy ? t('held.busy') : null} onClick={() => actions?.depth?.onDialog?.({ kind: 'putBack', changeId: entry.id, reason: '' })} aria-label={d('putBack.of', { revision: entry.revision })}>
                  <Undo2 size={13} aria-hidden /> {d('putBack.go')}
                </Button>
              )}
            </span>
          ),
        }
      }
      case 'confirmationMade':
        return { tone: 'neutral' as const, label: t('changes.history.made', { version: entry.version }), detail: [when(entry.at), entry.by ? t('changes.history.by', { name: entry.by }) : null].filter(Boolean).join(' · ') }
      case 'confirmationSent':
        return { tone: 'success' as const, label: t('changes.history.sent', { version: entry.version }), detail: when(entry.at) }
    }
  }
  return (
    <Card padded>
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('changes.history.title')}</h2>
        <SegmentedControl size="sm" ariaLabel={t('changes.history.chipsLabel')} value={chip} onChange={(value) => setChip(value as HistoryChip)} options={HISTORY_CHIPS.map((value) => ({ value, label: t(`changes.history.chips.${value}`) }))} wrap />
      </div>
      {shown.length === 0 ? (
        <EmptyState title={t(entries.length === 0 ? 'changes.empty.title' : 'changes.history.noneHere')} description={entries.length === 0 ? t(order.status === 'CANCELLED' || order.status === 'CLOSED' ? 'changes.empty.final' : 'changes.empty.body') : undefined} />
      ) : (
        <Timeline label={t('changes.history.title')} steps={shown.map((entry) => ({ key: entry.id, ...step(entry) }))} />
      )}
    </Card>
  )
}
