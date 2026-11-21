'use client'

import Link from 'next/link'
import { CalendarClock, CheckCircle2, Clock, XCircle } from 'lucide-react'
import { Card, Disclosure, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money } from '../../../quotes/model'
import type { Order } from '../../api'
import { dayInstant, daysUntil, depositGate, isFinal, isShippedInFull, nextStep, promiseHeld } from '../../model'
import { forecastPart } from '../production' // F-SA-234b
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { readOf } from '../overview/model'
// ---- B-W2b-323 (orders in depth on screen): the finish forecast per line; the milestones' card, fed by the order's own read ----
import { ForecastCell, MilestonesCard } from '../../depth/view/DatesDepth'
import { NAMESPACE as DEPTH } from '../../depth/model'
// ---- F-SA-235: Holds, quality & problems, Materials (the customer-supplied materials card, moved from Lines), Specs in force (the
// tech pack in force, moved from the tab's foot). F-PT-102: the order's health moved into Production now (one strip, shared rule). ----
import { Lock } from 'lucide-react'
import { useProductionWords } from '../../../../../lib/production/words'
import { MaterialsCard } from '../../materials/view/MaterialsCard'
import { TechPackCard } from '../../confirmation/view/ConfirmationCard'
import { say } from '../overview/model'
// ---- end F-SA-235
// F-SA-266: Discuss on Production's rows — holds and quality in office notes only (never a reply), a line's dates by its reference.
import { DiscussDoor } from './Discuss'
// ---- F-OP-115: the gate's Money door is a tab link (F-OP-210: the dock's scope kept, no prefetch) ----
import { useSearchParams } from 'next/navigation'
import { tabHref } from '../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../lib/tab-link/TabLink'
// ---- end F-OP-115
// ---- F-PT-101 … F-PT-105 (order PRODUCTION tab, W1): the layout, Production now, Work orders (one file per section, view/production) ----
import { NowSection } from './production/NowSection'
import { WorkOrdersSection } from './production/WorkOrdersSection'
import './production/production.css'
// ---- end F-PT-101

/** The readiness words are the production lane's (`production-work-orders` readiness.*), reused in place. */
const WORK_ORDERS_NS = 'production-work-orders'

/**
 * F-PT-101 (order PRODUCTION tab, 10-design §1; 18-lead-settles L10) — the tab's LAYOUT: its root is a size container (production.css:
 * every section chooses by the room the tab has, never the screen — the thread dock opening or closing re-lays it at once), the six
 * sections top to bottom with their addresses: Production now (#now) · Work orders (#work-orders) · Dates & plan (#dates) · Problems &
 * holds (#holds) | What we make it to (#specs) — side by side from 900 px — · Materials (#materials). Each section is its own file
 * (view/production/*); the cards below that W2 – W4 replace stay here until then (one path per job: each goes when its section lands).
 *
 *   Dates & …       (#dates) the deposit gate (door: Money), the order's dates, the published plan's days ("Customer sees …"), the
 *                   shipments, the gates and milestones under the order's own right (P16), by line with the finish forecast, and
 *                   every promise move with who and why.
 */
export function ProductionTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[WORK_ORDERS_NS, 'production' /* F-SA-235 · F-PT-102: the health's and the stages' words */]}>
      <div className="fw-pt">
        <NowSection order={order} model={model} actions={actions} />
        <WorkOrdersSection order={order} model={model} actions={actions} />
        <section id="dates" className="fw-so-anchor fw-so-stack" aria-labelledby="fw-so-dates-title">
          <DatesCard order={order} model={model} actions={actions} />
          <MilestonesCard part={milestonesPart(model)} onRetry={() => actions?.onRetryProduction?.()} />
          <PromiseMoves order={order} />
        </section>
        {/* F-SA-235: what holds it, its quality and its problems; the specs it is made to — F-PT-101 (L10): a pair by the tab's room. */}
        <div className="fw-pt-pairs">
          <HoldsQualityCard order={order} model={model} />
          <div id="specs" className="fw-so-anchor">
            <SpecsCard order={order} model={model} actions={actions} />
          </div>
        </div>
        <section id="materials" className="fw-so-anchor">
          <MaterialsCard order={order} model={model.depth} actions={actions?.depth} prefix={model.prefix} />
        </section>
      </div>
    </WithMessages>
  )
}

