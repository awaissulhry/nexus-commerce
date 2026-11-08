'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Ban, FileX, Layers, MoreHorizontal, Printer, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu, PerformanceGraph, SummaryTable, Tabs, type TabItem } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Pill, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { CutLog, TicketPrinters, WorkOrder, WorkOrderBundles } from '../../../_shared/api'
import { hideBar } from '../../../_shared/model'
import type { LiveState } from '../../../_shared/hooks'
import type { Allocation, CutRow, Replacement, WorkOrderYield } from '../../api'
import type { CutOrderSummary } from '../../orders/api'
import { againstPlan, areaBalance, feedbackHeld, ORDER_TONE, orderHref, ORDERS_NAMESPACE, planPhrase, shadeLots, underPlan } from '../../orders/model'
import {
  allocateHeld,
  areaNumber,
  CUTTING_NAMESPACE,
  hideLines,
  lotYields,
  percent,
  piecesMatrix,
  PRINT_TONE,
  reasonOk,
  RECORD_TABS,
  recutEntries,
  recutHeld,
  reprintHeld,
  STATE_TONE,
  ticketLines,
  unitWord,
  varianceTone,
  voidHeld,
  yieldChart,
  type CuttingCan,
  type HideLine,
  type Part,
  type Phrase,
  type RecordTab,
  type TicketLine,
} from '../../model'
import { AllocateHidesDialog, say, type AllocModel } from '../../view/CutDialogs'
import type { CuttingActions } from '../../view/CuttingView'
import '../../cutting.css'
import '../../../_shared/production.css'

export type CutDialog = { readonly kind: 'recut'; readonly id: string } | { readonly kind: 'reprint'; readonly id: string } | { readonly kind: 'void'; readonly id: string }

export interface CutRecordModel {
  readonly prefix: string
  readonly can: CuttingCan
  readonly tab: RecordTab
  readonly timeZone: string
  readonly workOrder: { readonly status: 'loading' | 'ready' | 'forbidden' | 'missing' | 'error'; readonly value: WorkOrder | null; readonly problem: string | null }
  /** The cut built from the work order, its cut log and yield (null until the work order is read). */
  readonly cut: CutRow | null
  readonly log: Part<CutLog>
  readonly figures: Part<WorkOrderYield>
  readonly recuts: Part<readonly Replacement[]>
  readonly allocated: Part<readonly Allocation[]>
  readonly bundles: Part<WorkOrderBundles>
  readonly printers: Part<TicketPrinters>
  /** B-W2b-129: the cut orders that name this work order (its fabric lays; a leather group). */
  readonly orders: Part<readonly CutOrderSummary[]>
  readonly live: LiveState
  readonly dialog: CutDialog | null
  readonly alloc: AllocModel | null
  readonly busy: boolean
  readonly problem: Phrase | null
  readonly notice: { readonly tone: 'success' | 'danger'; readonly words: Phrase } | null
}

export interface CutRecordActions extends CuttingActions {
  onDialog?: (dialog: CutDialog | null) => void
  onRetryPart?: (part: 'log' | 'figures' | 'recuts' | 'allocated' | 'bundles' | 'orders') => void
  onRecutDone?: (replacementId: string, cutLogId: string) => void
  onReprint?: (bundleId: string, reason: string, printerId: string) => void
  onVoid?: (bundleId: string, reason: string) => void
}

/**
 * SCR-238 — a cut (design production.cutting "Record: Cut", opens as a record page; Owner L1: the tabs in the band):
 * one work order's leather, cut by hide at the cutting table (its fabric lays are on cut orders, listed). The band: ‹ Cutting, "Cut ·
 * <number>", its state, style, due date, Allocate hides (the Find hides dialog) and the work order. The tabs: Lay or
 * hides (each hide's grade, shade, area before, used, remnant, waste and state, the same shade lot check (W2b), its
 * AreaBalanceBar, the hides allocated and not cut yet, the cut orders naming the work order), Pieces (part × size: planned,
 * cut, short, recut; the recuts asked for scrapped pieces, marked cut by their cut log entry), Yield (a bar per hide with the
 * planned line; issued vs used vs returned (W2b); per lot and supplier, a lot raised with its supplier (W2b)) and Tickets (the bundle
 * tickets of this cut, their print state, reprints with the reason, voids before any scan). A work order on hold says
 * why: the cutting table refuses every cut of it, in those words, until quality releases the hold. Never who cut.
 */
export function CutRecordView({ model, actions }: { model: CutRecordModel; actions?: CutRecordActions }) {
  return (
    <WithMessages namespaces={[CUTTING_NAMESPACE, ORDERS_NAMESPACE, 'lists']}>
      <Record model={model} actions={actions} />
    </WithMessages>
  )
}

