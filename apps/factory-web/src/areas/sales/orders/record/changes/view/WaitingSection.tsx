'use client'

import { useSearchParams } from 'next/navigation'
import { TEAM_WORDS, type ApplyTeam } from '@nexus/factory-domain/sales/change-requests/apply-plan'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { useProductionWords } from '../../../../../../lib/production/words'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { said } from '../../../../../home/approvals/requests/model'
import type { Order } from '../../../api'
import { CHANGE_YES_KIND, NAMESPACE as DEPTH, yesDoorOf } from '../../../depth/model'
import { YesDoorView } from '../../../depth/view/DepthBand'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { orderWaitingOf, readOf, rowWordsOf } from '../../overview/model'
import { PartFailed, PartReading, Section } from '../../view/production/Kit' // F-OC-101 (L6): the Production kit, in place
import { AnswerDoor, RowAge, StillDoorView, WaitingDoorView } from '../../view/RequestsSection' // the rows' doors, shared with Overview
import { dayTimeOf, WAITING_ALIASES } from '../layout'
import { askWordsOf, stillGroupsOf, type StillGroup } from '../model'
import { countsOf, holdsPointerOf, lastRevisionOf, lateDaysOf, mineCountOf, stillItemsOf, stillWordsOf, waitingAnswerOf, waitingItemOf, type StillItem, type WaitingAnswer, type WaitingItem } from '../waiting'
import { RowMenu } from './RowMenu' // F-OC-302: the ONE row ⋯
import './changes.css'

/** The catalogues Waiting's rows say their words in (Your turn, an approval's state, the old change's approval body). */
const APPROVALS_NS = 'approvals'
const RECORD_APPROVALS_NS = 'record-approvals'
/** F-OC-103: what the customer reads in its portal's "Waiting for you" (`row.<KIND>`: "Approve the artwork SEED-SO-0002"). */
const PORTAL_WAITING_NS = 'portal-waiting'

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
    <WithMessages namespaces={[APPROVALS_NS, RECORD_APPROVALS_NS, DEPTH, PORTAL_WAITING_NS /* F-OC-103 */]}>
      <Waiting {...props} />
    </WithMessages>
  )
}

