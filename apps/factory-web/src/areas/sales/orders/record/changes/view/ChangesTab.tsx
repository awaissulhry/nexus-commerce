'use client'

import { useState, type ReactNode } from 'react'
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
// ---- F-OP-117: the work-order changes of this order ----
import { changeFiguresOf, changeHeldOf, floorToldOfChange, workOrderChangeRowsOf } from '../model'
import { outcomeWordsOf } from '../../../../../home/approvals/work-order-changes/model'
import { said } from '../../../../../home/approvals/requests/model'
// F-SA-266: each history row's Discuss and Show in the thread; its anchor `change-<id>` ("Show on the page", `?tab=changes#change-<id>`)
import { DiscussDoor, ShowInThreadDoor } from '../../view/Discuss'
import type { DiscussPart } from '../../dock/discuss'
// F-SA-244: each change's Told line ("Told: conversation · bell to 6 people · floor note on WO-0311 · workshop notice") → Who was told.
import { toldOfHistory, toldParts } from '../../told'
import { autoReasonOf } from '../../lines-draft' // F-OL-03: the automatic reasons in words

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
      <StillToDo order={order} model={model} actions={actions /* F-OP-116: the doors in place */} />
      {/* F-OP-117: the work-order changes of this order (waiting first, then decided), each decided in place. */}
      <WorkOrderChanges order={order} model={model} actions={actions} />
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
    workOrderChanges: model.orderChanges?.list?.value ?? null, // F-OP-117: the chip Work orders
  })
  const shown = historyFor(entries, chip)
  const when = (at: string) => t('changes.when', { date: formatDate(at, { locale }), time: formatTime(at, { locale }) })
  // ---- F-SA-266: a request's row by its reference (the customer reads its own words); an amendment or a confirmation in words, in an
  // office note; every row: its step in the thread (the history step nearest its time).
  const partOf = (entry: HistoryEntry): DiscussPart => {
    if (entry.kind === 'requestAsked' || entry.kind === 'requestAnswered') return { part: t('discuss.request', { kind: w.t(`parts.request.kind.${entry.request.kind}`) }), target: { kind: 'OrderChangeRequest', id: entry.request.id } }
    if (entry.kind === 'amendment') return { part: t('discuss.revision', { revision: entry.revision }), target: null }
    // F-OP-117: a work-order change is discussed in an office note only (a work-order number never reaches a customer).
    if (entry.kind === 'workOrderChange') return entry.change.workOrder ? { part: entry.change.workOrder.number, target: { kind: 'WorkOrder', id: entry.change.workOrder.id }, officeOnly: true } : { part: entry.change.salesOrder.number, target: null, officeOnly: true }
    return { part: t(entry.kind === 'confirmationMade' ? 'changes.history.made' : 'changes.history.sent', { version: entry.version }), target: null }
  }
  // ---- F-SA-244: the change's Told line under its row — who was TOLD (the conversation, the bell, the floor, the workshop), never
  // who read it (R2, review WP-2); it opens Who was told. Only with the told lines read (the conversation's read right).
  const toldChanges = model.told?.value?.changes ?? []
  const toldLine = (entry: HistoryEntry): ReactNode => {
    const change = toldOfHistory({ kind: entry.kind, at: entry.at, requestId: entry.kind === 'requestAnswered' ? entry.request.id : null }, toldChanges)
    if (!change) return null
    const words = toldParts(change)
      .map((one) => t(one.key, one.params))
      .join(' · ')
    return (
      <span className="fw-so-told">
        <Button size="xs" variant="link" inline wrap onClick={() => actions?.onWhoWasTold?.(change.messageId)} title={t('told.open')}>
          {words}
        </Button>
      </span>
    )
  }
  // ---- end F-SA-244
  const withDoors = <S extends { label: ReactNode; detail?: ReactNode }>(entry: HistoryEntry, drawn: S): S & { key: string } => ({
    ...drawn,
    ...(toldChanges.length > 0 ? { detail: (<>{drawn.detail}{toldLine(entry)}</>) as ReactNode } : {}) /* F-SA-244 */,
    key: entry.id,
    label: (
      <span className="fw-so-inline" id={`change-${entry.id}`} tabIndex={-1}>
        {drawn.label}
        <DiscussDoor order={order} {...partOf(entry)} />
        <ShowInThreadDoor order={order} at={entry.at} />
      </span>
    ),
  })
  // ---- end F-SA-266
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
              {/* F-OL-03 (ol-s1, B-OL-004): a reason nobody typed is the server's automatic words — said in the reader's words. */}
              <span>{autoReasonOf(entry.reason) ? t(autoReasonOf(entry.reason)!.key) : entry.reason}</span>
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
      // F-OP-117: a work-order change decided — its work order, what it did to the cells, who decided and when.
      case 'workOrderChange':
        return {
          tone: entry.change.status === 'APPLIED' ? ('success' as const) : ('neutral' as const),
          label: `${entry.change.workOrder?.number ?? entry.change.madeWorkOrder?.number ?? '—'} · ${said(entry.change.words.status, locale)}`,
          detail: [when(entry.at), entry.change.decidedBy ? t('changes.history.by', { name: entry.change.decidedBy.name }) : null, entry.change.words.cells].filter(Boolean).join(' · '),
        }
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
        <Timeline label={t('changes.history.title')} steps={shown.map((entry) => withDoors(entry, step(entry)))} />
      )}
    </Card>
  )
}

