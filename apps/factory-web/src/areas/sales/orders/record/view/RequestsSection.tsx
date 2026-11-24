'use client'

import Link from 'next/link'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider' // F-OP-116: useScopedT
import { useProductionWords } from '../../../../../lib/production/words'
import { WithMessages } from '../../../../../record-panels/i18n'
import { answerHeld, waitsForMe } from '../../../../home/approvals/requests/model'
import type { BrandRequest } from '../../../../home/approvals/requests/api'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { readOf } from '../overview/model'
import type { Order } from '../../api'
import { askingOf, askWordsOf, decisionBandOf, stillRowsOf, type StillRowOf } from '../changes/model'
import { stillDoorsOf } from '../changes/model' // F-OP-116
import { rowAgeOf } from '../changes/model' // F-OO-204: a waiting row's age
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
// ---- F-OP-103: a row of the ONE waiting list and its one door (the review window, the thread, the yes, the payment, a tab) ----
import { useSearchParams } from 'next/navigation'
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { tabHref } from '../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../lib/tab-link/TabLink'
import { YesDoorView } from '../../depth/view/DepthBand'
import { yesDoorOf } from '../../depth/model'
import { rowWordsOf, type WaitingDoor, type WaitingRow } from '../overview/model'
import { rowActsOf } from '../../../../../lib/production/work-order-acts/model' // F-OP-116: the row's own Lift rule
// F-CO-K2: a row of Overview's card and its age are the shared overview kit's (GroupRow, RowAge); the order's RowAge is its words over it
import { GroupRow, RowAge as KitRowAge } from '../../../../_shared/record-overview/Overview'

/** The words the request card's lines are written with (Home › Approvals' own: `approvals` customerRequest.*). */
const APPROVALS_NS = 'approvals'

// F-OC-102 (order CHANGES tab, 10-design §3): the two cards "Waiting on us" and "Waiting on the customer" went into Changes › Waiting
// (changes/view/WaitingSection.tsx: the ONE waiting list's rows, each with who does it, its age and its one door). This file keeps
// the parts Overview's card and the band draw with — and Changes' rows reuse: WaitingRowItem, WaitingDoorView, StillDoorView,
// RowAge, AnswerDoor and the band's notices.

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
  const asking = askingOf((model.requests?.value ?? []).filter(waitsForMe) /* F-OC-102: only a reader who may answer it */)
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
          title={t('band.decision', { time: formatDateTime(decision.since, { locale }) /* F-OC-102: every time with its day */, count: decision.count })}
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
 * F-OO-204 (11-design §5.3): a Still to do row's door, in place — ONE copy, drawn by Changes' rows and by Overview's card: Decide…
 * (the ONE decide window), Accept / Decline… (planning's re-promise), Done (a task, its own right), or a real link (Scrap ›,
 * Products ›, Subcontracting ›). Every write sends its version.
 * F-OC-104 (18-lead-settles L1; Production D2): a work-order change is ONE Decide… for who may decide it — the same door as
 * Production's strip — and words for everyone else ("Waits for a planner · told 20/11/2026, 10:40"), no button, no Details door; a
 * production task's Done is hidden without its right (the row's own team words say who does it).
 */
export function StillDoorView({ row, order, model, actions, heldWords = true }: { row: StillRowOf; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; /** fx6 (walk 4): Changes says who decides in its who column. */ heldWords?: boolean }) {
  const t = useT('orders')
  const locale = useLocale() // F-OC-104: the planner's words say the day
  const search = useSearchParams()?.toString() ?? '' // F-OP-116: the order's own tabs keep the dock's scope
  const door = stillDoorsOf(row, { prefix: model.prefix, record: `${model.prefix}/sales/orders/${order.id}`, address: (ref) => recordAddress({ type: ref.type, id: ref.id, label: ref.number ?? undefined, companyId: order.companyId, siteId: null }, OFFICE_PAGES), search })
  const busy = model.busy ? t('held.busy') : null
  return (
    <>
      {/* F-OP-116: the door in place. F-OC-104 (L1): ONE Decide… for who may decide; words for everyone else. */}
      {door.kind === 'change' &&
        (door.held ? (
          heldWords ? <span className="fw-so-hint">{t('changesTab.still.waitsPlanner', { when: formatDateTime(row.since, { locale }) }) /* fx6 (walk 4): since, never "told" */}</span> : null
        ) : (
          <Button size="sm" heldReason={busy} onClick={() => actions?.orderChanges?.onOpen?.(door.changeId)}>
            {t('productionTab.wo.decide')}
          </Button>
        ))}
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
      {/* F-OC-104: the task's Done only for who may tick it (its assignee or a work-order manager, B-OC-005); hidden otherwise. */}
      {door.kind === 'task' && !door.held && (
        <Button size="sm" heldReason={door.version === null ? t('held.busy') : busy} onClick={() => door.version !== null && actions?.onTaskDone?.(door.taskId, door.version)}>
          {t('changesTab.still.markDone') /* fx6 (walk 13) */}
        </Button>
      )}
      {door.kind === 'link' && (
        <Button size="sm" variant="quiet" asChild>
          <Link href={door.href}>{t(`wo.go.${door.label}`)}</Link>
        </Button>
      )}
    </>
  )
}

