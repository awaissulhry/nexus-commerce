'use client'

import { useSearchParams } from 'next/navigation'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { tabHref } from '../../../../../_shared/record-frame/address'
import type { Order } from '../../../api'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { orderWaitingOf, readOf } from '../../overview/model'
import { PartFailed, PartReading, Section } from '../../view/production/Kit'
import { RequestsSection, StillToDo } from '../../view/RequestsSection'
import { dayTimeOf } from '../layout'
import { countsOf, holdsPointerOf, lastRevisionOf, waitingAnswerOf, type WaitingAnswer } from '../waiting'
import './changes.css'
// ---- F-OP-117: the work-order changes of this order (its card stays until F-OC-105 takes it out) ----
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatTime } from '../../../../../../lib/i18n/format'
import { said } from '../../../../../home/approvals/requests/model'
import { outcomeWordsOf } from '../../../../../home/approvals/work-order-changes/model'
import { PartState } from '../../view/OrderRecordView'
import { changeFiguresOf, changeHeldOf, floorToldOfChange, workOrderChangeRowsOf } from '../model'
// ---- end F-OP-117

/**
 * F-OC-101 (order CHANGES tab, 10-design §3) — section 1, Waiting (#waiting; #still-to-do and #work-order-changes land here): what
 * waits for an answer or a step on this order, whose turn, how long, and its one door. ONE list: the rows of `orderWaitingOf`, the
 * call Overview's card and the Changes badge make. The head: one answer, "As of 10:44" (the ages count to the read's own time), one ⓘ.
 * Reading: skeleton rows; failed: one line with Try again (the rest of the tab still draws); nothing: the head's one line.
 */
export function WaitingSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? ''
  const waiting = orderWaitingOf(order, model, locale)
  const title = t('changesTab.waiting.title')
  const customer = order.party?.legalName ?? ''
  const asOf = readOf(model.production)?.asOf ?? null
  const when = (at: string) => {
    const said = dayTimeOf(at, asOf, locale)
    return said.today ? t('changesTab.today', { time: said.time }) : t('changesTab.dayTime', { date: said.date, time: said.time })
  }
  const answerWords = (answer: WaitingAnswer): string =>
    answer.kind === 'nothing'
      ? t('changesTab.waiting.nothing')
      : answer.kind === 'steps'
        ? t('changesTab.waiting.onlySteps', { count: answer.count })
        : t('changesTab.waiting.total', { count: answer.count, parts: answer.parts.map((part) => t(part.key, { ...part.params, customer })).join(', ') })
  // L4: the one pointer to Production, only while the order has a hold or a date waiting (never on a cancelled order).
  const pointer = holdsPointerOf(waiting, order.status)
  const pointerLink = pointer ? (
    <TabLink className="fw-pt-link" href={`${tabHref(`${model.prefix}/sales/orders/${order.id}`, 'production', search)}#${pointer}`}>
      {t('changesTab.waiting.holdsAndDates')}
    </TabLink>
  ) : null
  const info = (
    <>
      <p>{t('changesTab.waiting.info')}</p>
    </>
  )
  const stamp = asOf ? <span className="fw-pt-asof">{t('changesTab.waiting.asOf', { when: when(asOf) })}</span> : null
  if (waiting.status !== 'ready') {
    return (
      <Section id="waiting" title={title} answer={waiting.status === 'loading' ? t('changesTab.waiting.reading') : null} info={info}>
        {waiting.status === 'loading' ? <PartReading rows={3} height={44} /> : <PartFailed part={title} problem={waiting.problem} onRetry={() => actions?.onRetryProduction?.()} />}
      </Section>
    )
  }
  const counts = countsOf(waiting.card)
  const answer = waitingAnswerOf(counts)
  if (answer.kind === 'nothing') {
    // Nothing waits: the whole section is its head's one line — the last change and, L4, where holds and dates are.
    const last = lastRevisionOf(model.depth?.changes?.value?.changes ?? model.amendments?.value?.amendments ?? null)
    return (
      <Section
        id="waiting"
        title={title}
        answer={
          <>
            {[answerWords(answer), last ? t('changesTab.waiting.lastRevision', { revision: last.revision, date: formatDate(last.at, { locale }) }) : null].filter(Boolean).join(' ')}
            {pointerLink ? <> · {pointerLink}</> : null}
          </>
        }
        info={info}
        more={stamp}
      >
        <WorkOrderChanges order={order} model={model} actions={actions} />
      </Section>
    )
  }
  return (
    <Section id="waiting" title={title} answer={answerWords(answer)} info={info} more={stamp}>
      <RequestsSection order={order} model={model} actions={actions} />
      <StillToDo order={order} model={model} actions={actions} />
      <WorkOrderChanges order={order} model={model} actions={actions} />
      {pointerLink ? <p className="fw-pt-quiet fw-oc-foot">{pointerLink}</p> : null}
    </Section>
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