/** The gates and milestones of the production read's `dates` (orders.view, P16), as the milestones' card reads them. */
function milestonesPart(model: OrderRecordModel) {
  const state = model.production ?? null
  if (!state) return null
  if (state.status === 'failed') return { value: null, problem: state.problem }
  const dates = readOf(state)?.dates ?? null
  if (!dates) return { value: null, problem: null }
  return { value: { milestones: dates.milestones.map((row) => ({ id: row.id, kind: row.kind as 'GATE' | 'START' | 'SHIP', gateKind: row.gateKind, label: row.label, target: row.target, actual: row.actual, state: row.state as 'DONE' | 'WAITING' | 'STARTED_BEFORE' | 'TO_COME', late: row.late })), next: dates.next, late: dates.late }, problem: null }
}

/**
 * Dates & milestones (#dates; today's Dates card merged in): the deposit gate first (production waits for it; its door: Money), the
 * order's dates (ordered, requested, promised with how late or how far, the first promise — it never changes), the published plan's
 * days ("Customer sees …"), the shipments' days, and by line its dates and the finish forecast.
 */
function DatesCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? '' // F-OP-115: the tab link keeps the address's terms (the dock's scope)
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const held = promiseHeld(order, model.can)
  const gate = depositGate(order)
  const request = gate.request
  const planned = readOf(model.production)?.dates?.planned ?? null
  const forecast = forecastPart(model.production) // F-SA-234b
  const lateness = (promise: string | null) => {
    if (!promise || isFinal(order) || isShippedInFull(order)) return null // F-SA-201: a Delivered order is not late either
    const days = daysUntil(promise, model.today)
    return days < 0 ? <Tag tone="danger">{t('dates.late', { count: -days })}</Tag> : <Tag tone="neutral">{t('dates.left', { count: days })}</Tag>
  }
  const lines = [...order.lines].sort((a, b) => (a.promiseDate ?? order.promiseDate ?? '9999').localeCompare(b.promiseDate ?? order.promiseDate ?? '9999') || a.seq - b.seq)
  const gateWords =
    gate.state === 'WAITING' && request
      ? t('gate.waiting', { date: day(request.dueDate) })
      : gate.state === 'PAID' && request?.paidAt
        ? t('gate.paid', { date: formatDate(request.paidAt, { locale }) })
        : t(`gate.${gate.state === 'PAID' ? 'paidNoDate' : gate.state === 'WAIVED' ? 'waived' : gate.state === 'MISSING' ? 'missing' : 'notNeeded'}`)
  const plannedItems = planned
    ? [
        ...(planned.cutStart ? [{ label: t('dates.cutStart'), value: t('dates.customerSees', { date: day(planned.cutStart) }) }] : []),
        ...(planned.sewStart ? [{ label: t('dates.sewStart'), value: t('dates.customerSees', { date: day(planned.sewStart) }) }] : []),
        ...(planned.finish ? [{ label: t('dates.finish'), value: t('dates.customerSees', { date: day(planned.finish) }) }] : []),
      ]
    : []
  const shipped = order.chain.shipments.filter((shipment) => shipment.shippedAt || shipment.deliveredAt)
  return (
    <Card padded>
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2" id="fw-so-dates-title">
          {t('dates.title')}
        </h2>
        {/* The band's primary is this same action while the order is in production: one button, not two. */}
        {!isFinal(order) && nextStep(order, model.can).kind !== 'changePromise' && (
          <Button size="sm" heldReason={held ? t(held.key) : model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'promise' })}>
            <CalendarClock size={14} aria-hidden /> {t('action.promise')}
          </Button>
        )}
      </div>
      <div className="fw-so-gate">
        {gate.state === 'PAID' || gate.state === 'WAIVED' || gate.state === 'NOT_NEEDED' ? (
          <CheckCircle2 size={18} className="fw-so-ico is-ok" aria-hidden />
        ) : gate.state === 'MISSING' ? (
          <XCircle size={18} className="fw-so-ico is-blocked" aria-hidden />
        ) : (
          <Clock size={18} className="fw-so-ico is-waiting" aria-hidden />
        )}
        <div className="fw-so-gate-body">
          <h3 className="fw-so-h3">{t('gate.title')}</h3>
          <p className="fw-so-gate-words">{gateWords}</p>
          {request && model.can.price && request.amount !== undefined && <p className="fw-so-hint">{t('gate.amount', { amount: money(request.amount, request.currency, locale), kind: t(`depositKind.${request.kind}`) })}</p>}
        </div>
        {request && (
          <Button size="sm" asChild>
            {/* F-OP-115: a tab link (F-OP-210) — the dock's scope kept, never prefetched; was a plain `?tab=money` link. */}
            <TabLink href={tabHref(`${model.prefix}/sales/orders/${order.id}`, 'money', search)}>{t('gate.money')}</TabLink>
          </Button>
        )}
      </div>
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('dates.ordered'), value: day(order.orderDate) },
          { label: t('dates.requested'), value: day(order.requestedDate) },
          {
            label: t('dates.promised'),
            value: (
              <span className="fw-so-inline">
                {day(order.promiseDate)} {lateness(order.promiseDate)}
              </span>
            ),
          },
          { label: t('dates.firstPromised'), value: day(order.originalPromiseDate) },
          ...plannedItems,
          ...shipped.map((shipment) => ({ label: shipment.number, value: shipment.deliveredAt ? t('dates.shippedDelivered', { shipped: shipment.shippedAt ? formatDate(shipment.shippedAt, { locale }) : '—', delivered: formatDate(shipment.deliveredAt, { locale }) }) : t('dates.shippedOn', { shipped: formatDate(shipment.shippedAt!, { locale }) }) })),
        ]}
      />
      <SummaryTable
        label={t('dates.linesLabel')}
        columns={[t('dates.col.line'), t('dates.col.requested'), t('dates.col.promised'), t('dates.col.state'), ...(model.depth ? [d('forecast.col')] : []) /* B-W2b-323 */]}
        rows={lines.map((line) => ({
          id: line.id,
          cells: [
            // F-SA-266: a line's dates discussed by the line's reference (the customer reads its own words, never a price).
            // F-OP-115 (A11's Overview doors): the address #line-<lineId> lands on the line's row.
            <span key="l" className="fw-so-inline fw-so-anchor" id={`line-${line.id}`} tabIndex={-1}>
              {`${line.style?.code ?? '—'} · ${line.colourway ? `${line.colourway.code} ${line.colourway.name}` : '—'}`}
              <DiscussDoor order={order} part={t('discuss.line', { seq: line.seq, name: `${line.style?.code ?? '—'} ${line.colourway?.name ?? ''}`.trim() })} target={{ kind: 'SalesOrderLine', id: line.id }} />
            </span>,
            day(line.requestedDate ?? order.requestedDate),
            line.promiseDate ? day(line.promiseDate) : t('dates.asOrder', { date: day(order.promiseDate) }),
            lateness(line.promiseDate ?? order.promiseDate) ?? '—',
            // B-W2b-323: Production finish forecast (from the plan).
            // F-SA-234b: from the order's own production read (`dates.forecast`), not a read of every site's promise lines.
            ...(model.depth ? [<ForecastCell key="f" part={forecast} lineId={line.id} />] : []),
          ],
        }))}
        density="roomy"
        stackOnPhone
        align={['left', 'right', 'right', 'right', ...(model.depth ? (['right'] as const) : [])]}
      />
    </Card>
  )
}

