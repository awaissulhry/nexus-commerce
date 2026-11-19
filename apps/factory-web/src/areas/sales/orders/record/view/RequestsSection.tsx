'use client'

import Link from 'next/link'
import type { ReactNode } from 'react' // F-OP-301
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider' // F-OP-116: useScopedT
import { money } from '../../../quotes/model'
import { useProductionWords } from '../../../../../lib/production/words'
import { RequestCard } from '../../../../../lib/production/view/RequestCard'
// F-SA-266: each request's Discuss (its reference: the customer reads its own words) and its anchor ("Show on the page")
import { DiscussDoor } from './Discuss'
import { rowAnchor } from '../dock/discuss'
import { WithMessages } from '../../../../../record-panels/i18n'
import { answerHeld, cardInputOf, said, stillStateOf, waitsForMe } from '../../../../home/approvals/requests/model'
import type { BrandRequest } from '../../../../home/approvals/requests/api'
import { TEAM_WORDS, type ApplyTeam } from '@nexus/factory-domain/sales/change-requests/apply-plan'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { readOf } from '../overview/model'
import type { Order } from '../../api'
import { askingOf, askWordsOf, decisionBandOf, stillGroupsOf, stillRowsOf, type StillRowOf } from '../changes/model'
import { stillDoorsOf } from '../changes/model' // F-OP-116
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { PartState } from './OrderRecordView'
// ---- F-OP-103: a row of the ONE waiting list and its one door (the review window, the thread, the yes, the payment, a tab) ----
import { useSearchParams } from 'next/navigation'
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { tabHref } from '../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../lib/tab-link/TabLink'
import { YesDoorView } from '../../depth/view/DepthBand'
import { yesDoorOf } from '../../depth/model'
import { rowWordsOf, type WaitingDoor, type WaitingRow } from '../overview/model'
import { orderWaitingOf } from '../overview/model' // F-OP-301 (walk #1): the ONE call of the waiting list
import { rowActsOf } from '../../../../../lib/production/work-order-acts/model' // F-OP-116: the row's own Lift rule

/** The words the request card's lines are written with (Home › Approvals' own: `approvals` customerRequest.*). */
const APPROVALS_NS = 'approvals'
/** The approvals-out states' words (the record's own approvals panel's). */
const RECORD_APPROVALS_NS = 'record-approvals'

/**
 * F-SA-236 (sales page plan N2, N3, P5; 10-order-page §2.4 C1, C3) — the top of Changes:
 *
 *   Waiting on us        one shared RequestCard (office face) per customer request that waits on us: its kind and how long it waits,
 *                        who asked, old → new, their words, the impact; its door goes to Home › Approvals' ONE review window (the
 *                        answer from this page comes with S4's doors). A request we countered: "Counter-offer sent · waits for the
 *                        customer".
 *   Waiting on the       what we asked them: the changed order's new yes, the approvals we asked (artwork, proof, sample …), each
 *   customer             with its state and its due day.
 *
 * Only this order's requests (the walled `GET /production/brand-requests?orderId=`) and its own approvals (`GET /approvals-out`).
 *
 * F-OP-301 (walk #1): both lists are the ONE waiting list's rows (`orderWaitingOf`, the call Overview's card and the Changes badge
 * make): a request waiting on us keeps its RequestCard, every other row its words and its door; an approval we asked keeps its own
 * question, due day and state. The changed order's new yes is the band's notice (information only, plan N2), not a row here.
 */
export function RequestsSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[APPROVALS_NS, RECORD_APPROVALS_NS]}>
      <Requests order={order} model={model} actions={actions} />
    </WithMessages>
  )
}