// ---- F-OP-117 (10-order-page §6): "Work-order changes of this order" ---------------------------------------------------------------
/**
 * The work-order changes an accepted change or an office change of this order proposed — waiting ones first (oldest first), then the
 * decided ones newest first: the work order, its cells before → after, the extra pieces' outcome, "Told the floor at hh:mm" once
 * carried out, and for a waiting one Apply… / Leave as is… in place (the ONE decide window here), held for who may not decide. Only
 * this order's changes (the API's wall); a planner's words are never the customer's.
 */
function WorkOrderChanges({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const part = model.orderChanges?.list ?? null
  // Not read here (a design case, no right): nothing is claimed — no card.
  if (!part) return null
  if (part.value === null) return part.problem ? <PartState problem={part.problem} label={t('wocs.title')} /> : null
  const rows = workOrderChangeRowsOf(part.value, order.id)
  const customer = order.party?.legalName ?? null
  return (
    <section id="work-order-changes" className="fw-so-anchor" aria-labelledby="fw-so-wocs-title">
      <Card padded>
        <div className="fw-so-card-head">
          <h2 className="fw-so-h2" id="fw-so-wocs-title">
            {t('wocs.title')}
          </h2>
        </div>
        {rows.length === 0 ? (
          <EmptyState title={t('wocs.none')} />
        ) : (
          <ul className="fw-so-datelist">
            {rows.map((change) => {
              const figures = changeFiguresOf(change)
              const held = changeHeldOf(change)
              const heldWords = held ? t(held.key, { time: formatTime(held.params.at, { locale }) }) : model.busy ? t('held.busy') : null
              const outcome = outcomeWordsOf(change, customer)
              const floor = floorToldOfChange(change)
              return (
                <li key={change.id} className="fw-so-still">
                  <span className="fw-so-stack-tight">
                    <span className="fw-so-inline">
                      <strong>{change.workOrder?.number ?? change.madeWorkOrder?.number ?? t('wocs.newDraft')}</strong>
                      <Pill tone={WOC_TONE[change.status]}>{said(change.words.status, locale)}</Pill>
                    </span>
                    <span className="fw-so-cell-sub">{[change.words.cells, t('wo.changeWaits', { before: figures.before, after: figures.after })].join(' · ')}</span>
                    {outcome && <span className="fw-so-cell-sub">{said(outcome, locale)}</span>}
                    {floor && <span className="fw-so-cell-sub">{t('told.floorAt', { time: formatTime(floor, { locale }) })}</span>}
                    {change.status === 'DECLINED' && change.decisionNote && <span className="fw-so-cell-sub">{`“${change.decisionNote}”`}</span>}
                  </span>
                  {change.status === 'PROPOSED' && (
                    <span className="fw-so-inline">
                      <Button size="sm" heldReason={heldWords} onClick={() => actions?.orderChanges?.onOpen?.(change.id)}>
                        {t('wo.changeApply')}
                      </Button>
                      <Button size="sm" variant="quiet" heldReason={heldWords} onClick={() => actions?.orderChanges?.onOpen?.(change.id)}>
                        {t('wo.changeLeave')}
                      </Button>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </section>
  )
}

const WOC_TONE: Readonly<Record<string, 'warning' | 'success' | 'neutral'>> = Object.freeze({ PROPOSED: 'warning', APPLIED: 'success', DECLINED: 'neutral', STALE: 'neutral' })
// ---- end F-OP-117