/** Promise moves: every change of the promise with who, when, from → to, for which lines and why (folded: a disclosure). */
function PromiseMoves({ order }: { order: Order }) {
  const t = useT('orders')
  const locale = useLocale()
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const nameOf = (id: string) => order.people.find((person) => person.id === id)?.name ?? t('dates.someone')
  const lineName = (id: string) => {
    const line = order.lines.find((entry) => entry.id === id)
    return line ? `${line.style?.code ?? '—'} ${line.colourway?.code ?? ''}`.trim() : '—'
  }
  return (
    <Card padded>
      {order.promiseHistory.length === 0 ? (
        <>
          <h2 className="fw-so-h2">{t('dates.historyTitle')}</h2>
          <EmptyState title={t('dates.never')} description={t('dates.neverBody')} />
        </>
      ) : (
        <Disclosure summary={t('dates.historyCount', { count: order.promiseHistory.length })} open>
          <SummaryTable
            label={t('dates.historyTitle')}
            columns={[t('dates.col.when'), t('dates.col.who'), t('dates.col.change'), t('dates.col.reason')]}
            rows={order.promiseHistory.map((entry, index) => ({
              id: `${entry.at}-${index}`,
              cells: [
                formatDateTime(entry.at, { locale }),
                nameOf(entry.actorId),
                <span key="c" className="fw-so-cell">
                  <span>{t('dates.fromTo', { from: day(entry.from), to: day(entry.to) })}</span>
                  <span className="fw-so-cell-sub">{entry.lineIds.length === 0 ? t('dates.wholeOrder') : entry.lineIds.map(lineName).join(', ')}</span>
                </span>,
                entry.reason ?? '—',
              ],
            }))}
            density="roomy"
            stackOnPhone
            align={['left', 'left', 'left', 'left']}
          />
        </Disclosure>
      )}
    </Card>
  )
}

