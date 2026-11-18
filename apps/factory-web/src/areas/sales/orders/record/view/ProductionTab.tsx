'use client'

import Link from 'next/link'
import { CalendarClock, CheckCircle2, Clock, Factory, XCircle } from 'lucide-react'
import { Card, Disclosure, EmptyState, KeyValue, ProgressBar, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money } from '../../../quotes/model'
import type { Order } from '../../api'
import { productionWordsFor } from '../../../../../lib/production/words'
import { dayInstant, daysUntil, depositGate, isFinal, isShippedInFull, linesNotInProduction, nextStep, promiseHeld } from '../../model'
import { madeForOf, ownProgress } from '../production'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { PartState } from './OrderRecordView'
import { readOf } from '../overview/model'
import type { Work } from '../overview/api'
// ---- B-W2b-323 (orders in depth on screen): the finish forecast per line; the milestones' card, fed by the order's own read ----
import { ForecastCell, ForecastNote, MilestonesCard } from '../../depth/view/DatesDepth'
import { NAMESPACE as DEPTH } from '../../depth/model'

const WO_TONE = { DRAFT: 'neutral', RELEASED: 'info', IN_PROGRESS: 'info', COMPLETED: 'success', CLOSED: 'neutral', CANCELLED: 'danger' } as const
/** The readiness words are the production lane's (`production-work-orders` readiness.*), reused in place. */
const WORK_ORDERS_NS = 'production-work-orders'

/**
 * F-SA-234 (sales page plan N2, N7, picks P2, P3, P12, P16, R9; 10-order-page §2.3 P1, P2) — Production, the work behind the order:
 *
 *   Work orders     the work orders with the order's OWN pieces (the production read, B-SA-031): where (site · line · an outside
 *                   workshop), "Made for this order 40 of 100 · also makes SO-…" (only this customer's orders the reader reaches; a
 *                   work order of several customers says "also makes work of other orders", a shared cut "cut together with other
 *                   work" — no other number, name or count), status with the hold mark, ONE progress figure of its own cells, due,
 *                   the materials' readiness; made to measure grouped per style × colourway (one row, its units in a centred list).
 *                   Without workorders.view: the chain's numbers and states, and why the progress is not shown.
 *   Dates & …       (#dates) the deposit gate (door: Money), the order's dates, the published plan's days ("Customer sees …"), the
 *                   shipments, the gates and milestones under the order's own right (P16), by line with the finish forecast, and
 *                   every promise move with who and why. Today's Dates card lives here now.
 */
export function ProductionTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[WORK_ORDERS_NS]}>
      <div className="fw-so-stack">
        <WorkOrdersCard order={order} model={model} actions={actions} />
        <section id="dates" className="fw-so-anchor fw-so-stack" aria-labelledby="fw-so-dates-title">
          <DatesCard order={order} model={model} actions={actions} />
          <MilestonesCard part={milestonesPart(model)} onRetry={() => actions?.onRetryProduction?.()} />
          <PromiseMoves order={order} />
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

function WorkOrdersCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const step = nextStep(order, model.can)
  const state = model.production ?? null
  const read = readOf(state)
  const work = read?.work ?? null
  const withheld = !!read && read.withheld.includes('work')
  const uncovered = work ? work.notInProduction.lines : linesNotInProduction(order)
  const makeHref = `${model.prefix}/production/work-orders?new=1&order=${encodeURIComponent(order.number)}`
  const mayMake = order.status === 'CONFIRMED' || order.status === 'IN_PRODUCTION'
  const makeHeld = !model.can.makeWorkOrders ? t('held.noWorkOrders') : order.status === 'CONFIRMED' && step.held ? t(step.held.key, step.held.params?.date ? { date: formatDate(dayInstant(String(step.held.params.date)), { locale }) } : step.held.params) : null
  const workOrderHref = (row: { id: string; number: string }) => `${model.prefix}${recordAddress({ type: 'WorkOrder', id: row.id, label: row.number, companyId: order.companyId }, OFFICE_PAGES)}`

  return (
    <Card padded>
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('production.title')}</h2>
        {mayMake &&
          (makeHeld ? (
            <Button size="sm" variant="primary" heldReason={makeHeld}>
              <Factory size={14} aria-hidden /> {t('step.makeWorkOrders')}
            </Button>
          ) : (
            <Button size="sm" variant="primary" asChild>
              <Link href={makeHref}>
                <Factory size={14} aria-hidden /> {t('step.makeWorkOrders')}
              </Link>
            </Button>
          ))}
      </div>
      {!state || state.status === 'loading' ? (
        <div className="fw-so-stack" aria-busy="true">
          {[0, 1].map((index) => (
            <Skeleton key={index} height={22} />
          ))}
        </div>
      ) : state.status === 'failed' ? (
        <PartState problem={state.problem} label={t('production.title')} onRetry={() => actions?.onRetryProduction?.()} />
      ) : work ? (
        work.workOrders.length === 0 && work.mtm.length === 0 ? (
          <EmptyState title={t('production.empty.title')} description={t('production.empty.body')} />
        ) : (
          <OwnWorkOrders work={work} model={model} href={workOrderHref} />
        )
      ) : order.chain.workOrders.length === 0 ? (
        <EmptyState title={t('production.empty.title')} description={t('production.empty.body')} />
      ) : (
        // Without workorders.view: the chain's numbers and states only, and why the progress is not shown.
        <SummaryTable
          label={t('production.title')}
          columns={[t('production.col.number'), t('production.col.status'), t('production.col.released')]}
          rows={order.chain.workOrders.map((row) => ({
            id: row.id,
            cells: [
              <Link key="n" className="fw-so-link" href={workOrderHref(row)}>
                {row.number}
              </Link>,
              <Pill key="s" tone={WO_TONE[row.status as keyof typeof WO_TONE] ?? 'neutral'}>{t(`woStatus.${row.status}`)}</Pill>,
              row.releasedAt ? formatDate(row.releasedAt, { locale }) : '—',
            ],
          }))}
          density="roomy"
          stackOnPhone
        />
      )}
      {uncovered > 0 && mayMake && <p className="fw-so-hint">{t('production.uncovered', { count: uncovered })}</p>}
      {work && work.workOrdersLeftOut > 0 && <p className="fw-so-hint">{t('overview.linked.leftOut', { count: work.workOrdersLeftOut })}</p>}
      {(withheld || (read && !work)) && <p className="fw-so-hint">{t('production.progressHeld')}</p>}
    </Card>
  )
}