function Waiting({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const frame = useRecordFrame() // F-OC-103: Manage in the thread… opens the dock's Approvals window
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
  // walk 13: "As of 10:44" today (the picture's), the day only on another day.
  const stamp = asOf ? <span className="fw-pt-asof">{t('changesTab.waiting.asOf', { when: dayTimeOf(asOf, asOf, locale).today ? dayTimeOf(asOf, asOf, locale).time : when(asOf) })}</span> : null
  // F-OC-105: the two cards that went into Waiting keep their addresses (the band's "Open", Overview's "N more on Changes ›", the
  // dock's change lines): an element at its top; Still to do's own group carries #still-to-do when it is drawn.
  const aliases = (stillDrawn: boolean) => WAITING_ALIASES.filter((alias) => !(stillDrawn && alias === 'still-to-do')).map((alias) => <span key={alias} id={alias} className="fw-oc-alias" tabIndex={-1} />)
  if (waiting.status !== 'ready') {
    return (
      <Section id="waiting" title={title} answer={waiting.status === 'loading' ? t('changesTab.waiting.reading') : null} info={info}>
        {aliases(false)}
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
        {aliases(false)}
      </Section>
    )
  }
  const onUs = waiting.card.onUs.map((row) => waitingItemOf(row, model.can))
  const onCustomer = waiting.card.onCustomer.map((row) => waitingItemOf(row, model.can))
  const mine = mineCountOf([...onUs, ...onCustomer], waiting.card.still)
  // The groups with nothing in them: one quiet line at the foot (never an empty box), then L4's pointer.
  const none = [counts.onUs === 0 ? t('changesTab.waiting.noneUs') : null, counts.onCustomer === 0 ? t('changesTab.waiting.noneCustomer', { customer: customer.replace(/\.$/, '') /* walk 13: "S.r.l.." */ }) : null, counts.still === 0 ? t('changes.still.none') : null].filter(Boolean)
  // F-OC-104: the work orders of the order this reader does not reach — counted, never named (a shared work order is "a work order").
  const leftOut = readOf(model.production)?.changes?.stillToDo?.workOrdersLeftOut ?? 0
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
      {aliases(waiting.card.still.length > 0)}
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
              {/* F-OC-103: ask, see and take back what we asked them — the dock's Approvals window (partners.approvals.ask only). */}
              {model.can.askCustomer && frame?.openDoor ? (
                <>
                  <span className="fw-oc-sp" />
                  <Button size="sm" variant="link" inline onClick={() => frame.openDoor?.('approve')}>
                    {t('changesTab.waiting.manage')}
                  </Button>
                </>
              ) : null}
            </div>
            {onCustomer.map(rowOf)}
          </div>
        )}
        {/* F-OC-104: Still to do, one group per accepted change (#still-to-do lands here: the band's "Open"). */}
        {waiting.card.still.length > 0 && (
          <div className="fw-oc-grp" role="group" aria-labelledby="fw-oc-g-still" id="still-to-do" tabIndex={-1}>
            <div className="fw-oc-grp-h">
              <h3 id="fw-oc-g-still">{t('overview.requests.still', { count: waiting.card.still.length })}</h3>
            </div>
            {stillGroupsOf(waiting.card.still, model.requests?.value ?? []).map((group) => (
              <StillGroupView key={`${group.requestId ?? 'office'}:${group.revision ?? ''}:${group.since}`} group={group} order={order} model={model} actions={actions} asOf={asOf} when={when} />
            ))}
          </div>
        )}
      </div>
      {leftOut > 0 ? <p className="fw-pt-quiet">{t('changes.still.leftOut', { count: leftOut })}</p> : null}
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
  const p = useT(PORTAL_WAITING_NS) // F-OC-103
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
      ? door.task.kind === CHANGE_YES_KIND // fx8: our approval of an old change, in this tab's words
        ? t('changesTab.row.approvalChange')
        : t('changesTab.row.approval', { kind: locale === 'en' ? door.task.kindLabel.en : door.task.kindLabel.it })
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
  // ---- F-OC-103: what waits on the customer — by when (the read's `due`, else the approval's own), how late, what they see ----
  const counter = door.kind === 'open' ? (door.request?.counter ?? null) : null
  const due = row.due ?? approval?.dueAt ?? null
  const late = item.face === 'asked' ? lateDaysOf(due, asOf) : null
  if (counter) {
    // Our counter-offer: what we offered, and the day it lapses (B-OC-003; not said until the server sends it).
    detail.push({ key: 'offer', text: said(counter.offer, locale) })
    if (counter.dueAt) detail.push({ key: 'lapses', text: t('changesTab.row.lapses', { date: formatDate(counter.dueAt, { locale }) }) })
  } else if (due && item.face === 'asked') detail.push({ key: 'due', text: t('changes.onCustomer.due', { date: formatDate(due, { locale }) }) })
  if (row.task?.label) detail.push({ key: 'task', text: row.task.label }) // a portal task: the record it is about
  const sees = approval ? p(`row.${approval.kind}`, { label: locale === 'en' ? approval.record.words.en : approval.record.words.it }) : null
  if (approval && sees && sees !== `row.${approval.kind}`) detail.push({ key: 'sees', text: t('changesTab.row.theySee', { words: sees }), quote: true })
  // ---- end F-OC-103
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  return (
    <div className="fw-oc-row" id={item.anchor ?? undefined} tabIndex={item.anchor ? -1 : undefined}>
      <div className="fw-oc-row-h">
        <b>{words}</b>
        {approval && <Pill tone="warning">{ra(`status.${approval.status}`)}</Pill>}
        {late !== null && <Tag tone="danger">{t('changesTab.row.late', { count: late })}</Tag>}
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
        {/* F-OC-302: the ONE row ⋯ — Discuss a request (by its reference: the customer reads its own words) · Copy link to this row. */}
        <RowMenu order={order} prefix={model.prefix} label={t('changesTab.menu.label')} anchor={item.anchor} discuss={request && model.people?.mayNote !== false /* fx6 (walk 1): Discuss only with threads.post */ ? { part: t('discuss.request', { kind: w.t(`parts.request.kind.${request.kind}`) }), target: { kind: 'OrderChangeRequest', id: request.id } } : null} discussLabel={request ? t('changesTab.menu.discussRequest', { kind: w.t(`parts.request.kind.${request.kind}`).toLocaleLowerCase(locale) }) /* fx8 */ : null} />
      </div>
    </div>
  )
}
// ---- end F-OC-102

