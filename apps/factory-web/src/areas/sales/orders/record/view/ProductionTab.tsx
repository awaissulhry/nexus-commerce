'use client'

import Link from 'next/link'
import { CalendarClock, CheckCircle2, Clock, Factory, XCircle } from 'lucide-react'
import { Card, Disclosure, EmptyState, KeyValue, ProgressBar, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime /* F-SA-244 */ } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money } from '../../../quotes/model'
import type { Order } from '../../api'
import { productionWordsFor } from '../../../../../lib/production/words'
import { dayInstant, daysUntil, depositGate, isFinal, isShippedInFull, linesNotInProduction, nextStep, promiseHeld } from '../../model'
import { madeForOf, ownProgress } from '../production'
// F-OP-112: Make work orders… in place — why it waits, and the Production page's own New work order dialog (its view, as it is).
import { makeHeldOf } from '../production'
import { NewWorkOrderDialog } from '../../../../production/work-orders/view/NewWorkOrderDialog'
import { forecastPart } from '../production' // F-SA-234b
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { PartState } from './OrderRecordView'
import { readOf } from '../overview/model'
import type { Work } from '../overview/api'
// ---- B-W2b-323 (orders in depth on screen): the finish forecast per line; the milestones' card, fed by the order's own read ----
import { ForecastCell, MilestonesCard } from '../../depth/view/DatesDepth'
import { NAMESPACE as DEPTH } from '../../depth/model'
// ---- F-SA-235: Holds, quality & problems (the work order record's HealthCard, moved to lib/production/health: one card), Materials
// (the customer-supplied materials card, moved from Lines), Specs in force (the tech pack in force, moved from the tab's foot) ----
import { Lock } from 'lucide-react'
import { HealthCard } from '../../../../../lib/production/health/view/HealthCard'
import { useProductionWords } from '../../../../../lib/production/words'
import { MaterialsCard } from '../../materials/view/MaterialsCard'
import { TechPackCard } from '../../confirmation/view/ConfirmationCard'
import { say } from '../overview/model'
// ---- end F-SA-235

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
// F-SA-266: Discuss on Production's rows — the work orders, holds and quality in office notes only (never a reply), a line's dates by
// its reference; each row its anchor ("Show on the page").
import { DiscussDoor } from './Discuss'
import { floorToldAt } from '../told' // F-SA-244: "Told the floor at hh:mm" per work order (never who saw it)
import { rowAnchor } from '../dock/discuss'
// ---- F-OP-113 (10-order-page §5.2; R-11): the work-order rows' acts — Due · Priority · Rush in place, the row ⋯ (DS Menu), a
// shared row read-only with its words; the dialogs are the lib's (lib/production/work-order-acts/view), fed by the container ----
import { MoreHorizontal } from 'lucide-react'
import { Menu } from '@nexus/ui/components'
import { FilterChip, Select } from '@nexus/ui/primitives'
import { CellSaveMark, DateField } from '../../../../../lib/i18n/ds-parts'
import { useScopedT } from '../../../../../lib/i18n/provider'
import { laterOf, priorityChoices, rowActsOf, stableRows, type RowActs } from '../../../../../lib/production/work-order-acts/model'
// F-OP-116: a row's waiting work-order changes ("Change waits: 40 → 28 · Apply… / Leave as is…").
import { changeFiguresOf, changeHeldOf, waitingChangesOf } from '../changes/model'
// ---- end F-OP-113
// ---- F-OP-115: the row ⋯'s links (the planning board at the work order, the work order's own page); the gate's Money door is a
// tab link (F-OP-210: the dock's scope kept, no prefetch) ----
import { useSearchParams } from 'next/navigation'
import { HELD_FOR_SALES, planningHref } from '../../../../../lib/production/work-order-acts/model'
import { tabHref } from '../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../lib/tab-link/TabLink'
// ---- end F-OP-115