/** The work orders with the order's own pieces, and the made-to-measure groups (one row per style × colourway). */
function OwnWorkOrders({ work, model, href }: { work: Work; model: OrderRecordModel; href: (row: { id: string; number: string }) => string }) {
  const t = useT('orders')
  const r = useT(WORK_ORDERS_NS)
  const locale = useLocale()
  const words = productionWordsFor(locale)
  const totals = new Map((model.workOrders?.value ?? []).map((row) => [row.id, row.pieces]))
  const readiness = new Map((model.readiness?.value ?? []).map((row) => [row.workOrderId, row]))
  const named = (entry: { code: string; name: string } | null) => (entry ? entry.name || entry.code : null)
  const rows = work.workOrders.map((row) => {
    const { figure, notCounted } = ownProgress(row.own, row.status)
    const figureWords = words(figure.words.key, figure.words.params)
    const where = [named(row.site), named(row.line), ...row.workshops.map((shop) => shop.name)].filter((part): part is string => !!part).join(' · ')
    const madeFor = madeForOf(row.own, totals.get(row.id) ?? null, row.alsoMakes, row.sharedWithOtherCustomers, row.cutWithOtherWork)
    const ready = readiness.get(row.id) ?? null
    return {
      id: row.id,
      cells: [
        <span key="n" className="fw-so-cell">
          <Link className="fw-so-link" href={href(row)}>
            {row.number}
          </Link>
          <span className="fw-so-inline">
            <Pill tone={WO_TONE[row.status as keyof typeof WO_TONE] ?? 'neutral'}>{t(`woStatus.${row.status}`)}</Pill>
            {row.held && <Tag tone="warning">{t('production.held')}</Tag>}
            {row.rush && <Tag tone="danger">{t('production.rush')}</Tag>}
          </span>
        </span>,
        <span key="st" className="fw-so-cell">
          <span>{row.style?.code ?? '—'}</span>
          <span className="fw-so-cell-sub">{row.colourways.map((colour) => colour.name || colour.code).join(', ')}</span>
          {where && <span className="fw-so-cell-sub">{where}</span>}
        </span>,
        <span key="own" className="fw-so-cell">
          {madeFor.map((entry, index) => (
            <span key={entry.key} className={index === 0 ? undefined : 'fw-so-cell-sub'}>
              {t(entry.key, entry.params)}
            </span>
          ))}
        </span>,
        <span key="p" className="fw-so-progress">
          <ProgressBar value={figure.percent} ariaLabel={t('production.progressLabel', { number: row.number, figure: figureWords })} height={6} />
          <span className="fw-so-cell-sub">{row.status === 'DRAFT' ? t('production.notReleased') : figureWords}</span>
          {notCounted.map((step) => (
            <span key={step} className="fw-so-cell-sub" title={t(`production.notCounted.${step}`)} aria-label={`${t(`production.step.${step}`)}: ${t(`production.notCounted.${step}`)}`}>
              {t(`production.step.${step}`)} —
            </span>
          ))}
        </span>,
        row.due ? (
          <span key="d" className="fw-so-inline">
            {formatDate(dayInstant(row.due), { locale })}
            {row.daysLate !== null && row.daysLate > 0 && <Tag tone="danger">{t('list.daysLate', { count: row.daysLate })}</Tag>}
          </span>
        ) : (
          '—'
        ),
        ready ? r(ready.word === 'EXPECTED' && ready.date ? 'readiness.EXPECTED_on' : `readiness.${ready.word}`, ready.date ? { date: formatDate(dayInstant(ready.date), { locale }) } : undefined) : '—',
      ],
    }
  })
  const mtm = work.mtm.map((group, index) => ({
    id: `mtm-${index}`,
    cells: [
      <span key="n" className="fw-so-cell">
        <span>{t('production.mtmRow', { style: group.style?.code ?? '—', colour: group.colourway?.name ?? group.colourway?.code ?? '—', units: group.units, workOrders: group.workOrders })}</span>
        <span className="fw-so-cell-sub">{group.byStatus.map((entry) => `${t(`woStatus.${entry.status}`)} ${entry.count}`).join(' · ')}</span>
      </span>,
      <span key="st">{group.style?.code ?? '—'}</span>,
      <span key="own">{t('production.own.all', { own: group.own.pieces })}</span>,
      (() => {
        const { figure } = ownProgress(group.own, 'RELEASED')
        const figureWords = words(figure.words.key, figure.words.params)
        return (
          <span key="p" className="fw-so-progress">
            <ProgressBar value={figure.percent} ariaLabel={figureWords} height={6} />
            <span className="fw-so-cell-sub">{figureWords}</span>
          </span>
        )
      })(),
      '—',
      '—',
    ],
  }))
  return (
    <SummaryTable
      label={t('production.title')}
      columns={[t('production.col.number'), t('production.col.style'), t('production.col.own'), t('production.col.progress'), t('production.col.due'), t('production.col.materials')]}
      rows={[...rows, ...mtm]}
      density="roomy"
      stackOnPhone
      align={['left', 'left', 'left', 'left', 'right', 'left']}
    />
  )
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
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const held = promiseHeld(order, model.can)
  const gate = depositGate(order)
  const request = gate.request
  const planned = readOf(model.production)?.dates?.planned ?? null
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
            <Link href={`${model.prefix}/sales/orders/${order.id}?tab=money`}>{t('gate.money')}</Link>
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
      {/* B-W2b-323: the forecast's read failed (said once). */}
      <ForecastNote model={model.depth} actions={actions?.depth} />
      <SummaryTable
        label={t('dates.linesLabel')}
        columns={[t('dates.col.line'), t('dates.col.requested'), t('dates.col.promised'), t('dates.col.state'), ...(model.depth ? [d('forecast.col')] : []) /* B-W2b-323 */]}
        rows={lines.map((line) => ({
          id: line.id,
          cells: [
            `${line.style?.code ?? '—'} · ${line.colourway ? `${line.colourway.code} ${line.colourway.name}` : '—'}`,
            day(line.requestedDate ?? order.requestedDate),
            line.promiseDate ? day(line.promiseDate) : t('dates.asOrder', { date: day(order.promiseDate) }),
            lateness(line.promiseDate ?? order.promiseDate) ?? '—',
            // B-W2b-323: Production finish forecast (from the plan).
            ...(model.depth ? [<ForecastCell key="f" model={model.depth} lineId={line.id} />] : []),
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
