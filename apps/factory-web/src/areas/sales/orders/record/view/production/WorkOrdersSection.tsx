'use client'

import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import Link from 'next/link'
import { Factory, MessageSquarePlus } from 'lucide-react'
import { ProgressBar, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { Button, Pill, Tag, ToolbarButton } from '@nexus/ui/primitives'
import { useSearchParams } from 'next/navigation'
import { CellSaveMark, DateField } from '../../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../../lib/i18n/provider'
import { useProductionWords } from '../../../../../../lib/production/words'
import { laterOf, planningHref, rowActsOf, stableRows, type RowActs } from '../../../../../../lib/production/work-order-acts/model'
import { recordAddress } from '../../../../../../lib/records/record-links'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { OFFICE_PAGES } from '../../../../../../shell/nav/office-nav'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { ReadinessPill } from '../../../../../production/work-orders/daily/view/DailyParts'
import type { Order } from '../../../api'
import { dayInstant, isFinal, linesNotInProduction, readOnlyOnPage } from '../../../model'
import { rowAnchor } from '../../dock/discuss'
import type { WorkOrderOwn } from '../../overview/api'
import { readOf, say } from '../../overview/model'
import { madeForOf, makeHeldOf, ownProgress } from '../../production'
import { askPresetOf, askStarterOf } from '../../production/asks'
import { decisionsOf, priorityShownOf, rowMenuShown, shownActsOf, statusKeyOf, workDatesOf, workProgressOf, workSummaryOf, WO_TONE } from '../../production/work'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { floorToldAt } from '../../told'
import { LineMenuButton } from '../LineMenu'
import { PartFailed, PartReading, Quiet, Section } from '../../../../../../lib/record-sections/Kit'
import { PriorityRushDialog, WorkOrderDetail, type DetailEntry } from './WorkOrderDetail'

const WORK_ORDERS_NS = 'production-work-orders'

/**
 * F-PT-104 / F-PT-105 (order PRODUCTION tab, 10-design §4; 15-steps W1) — "Work orders": one row per work order with THIS order's own
 * pieces (the production read, B-SA-031 — never another customer's number, name or count), in columns that follow the tab's ROOM
 * (row cards at S, 5 columns at M, 7 at L: production.css), each row its anchor `about-WorkOrder-<id>` ("Show on the page" lands on
 * it). A row opens its centred window (‹ › across the work orders). Above them the waiting decisions, one Decide… each (B5).
 *
 * The acts are the production lane's own (lib/production/work-order-acts: its rule per row, its dialogs mounted once for the page);
 * a door the reader may not use is not drawn (L9) and one line says who does it; Due stays in place, Priority and rush move into one
 * small dialog (same PATCH). The Ask door per row is the ONE note dialog on this order (office only), a question about that work order.
 */
export function WorkOrdersSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const state = model.production ?? null
  const read = readOf(state)
  const work = read?.work ?? null
  const withheld = !!read && (read.withheld.includes('work') || !work)
  const uncovered = work ? work.notInProduction.lines : linesNotInProduction(order)
  const mayMake = order.status === 'CONFIRMED' || order.status === 'IN_PRODUCTION'
  // F-OP-112: Make work orders… in place (the order fixed) — F-PT-104 (L9): only for who may make them; held in words by the deposit.
  const makeWait = makeHeldOf(order, model.can)
  const make = model.makeWorkOrders ?? null
  const showMake = mayMake && model.can.makeWorkOrders && (uncovered > 0 || (!!work && work.workOrders.length === 0 && work.mtm.length === 0))
  const makeLabel = make?.next ? t('wo.makeNext', { style: make.next.code }) : t('step.makeWorkOrders')
  const makeButton = showMake ? (
    <Button key="make" size="sm" variant="primary" heldReason={makeWait ? t(makeWait.key, makeWait.params?.date ? { date: formatDate(dayInstant(String(makeWait.params.date)), { locale }) } : makeWait.params) : null} onClick={() => actions?.makeWorkOrders?.onOpen?.()}>
      <Factory size={14} aria-hidden /> {makeLabel}
    </Button>
  ) : null
  const summary = work ? workSummaryOf(work) : null
  const answer = summary
    ? [t('productionTab.wo.summary', { count: summary.count }), t('productionTab.wo.pieces', { count: summary.pieces }), summary.onHold > 0 ? t('productionTab.wo.onHoldCount', { count: summary.onHold }) : null, summary.afterDue > 0 ? t('productionTab.wo.afterDueCount', { count: summary.afterDue }) : null].filter(Boolean).join(' · ')
    : null
  const workOrderHref = (row: { id: string; number: string }) => `${model.prefix}${recordAddress({ type: 'WorkOrder', id: row.id, label: row.number, companyId: order.companyId }, OFFICE_PAGES)}`

  let body
  if (!state || state.status === 'loading') body = <PartReading rows={3} height={40} />
  else if (state.status === 'failed') body = <PartFailed part={t('productionTab.wo.title')} problem={state.problem} onRetry={() => actions?.onRetryProduction?.()} />
  else if (work && (work.workOrders.length > 0 || work.mtm.length > 0)) body = <Rows order={order} model={model} actions={actions} href={workOrderHref} />
  else if (work) body = <EmptyWork model={model} uncovered={uncovered} />
  else body = <ChainOnly order={order} href={workOrderHref} />
  return (
    <Section id="work-orders" title={t('productionTab.wo.title')} answer={answer} asOf={work ? read!.asOf : null} buttons={makeButton ? [makeButton] : []} info={<p>{t('productionTab.wo.infoBody')}</p>}>
      {body}
      <div className="fw-pt-wo-foot">
        {uncovered > 0 && mayMake && work && (work.workOrders.length > 0 || work.mtm.length > 0) ? <p className="fw-pt-hint">{t('production.uncovered', { count: uncovered })}</p> : null}
        {work && work.workOrdersLeftOut > 0 ? <p className="fw-pt-hint">{t('overview.linked.leftOut', { count: work.workOrdersLeftOut })}</p> : null}
        {withheld && state?.status === 'ready' ? <p className="fw-pt-hint">{t('productionTab.wo.withheld')}</p> : null}
      </div>
    </Section>
  )
}

