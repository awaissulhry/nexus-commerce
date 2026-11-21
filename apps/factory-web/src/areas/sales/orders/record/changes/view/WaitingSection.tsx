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
import { AnswerDoor, RowAge, StillToDo, WaitingDoorView } from '../../view/RequestsSection'
import { dayTimeOf } from '../layout'
import { countsOf, holdsPointerOf, lastRevisionOf, waitingAnswerOf, type WaitingAnswer } from '../waiting'
// ---- F-OC-102: Waiting on us / on {customer} — the ONE list's rows, each with who does it, its age and its one door ----
import { Tag } from '@nexus/ui/primitives'
import { useProductionWords } from '../../../../../../lib/production/words'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { NAMESPACE as DEPTH, yesDoorOf } from '../../../depth/model'
import { YesDoorView } from '../../../depth/view/DepthBand'
import { DiscussDoor } from '../../view/Discuss'
import { rowWordsOf } from '../../overview/model'
import { askWordsOf } from '../model'
import { mineCountOf, waitingItemOf, type WaitingItem } from '../waiting'
// ---- end F-OC-102
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

/** The catalogues Waiting's rows say their words in (Your turn, an approval's state, the old change's approval body). */
const APPROVALS_NS = 'approvals'
const RECORD_APPROVALS_NS = 'record-approvals'

/**
 * F-OC-101 … 104 (order CHANGES tab, 10-design §3; 18-lead-settles L1, L2, L4, L11) — section 1, Waiting (#waiting; #still-to-do and
 * #work-order-changes land here): what waits for an answer or a step on this order, whose turn, how long, and its one door. ONE list:
 * the rows of `orderWaitingOf`, the call Overview's card and the Changes badge make, in Overview's three groups and words (D8) —
 * Waiting on us · Waiting on {customer} · Still to do — always stacked; a group with nothing in it is one quiet line at the foot.
 * The head: one answer, "N are your turn", "As of 10:44" (the ages count to the read's own time), one ⓘ. Reading: skeleton rows;
 * failed: one line with Try again (the rest of the tab still draws); nothing at all: the head's one line.
 */
export function WaitingSection(props: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[APPROVALS_NS, RECORD_APPROVALS_NS, DEPTH]}>
      <Waiting {...props} />
    </WithMessages>
  )
}