function Record({ model, actions }: { model: CutRecordModel; actions?: CutRecordActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const listHref = `${model.prefix}/production/cutting`
  const loaded = model.workOrder
  const missing = !model.can.view ? 'production.cutting.view' : !model.can.workOrders ? 'workorders.view' : null
  if (missing || loaded.status !== 'ready' || !loaded.value) {
    return (
      <div className="fw-ct">
        <DetailHeader dense backAsChild backLabel={<Link href={listHref}>{t('record.back')}</Link>} title={loaded.status === 'loading' && !missing ? <Skeleton width={240} height={22} /> : t('record.title')} />
        <Card padded aria-busy={loaded.status === 'loading' && !missing}>
          {loaded.status === 'loading' && !missing ? (
            <div className="fw-ct-body">
              <p className="fw-ct-hint" role="status">
                <Spinner size={14} /> {t('record.loading')}
              </p>
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} height={22} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={missing || loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={missing ? t('record.state.forbidden.title') : t(`record.state.${loaded.status === 'ready' ? 'missing' : loaded.status}.title`)}
              description={missing ? t('page.noAccess.body', { permission: missing }) : loaded.status === 'error' ? t(loaded.problem ?? 'problem.read') : t(`record.state.${loaded.status === 'ready' ? 'missing' : loaded.status}.body`)}
              action={
                loaded.status === 'error' && !missing ? (
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={listHref}>{t('record.backToList')}</Link>
                  </Button>
                )
              }
            />
          )}
        </Card>
      </div>
    )
  }
  return <Ready workOrder={loaded.value} model={model} actions={actions} />
}

function Ready({ workOrder, model, actions }: { workOrder: WorkOrder; model: CutRecordModel; actions?: CutRecordActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const cut = model.cut
  const recordHref = `${model.prefix}/production/cutting/${workOrder.id}`
  const allocWhy = say(t, allocateHeld(cut, model.can))
  const count = (tab: RecordTab): number | null => {
    if (tab === 'lay') return model.log.value?.hides.length ?? null
    if (tab === 'pieces') return model.recuts.value ? model.recuts.value.filter((recut) => recut.status === 'OPEN').length || null : null
    if (tab === 'yield') return null
    return model.bundles.value?.bundles.filter((bundle) => bundle.status === 'ACTIVE').length ?? null
  }
  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({ id: tab, href: `${recordHref}?tab=${tab}`, label: t(`tab.${tab}`), count: count(tab) }))
  const more = [
    { id: 'workOrder', label: t('record.openWorkOrder'), href: `${model.prefix}/production/work-orders/${workOrder.id}?tab=cutting` },
    {
      id: 'copy',
      label: t('record.copyNumber'),
      onSelect: () => {
        void navigator.clipboard?.writeText(workOrder.number).catch(() => undefined)
      },
    },
  ]
  return (
    <div className="fw-ct">
      <div className="fw-ct-band">
        <DetailHeader
          dense
          backAsChild
          backLabel={<Link href={`${model.prefix}/production/cutting`}>{t('record.back')}</Link>}
          title={t('record.titleOf', { number: workOrder.number })}
          meta={
            <span className="fw-ct-inline">
              {cut && <Pill tone={STATE_TONE[cut.state]}>{t(`state.${cut.state}`)}</Pill>}
              <span className="fw-ct-hint">
                {workOrder.style.code} · {workOrder.style.name}
                {workOrder.dueDate ? ` · ${t('list.due', { date: formatDate(`${workOrder.dueDate}T12:00:00Z`, place) })}` : ''}
                {` · ${t('kind.LEATHER')}`}
              </span>
            </span>
          }
          status={<span className="fw-ct-status">{t(`live.${model.live}`)}</span>}
          actions={
            <span className="fw-ct-actions">
              <Button size="sm" variant={cut?.state === 'WAITING' ? 'primary' : undefined} heldReason={allocWhy} onClick={() => actions?.onAllocate?.(workOrder.id)}>
                <Layers size={14} aria-hidden /> {t('alloc.open')}
              </Button>
              <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('page.more') }} items={more} />
            </span>
          }
        />
        <Tabs ariaLabel={t('record.tabs')} tabs={tabs} active={model.tab} size="sm" />
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {workOrder.status === 'ON_HOLD' && <Banner tone="warning" title={t('record.held.title')}>{t('record.held.body', { reason: workOrder.hold?.reason ?? t('common.noReason') })}</Banner>}

      <div className="fw-ct-body">
        {model.tab === 'lay' && <LayTab model={model} actions={actions} />}
        {model.tab === 'pieces' && <PiecesTab model={model} actions={actions} />}
        {model.tab === 'yield' && <YieldTab model={model} actions={actions} />}
        {model.tab === 'tickets' && <TicketsTab model={model} actions={actions} />}
      </div>

      {model.alloc && <AllocateHidesDialog model={model.alloc} can={model.can} actions={actions} />}
      {model.dialog?.kind === 'recut' && <RecutDialog model={model} id={model.dialog.id} actions={actions} />}
      {model.dialog?.kind === 'reprint' && <ReprintDialog model={model} id={model.dialog.id} actions={actions} />}
      {model.dialog?.kind === 'void' && <VoidDialog model={model} id={model.dialog.id} actions={actions} />}
    </div>
  )
}