/** No work order yet: the lines that wait for one (they fill the row), the head's Make work orders opens the dialog. */
function EmptyWork({ model, uncovered }: { model: OrderRecordModel; uncovered: number }) {
  const t = useT('orders')
  const lines = (readOf(model.production)?.lines ?? []).filter((line) => line.notInWorkOrders && line.kind !== 'FEE')
  if (uncovered === 0 || lines.length === 0) return <Quiet>{`${t('production.empty.title')} · ${t('production.empty.body')}`}</Quiet>
  return (
    <>
      <Quiet>{t('productionTab.wo.emptyLines', { count: lines.length })}</Quiet>
      <ul className="fw-pt-ready">
        {lines.map((line) => (
          <li key={line.lineId}>{`${t('discuss.line', { seq: line.seq, name: [line.style?.code ?? null, line.colourway?.name || line.colourway?.code || null].filter(Boolean).join(' ') || '—' })} · ${t('productionTab.wo.pieces', { count: line.ordered })}`}</li>
        ))}
      </ul>
    </>
  )
}

/** Without the work orders' progress (workorders.view): the chain's numbers and states only (the withheld line says why). */
function ChainOnly({ order, href }: { order: Order; href: (row: { id: string; number: string }) => string }) {
  const t = useT('orders')
  const locale = useLocale()
  if (order.chain.workOrders.length === 0) return <Quiet>{`${t('production.empty.title')} · ${t('production.empty.body')}`}</Quiet>
  return (
    <SummaryTable
      label={t('productionTab.wo.title')}
      columns={[t('production.col.number'), t('production.col.status'), t('production.col.released')]}
      rows={order.chain.workOrders.map((row) => ({
        id: row.id,
        cells: [
          <Link key="n" className="fw-pt-link" href={href(row)}>
            {row.number}
          </Link>,
          <Pill key="s" tone={WO_TONE[row.status] ?? 'neutral'}>{t(statusKeyOf(row.status))}</Pill>,
          row.releasedAt ? formatDate(row.releasedAt, { locale }) : '—',
        ],
      }))}
      density="roomy"
      stackOnPhone
    />
  )
}