export function ProductionTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[WORK_ORDERS_NS, 'production' /* F-SA-235: the HealthCard's words */]}>
      <div className="fw-so-stack">
        <WorkOrdersCard order={order} model={model} actions={actions} />
        <section id="dates" className="fw-so-anchor fw-so-stack" aria-labelledby="fw-so-dates-title">
          <DatesCard order={order} model={model} actions={actions} />
          <MilestonesCard part={milestonesPart(model)} onRetry={() => actions?.onRetryProduction?.()} />
          <PromiseMoves order={order} />
        </section>
        {/* F-SA-235: what holds it, its quality and its problems; the materials; the specs it is made to. */}
        <div className="fw-so-cards fw-so-cards--wide">
          <HoldsQualityCard order={order} model={model} actions={actions} />
          <SpecsCard order={order} model={model} actions={actions} />
        </div>
        <MaterialsCard order={order} model={model.depth} actions={actions?.depth} prefix={model.prefix} />
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
  const state = model.production ?? null
  const read = readOf(state)
  const work = read?.work ?? null
  const withheld = !!read && read.withheld.includes('work')
  const uncovered = work ? work.notInProduction.lines : linesNotInProduction(order)
  const mayMake = order.status === 'CONFIRMED' || order.status === 'IN_PRODUCTION'
  // F-OP-112: Make work orders… opens in place (the order fixed); held in words: no right, the deposit waiting or missing.
  const makeWait = makeHeldOf(order, model.can)
  const makeHeld = makeWait ? t(makeWait.key, makeWait.params?.date ? { date: formatDate(dayInstant(String(makeWait.params.date)), { locale }) } : makeWait.params) : null
  const make = model.makeWorkOrders ?? null
  const makeLabel = make?.next ? t('wo.makeNext', { style: make.next.code }) : t('step.makeWorkOrders')
  const workOrderHref = (row: { id: string; number: string }) => `${model.prefix}${recordAddress({ type: 'WorkOrder', id: row.id, label: row.number, companyId: order.companyId }, OFFICE_PAGES)}`

  return (
    // F-OP-115 (A11's Overview doors): the address #work-orders lands here.
    <Card padded id="work-orders" className="fw-so-anchor">
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('production.title')}</h2>
        {mayMake && (
          <Button size="sm" variant="primary" heldReason={makeHeld} onClick={() => actions?.makeWorkOrders?.onOpen?.()}>
            <Factory size={14} aria-hidden /> {makeLabel}
          </Button>
        )}
      </div>
      {/* F-OP-112: the Production page's New work order dialog, its order fixed (the style step; Create stays on this page). */}
      {make?.dialog && <NewWorkOrderDialog model={make.dialog} can={make.can} actions={actions?.makeWorkOrders?.dialog} />}
      {/* F-OP-113: the dialog a work-order row's ⋯ opened (on the work order read afresh) — F-OP-116: mounted once for the page
          (OrderRecordView), so the waiting list's "Lift the customer's pause…" opens it from any tab. */}
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
          <OwnWorkOrders work={work} model={model} actions={actions /* F-OP-113 */} href={workOrderHref} order={order /* F-SA-266 */} />
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

/**
 * The work orders with the order's own pieces, and the made-to-measure groups (one row per style × colourway).
 * F-OP-113: rows stable by number; Due, Priority and Rush in place (with workorders.manage over the work order; held otherwise, the
 * row's ⋯ saying who does it); the row ⋯ (DS Menu); "Told the floor at hh:mm" after a write that reaches the floor; a work order
 * shared with other customers is read-only here — its link and "Shared with other customers: change it on its page" (R-11).
 */