function Requests({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const a = useT(APPROVALS_NS)
  const ra = useT(RECORD_APPROVALS_NS)
  const w = useProductionWords()
  const locale = useLocale()
  // F-OP-301 (walk #1): the ONE waiting list — the same call Overview's card and the Changes badge make, so the counts agree.
  const waiting = orderWaitingOf(order, model, locale)
  const card = waiting.status === 'ready' ? waiting.card : null
  const part = model.requests ?? null
  const requestsReading = !!part && part.value === null && part.problem === null
  const asked = model.askedOfCustomer?.value ?? []
  /** Not ready: the production read's state in this card's words (it reads, or it failed with Try again); never "nothing" before it. */
  const notReady = (label: string) => (waiting.status === 'ready' ? null : <PartState problem={waiting.status === 'failed' ? waiting.problem : null} label={label} onRetry={() => actions?.onRetryProduction?.()} />)
  return (
    <div className="fw-so-cards fw-so-cards--wide">
      <Card padded>
        <div className="fw-so-card-head">
          <h2 className="fw-so-h2">{t('changes.onUs.title')}</h2>
          {card && card.onUs.length > 0 && <span className="fw-so-hint">{t('changes.onUs.count', { count: card.onUs.length })}</span>}
        </div>
        {!card ? (
          notReady(t('changes.onUs.title'))
        ) : card.onUs.length === 0 ? (
          <p className="fw-so-hint">{t('changes.onUs.nothing')}</p>
        ) : (
          <div className="fw-so-stack">
            {card.onUs.map((row) => {
              const request = row.door.kind === 'answer' ? row.door.request : null
              // A request the page has not read yet: its card comes with the read.
              if (row.door.kind === 'answer' && !request && requestsReading) return <Skeleton key={row.key} height={64} />
              if (!request) {
                return (
                  <ul key={row.key} className="fw-so-datelist">
                    <WaitingRowItem row={row} order={order} model={model} actions={actions} here="changes" />
                  </ul>
                )
              }
              return (
                <div key={row.key} id={rowAnchor('OrderChangeRequest', request.id) /* F-SA-266 */} tabIndex={-1}>
                  <RequestCard
                    face="office"
                    request={cardInputOf(request, null, { say: a, locale, day: w.day, money: (minor, currency) => money(minor, currency, locale) })}
                    action={
                      <span className="fw-so-inline">
                        {/* F-SA-243: Answer… opens the ONE review window on this page (Esc returns here); held with the reason when
                            another team answers the kind ("Production answers a pause"). F-OP-301: an agreed or lapsed counter waits
                            on us too — Answer… as well. */}
                        <AnswerDoor request={request} model={model} />
                        {/* F-SA-266: discuss this request (its reference; the customer reads its own words). */}
                        <DiscussDoor order={order} part={t('discuss.request', { kind: w.t(`parts.request.kind.${request.kind}`) })} target={{ kind: 'OrderChangeRequest', id: request.id }} />
                      </span>
                    }
                  />
                </div>
              )
            })}
          </div>
        )}
      </Card>
      <Card padded>
        <div className="fw-so-card-head">
          <h2 className="fw-so-h2">{t('changes.onCustomer.title')}</h2>
          {card && card.onCustomer.length > 0 && <span className="fw-so-hint">{t('changes.onUs.count', { count: card.onCustomer.length })}</span>}
        </div>
        {!card ? (
          notReady(t('changes.onCustomer.title'))
        ) : card.onCustomer.length === 0 ? (
          <EmptyState title={t('changes.onCustomer.nothing')} />
        ) : (
          <ul className="fw-so-datelist">
            {card.onCustomer.map((row) => {
              // F-OP-301: an approval we asked, in its own question with its due day and state (record-approvals' words); our open
              // counter-offer in its own words; the rest in the list's words.
              const approval = row.ref?.type === 'ApprovalRequest' ? (asked.find((entry) => entry.id === row.ref!.id) ?? null) : null
              const counter = row.kind === 'APPROVAL' && row.ref?.type === 'OrderChangeRequest'
              return (
                <WaitingRowItem
                  key={row.key}
                  row={row}
                  order={order}
                  model={model}
                  actions={actions}
                  here="changes"
                  words={approval?.question ?? (counter ? t('changes.onUs.countered') : null)}
                  extra={
                    approval ? (
                      <>
                        {approval.dueAt ? ` · ${t('changes.onCustomer.due', { date: formatDate(approval.dueAt, { locale }) })}` : ''}{' '}
                        <Pill tone="warning">{ra(`status.${approval.status}`)}</Pill>
                      </>
                    ) : null
                  }
                />
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}

// ---- F-SA-243 (sales page plan P5, R1; 14-change-flow §3.1, §3.4; review R-5): Answer… on this page, the band notices, Still to do ----

/** Answer…: a real link that opens the review window on this page; held in words when this reader's team does not answer the kind. */
export function AnswerDoor(props: { request: BrandRequest; model: OrderRecordModel; size?: 'sm' }) {
  return (
    <WithMessages namespaces={[APPROVALS_NS]}>
      <Answer {...props} />
    </WithMessages>
  )
}

function Answer({ request, model, size = 'sm' }: { request: BrandRequest; model: OrderRecordModel; size?: 'sm' }) {
  const t = useT('orders')
  const a = useT(APPROVALS_NS)
  // F-CP-160: the reader's price grain (answerHeld holds a priced counter-offer's accept for a reader without it).
  const held = waitsForMe(request) ? null : answerHeld(request, 'accept', { offline: false, busy: false, price: model.can.price }, 'words')
  const href = model.requestDoor?.hrefOf(request.id) ?? null
  if (held || !href) {
    return (
      <Button size={size} heldReason={held ? a(held) : t('band.answerNone')}>
        {t('band.answer')}
      </Button>
    )
  }
  return (
    <Button size={size} variant="primary" asChild>
      <Link href={href} scroll={false}>
        {t('band.answer')}
      </Link>
    </Button>
  )
}

/**
 * The band's notices of this order's changes, in the ONE banner place (RecordNotices draws the most serious, "N more" behind): the
 * door's own notice after an answer, "<Customer> asks: … · Answer…" (the oldest waiting on us; "N more requests"), and "Change of
 * hh:mm: N steps need a decision · Open" — only while a Still to do row asks THIS reader (Your turn / Needs a decision, R-5).
 */
export function RequestBandNotices({ order, model }: { order: Order; model: OrderRecordModel }) {
  return (
    <WithMessages namespaces={[APPROVALS_NS]}>
      <BandNotices order={order} model={model} />
    </WithMessages>
  )
}

function BandNotices({ order, model }: { order: Order; model: OrderRecordModel }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? '' // F-OP-103: the tab link keeps the dock's scope (F-OP-210)
  const asking = askingOf(model.requests?.value ?? [])
  const decision = decisionBandOf(stillRowsOf(readOf(model.production)))
  const customer = order.party?.legalName ?? ''
  return (
    <>
      {asking && (
        <Banner
          tone="warning"
          title={t('band.asks', { customer: asking.first.party.name || customer, what: askWordsOf(asking.first, { kind: w.t(`parts.request.kind.${asking.first.kind}`), say: t, day: w.day }) })}
          action={<AnswerDoor request={asking.first} model={model} />}
        >
          {asking.more > 0 ? t('band.moreRequests', { count: asking.more }) : undefined}
        </Banner>
      )}
      {decision && (
        <Banner
          tone="warning"
          title={t('band.decision', { time: formatTime(decision.since, { locale }), count: decision.count })}
          action={
            <Button size="sm" variant="quiet" asChild>
              <TabLink href={`${tabHref(`${model.prefix}/sales/orders/${order.id}`, 'changes', search)}#still-to-do` /* F-OP-103 */}>{t('band.open')}</TabLink>
            </Button>
          }
        />
      )}
    </>
  )
}

/**
 * One Still to do row: the step, who acts (the team), its state in the window's own words, since when, its door.
 * F-OP-116 (10-order-page §5.3; R-12): the door in place where it can be — a work-order change: Apply… / Leave as is… (the ONE decide
 * window here); planning's re-promise: Accept / Decline…; a production task: Done by the task's own right, else held "Production does
 * this"; a scrap, a style change, a workshop: a real link (Scrap ›, Products ›, Subcontracting ›).
 */
export function StillRow({ row, order, model, actions }: { row: StillRowOf; order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const a = useT(APPROVALS_NS)
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? '' // F-OP-116: the order's own tabs keep the dock's scope
  const state = stillStateOf(row)
  const team = TEAM_WORDS[row.waitingOn as ApplyTeam]
  const door = stillDoorsOf(row, { prefix: model.prefix, record: `${model.prefix}/sales/orders/${order.id}`, address: (ref) => recordAddress({ type: ref.type, id: ref.id, label: ref.number ?? undefined, companyId: order.companyId, siteId: null }, OFFICE_PAGES), search })
  const busy = model.busy ? t('held.busy') : null
  return (
    <li className="fw-so-still">
      <span className="fw-so-stack-tight">
        <span>{said(row.words, locale)}</span>
        <span className="fw-so-cell-sub">{[team ? said(team, locale) : null, t('changes.still.since', { when: formatDateTime(row.since, { locale }) })].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="fw-so-inline">
        <Pill tone={state.tone}>{a(state.key)}</Pill>
        {/* F-OP-116: the door in place. */}
        {door.kind === 'change' && (
          <>
            <Button size="sm" heldReason={door.held ? t('wo.waitsPlannerShort') : busy} onClick={() => actions?.orderChanges?.onOpen?.(door.changeId)}>
              {t('wo.changeApply')}
            </Button>
            <Button size="sm" variant="quiet" heldReason={door.held ? t('wo.waitsPlannerShort') : busy} onClick={() => actions?.orderChanges?.onOpen?.(door.changeId)}>
              {t('wo.changeLeave')}
            </Button>
          </>
        )}
        {door.kind === 'repromise' && (
          <>
            <Button size="sm" heldReason={door.held ? t('wo.repromiseHeld') : busy} onClick={() => actions?.links?.onAccept?.(door.proposalId)}>
              {t('links.rePromise.accept')}
            </Button>
            <Button size="sm" variant="quiet" heldReason={door.held ? t('wo.repromiseHeld') : busy} onClick={() => actions?.links?.onDeclineStart?.(door.proposalId)}>
              {t('links.rePromise.decline')}
            </Button>
          </>
        )}
        {door.kind === 'task' && (
          <Button size="sm" heldReason={door.held ? t('wo.heldHold') : door.version === null ? t('held.busy') : busy} onClick={() => door.version !== null && actions?.onTaskDone?.(door.taskId, door.version)}>
            {t('wo.done')}
          </Button>
        )}
        {door.kind === 'link' && (
          <Button size="sm" variant="quiet" asChild>
            <Link href={door.href}>{t(`wo.go.${door.label}`)}</Link>
          </Button>
        )}
      </span>
    </li>
  )
}

/**
 * Changes › Still to do: under each accepted change (the customer's request it carries out, or the office's own) its rows, until
 * each is done or left as is; the order's own "Made extra: 4 M" (office only); work orders the reader does not reach counted.
 */
export function StillToDo({ order, model, actions }: { order: Order; model: OrderRecordModel; /* F-OP-116 */ actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[APPROVALS_NS]}>
      <Still order={order} model={model} actions={actions} />
    </WithMessages>
  )
}

function Still({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const read = readOf(model.production)
  const still = read?.changes?.stillToDo ?? null
  const groups = stillGroupsOf(stillRowsOf(read), model.requests?.value ?? [])
  // Not read (no production read yet, or no right): nothing is claimed — no card at all.
  if (!still) return null
  const extra = (read?.lines ?? []).flatMap((line) => line.sizes.flatMap((size) => (size.madeExtraWords ? [{ key: `${line.lineId}:${size.size ?? ''}`, seq: line.seq, words: size.madeExtraWords }] : [])))
  return (
    <section id="still-to-do" className="fw-so-anchor" aria-labelledby="fw-so-still-title" tabIndex={-1 /* F-SA-244: a change line's "Still to do: N" lands here with the focus */}>
      <Card padded>
        <div className="fw-so-card-head">
          <h2 className="fw-so-h2" id="fw-so-still-title">
            {t('changes.still.title')}
          </h2>
          {still.count > 0 && <span className="fw-so-hint">{t('overview.requests.still', { count: still.count })}</span>}
        </div>
        {/* F-OP-304 (walk #7): "Nothing left to do" only when no row stands AND no piece was made extra — the pieces made extra
            are their own list under their own heading, never rows under "nothing". */}
        {groups.length === 0 && extra.length === 0 ? (
          <EmptyState title={t('changes.still.none')} />
        ) : groups.length === 0 ? null : (
          <div className="fw-so-stack">
            {groups.map((group) => (
              <div key={group.requestId ?? 'office'} className="fw-so-stack-tight">
                <p className="fw-so-h3">
                  {group.request
                    ? t('changes.still.changeOf', { kind: w.t(`parts.request.kind.${group.request.kind}`), when: formatDateTime(group.since, { locale }) })
                    : t('changes.still.office', { when: formatDateTime(group.since, { locale }) })}
                </p>
                <ul className="fw-so-datelist">
                  {group.rows.map((row, index) => (
                    <StillRow key={`${row.kind}:${row.ref?.id ?? index}`} row={row} order={order} model={model} actions={actions /* F-OP-116 */} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {extra.length > 0 && (
          <div className="fw-so-stack-tight">
            <p className="fw-so-h3" id="fw-so-still-extra">
              {t('changes.still.madeExtra')}
            </p>
            <ul className="fw-so-datelist" aria-labelledby="fw-so-still-extra">
              {extra.map((entry) => (
                <li key={entry.key} className="fw-so-hint">
                  {t('changes.still.extraLine', { line: entry.seq, words: said(entry.words, locale) })}
                </li>
              ))}
            </ul>
          </div>
        )}
        {still.workOrdersLeftOut > 0 && <p className="fw-so-hint">{t('changes.still.leftOut', { count: still.workOrdersLeftOut })}</p>}
      </Card>
    </section>
  )
}
// ---- end F-SA-243

// ---- F-OP-103 (10-order-page §3.2): one row of the ONE waiting list — its words, since when, and its ONE door ---------------------
/** A waiting row: what waits (the API's words or the page's), since when, its door; an answer row keeps its Discuss (F-SA-266). */
// F-OP-301 (walk #1): the Changes tab draws the same rows — `here` (the tab it is drawn on: no door back to itself), `words` (an
// approval we asked in its own question), `extra` (its due day and state after the since).
export function WaitingRowItem({ row, order, model, actions, here, words: own, extra }: { row: WaitingRow; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; here?: 'changes'; words?: string | null; extra?: ReactNode }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const words = own || rowWordsOf(row, { t, kindWords: (kind) => w.t(`parts.request.kind.${kind}`), locale, customer: order.party?.legalName ?? '' })
  return (
    <li className="fw-so-still">
      <span className="fw-so-stack-tight">
        <span>{words}</span>
        {(row.since || extra) && (
          <span className="fw-so-cell-sub">
            {row.since ? t('changes.still.since', { when: formatDateTime(row.since, { locale }) }) : null}
            {extra}
          </span>
        )}
      </span>
      <span className="fw-so-inline">
        <WaitingDoorView door={row.door} order={order} model={model} actions={actions} here={here} />
        {row.door.kind === 'answer' && <DiscussDoor order={order} part={row.door.request ? t('discuss.request', { kind: w.t(`parts.request.kind.${row.door.request.kind}`) }) : words} target={{ kind: 'OrderChangeRequest', id: row.door.requestId }} />}
      </span>
    </li>
  )
}

/** The row's one door, in place: Answer… (the review window here), Reply in the thread, the yes, Record the payment, or a tab ›. */
function WaitingDoorView({ door, order, model, actions, here }: { door: WaitingDoor; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; here?: 'changes' }) {
  const t = useT('orders')
  const scoped = useScopedT('orders') // F-OP-116: a held phrase may name another catalogue
  const frame = useRecordFrame()
  const search = useSearchParams()?.toString() ?? ''
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const tabLink = (tab: 'production' | 'money' | 'changes', anchor: string | null) => (
    <Button size="sm" variant="quiet" asChild>
      <TabLink href={`${tabHref(recordHref, tab, search)}${anchor ? `#${anchor}` : ''}`}>{t(`waiting.go.${tab}`)}</TabLink>
    </Button>
  )
  switch (door.kind) {
    case 'answer':
      // The request as this page read it opens the ONE review window; not read (yet): Changes, where it is listed.
      // F-OP-301: on Changes itself no link back to it.
      return door.request ? <AnswerDoor request={door.request} model={model} /> : here === 'changes' ? null : tabLink('changes', null)
    case 'reply':
      // This order's conversation at the message the problem was raised with, the box on Reply (the customer reads it).
      return (
        <Button size="sm" heldReason={frame?.compose ? null : t('waiting.noThread')} onClick={() => frame?.compose?.({ messageId: door.messageId, mode: 'reply' })}>
          {t('waiting.reply')}
        </Button>
      )
    case 'yes':
      return <YesDoorView door={yesDoorOf(door.task, model.busy)} onYes={actions?.yes} />
    case 'payment':
      return (
        <Button size="sm" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'depositPayment', requestId: door.requestId })}>
          {t('deposit.record')}
        </Button>
      )
    case 'tab':
      return door.tab === here ? null : tabLink(door.tab, door.anchor) // F-OP-301: never a door to the tab it is drawn on
    case 'lift': {
      // F-OP-116: the work-order row's own Lift (F-OP-114, one copy), on the row the production read gives; held with who does it.
      const row = (readOf(model.production)?.work?.workOrders ?? []).find((entry) => entry.id === door.workOrderId) ?? null
      const acts = model.workOrderActs ?? null
      const lift = row && acts ? (rowActsOf(row, acts.can).menu.find((entry) => entry.act === 'lift') ?? null) : null
      if (!row || !lift) return tabLink('production', 'holds')
      const held = lift.held ? scoped(lift.held.key, lift.held.params) : model.busy ? t('held.busy') : null
      return (
        <Button size="sm" heldReason={held} onClick={() => actions?.workOrderActs?.onAct?.(row, 'lift')}>
          {t('wo.liftPause')}
        </Button>
      )
    }
  }
}
// ---- end F-OP-103