// ---- end F-SA-243

// ---- F-OP-103 (10-order-page §3.2): one row of the ONE waiting list — its words, since when, and its ONE door ---------------------
/** A waiting row: what waits (the API's words or the page's), since when, its door. */
// F-OO-204 (11-design §5.2, §5.4): on Overview's card a row is `words | age | door` — the age ("15 d") with its exact day in the
// title, no Discuss, and Read-only (`readOnly`) sees the words and the age, no door. A request is said whole as the band says it
// ("<Customer> asks: Change · line 10 · M 40 → 36"); an approval we asked says its own question and its due day.
// F-OC-105: Overview's face only — the Changes tab draws its own rows of the same list (changes/view/WaitingSection.tsx).
export function WaitingRowItem({ row, order, model, actions, readOnly = false }: { row: WaitingRow; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; readOnly?: boolean }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const approval = row.ref?.type === 'ApprovalRequest' ? ((model.askedOfCustomer?.value ?? []).find((entry) => entry.id === row.ref!.id) ?? null) : null
  const due = approval?.dueAt ? t('changes.onCustomer.due', { date: formatDate(approval.dueAt, { locale }) }) : null
  const words =
    approval?.question ??
    rowWordsOf(row, {
      t,
      kindWords: (kind) => w.t(`parts.request.kind.${kind}`),
      locale,
      customer: order.party?.legalName ?? '',
      askWords: (request) => askWordsOf(request, { kind: w.t(`parts.request.kind.${request.kind}`), say: t, day: w.day }), // F-OO-204
    })
  // F-OO-204: Overview's card row (the shared card row's columns). F-CO-K2: the shared overview kit's GroupRow lays them out.
  return (
    <GroupRow age={<RowAge since={row.since} asOf={readOf(model.production)?.asOf ?? null} />} doors={<WaitingDoorView door={row.door} order={order} model={model} actions={actions} readOnly={readOnly} />}>
      {due ? `${words} · ${due}` : words}
    </GroupRow>
  )
}

/**
 * F-OO-204: how long a row waits — "15 d" (the parts' words), counted to the production read's own time; its exact day in the title
 * ("since 02/11/2026, 09:00"); no start known: "—". Shared by the card's request and Still to do rows (and Changes' rows).
 * F-CO-K2: the order's adapter over the shared overview kit's `RowAge` — this says the order's words, the kit draws the cell.
 */
export function RowAge({ since, asOf }: { since: string | null; asOf: string | null }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const age = rowAgeOf(since, asOf)
  return <KitRowAge since={since} words={age ? w.say(age) : null} title={since && age ? t('changes.still.since', { when: formatDateTime(since, { locale }) }) : undefined} />
}

/**
 * The row's one door, in place: Answer… (the review window here), Open… (our counter-offer, the same window), Reply in the thread, the
 * yes, Record the payment, Lift…, or a tab ›; "Their turn" (words, no button) for what we asked the customer. F-OO-204: Read-only gets
 * no door, only the words.
 */
export function WaitingDoorView({ door, order, model, actions, here, readOnly = false }: { door: WaitingDoor; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; here?: 'changes'; readOnly?: boolean }) {
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
  // F-OO-204: what we asked the customer is theirs to answer — said on Overview's card (Changes lists it under "Waiting on the
  // customer", its state beside it); never a button, for anyone.
  if (door.kind === 'their') return here === 'changes' ? null : <span className="fw-so-hint">{t('waiting.theirTurn')}</span>
  if (readOnly) return null
  switch (door.kind) {
    case 'answer':
      // The request as this page read it opens the ONE review window; not read (yet): Changes, where it is listed.
      // F-OP-301: on Changes itself no link back to it.
      // fx6 (walk 2, as Changes does): no button this reader may not use — who answers it, in words.
      if (door.request && !waitsForMe(door.request)) return <span className="fw-so-hint">{t(door.request.answeredIn === 'SALES' ? 'changesTab.who.sales' : 'changesTab.who.production')}</span>
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
    case 'open': {
      // F-OO-204 (11-design §5.3): our open counter-offer opens the ONE review window on this page (`?open=`: our counter, and Decide
      // for <customer> for the one who may); it only opens, so it is never held for a right.
      const href = model.requestDoor?.hrefOf(door.requestId) ?? null
      if (!href) {
        return (
          <Button size="sm" heldReason={t('band.answerNone')}>
            {t('waiting.open')}
          </Button>
        )
      }
      return (
        <Button size="sm" asChild>
          <Link href={href} scroll={false}>
            {t('waiting.open')}
          </Link>
        </Button>
      )
    }
    case 'tab':
      // F-OO-204: a row's tab is Production or Money (what waits on the customer has its own door now), never the tab drawn on.
      return tabLink(door.tab, door.anchor)
    case 'refused':
      // F-OC-102 (L11): the revision they said no to — its row in Changes › What changed (Restore as before… lives there).
      return here === 'changes' ? (
        <Button size="sm" variant="quiet" asChild>
          <a href={`#change-${door.amendmentId}`}>{t('changesTab.open')}</a>
        </Button>
      ) : (
        tabLink('changes', `change-${door.amendmentId}`)
      )
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