/** The rows, the waiting decisions above them, the row's window and the Priority and rush dialog (one at a time). */
function Rows({ order, model, actions, href }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; href: (row: { id: string; number: string }) => string }) {
  const t = useT('orders')
  /** fx5 #6: "160 of 160" — this order's pieces of the work order's (its whole not read: the pieces alone). */
  const ownWords = (own: number, total: number | null): string => (total === null ? String(own) : t('productionTab.wo.ownOf', { own, total: Math.max(total, own) }))
  const r = useT(WORK_ORDERS_NS)
  const w = useProductionWords()
  const scoped = useScopedT('orders') // a refusal may name another catalogue (production:error.changed)
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? ''
  const work = readOf(model.production)!.work!
  const acts = model.workOrderActs ?? null
  const act = actions?.workOrderActs
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const [open, setOpen] = useState<string | null>(null)
  const [prio, setPrio] = useState<string | null>(null)
  const rows = stableRows(work.workOrders)
  const offers = new Map<string, RowActs>(rows.map((row) => [row.id, acts ? rowActsOf(row, acts.can) : { shared: row.sharedWithOtherCustomers ? (row.rights?.why ?? null) : null, inline: null, menu: [] }]))
  const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: acts?.can.qualityHold })
  const hidden = !readOnly && [...offers.values()].some((offer) => shownActsOf(offer).hidden)
  const totals = new Map((model.workOrders?.value ?? []).map((row) => [row.id, row.pieces]))
  const readiness = new Map((model.readiness?.value ?? []).map((row) => [row.workOrderId, row]))
  const toldChanges = model.told?.value?.changes ?? [] // F-SA-244
  const toldAt = (id: string) => laterOf(floorToldAt(toldChanges, id), acts?.toldAt[id])
  const mayAsk = !!model.people?.mayNote && !isFinal(order)
  const ask = (row: WorkOrderOwn) => actions?.people?.onAsk?.(askPresetOf(t, askStarterOf({ number: order.number, promise: order.promiseDate, workOrder: { number: row.number, due: row.due } }, day)))
  // The row's ⋯: its open acts (the lib's dialogs), Priority and rush…, then the links. `before` closes a window first (one at a time).
  const menuOf = (row: WorkOrderOwn, before?: () => void): MenuItemDef[] => {
    const shown = shownActsOf(offers.get(row.id)!)
    if (!rowMenuShown(shown)) return [] // F-PT-104b: nothing the row (and its window) does not already give
    const run = (go: () => void) => () => {
      before?.()
      go()
    }
    return [
      ...(shown.inline ? [{ id: 'priority', label: t('productionTab.wo.priorityRush'), onSelect: run(() => setPrio(row.id)) }] : []),
      ...shown.acts.map((entry) => ({ id: entry, label: t(`wo.act.${entry}`), onSelect: run(() => act?.onAct?.(row, entry)) })),
      ...(shown.links.length > 0 ? [{ id: 'links', separator: true }] : []),
      ...shown.links.map((link) => ({ id: `link-${link}`, label: t(`wo.link.${link}`), href: link === 'planning' ? planningHref(model.prefix, row.id) : href(row) })),
    ]
  }
  const entries: DetailEntry[] = [...rows.map((row): DetailEntry => ({ kind: 'wo', id: row.id, row })), ...work.mtm.map((group, index): DetailEntry => ({ kind: 'mtm', id: `mtm-${index}`, group }))]
  const prioRow = prio ? (rows.find((row) => row.id === prio) ?? null) : null
  // A click on the row opens its window — never one on a control inside it (a field, a button, a link, the ⋯).
  const openFrom = (id: string) => (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('a, button, input, select, textarea, [role="menu"], [role="dialog"]')) return
    setOpen(id)
  }
  const openByKey = (id: string) => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && event.target === event.currentTarget) setOpen(id)
  }
  return (
    <>
      <Decisions order={order} model={model} actions={actions} recordHref={`${model.prefix}/sales/orders/${order.id}`} search={search} />
      <div className="fw-pt-wo" role="list" aria-label={t('productionTab.wo.title')}>
        <div className="fw-pt-wo-hd" aria-hidden>
          <div>{t('production.col.number')}</div>
          <div className="fw-pt-c-mk">{t('productionTab.wo.col.making')}</div>
          <div>{t('production.col.own')}</div>
          <div>{t('production.col.progress')}</div>
          <div>{t('productionTab.wo.col.dates')}</div>
          <div className="fw-pt-c-mat">{t('production.col.materials')}</div>
          <div />
        </div>
        {rows.map((row) => {
          const offer = offers.get(row.id)!
          const shown = shownActsOf(offer)
          const progress = workProgressOf(row.own, row.status)
          const dates = workDatesOf(row)
          const where = [row.site?.name || row.site?.code || null, row.line?.name || row.line?.code || null, ...row.workshops.map((shop) => shop.name)].filter(Boolean).join(' · ')
          const colours = row.colourways.map((colour) => colour.name || colour.code).join(', ')
          const madeFor = madeForOf(row.own, totals.get(row.id) ?? null, row.alsoMakes, row.sharedWithOtherCustomers, row.cutWithOtherWork)
          const ready = readiness.get(row.id) ?? null
          const floorAt = toldAt(row.id)
          const save = acts?.saves[row.id] ?? null
          const items = menuOf(row)
          const pill = ready ? (
            <a className="fw-pt-link" href="#materials" aria-label={`${t('production.col.materials')}: ${r(ready.word === 'EXPECTED' && ready.date ? 'readiness.EXPECTED_on' : `readiness.${ready.word}`, ready.date ? { date: day(ready.date) } : undefined)}`}>
              <ReadinessPill word={ready.word} date={ready.date} />
            </a>
          ) : null
          const priority = priorityShownOf(row.priority)
          // ONE figure: the furthest step counted in this tab's words ("Checked 40 of 160", B4); nothing counted yet: the lib's own words.
          const figureText = progress.step ? t('productionTab.wo.figure', { step: t(`productionTab.step.${progress.step}`), done: progress.figure.done ?? 0, total: progress.figure.total }) : w.t(progress.figure.words.key, progress.figure.words.params)
          return (
            <div key={row.id} role="listitem" className="fw-pt-wo-row" id={rowAnchor('WorkOrder', row.id)} tabIndex={0} aria-label={t('productionTab.wo.openDetail', { number: row.number })} onClick={openFrom(row.id)} onKeyDown={openByKey(row.id)}>
              <div className="fw-pt-c-no">
                <span className="fw-pt-inline">
                  {/* fx5 #10: ONE row shape — the number and its Ask door never part (the pill and tags wrap after them). */}
                  <span className="fw-pt-wo-id">
                    <button type="button" className="fw-pt-link fw-pt-wo-num" onClick={() => setOpen(row.id)}>
                      {row.number}
                    </button>
                    {mayAsk && !row.sharedWithOtherCustomers ? <ToolbarButton icon={<MessageSquarePlus size={14} aria-hidden />} label={t('productionTab.wo.ask', { number: row.number })} onClick={() => ask(row)} /> : null}
                  </span>
                  <Pill tone={WO_TONE[row.status] ?? 'neutral'}>{t(statusKeyOf(row.status))}</Pill>
                  {row.held && row.status !== 'ON_HOLD' ? <Tag tone="warning">{t('productionTab.wo.onHold')}</Tag> : null}
                  {row.rush ? <Tag tone="neutral">{t('productionTab.wo.rush')}</Tag> : null}
                </span>
                <span className="fw-pt-sub fw-pt-sub-mk">{[row.style?.code ?? null, colours || null].filter(Boolean).join(' · ')}</span>
                {where ? <span className="fw-pt-sub fw-pt-sub-mk">{where}</span> : null}
                {/* F-SA-244 · B2: when the floor of this work order was last told about a change of the order — the day and the time, never who. */}
                {floorAt ? <span className="fw-pt-sub">{t('productionTab.wo.toldAt', { time: formatDateTime(floorAt, { locale }) })}</span> : null}
                {/* R-11: a work order shared with other customers is changed on its own page only. */}
                {offer.shared ? <span className="fw-pt-sub">{say(offer.shared, locale)}</span> : null}
                {save?.problem ? (
                  <span className="fw-pt-sub" role="alert">
                    {scoped(save.problem.key, save.problem.params)}
                  </span>
                ) : null}
              </div>
              <div className="fw-pt-c-mk">
                <span>{[row.style?.code ?? null, colours || null].filter(Boolean).join(' · ') || '—'}</span>
                {where ? <span className="fw-pt-sub">{where}</span> : null}
              </div>
              <div className="fw-pt-c-own">
                {/* fx5 #6: the column says "For this order"; the cell its own pieces of the work order's ("160 of 160"), one line. */}
                <span className="fw-pt-own-n">{ownWords(row.own.pieces, totals.get(row.id) ?? null)}</span>
                {madeFor.slice(1).map((entry) => (
                  <span key={entry.key} className="fw-pt-sub">
                    {t(entry.key, entry.params)}
                  </span>
                ))}
              </div>
              <div className="fw-pt-c-pr">
                {row.status === 'DRAFT' ? (
                  <span>{t('production.notReleased')}</span>
                ) : (
                  <>
                    <span className="fw-pt-bar">
                      <ProgressBar value={progress.figure.percent} ariaLabel={t('production.progressLabel', { number: row.number, figure: figureText })} height={6} />
                    </span>
                    <span>{figureText}</span>
                  </>
                )}
                {progress.others.length > 0 ? (
                  <span className="fw-pt-sub" title={progress.others.some((entry) => entry.value === null) ? w.t('parts.pieces.notCounted') : undefined}>
                    {progress.others.map((entry) => `${t(`productionTab.step.${entry.step}`)} ${entry.value ?? '—'}`).join(' · ')}
                  </span>
                ) : null}
                {pill ? <span className="fw-pt-sub fw-pt-sub-mat">{pill}</span> : null}
              </div>
              <div className="fw-pt-c-dt">
                {/* F-OP-113: Due in place (a day; empty: no due date), marked while it saves — with the right, the row open; fx5 #14: never on
                    a completed work order (its due day is history). */}
                {shown.inline && row.status !== 'COMPLETED' ? (
                  <span className="fw-pt-inline">
                    <DateField value={row.due ?? ''} onChange={(next) => act?.onDue?.(row, next || null)} clearable ariaLabel={t('wo.dueOf', { number: row.number })} />
                    <CellSaveMark state={save?.field === 'due' ? 'saving' : null} />
                  </span>
                ) : (
                  <span>{dates.due ? t('productionTab.wo.due', { date: day(dates.due) }) : t('productionTab.wo.noDue')}</span>
                )}
                {dates.daysLate !== null ? (
                  <span className="fw-pt-sub">
                    <Tag tone="danger">{t('list.daysLate', { count: dates.daysLate })}</Tag>
                  </span>
                ) : null}
                {dates.planEnd ? (
                  <span className="fw-pt-sub">
                    {t('productionTab.wo.planEnds', { date: day(dates.planEnd) })} {dates.afterDue ? <Tag tone="danger">{t('productionTab.wo.afterDue')}</Tag> : null}
                  </span>
                ) : dates.planned === false ? (
                  <span className="fw-pt-sub">{t('productionTab.wo.notPlanned')}</span>
                ) : null}
                {dates.risk && dates.risk.state !== 'LATE' ? (
                  <span className="fw-pt-sub">
                    <Tag tone={dates.risk.state === 'BLOCKED' ? 'danger' : 'warning'}>{[w.t(`risk.${dates.risk.state}`), dates.risk.blockedBy ? w.t(`blocked.${dates.risk.blockedBy}`) : null].filter(Boolean).join(' · ')}</Tag>
                  </span>
                ) : null}
                {priority !== null ? (
                  <span className="fw-pt-sub">
                    {t('productionTab.wo.priority', { value: priority })} <CellSaveMark state={save?.field === 'priority' || save?.field === 'rush' ? 'saving' : null} />
                  </span>
                ) : save?.field === 'priority' || save?.field === 'rush' ? (
                  <CellSaveMark state="saving" />
                ) : null}
              </div>
              <div className="fw-pt-c-mat">{pill ?? <span className="fw-pt-sub">—</span>}</div>
              <div className="fw-pt-c-more">{items.length > 0 ? <LineMenuButton label={t('wo.acts', { number: row.number })} items={items} /> : null}</div>
            </div>
          )
        })}
        {work.mtm.map((group, index) => {
          const { figure } = ownProgress(group.own, 'RELEASED')
          const id = `mtm-${index}`
          const name = `${group.style?.code ?? '—'} · ${group.colourway?.name ?? group.colourway?.code ?? '—'}`
          return (
            <div key={id} role="listitem" className="fw-pt-wo-row" tabIndex={0} aria-label={t('productionTab.wo.openDetail', { number: name })} onClick={openFrom(id)} onKeyDown={openByKey(id)}>
              <div className="fw-pt-c-no">
                <span>{t('production.mtmRow', { style: group.style?.code ?? '—', colour: group.colourway?.name ?? group.colourway?.code ?? '—', units: group.units, workOrders: group.workOrders })}</span>
                <span className="fw-pt-sub">{group.byStatus.map((entry) => `${t(statusKeyOf(entry.status))} ${entry.count}`).join(' · ')}</span>
              </div>
              <div className="fw-pt-c-mk">
                <span>{name}</span>
              </div>
              <div className="fw-pt-c-own">
                <span className="fw-pt-own-n">{ownWords(group.own.pieces, group.own.pieces)}</span>
              </div>
              <div className="fw-pt-c-pr">
                <span className="fw-pt-bar">
                  <ProgressBar value={figure.percent} ariaLabel={w.t(figure.words.key, figure.words.params)} height={6} />
                </span>
                <span>{w.t(figure.words.key, figure.words.params)}</span>
              </div>
              <div className="fw-pt-c-dt">
                <button type="button" className="fw-pt-link" onClick={() => setOpen(id)}>
                  {t('productionTab.wo.details')}
                </button>
              </div>
              <div className="fw-pt-c-mat" />
              <div className="fw-pt-c-more" />
            </div>
          )
        })}
      </div>
      {/* F-OP-113 · L9: a reader who may not change them reads who does — one line, no grey door. */}
      {hidden ? <p className="fw-pt-hint">{t('wo.heldHint')}</p> : null}
      {open ? (
        <WorkOrderDetail
          entries={entries}
          openId={open}
          orderNumber={order.number}
          readiness={readiness}
          toldAt={toldAt}
          menuOf={(row, close) => menuOf(row, close)}
          onAsk={
            mayAsk
              ? (row) => {
                  setOpen(null)
                  if (!row.sharedWithOtherCustomers) ask(row)
                }
              : null
          }
          hrefOf={href}
          onGo={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {prioRow ? (
        <PriorityRushDialog
          row={prioRow}
          busy={acts?.saves[prioRow.id]?.field === 'priority' || acts?.saves[prioRow.id]?.field === 'rush'}
          onSave={(body) => {
            act?.onPriorityRush?.(prioRow, body)
            setPrio(null)
          }}
          onClose={() => setPrio(null)}
        />
      ) : null}
    </>
  )
}

/**
 * F-PT-105 (B5): "Waiting for a decision" — every work-order change of the order the customer's change proposed (a MAKE_MORE too), the
 * oldest first, ONE Decide… each (the ONE decide window, Approvals' own); who may not decide reads who does and when they were told
 * (the day and the time — B2). At most three, then "+N more on Changes ›".
 */
function Decisions({ order, model, actions, recordHref, search }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; recordHref: string; search: string }) {
  const t = useT('orders')
  const locale = useLocale()
  const { shown, more } = decisionsOf(model.orderChanges?.list?.value, order.lines)
  if (shown.length === 0) return null
  return (
    <div className="fw-pt-dec">
      <h3>{t('productionTab.wo.decisions')}</h3>
      {shown.map((row) => (
        <div key={row.id} className="fw-pt-dec-row">
          {/* fx5 #13: a sentence — what it makes, of what, who changed which line, when it was proposed. */}
          <span>{[[t(row.sentence.verb.key, row.sentence.verb.params), row.sentence.why ? t(row.sentence.why.key, row.sentence.why.params) : null].filter(Boolean).join(' — '), t('productionTab.wo.decision.proposed', { date: formatDate(row.at, { locale }) })].join(' · ')}</span>
          {row.mayDecide ? (
            <Button size="sm" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.orderChanges?.onOpen?.(row.id)}>
              {t('productionTab.wo.decide')}
            </Button>
          ) : (
            <span className="fw-pt-sub">{t('productionTab.wo.waitsPlanner', { time: formatDateTime(row.at, { locale }) })}</span>
          )}
        </div>
      ))}
      {more > 0 ? (
        <TabLink className="fw-pt-link" href={`${tabHref(recordHref, 'changes', search)}#waiting` /* F-OC-104: the rest wait in Changes › Waiting */}>
          {t('productionTab.wo.decisionsMore', { count: more })}
        </TabLink>
      ) : null}
    </div>
  )
}