function OwnWorkOrders({ work, model, actions, href, order }: { work: Work; model: OrderRecordModel; actions?: OrderRecordActions; href: (row: { id: string; number: string }) => string; order: Order }) {
  const t = useT('orders')
  const r = useT(WORK_ORDERS_NS)
  const scoped = useScopedT('orders') // F-OP-113: a phrase may name another catalogue (production:error.changed)
  const locale = useLocale()
  // ---- F-OP-113 ----
  const acts = model.workOrderActs ?? null
  const act = actions?.workOrderActs
  const offers = new Map<string, RowActs>(work.workOrders.map((row) => [row.id, acts ? rowActsOf(row, acts.can) : { shared: row.sharedWithOtherCustomers ? (row.rights?.why ?? null) : null, inline: null, menu: [] }]))
  // F-OP-115: the hint speaks of Production's people only (a planner reading "only the production manager reopens" sees it on the ⋯).
  const heldForReader = [...offers.values()].some((offer) => offer.inline?.held || offer.menu.some((entry) => entry.held?.key === HELD_FOR_SALES.key))
  // ---- end F-OP-113
  const words = productionWordsFor(locale)
  const totals = new Map((model.workOrders?.value ?? []).map((row) => [row.id, row.pieces]))
  const readiness = new Map((model.readiness?.value ?? []).map((row) => [row.workOrderId, row]))
  const named = (entry: { code: string; name: string } | null) => (entry ? entry.name || entry.code : null)
  const toldChanges = model.told?.value?.changes ?? [] // F-SA-244
  const rows = stableRows(work.workOrders).map((row) => {
    const { figure, notCounted } = ownProgress(row.own, row.status)
    const figureWords = words(figure.words.key, figure.words.params)
    const where = [named(row.site), named(row.line), ...row.workshops.map((shop) => shop.name)].filter((part): part is string => !!part).join(' · ')
    const madeFor = madeForOf(row.own, totals.get(row.id) ?? null, row.alsoMakes, row.sharedWithOtherCustomers, row.cutWithOtherWork)
    const ready = readiness.get(row.id) ?? null
    // F-SA-244; F-OP-113: + a write of this page that reached the floor (the later of the two).
    const floorAt = laterOf(floorToldAt(toldChanges, row.id), acts?.toldAt[row.id])
    // ---- F-OP-113: what the row offers its reader, its in-place save ----
    const offer = offers.get(row.id)!
    const inline = offer.inline && !offer.inline.held ? offer.inline : null
    const save = acts?.saves[row.id] ?? null
    const saving = (field: 'due' | 'priority' | 'rush') => <CellSaveMark state={save?.field === field ? 'saving' : null} />
    // ---- end F-OP-113
    return {
      id: row.id,
      cells: [
        <span key="n" className="fw-so-cell" id={rowAnchor('WorkOrder', row.id) /* F-SA-266 */} tabIndex={-1}>
          <span className="fw-so-inline">
            <Link className="fw-so-link" href={href(row)}>
              {row.number}
            </Link>
            {/* F-SA-266: a work order is discussed in an office note only (its number never reaches a customer). */}
            <DiscussDoor order={order} part={row.number} target={{ kind: 'WorkOrder', id: row.id }} officeOnly />
          </span>
          <span className="fw-so-inline">
            <Pill tone={WO_TONE[row.status as keyof typeof WO_TONE] ?? 'neutral'}>{t(`woStatus.${row.status}`)}</Pill>
            {row.held && <Tag tone="warning">{t('production.held')}</Tag>}
            {row.rush && !inline /* F-OP-113: in place it is the Rush chip */ && <Tag tone="danger">{t('production.rush')}</Tag>}
          </span>
          {/* F-SA-244 (R2): when the floor of this work order was last told about a change of the order — never who saw it. */}
          {floorAt && <span className="fw-so-cell-sub">{t('told.floorAt', { time: formatTime(floorAt, { locale }) })}</span>}
          {/* F-OP-116 (10-order-page §5.2): a change waiting on this work order, decided in place (the ONE decide window); a reader who
              may not decide it reads who does and when they were told. */}
          {waitingChangesOf(model.orderChanges?.list?.value, row.id).map((change) => {
            const figures = changeFiguresOf(change)
            const held = changeHeldOf(change)
            const heldWords = held ? t(held.key, { time: formatTime(held.params.at, { locale }) }) : model.busy ? t('held.busy') : null
            return (
              <span key={change.id} className="fw-so-inline fw-so-cell-sub">
                <span>{t('wo.changeWaits', { before: figures.before, after: figures.after })}</span>
                <Button size="sm" heldReason={heldWords} onClick={() => actions?.orderChanges?.onOpen?.(change.id)}>
                  {t('wo.changeApply')}
                </Button>
                <Button size="sm" variant="quiet" heldReason={heldWords} onClick={() => actions?.orderChanges?.onOpen?.(change.id)}>
                  {t('wo.changeLeave')}
                </Button>
              </span>
            )
          })}
          {/* F-OP-113 (R-11): a work order shared with other customers is changed on its own page only. */}
          {offer.shared && <span className="fw-so-cell-sub">{say(offer.shared, locale)}</span>}
          {save?.problem && (
            <span className="fw-so-cell-sub" role="alert">
              {scoped(save.problem.key, save.problem.params)}
            </span>
          )}
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
        // F-OP-113: Due in place (a day; empty: no due date), marked while it saves.
        inline ? (
          <span key="d" className="fw-so-inline">
            <DateField value={row.due ?? ''} onChange={(day) => act?.onDue?.(row, day || null)} clearable ariaLabel={t('wo.dueOf', { number: row.number })} />
            {saving('due')}
            {row.daysLate !== null && row.daysLate > 0 && <Tag tone="danger">{t('list.daysLate', { count: row.daysLate })}</Tag>}
          </span>
        ) : row.due ? (
          <span key="d" className="fw-so-inline">
            {formatDate(dayInstant(row.due), { locale })}
            {row.daysLate !== null && row.daysLate > 0 && <Tag tone="danger">{t('list.daysLate', { count: row.daysLate })}</Tag>}
          </span>
        ) : (
          '—'
        ),
        // F-OP-113: Priority (higher comes first) and the Rush chip in place; read-only words otherwise.
        inline ? (
          <span key="pr" className="fw-so-inline">
            <Select size="sm" value={String(row.priority ?? 0)} onChange={(event) => act?.onPriority?.(row, Number(event.target.value))} aria-label={t('wo.priorityOf', { number: row.number })} title={t('wo.priorityHint')}>
              {priorityChoices(row.priority).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
            {saving('priority')}
            <FilterChip pressed={row.rush} onClick={() => act?.onRush?.(row, !row.rush)} aria-label={t('wo.rushOf', { number: row.number })}>
              {t('production.rush')}
            </FilterChip>
            {saving('rush')}
          </span>
        ) : (
          <span key="pr">{row.priority ?? '—'}</span>
        ),
        ready ? r(ready.word === 'EXPECTED' && ready.date ? 'readiness.EXPECTED_on' : `readiness.${ready.word}`, ready.date ? { date: formatDate(dayInstant(ready.date), { locale }) } : undefined) : '—',
        // F-OP-113: the row ⋯ — each act open, or held with who does it (a shared row has none: its link only).
        ...(acts
          ? [
              offer.menu.length > 0 ? (
                <Menu
                  key="acts"
                  align="right"
                  label={<MoreHorizontal size={16} aria-hidden />}
                  triggerProps={{ 'aria-label': t('wo.acts', { number: row.number }) }}
                  items={[
                    ...offer.menu.map((entry) => ({
                      id: entry.act,
                      label: t(`wo.act.${entry.act}`),
                      disabled: !!entry.held,
                      description: entry.held ? scoped(entry.held.key, entry.held.params) : undefined,
                      onSelect: entry.held ? undefined : () => act?.onAct?.(row, entry.act),
                    })),
                    // F-OP-115: line, workshop, start and outside operations are Planning's (its board, at this work order); the
                    // work order's own page. Real links (⌘-click opens a tab).
                    ...((offer.links ?? []).length > 0 ? [{ id: 'links', separator: true }] : []),
                    ...(offer.links ?? []).map((link) => ({ id: `link-${link}`, label: t(`wo.link.${link}`), href: link === 'planning' ? planningHref(model.prefix, row.id) : href(row) })),
                  ]}
                />
              ) : (
                ''
              ),
            ]
          : []),
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
      '—', // F-OP-113: a made-to-measure group is many work orders: each is changed on its own page
      '—',
      ...(acts ? [''] : []),
    ],
  }))
  return (
    <>
      <SummaryTable
        label={t('production.title')}
        columns={[t('production.col.number'), t('production.col.style'), t('production.col.own'), t('production.col.progress'), t('production.col.due'), t('wo.col.priority') /* F-OP-113 */, t('production.col.materials'), ...(acts ? [t('wo.col.acts')] : [])]}
        rows={[...rows, ...mtm]}
        density="roomy"
        stackOnPhone
        align={['left', 'left', 'left', 'left', 'right', 'left', 'left', ...(acts ? (['right'] as const) : [])]}
      />
      {/* F-OP-113: a reader who may not change them reads who does (the row ⋯ says it again per act). */}
      {heldForReader && <p className="fw-so-hint">{t('wo.heldHint')}</p>}
    </>
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
 * P3 Holds, quality & problems: the order's health (the work order record's HealthCard — computed + shown, Raise to At risk with a
 * curated reason and an office note, Clear; production.brand.manage), what holds its work (in plain words; the office's note per work
 * order with workorders.view, never shared), the open problems that need an answer, the final inspections and the NCRs of its own
 * work orders. Each block without its right is held in one line of words — never an empty list that looks like "none". A hold that
 * serves several customers names none of the others (the read's own words).
 */
function HoldsQualityCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
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
      {model.health && model.health.orders.length > 0 && <HealthCard model={model.health} daysLate={order.daysLate} actions={actions?.health} />}
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