// ---- F-SA-235 (10-order-page §2.3 P3, P4, P5) ------------------------------------------------------------------------------------

/**
 * P3 Holds, quality & problems (F-PT-102: the order's health moved into Production now — one strip, the shared mark rule): what holds its work (in plain words; the office's note per work
 * order with workorders.view, never shared), the open problems that need an answer, the final inspections and the NCRs of its own
 * work orders. Each block without its right is held in one line of words — never an empty list that looks like "none". A hold that
 * serves several customers names none of the others (the read's own words).
 */
function HoldsQualityCard({ order, model }: { order: Order; model: OrderRecordModel }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const read = readOf(model.production)
  const headline = read?.headline ?? null
  const quality = read?.quality ?? null
  const withheld = new Set(read?.withheld ?? [])
  const holds = headline?.holds ?? []
  const notes = headline?.holdNotes ?? null
  const issues = quality?.issues ?? null
  const ncrs = quality?.ncrs ?? null
  const finals = quality?.final ?? null
  // "Nothing" only when every block was read and is empty (a block held back is never "none").
  const none = (list: readonly unknown[] | null) => list !== null && list.length === 0
  const nothing = !!read && holds.length === 0 && none(issues) && none(ncrs) && none(finals)
  const ncrHref = (id: string, number: string) => `${model.prefix}${recordAddress({ type: 'Nonconformance', id, label: number, companyId: order.companyId }, OFFICE_PAGES)}`
  return (
    <div className="fw-so-stack">
      {/* F-OP-115 (A11's Overview doors): the address #holds lands here. */}
      <Card padded id="holds" className="fw-so-anchor">
        <h2 className="fw-so-h2">{t('production.quality.title')}</h2>
        {!read ? (
          <Skeleton height={44} />
        ) : (
          <div className="fw-so-stack">
            {holds.map((hold, index) => (
              <div key={`${hold.kind}-${index}`} className="fw-so-cell">
                <span>{w.t('parts.hold.office.titleWhy', { date: w.day(hold.since), reason: say(hold.words, locale) })}</span>
                <span className="fw-so-cell-sub">{w.t(`parts.hold.office.${hold.kind}`)}</span>
              </div>
            ))}
            {notes && notes.length > 0 && (
              <ul className="fw-so-datelist" aria-label={t('production.quality.notes')}>
                {notes.map((note) => (
                  <li key={`${note.workOrderId}-${note.since}`}>
                    <span className="fw-so-inline">
                      <Lock size={12} aria-hidden /> <strong>{note.number}</strong> {note.note}
                      {/* F-SA-266: a hold is discussed in an office note only. */}
                      <DiscussDoor order={order} part={t('discuss.hold', { number: note.number })} target={{ kind: 'WorkOrder', id: note.workOrderId }} officeOnly />
                    </span>
                    <span className="fw-so-cell-sub">{t('production.quality.officeOnly', { date: formatDate(note.since, { locale }) })}</span>
                  </li>
                ))}
              </ul>
            )}
            {issues === null ? (
              withheld.has('quality.issues') && <p className="fw-so-hint">{t('production.quality.issuesHeld')}</p>
            ) : issues.length > 0 ? (
              <div className="fw-so-stack">
                <h3 className="fw-so-h3">{t('production.quality.needsAnswer', { count: issues.length })}</h3>
                <ul className="fw-so-datelist">
                  {issues.map((issue) => (
                    <li key={issue.id}>
                      <span>{t('production.quality.issue', { since: formatDate(issue.since, { locale }), due: formatDate(dayInstant(issue.dueOn), { locale }) })}</span>
                      {issue.escalation > 0 && <span className="fw-so-cell-sub">{t('production.quality.escalated', { count: issue.escalation })}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {ncrs === null ? (
              withheld.has('quality.ncrs') && <p className="fw-so-hint">{t('production.quality.ncrsHeld')}</p>
            ) : ncrs.length > 0 ? (
              <p className="fw-so-inline">
                <span>{t('production.quality.ncrs', { count: ncrs.length })}</span>
                {ncrs.map((ncr) => (
                  <Link key={ncr.id} className="fw-so-link" href={ncrHref(ncr.id, ncr.number)}>
                    {ncr.number}
                  </Link>
                ))}
              </p>
            ) : null}
            {finals === null ? (
              withheld.has('quality.final') && <p className="fw-so-hint">{t('production.quality.finalHeld')}</p>
            ) : finals.length > 0 ? (
              <ul className="fw-so-datelist" aria-label={t('production.quality.final')}>
                {finals.map((entry) => (
                  <li key={entry.workOrderId}>
                    <span className="fw-so-inline">
                      {t('production.quality.finalRow', { number: entry.number ?? '—', checked: entry.sampleSize })}
                      {/* F-SA-266: quality is discussed in an office note only. */}
                      <DiscussDoor order={order} part={t('discuss.quality', { number: entry.number ?? '—' })} target={{ kind: 'WorkOrder', id: entry.workOrderId }} officeOnly />
                    </span>
                    <span className="fw-so-cell-sub">{t(`production.quality.finalState.${entry.status === 'PASSED' || entry.status === 'FAILED' ? entry.status : 'WAITING'}`, { date: entry.on ? formatDate(dayInstant(entry.on), { locale }) : '—' })}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {nothing && <p className="fw-so-hint">{t('production.quality.nothing')}</p>}
          </div>
        )}
      </Card>
    </div>
  )
}

/**
 * P5 Specs in force: the revision of each style the order is made to (as the order fixes it; else the work order chooses), and the
 * customer's tech pack in force (the request's files: named vs newer, opened in the viewer). An open design change has its place
 * here once the change flow lands (S4).
 */
function SpecsCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const styles = [...new Map(order.lines.map((line) => [line.styleId, line])).values()]
  return (
    <div className="fw-so-stack">
      <Card padded>
        <h2 className="fw-so-h2">{t('production.specs.title')}</h2>
        <ul className="fw-so-datelist">
          {styles.map((line) => (
            <li key={line.styleId}>
              <span>{`${line.style?.code ?? '—'} · ${line.style?.name ?? ''}`}</span>
              <span className="fw-so-cell-sub">{line.styleRevision ? t('lines.revision', { revision: line.styleRevision.revision }) : t('lines.noRevision')}</span>
            </li>
          ))}
        </ul>
      </Card>
      <TechPackCard model={model.depth} actions={actions?.depth} />
    </div>
  )
}
// ---- end F-SA-235