function PartState({ label, part, onRetry }: { label: string; part: Part<unknown>; onRetry?: () => void }) {
  const t = useT(CUTTING_NAMESPACE)
  if (part.problem) {
    return (
      <Card padded>
        <EmptyState title={t('part.failed', { part: label })} description={t(part.problem)} action={onRetry ? <Button size="sm" onClick={onRetry}>{t('common.retry')}</Button> : undefined} />
      </Card>
    )
  }
  return (
    <Card padded aria-busy="true">
      <p className="fw-ct-hint" role="status">
        <Spinner size={14} /> {t('part.loading', { part: label })}
      </p>
    </Card>
  )
}

// ---- Lay or hides -----------------------------------------------------------------------------------------------------------------

/** AreaBalanceBar (design "(new)", composed here: the DS has none): a hide's issued area as cut + waste + returned + left. */
function AreaBalanceBar({ line }: { line: HideLine }) {
  const t = useT(CUTTING_NAMESPACE)
  const locale = useLocale()
  const bar = hideBar(line.bar)
  return (
    <div className="fw-ct-bar-card">
      <div className="fw-ct-card-head">
        <span className="fw-ct-code">{line.code}</span>
        <Tag tone={line.state === 'CONSUMED' ? 'neutral' : line.state === 'REMNANT' ? 'info' : 'warning'}>{t(`hideState.${line.state}`)}</Tag>
      </div>
      <span className="fw-ct-hint">{t('lay.issued', { lot: line.lotCode, area: areaNumber(line.bar.issued, locale), uom: unitWord(line.uom) })}</span>
      <div className="fw-pr-bar" role="img" aria-label={bar.parts.map((part) => `${t(`lay.area.${part.part}`)} ${areaNumber(part.value, locale)}`).join(', ')}>
        {bar.parts
          .filter((part) => part.percent > 0)
          .map((part) => (
            <span key={part.part} className={`is-${part.part}`} style={{ width: `${part.percent}%` }} />
          ))}
      </div>
      <ul className="fw-pr-legend">
        {bar.parts.map((part) => (
          <li key={part.part}>
            <span className={`fw-pr-swatch is-${part.part}`} aria-hidden />
            {t(`lay.area.${part.part}`)} {areaNumber(part.value, locale)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function LayTab({ model, actions }: { model: CutRecordModel; actions?: CutRecordActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const locale = useLocale()
  const log = model.log.value
  const lines = useMemo(() => (log ? hideLines(log, model.figures.value) : []), [log, model.figures.value])
  const columns = useMemo<ColDef<HideLine>[]>(() => {
    const HideCell = ({ data }: ICellRendererParams<HideLine>) =>
      data ? (
        <span className="fw-ct-cell">
          {model.can.stock ? (
            <Link className="fw-ct-link" href={`${model.prefix}/warehouse/hides/${data.hideId}`}>
              {data.code}
            </Link>
          ) : (
            <span className="fw-ct-code">{data.code}</span>
          )}
          <span className="fw-ct-sub">{t('lay.lot', { lot: data.lotCode })}</span>
        </span>
      ) : null
    const area = (value: string | null, uom: string) => (value === null ? '—' : `${areaNumber(value, locale)} ${unitWord(uom)}`)
    return [
      { colId: 'hide', headerName: t('lay.col.hide'), minWidth: 150, flex: 1.1, cellRenderer: HideCell, valueGetter: (params) => params.data?.code ?? '' },
      { colId: 'grade', headerName: t('lay.col.grade'), minWidth: 70, flex: 0.5, valueGetter: (params) => params.data?.grade ?? '—' },
      { colId: 'shade', headerName: t('lay.col.shade'), minWidth: 80, flex: 0.6, valueGetter: (params) => params.data?.shade ?? '—' },
      { colId: 'before', headerName: t('lay.col.before'), minWidth: 110, flex: 0.8, type: 'rightAligned', valueGetter: (params) => (params.data ? area(params.data.areaIn, params.data.uom) : '') },
      { colId: 'used', headerName: t('lay.col.used'), minWidth: 110, flex: 0.8, type: 'rightAligned', valueGetter: (params) => (params.data ? area(params.data.used, params.data.uom) : '') },
      { colId: 'remnant', headerName: t('lay.col.remnant'), minWidth: 110, flex: 0.8, type: 'rightAligned', valueGetter: (params) => (params.data ? area(params.data.remnant, params.data.uom) : '') },
      {
        colId: 'waste',
        headerName: t('lay.col.waste'),
        minWidth: 110,
        flex: 0.8,
        type: 'rightAligned',
        valueGetter: (params) => (params.data ? `${area(params.data.waste, params.data.uom)}${params.data.wastePct !== null ? ` · ${percent(params.data.wastePct, locale)}` : ''}` : ''),
      },
      { colId: 'state', headerName: t('lay.col.state'), minWidth: 120, flex: 0.8, valueGetter: (params) => (params.data ? t(`hideState.${params.data.state}`) : '') },
    ]
  }, [t, locale, model.prefix, model.can.stock])
  if (!log) return <PartState label={t('tab.lay')} part={model.log} onRetry={() => actions?.onRetryPart?.('log')} />
  const allocated = model.allocated.value
  return (
    <>
      <section className="fw-ct-card" aria-label={t('lay.hides')}>
        <div className="fw-ct-card-head">
          <h2 className="fw-ct-h2">{t('lay.hides')}</h2>
        </div>
        <ListFrame<HideLine>
          label={t('lay.hides')}
          rows={lines}
          rowId={(row) => row.hideId}
          columns={columns}
          count={t('lay.count', { count: lines.length })}
          listKey={null}
          state={lines.length === 0 ? <EmptyState title={t('lay.empty.title')} description={t('lay.empty.body')} /> : undefined}
        />
        <ShadeLotCheck lines={lines} allocated={model.allocated.value ?? []} />
      </section>
      <div className="fw-ct-cards">
        <Card padded className="fw-ct-card">
          <h2 className="fw-ct-h2">{t('lay.balance')}</h2>
          {lines.length === 0 ? <p className="fw-ct-hint">{t('lay.noBalance')}</p> : <div className="fw-ct-bars">{lines.map((line) => <AreaBalanceBar key={line.hideId} line={line} />)}</div>}
        </Card>
        <Card padded className="fw-ct-card">
          <div className="fw-ct-card-head">
            <h2 className="fw-ct-h2">{t('lay.allocated')}</h2>
            <Button size="sm" heldReason={say(t, allocateHeld(model.cut, model.can))} onClick={() => model.cut && actions?.onAllocate?.(model.cut.workOrder.id)}>
              <Layers size={13} aria-hidden /> {t('alloc.open')}
            </Button>
          </div>
          {!model.can.stock ? (
            <p className="fw-ct-hint">{t('page.noAccess.body', { permission: 'inventory.stock.view' })}</p>
          ) : model.allocated.problem ? (
            <p className="fw-ct-hint">{t(model.allocated.problem)}</p>
          ) : !allocated ? (
            <p className="fw-ct-hint" role="status">
              <Spinner size={12} /> {t('part.loading', { part: t('lay.allocated') })}
            </p>
          ) : allocated.length === 0 ? (
            <p className="fw-ct-hint">{t('lay.noAllocated')}</p>
          ) : (
            <ul className="fw-ct-list">
              {allocated.map((row) => (
                <li key={row.id}>
                  <span className="fw-ct-code">{row.hide?.code}</span>
                  <span className="fw-ct-hint">
                    {row.lot?.code ?? '—'} · {areaNumber(row.quantity, locale)} {unitWord(row.item.baseUom)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="fw-ct-hint">{t('lay.allocatedHint')}</p>
        </Card>
      </div>
      <OrdersOfWorkOrder model={model} actions={actions} />
    </>
  )
}

/**
 * rec:Cut/lay/ct-hides#1 — the W2b same shade lot check (SCM-206 "one shade lot per order"): the hides cut and allocated for
 * this work order by lot and shade. One: said; more: a warning in words (the table warns and a lead signs Cut anyway; the
 * reserve refuses another lot without inventory.shade.override).
 */
function ShadeLotCheck({ lines, allocated }: { lines: readonly HideLine[]; allocated: readonly Allocation[] }) {
  const o = useT(ORDERS_NAMESPACE)
  const lots = shadeLots(lines.map((line) => ({ lotCode: line.lotCode, shade: line.shade })), allocated)
  if (lots.length === 0) return <p className="fw-ct-hint">{o('shadeLot.none')}</p>
  const words = lots.map((lot) => o('shadeLot.lot', { lot: lot.lot, shade: lot.shade ?? o('shadeLot.unknown'), count: lot.hides })).join(' · ')
  if (lots.length === 1) {
    return (
      <p className="fw-ct-inline">
        <Tag tone="success">{o('shadeLot.one')}</Tag>
        <span className="fw-ct-hint">{words}</span>
      </p>
    )
  }
  return <Banner tone="warning" title={o('shadeLot.many', { count: lots.length })}>{`${words}. ${o('shadeLot.rule')}`}</Banner>
}

/**
 * rec:Cut/lay/ct-lays for a work order: the cut orders that name it (B-W2b-129) — its fabric lays and any leather group —, each
 * with its status and plan, opened on its own record (the Lays grid is there).
 */
function OrdersOfWorkOrder({ model, actions }: { model: CutRecordModel; actions?: CutRecordActions }) {
  const o = useT(ORDERS_NAMESPACE)
  const orders = model.orders
  return (
    <Card padded className="fw-ct-card">
      <h2 className="fw-ct-h2">{o('ofWorkOrder.title')}</h2>
      {orders.problem ? (
        <EmptyState title={o('part.failed', { part: o('ofWorkOrder.title') })} description={o(orders.problem)} action={<Button size="sm" onClick={() => actions?.onRetryPart?.('orders')}>{o('common.retry')}</Button>} />
      ) : !orders.value ? (
        <p className="fw-ct-hint" role="status">
          <Spinner size={12} /> {o('part.loading', { part: o('ofWorkOrder.title') })}
        </p>
      ) : orders.value.length === 0 ? (
        <p className="fw-ct-hint">{o('ofWorkOrder.none')}</p>
      ) : (
        <ul className="fw-ct-list">
          {orders.value.map((order) => {
            const plan = planPhrase(order)
            return (
              <li key={order.id}>
                <span className="fw-ct-inline">
                  <Link className="fw-ct-link" href={orderHref(model.prefix, order.id)}>
                    {order.number}
                  </Link>
                  <Pill tone={ORDER_TONE[order.status]}>{o(`status.${order.status}`)}</Pill>
                  <span className="fw-ct-hint">
                    {o(`kind.${order.kind}`)} · {[order.material.item.code, order.material.colour?.code].filter(Boolean).join(' · ')} · {o(plan.key, plan.params)}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <p className="fw-ct-hint">{o('ofWorkOrder.hint')}</p>
    </Card>
  )
}

// ---- Pieces ----------------------------------------------------------------------------------------------------------------------

function PiecesTab({ model, actions }: { model: CutRecordModel; actions?: CutRecordActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const locale = useLocale()
  const log = model.log.value
  if (!log) return <PartState label={t('tab.pieces')} part={model.log} onRetry={() => actions?.onRetryPart?.('log')} />
  const recuts = model.recuts.value ?? []
  const matrix = piecesMatrix(log, recuts)
  return (
    <>
      <Card padded className="fw-ct-card">
        <h2 className="fw-ct-h2">{t('pieces.title')}</h2>
        {matrix.length === 0 ? (
          <p className="fw-ct-hint">{t('pieces.none')}</p>
        ) : (
          <div className="fw-ct-matrix">
            <SummaryTable
              label={t('pieces.title')}
              columns={[t('pieces.part'), ...log.cells.map((cell) => `${cell.colourwayCode} ${cell.size}`)]}
              align={[undefined, ...log.cells.map(() => 'right' as const)]}
              rows={matrix.map((row) => ({
                id: row.part,
                cells: [
                  row.planned ? row.part : t('pieces.extraPart', { part: row.part }),
                  ...row.cells.map((cell) => (
                    <span key={cell.cellId} className="fw-ct-pieces">
                      <span>{t('pieces.cell', { cut: cell.cut, planned: cell.planned })}</span>
                      {cell.short > 0 && <span className="is-short">{t('pieces.short', { count: cell.short })}</span>}
                      {cell.recut > 0 && <span className="is-recut">{t('pieces.recut', { count: cell.recut })}</span>}
                    </span>
                  )),
                ],
              }))}
            />
          </div>
        )}
        <p className="fw-ct-hint">{t('pieces.hint')}</p>
      </Card>
      <Card padded className="fw-ct-card">
        <h2 className="fw-ct-h2">{t('recuts.title')}</h2>
        {!model.can.scrap ? (
          <p className="fw-ct-hint">{t('page.noAccess.body', { permission: 'production.scrap.view' })}</p>
        ) : model.recuts.problem ? (
          <EmptyState title={t('part.failed', { part: t('recuts.title') })} description={t(model.recuts.problem)} action={<Button size="sm" onClick={() => actions?.onRetryPart?.('recuts')}>{t('common.retry')}</Button>} />
        ) : !model.recuts.value ? (
          <p className="fw-ct-hint" role="status">
            <Spinner size={12} /> {t('part.loading', { part: t('recuts.title') })}
          </p>
        ) : recuts.length === 0 ? (
          <p className="fw-ct-hint">{t('recuts.none')}</p>
        ) : (
          <ul className="fw-ct-list">
            {recuts.map((recut) => (
              <li key={recut.id}>
                <span className="fw-ct-inline">
                  <Pill tone={recut.status === 'OPEN' ? 'info' : 'success'}>{t(`recuts.status.${recut.status}`)}</Pill>
                  <span>{t('recuts.what', { quantity: recut.quantity, part: recut.part ?? t('recuts.whole'), cell: `${recut.cell.colourwayCode} ${recut.cell.size}` })}</span>
                  <span className="fw-ct-hint">
                    {recut.reason} · {formatDateTime(recut.createdAt, { locale, timeZone: model.timeZone })}
                  </span>
                </span>
                {recut.status === 'OPEN' && (
                  <Button size="sm" heldReason={say(t, recutHeld(recut, log, model.can, model.busy))} onClick={() => actions?.onDialog?.({ kind: 'recut', id: recut.id })}>
                    {t('recuts.markCut')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="fw-ct-hint">{t('recuts.hint')}</p>
      </Card>
    </>
  )
}

function RecutDialog({ model, id, actions }: { model: CutRecordModel; id: string; actions?: CutRecordActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const locale = useLocale()
  const recut = model.recuts.value?.find((row) => row.id === id) ?? null
  const entries = recut && model.log.value ? recutEntries(model.log.value, recut) : []
  const [entryId, setEntryId] = useState(entries[0]?.id ?? '')
  const held = recut ? (say(t, recutHeld(recut, model.log.value, model.can, model.busy)) ?? (entryId ? null : t('recuts.held.entry'))) : t('held.loading')
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('recuts.dialog.title')}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => recut && actions?.onRecutDone?.(recut.id, entryId)}>
            {model.busy ? <Spinner size={12} /> : null} {t('recuts.dialog.go')}
          </Button>
        </>
      }
    >
      <div className="fw-ct-dialog">
        {model.problem && <Banner tone="danger" title={say(t, model.problem)} />}
        {recut && <p>{t('recuts.what', { quantity: recut.quantity, part: recut.part ?? t('recuts.whole'), cell: `${recut.cell.colourwayCode} ${recut.cell.size}` })}</p>}
        <Field label={t('recuts.dialog.entry')} hint={t('recuts.dialog.entryHint')}>
          <Select size="sm" value={entryId} onChange={(event) => setEntryId(event.target.value)}>
            {entries.length === 0 && <option value="">{t('recuts.dialog.noEntry')}</option>}
            {entries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {`${formatDateTime(entry.serverTime, { locale, timeZone: model.timeZone })} · ${entry.hideCode} · ${entry.station?.code ?? t('record.office')}`}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

// ---- Yield ------------------------------------------------------------------------------------------------------------------------

function YieldTab({ model, actions }: { model: CutRecordModel; actions?: CutRecordActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const o = useT(ORDERS_NAMESPACE)
  const locale = useLocale()
  const figures = model.figures.value
  if (!figures) return <PartState label={t('tab.yield')} part={model.figures} onRetry={() => actions?.onRetryPart?.('figures')} />
  const lots = lotYields(figures.hides)
  const overall = figures.overall
  return (
    <>
      <Card padded className="fw-ct-card">
        <div className="fw-ct-card-head">
          <h2 className="fw-ct-h2">{t('yield.title')}</h2>
          <span className="fw-ct-inline">
            <Tag tone={varianceTone(overall.variancePct)}>{t('yield.overall', { pct: percent(overall.yieldPct, locale) })}</Tag>
            <span className="fw-ct-hint">{overall.plannedPct === null ? t('list.noPlan') : t(`yield.plan.${figures.plannedSource}`, { pct: percent(overall.plannedPct, locale) })}</span>
          </span>
        </div>
        <KeyValue
          columns={2}
          items={[
            { label: t('yield.used'), value: areaNumber(overall.used, locale) },
            { label: t('yield.pattern'), value: areaNumber(overall.pattern, locale) },
            { label: t('yield.remnant'), value: areaNumber(overall.remnant, locale) },
            { label: t('yield.waste'), value: `${areaNumber(overall.waste, locale)}${overall.wastePct !== null ? ` · ${percent(overall.wastePct, locale)}` : ''}` },
          ]}
        />
        {Number(overall.unmatched) > 0 && <p className="fw-ct-hint">{t('yield.unmatched', { area: areaNumber(overall.unmatched, locale) })}</p>}
        {figures.hides.length === 0 ? (
          <p className="fw-ct-hint">{t('yield.none')}</p>
        ) : (
          <PerformanceGraph
            data={yieldChart(figures)}
            xKey="hide"
            left={{ key: 'yieldPct', label: t('yield.series.yield'), color: 'var(--nds-info)', axis: 'left', shape: 'bar', format: (value) => `${value.toFixed(1)} %`, domain: [0, 100] }}
            right={{ key: 'plannedPct', label: t('yield.series.planned'), color: 'var(--nds-warning)', axis: 'left', format: (value) => `${value.toFixed(1)} %` }}
            height={220}
          />
        )}
      </Card>
      <AreaBalanceCard model={model} />
      <Card padded className="fw-ct-card">
        <h2 className="fw-ct-h2">{t('yield.byLot')}</h2>
        {lots.length === 0 ? (
          <p className="fw-ct-hint">{t('yield.none')}</p>
        ) : (
          <SummaryTable
            label={t('yield.byLot')}
            density="roomy"
            stackOnPhone
            columns={[t('yield.col.lot'), t('yield.col.supplier'), t('yield.col.hides'), t('yield.col.used'), t('yield.col.pattern'), t('yield.col.yield'), o('feedback.col.plan'), o('feedback.col.action')]}
            align={[undefined, undefined, 'right', 'right', 'right', 'right', 'right', 'left']}
            rows={lots.map((lot) => {
              const points = againstPlan(lot.yieldPct, overall.plannedPct)
              const held = feedbackHeld(lot, model.can.claims)
              return {
                id: lot.lotId,
                cells: [
                  lot.supplierLotRef ? `${lot.lotCode} (${lot.supplierLotRef})` : lot.lotCode,
                  lot.supplier ?? '—',
                  String(lot.hides),
                  `${areaNumber(String(lot.used), locale)} ${unitWord(lot.uom)}`,
                  `${areaNumber(String(lot.pattern), locale)} ${unitWord(lot.uom)}`,
                  percent(lot.yieldPct, locale),
                  points === null ? '—' : <Tag key="plan" tone={underPlan(points) ? 'warning' : 'neutral'}>{o('feedback.points', { points: `${points > 0 ? '+' : points < 0 ? '−' : ''}${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Math.abs(points))}` })}</Tag>,
                  held ? (
                    <Button key="feedback" size="sm" variant={underPlan(points) ? 'primary' : undefined} heldReason={o(held.key, held.params)}>
                      {o('feedback.raise')}
                    </Button>
                  ) : (
                    <Button key="feedback" size="sm" variant={underPlan(points) ? 'primary' : undefined} asChild>
                      <Link href={`${model.prefix}/purchasing/claims?lot=${encodeURIComponent(lot.lotId)}&new=1`}>{o('feedback.raise')}</Link>
                    </Button>
                  ),
                ],
              }
            })}
          />
        )}
        <p className="fw-ct-hint">{o('feedback.hint')}</p>
        <p className="fw-ct-hint">{t('yield.hint')}</p>
      </Card>
    </>
  )
}

/**
 * rec:Cut/yield/ct-yield#1 — the W2b reconciliation of issued vs used vs returned (MES-045) for the work order's leather: the
 * hides of the cut log summed per unit — issued, cut (used), waste, back to stock, still on the hide. Never by cutter.
 */
function AreaBalanceCard({ model }: { model: CutRecordModel }) {
  const o = useT(ORDERS_NAMESPACE)
  const locale = useLocale()
  const log = model.log.value
  if (!log) return null
  const units = [...new Set((model.cut?.materials ?? []).map((material) => material.baseUom))]
  const sums = areaBalance(log, model.figures.value, units.length === 1 ? (units[0] ?? '') : '')
  return (
    <Card padded className="fw-ct-card">
      <h2 className="fw-ct-h2">{o('balance.title')}</h2>
      {sums.length === 0 ? (
        <p className="fw-ct-hint">{o('balance.none')}</p>
      ) : (
        <SummaryTable
          label={o('balance.title')}
          stackOnPhone
          columns={[o('balance.col.unit'), o('balance.col.hides'), o('balance.col.issued'), o('balance.col.used'), o('balance.col.waste'), o('balance.col.returned'), o('balance.col.left')]}
          align={['left', 'right', 'right', 'right', 'right', 'right', 'right']}
          rows={sums.map((sum) => ({
            id: sum.uom || 'unit',
            cells: [unitWord(sum.uom) || '—', String(sum.hides), areaNumber(String(sum.issued), locale), areaNumber(String(sum.cut), locale), areaNumber(String(sum.waste), locale), areaNumber(String(sum.returned), locale), areaNumber(String(sum.left), locale)],
          }))}
        />
      )}
      <p className="fw-ct-hint">{o('balance.hint')}</p>
    </Card>
  )
}

// ---- Tickets -----------------------------------------------------------------------------------------------------------------------

function TicketsTab({ model, actions }: { model: CutRecordModel; actions?: CutRecordActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const bundles = model.bundles.value
  const lines = useMemo(() => (bundles ? ticketLines(bundles) : []), [bundles])
  const columns = useMemo<ColDef<TicketLine>[]>(() => {
    const CodeCell = ({ data }: ICellRendererParams<TicketLine>) =>
      data ? (
        <span className="fw-ct-cell">
          <span className="fw-ct-code">{data.bundle.code}</span>
          <span className="fw-ct-sub">{data.bundle.replacedCodes.length > 0 ? t('tickets.replaced', { codes: data.bundle.replacedCodes.join(', ') }) : formatDateTime(data.bundle.createdAt, place)}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<TicketLine>) =>
      data ? (
        <span className="fw-ct-inline">
          <Pill tone={data.bundle.status === 'VOID' ? 'neutral' : 'success'}>{t(`tickets.status.${data.bundle.status}`)}</Pill>
          <Tag tone={PRINT_TONE[data.print]}>{t(`tickets.print.${data.print}`)}</Tag>
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<TicketLine>) => {
      if (!data) return null
      const reprint = say(t, reprintHeld(data.bundle, model.can, model.busy))
      const voided = say(t, voidHeld(data.bundle, model.can, model.busy))
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('tickets.rowMenu', { code: data.bundle.code }) }}
          items={[
            { id: 'reprint', label: t('tickets.reprint'), disabled: !!reprint, description: reprint ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'reprint', id: data.bundle.id }) },
            { id: 'void', label: t('tickets.void'), tone: 'danger' as const, disabled: !!voided, description: voided ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'void', id: data.bundle.id }) },
          ]}
        />
      )
    }
    return [
      { colId: 'code', headerName: t('tickets.col.code'), minWidth: 160, flex: 1.1, cellRenderer: CodeCell, valueGetter: (params) => params.data?.bundle.code ?? '' },
      { colId: 'cell', headerName: t('tickets.col.cell'), minWidth: 100, flex: 0.7, valueGetter: (params) => (params.data ? `${params.data.bundle.colourwayCode} ${params.data.bundle.size}` : '') },
      { colId: 'part', headerName: t('tickets.col.part'), minWidth: 100, flex: 0.7, valueGetter: (params) => params.data?.bundle.part ?? t('tickets.whole') },
      { colId: 'garments', headerName: t('tickets.col.garments'), minWidth: 90, flex: 0.5, type: 'rightAligned', valueGetter: (params) => params.data?.bundle.quantity ?? 0 },
      { colId: 'status', headerName: t('tickets.col.status'), minWidth: 190, flex: 1.2, cellRenderer: StatusCell },
      { colId: 'reprints', headerName: t('tickets.col.reprints'), minWidth: 160, flex: 1.1, valueGetter: (params) => (params.data ? (params.data.bundle.reprints.length === 0 ? '—' : params.data.bundle.reprints.map((reprint) => reprint.reason).join(' · ')) : '') },
      { colId: 'scans', headerName: t('tickets.col.scans'), minWidth: 80, flex: 0.5, type: 'rightAligned', valueGetter: (params) => params.data?.bundle.scans ?? 0 },
      { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.timeZone, model.can, model.busy, actions])
  if (!bundles) return <PartState label={t('tab.tickets')} part={model.bundles} onRetry={() => actions?.onRetryPart?.('bundles')} />
  return (
    <section className="fw-ct-card" aria-label={t('tickets.title')}>
      <h2 className="fw-ct-h2">{t('tickets.title')}</h2>
      <ListFrame<TicketLine>
        label={t('tickets.title')}
        rows={lines}
        rowId={(row) => row.bundle.id}
        columns={columns}
        count={t('tickets.count', { count: lines.filter((line) => line.bundle.status === 'ACTIVE').length })}
        listKey={null}
        state={lines.length === 0 ? <EmptyState title={t('tickets.empty.title')} description={t('tickets.empty.body')} /> : undefined}
      />
      <p className="fw-ct-hint">{t('tickets.hint')}</p>
    </section>
  )
}

function ReprintDialog({ model, id, actions }: { model: CutRecordModel; id: string; actions?: CutRecordActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const bundle = model.bundles.value?.bundles.find((row) => row.id === id) ?? null
  const printers = model.printers.value
  const [reason, setReason] = useState('')
  const [printerId, setPrinterId] = useState(printers?.defaultPrinterId ?? printers?.printers[0]?.id ?? '')
  const held = !bundle ? t('held.loading') : (say(t, reprintHeld(bundle, model.can, model.busy)) ?? (!printerId ? t('tickets.held.printer') : !reasonOk(reason) ? t('held.reason') : null))
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('tickets.reprintTitle', { code: bundle?.code ?? '—' })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => bundle && actions?.onReprint?.(bundle.id, reason.trim(), printerId)}>
            {model.busy ? <Spinner size={12} /> : <Printer size={13} aria-hidden />} {t('tickets.reprintGo')}
          </Button>
        </>
      }
    >
      <div className="fw-ct-dialog">
        {model.problem && <Banner tone="danger" title={say(t, model.problem)} />}
        <p>{t('tickets.reprintBody')}</p>
        <Field label={t('tickets.printer')}>
          <Select size="sm" value={printerId} onChange={(event) => setPrinterId(event.target.value)}>
            {(printers?.printers ?? []).length === 0 && <option value="">{t('tickets.noPrinter')}</option>}
            {(printers?.printers ?? []).map((printer) => (
              <option key={printer.id} value={printer.id}>
                {`${printer.code} · ${printer.name}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('tickets.reason')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={200} />
        </Field>
      </div>
    </Modal>
  )
}

function VoidDialog({ model, id, actions }: { model: CutRecordModel; id: string; actions?: CutRecordActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const bundle = model.bundles.value?.bundles.find((row) => row.id === id) ?? null
  const [reason, setReason] = useState('')
  const held = !bundle ? t('held.loading') : (say(t, voidHeld(bundle, model.can, model.busy)) ?? (!reasonOk(reason) ? t('held.reason') : null))
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('tickets.voidTitle', { code: bundle?.code ?? '—' })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="danger" heldReason={held} onClick={() => bundle && actions?.onVoid?.(bundle.id, reason.trim())}>
            {model.busy ? <Spinner size={12} /> : <Ban size={13} aria-hidden />} {t('tickets.voidGo')}
          </Button>
        </>
      }
    >
      <div className="fw-ct-dialog">
        {model.problem && <Banner tone="danger" title={say(t, model.problem)} />}
        {bundle && <p>{t('tickets.voidBody', { code: bundle.code, garments: bundle.quantity, cell: `${bundle.colourwayCode} ${bundle.size}` })}</p>}
        <Field label={t('tickets.reason')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={200} />
        </Field>
      </div>
    </Modal>
  )
}