// ---- F-OC-104 (10-design §3; L1): Still to do — the head of each accepted change, its rows under it ----------------------------
function StillGroupView({ group, order, model, actions, asOf, when }: { group: StillGroup; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; asOf: string | null; when: (at: string) => string }) {
  const t = useT('orders')
  const w = useProductionWords()
  // "Change accepted · 20/11/2026 10:40" (the customer's request it carries out) · "Revision 3 · 19/11/2026 10:40" (the office's own,
  // B-OC-006) · "Office change · …" until the read names the revision.
  const head = group.request
    ? t('changes.still.changeOf', { kind: w.t(`parts.request.kind.${group.request.kind}`), when: when(group.since) })
    : group.revision !== null
      ? t('changesTab.still.revision', { revision: group.revision, when: when(group.since) })
      : t('changes.still.office', { when: when(group.since) })
  return (
    <>
      <div className="fw-oc-chg-h">
        <span>{head}</span>
      </div>
      {stillItemsOf(group.rows).map((item) => (
        <StillItemRow key={`${item.row.kind}:${item.row.ref?.id ?? item.index}`} item={item} order={order} model={model} actions={actions} asOf={asOf} when={when} />
      ))}
    </>
  )
}

function StillItemRow({ item, order, model, actions, asOf, when }: { item: StillItem; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; asOf: string | null; when: (at: string) => string }) {
  const t = useT('orders')
  const a = useT(APPROVALS_NS)
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? ''
  const { row } = item
  const team = TEAM_WORDS[row.waitingOn as ApplyTeam]
  // A work-order change in ONE sentence — the same builder as Production's strip ("Make 1 fewer on SEED-WO-0411: SEED-JKT-02 · Red —
  // the customer changed line 2"); the read's words when the change itself is not read here.
  const words = stillWordsOf(row, model.orderChanges?.list?.value, order.lines, t, locale) // fx6 (walk 7): the ONE sentence
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const anchor = row.ref ? `still-${row.kind}-${row.ref.id}` : undefined
  return (
    <div className="fw-oc-row" id={anchor} tabIndex={anchor ? -1 : undefined}>
      <div className="fw-oc-row-h">
        <b>{words}</b>
      </div>
      <div className="fw-oc-row-x">
        {/* B-OC-007: the workshop told by itself when this change is applied — its sub-line, never a row of its own. */}
        {item.workshops.map((workshop, index) => (
          <span key={workshop.ref?.id ?? index} className="fw-oc-q">
            {said(workshop.words, locale)}
          </span>
        ))}
      </div>
      <div className="fw-oc-row-m">
        {row.mayAct && <Tag tone="warning">{a('customerRequest.next.state.yourTurn')}</Tag>}
        {/* fx6 (walk 4, L1): a work-order change says who decides and since when — the same words for every reader. */}
        {row.kind === 'WORK_ORDER_CHANGE' ? <span>{t('changesTab.still.waitsPlanner', { when: when(row.since) })}</span> : team && <span>{said(team, locale)}</span>}
        <RowAge since={row.since} asOf={asOf} />
      </div>
      <div className="fw-oc-row-d">
        {row.kind === 'REPROMISE' ? (
          // A new date from planning: THE path is Production › Dates & plan (accepted or declined there, with the dates and the tick).
          <Button size="sm" variant="quiet" asChild>
            <TabLink href={`${tabHref(recordHref, 'production', search)}#dates`}>{t('changesTab.still.newDates')}</TabLink>
          </Button>
        ) : row.kind === 'EXTRA_PIECES' && row.ref?.type === 'SalesOrderAmendment' ? (
          // Charged extra pieces wait for the customer's new yes: see it in the customer's agreement (no amount here).
          <Button size="sm" variant="quiet" asChild>
            <a href="#confirmation">{t('changesTab.still.seeYes')}</a>
          </Button>
        ) : (
          <StillDoorView row={row} order={order} model={model} actions={actions} heldWords={false} />
        )}
        <RowMenu order={order} prefix={model.prefix} label={t('changesTab.menu.label')} anchor={anchor ?? null} />
      </div>
    </div>
  )
}
// ---- end F-OC-104