function Waiting({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? ''
  const waiting = orderWaitingOf(order, model, locale)
  const title = t('changesTab.waiting.title')
  const customer = order.party?.legalName ?? ''
  const asOf = readOf(model.production)?.asOf ?? null
  const when = (at: string) => {
    const day = dayTimeOf(at, asOf, locale)
    return day.today ? t('changesTab.today', { time: day.time }) : t('changesTab.dayTime', { date: day.date, time: day.time })
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
  const onUs = waiting.card.onUs.map((row) => waitingItemOf(row, model.can))
  const onCustomer = waiting.card.onCustomer.map((row) => waitingItemOf(row, model.can))
  const mine = mineCountOf([...onUs, ...onCustomer], waiting.card.still)
  // The groups with nothing in them: one quiet line at the foot (never an empty box), then L4's pointer.
  const none = [counts.onUs === 0 ? t('changesTab.waiting.noneUs') : null, counts.onCustomer === 0 ? t('changesTab.waiting.noneCustomer', { customer }) : null].filter(Boolean)
  const rowOf = (item: WaitingItem) => <WaitingItemRow key={item.row.key} item={item} order={order} model={model} actions={actions} asOf={asOf} when={when} />
  return (
    <Section
      id="waiting"
      title={title}
      answer={
        <>
          {answerWords(answer)}
          {mine > 0 ? (
            <>
              {' '}
              <Tag tone="warning">{t('changesTab.waiting.mine', { count: mine })}</Tag>
            </>
          ) : null}
        </>
      }
      info={info}
      more={stamp}
    >
      <div className="fw-oc-groups">
        {onUs.length > 0 && (
          <div className="fw-oc-grp" role="group" aria-labelledby="fw-oc-g-us">
            <div className="fw-oc-grp-h">
              <h3 id="fw-oc-g-us">{t('waiting.onUs', { count: onUs.length })}</h3>
            </div>
            {onUs.map(rowOf)}
          </div>
        )}
        {onCustomer.length > 0 && (
          <div className="fw-oc-grp" role="group" aria-labelledby="fw-oc-g-customer">
            <div className="fw-oc-grp-h">
              <h3 id="fw-oc-g-customer">{t('waiting.onCustomer', { count: onCustomer.length, customer })}</h3>
            </div>
            {onCustomer.map(rowOf)}
          </div>
        )}
        <StillToDo order={order} model={model} actions={actions} />
        <WorkOrderChanges order={order} model={model} actions={actions} />
      </div>
      {none.length > 0 || pointerLink ? (
        <p className="fw-pt-quiet fw-oc-foot">
          {none.join(' ')}
          {none.length > 0 && pointerLink ? ' · ' : null}
          {pointerLink}
        </p>
      ) : null}
    </Section>
  )
}

// ---- F-OC-102: one row — words | detail | who + age | one door (the door only for who acts; the others read who does it) ----
function WaitingItemRow({ item, order, model, actions, asOf, when }: { item: WaitingItem; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; asOf: string | null; when: (at: string) => string }) {
  const t = useT('orders')
  const a = useT(APPROVALS_NS)
  const ra = useT(RECORD_APPROVALS_NS)
  const d = useT(DEPTH)
  const w = useProductionWords()
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? ''
  const { row } = item
  const door = row.door
  const request = door.kind === 'answer' ? door.request : null
  // An approval we asked, as this reader may read it (partners.approvals.view: its own question), as Overview's card says it.
  const approval = row.ref?.type === 'ApprovalRequest' ? ((model.askedOfCustomer?.value ?? []).find((entry) => entry.id === row.ref!.id) ?? null) : null
  const words =
    door.kind === 'yes'
      ? t('changesTab.row.approval', { kind: locale === 'en' ? door.task.kindLabel.en : door.task.kindLabel.it })
      : approval?.question ??
        rowWordsOf(row, { t, kindWords: (kind) => w.t(`parts.request.kind.${kind}`), locale, customer: order.party?.legalName ?? '', askWords: (asked) => askWordsOf(asked, { kind: w.t(`parts.request.kind.${asked.kind}`), say: t, day: w.day }) })
  // The detail lines: who asked and when, their words, what it meant when they asked, what the customer reads of it.
  const detail: { key: string; text: string; quote?: boolean }[] = []
  if (request) {
    if (request.askedBy) detail.push({ key: 'by', text: t('changesTab.row.askedBy', { name: request.askedBy, when: when(request.askedAt) }) })
    if (request.note) detail.push({ key: 'note', text: `“${request.note}”`, quote: true })
    const impact = [request.impact?.earliest?.words, request.impact?.pricedWords].flatMap((part) => (part ? [said(part, locale)] : []))
    if (impact.length > 0) detail.push({ key: 'impact', text: t('changesTab.row.whenAsked', { words: impact.join(' · ') }) })
    detail.push({ key: 'sees', text: t('changesTab.row.theySee', { words: said(request.standing, locale) }), quote: true })
  }
  if (door.kind === 'yes') {
    detail.push({ key: 'by', text: t('changesTab.row.askedBy', { name: door.task.requester.name, when: when(door.task.requestedAt) }) })
    detail.push({ key: 'body', text: d('changeYes.waitingBody') })
  }
  // An approval we asked: by when, and where it stands (the record's own approvals' words).
  if (approval) detail.push({ key: 'due', text: t('changes.onCustomer.due', { date: formatDate(approval.dueAt, { locale }) }) })
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  return (
    <div className="fw-oc-row" id={item.anchor ?? undefined} tabIndex={item.anchor ? -1 : undefined}>
      <div className="fw-oc-row-h">
        <b>{words}</b>
        {approval && <Pill tone="warning">{ra(`status.${approval.status}`)}</Pill>}
      </div>
      <div className="fw-oc-row-x">
        {detail.map((line) => (
          <span key={line.key} className={line.quote ? 'fw-oc-q' : undefined}>
            {line.text}
          </span>
        ))}
      </div>
      <div className="fw-oc-row-m">
        {item.mine && <Tag tone="warning">{a('customerRequest.next.state.yourTurn')}</Tag>}
        {item.who && <span>{t(item.who.key, item.who.params)}</span>}
        <RowAge since={row.since} asOf={asOf} />
      </div>
      <div className="fw-oc-row-d">
        {item.face === 'request' ? (
          <>
            {/* Answer… opens the ONE review window on this page — only for the team that answers the kind (the others read who does). */}
            {item.mine && request && <AnswerDoor request={request} model={model} />}
            {request && <DiscussDoor order={order} part={t('discuss.request', { kind: w.t(`parts.request.kind.${request.kind}`) })} target={{ kind: 'OrderChangeRequest', id: request.id }} align="end" />}
          </>
        ) : item.face === 'problem' ? (
          // L2: a pointer — the problem is answered on Production › Problems & holds (its Reply lives there).
          <Button size="sm" variant="quiet" asChild>
            <TabLink href={`${tabHref(recordHref, 'production', search)}#holds`}>{t('waiting.go.production')}</TabLink>
          </Button>
        ) : door.kind === 'yes' ? (
          // Our approval of an old change: Confirm / Refuse… for its approver only, in place (THE place on this tab).
          item.mine ? <YesDoorView door={yesDoorOf(door.task, model.busy)} onYes={actions?.yes} /> : null
        ) : (
          <WaitingDoorView door={door} order={order} model={model} actions={actions} here="changes" />
        )}
      </div>
    </div>
  )
}
// ---- end F-OC-102

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
