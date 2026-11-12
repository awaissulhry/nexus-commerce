'use client'

import { useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { ExternalLink, Mail, MoreHorizontal, Route } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { SelectionLabel } from '@nexus/ui/grid'
import { Button, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { Timeline } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { EXPEDITE_REASONS, type ExpediteReason, type LateRow } from '../api'
import { blockedOf, chainOf, chaseGroupsOf, chaseHeldOf, orderHref, recordHref } from '../model'
import { Head, stateOf } from './SpendPanel'
import type { ReportsActions, ReportsModel } from './types'

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

const REASON_TONE: Record<ExpediteReason, 'danger' | 'warning' | 'info'> = { LATE: 'danger', CONFIRMED_LATE: 'warning', NOT_CONFIRMED: 'info' }

/**
 * Late lines and what they block (design sec late; SCM-169): the expediting worklist's open lines — late, confirmed later than
 * needed, not confirmed in time — ranked by the customer orders they put at risk (then the earliest promise, the work orders, the
 * days late), as the shared list frame: PO line (opens the order), supplier, material, the day needed and expected, why, the work
 * orders and the customer orders it holds up with their dates. A row's ⋯ draws its chain below (supplier → PO line → work orders →
 * customer orders, design CauseChain), opens its order, or chases the supplier; selected rows are chased one mail per order
 * (purchasing.send; held with the reason without it). No money in this section.
 */
export function LatePanel({ model, actions }: Props) {
  const t = useT('purchasing-reports')
  const locale = useLocale()
  const read = model.late
  const answer = read.status === 'ready' ? read.value : null
  const rows = useMemo(() => (answer ? [...answer.rows, ...model.lateMore] : null), [answer, model.lateMore])
  const day = (date: string | null) => (date ? formatDate(`${date}T12:00:00Z`, { locale }) : '—')
  const selected = model.selected
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.lineId === id))) actions?.onSelected?.(selected.filter((id) => rows.some((row) => row.lineId === id)))
  }, [rows, selected, actions])
  const live = useRef({ prefix: model.prefix, can: model.can })
  live.current = { prefix: model.prefix, can: model.can }
  const held = { send: t('late.held.send'), status: t('late.held.status') }

  const columns = useMemo<ColDef<LateRow>[]>(() => {
    const LineCell = ({ data }: ICellRendererParams<LateRow>) =>
      data ? (
        <span className="fw-pr-cell">
          <Link className="fw-pr-link" href={orderHref(live.current.prefix, data.purchaseOrderId, data.number)}>
            {t('late.line', { number: data.number, seq: data.seq })}
          </Link>
          <span className="fw-pr-muted">{t(`status.${data.status}`)}</span>
        </span>
      ) : null
    const MaterialCell = ({ data }: ICellRendererParams<LateRow>) =>
      data ? (
        <span className="fw-pr-cell">
          <span>{`${data.item.code} · ${data.item.name}`}</span>
          {data.colour ? <span className="fw-pr-muted">{data.colour.name}</span> : null}
        </span>
      ) : null
    const WhenCell = ({ data }: ICellRendererParams<LateRow>) =>
      data ? (
        <span className="fw-pr-cell">
          <span>{t('late.expected', { day: day(data.expectedDate) })}</span>
          <span className="fw-pr-muted">{data.daysLate > 0 ? t('late.daysLate', { count: data.daysLate }) : data.confirmedLaterBy > 0 ? t('late.laterBy', { count: data.confirmedLaterBy, day: day(data.nextDelivery?.needDate ?? data.needDate) }) : t('late.needed', { day: day(data.nextDelivery?.needDate ?? data.needDate) })}</span>
        </span>
      ) : null
    const WhyCell = ({ data }: ICellRendererParams<LateRow>) =>
      data ? (
        <span className="fw-pr-tags">
          {data.reasons.map((reason) => (
            <Tag key={reason} tone={REASON_TONE[reason]}>
              {t(`reason.${reason}`)}
            </Tag>
          ))}
        </span>
      ) : null
    const WorkCell = ({ data }: ICellRendererParams<LateRow>) => {
      if (!data) return null
      const blocked = blockedOf(data).workOrders
      if (blocked.length === 0) return <span className="fw-pr-muted">{t('late.none')}</span>
      return (
        <span className="fw-pr-cell">
          {blocked.slice(0, 2).map((entry) => (
            <span key={entry.id}>
              <Link className="fw-pr-link" href={recordHref(live.current.prefix, 'WorkOrder', entry.id, entry.number)}>
                {entry.number}
              </Link>{' '}
              <span className="fw-pr-muted">{entry.lateBy > 0 ? t('late.lateBy', { count: entry.lateBy }) : t('late.inTime')}</span>
            </span>
          ))}
          {blocked.length > 2 ? <span className="fw-pr-muted">{t('late.more', { count: blocked.length - 2 })}</span> : null}
        </span>
      )
    }
    const SalesCell = ({ data }: ICellRendererParams<LateRow>) => {
      if (!data) return null
      const blocked = blockedOf(data).salesOrders
      if (blocked.length === 0) return <span className="fw-pr-muted">{t('late.none')}</span>
      return (
        <span className="fw-pr-cell">
          {blocked.slice(0, 2).map((entry) => (
            <span key={entry.id}>
              <Link className="fw-pr-link" href={recordHref(live.current.prefix, 'SalesOrder', entry.id, entry.number)}>
                {entry.number}
              </Link>{' '}
              <span className={entry.lateBy > 0 ? 'fw-pr-danger' : 'fw-pr-muted'}>{t('late.promise', { day: day(entry.promiseDate) })}</span>
            </span>
          ))}
          {blocked.length > 2 ? <span className="fw-pr-muted">{t('late.more', { count: blocked.length - 2 })}</span> : null}
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<LateRow>) => {
      if (!data) return null
      const chaseHeld = chaseHeldOf(data, live.current.can, held)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('late.menu', { number: data.number, seq: data.seq }) }}
          items={[
            { id: 'chain', label: t('late.showChain'), icon: <Route size={14} aria-hidden />, onSelect: () => actions?.onChain?.(data.lineId) },
            { id: 'open', label: t('late.openOrder'), icon: <ExternalLink size={14} aria-hidden />, href: orderHref(live.current.prefix, data.purchaseOrderId, data.number) },
            chaseHeld
              ? { id: 'chase', label: t('late.chase'), icon: <Mail size={14} aria-hidden />, disabled: true, description: chaseHeld }
              : { id: 'chase', label: t('late.chase'), icon: <Mail size={14} aria-hidden />, onSelect: () => actions?.onChase?.([{ orderId: data.purchaseOrderId, number: data.number, supplierName: data.supplierName, version: data.version, lineIds: [], seqs: [] }]) },
          ]}
        />
      )
    }
    return [
      { colId: 'line', headerName: t('late.col.line'), field: 'number', minWidth: 180, flex: 1, cellRenderer: LineCell },
      { colId: 'supplier', headerName: t('late.col.supplier'), field: 'supplierName', minWidth: 160, flex: 1.1 },
      { colId: 'material', headerName: t('late.col.material'), minWidth: 180, flex: 1.3, valueGetter: (params) => (params.data ? `${params.data.item.code} ${params.data.item.name}` : ''), cellRenderer: MaterialCell },
      { colId: 'when', headerName: t('late.col.expected'), field: 'expectedDate', minWidth: 170, flex: 1, cellRenderer: WhenCell },
      { colId: 'why', headerName: t('late.col.why'), minWidth: 200, flex: 1.1, valueGetter: (params) => (params.data ? params.data.reasons.join(' ') : ''), cellRenderer: WhyCell },
      { colId: 'workOrders', headerName: t('late.col.workOrders'), minWidth: 170, flex: 1, valueGetter: (params) => (params.data ? params.data.blocks.workOrdersAtRisk : 0), cellRenderer: WorkCell },
      { colId: 'salesOrders', headerName: t('late.col.salesOrders'), minWidth: 200, flex: 1.2, valueGetter: (params) => (params.data ? params.data.blocks.salesOrdersAtRisk : 0), cellRenderer: SalesCell },
      { colId: 'more', headerName: t('late.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The words and the day format follow the language; the rows' links and rights read `live`.
  }, [t, locale, actions])

  const reason = model.address.reason
  const head = (
    <Head id="pr-late" title={t('section.late')} hint={t('late.hint')}>
      <SegmentedControl
        size="sm"
        wrap
        ariaLabel={t('late.reason')}
        value={reason ?? 'ALL'}
        onChange={(value) => actions?.onAddress?.({ reason: value === 'ALL' ? null : (value as ExpediteReason) })}
        options={[{ value: 'ALL', label: t('reason.ALL') }, ...EXPEDITE_REASONS.map((value) => ({ value, label: t(`reason.${value}`) }))]}
      />
    </Head>
  )
  if (!model.can.orders) {
    return (
      <section className="fw-pr-panel" aria-labelledby="pr-late">
        {head}
        <EmptyState title={t('notInRole.title')} description={t('notInRole.late')} />
      </section>
    )
  }
  const waiting = stateOf(read, t('late.failed'), () => actions?.onRetry?.('late'), false)
  if (waiting || !answer || !rows) {
    return (
      <section className="fw-pr-panel" aria-labelledby="pr-late">
        {head}
        {waiting}
      </section>
    )
  }
  const chosen = rows.find((row) => row.lineId === model.chainLine) ?? rows[0] ?? null
  const groups = chaseGroupsOf(rows, selected)
  const plans = answer.plans.filter((plan) => plan.finishedAt)
  const chainWords = {
    supplier: (name: string) => t('chain.supplier', { name }),
    line: (number: string, seq: number, item: string) => t('chain.line', { number, seq, item }),
    lineDetail: (row: LateRow) => (row.daysLate > 0 ? t('chain.lineLate', { day: day(row.expectedDate), count: row.daysLate }) : t('chain.lineExpected', { day: day(row.expectedDate), needed: day(row.nextDelivery?.needDate ?? row.needDate) })),
    workOrder: (number: string) => t('chain.workOrder', { number }),
    workOrderDetail: (dueDate: string | null, lateBy: number) => (lateBy > 0 ? t('chain.dueLate', { day: day(dueDate), count: lateBy }) : t('chain.dueInTime', { day: day(dueDate) })),
    salesOrder: (number: string) => t('chain.salesOrder', { number }),
    salesOrderDetail: (promiseDate: string | null, lateBy: number) => (lateBy > 0 ? t('chain.promiseLate', { day: day(promiseDate), count: lateBy }) : t('chain.promiseInTime', { day: day(promiseDate) })),
    nothing: t('chain.nothing'),
  }
  const chaseOne = chosen ? chaseHeldOf(chosen, model.can, held) : null
  return (
    <section className="fw-pr-panel" aria-labelledby="pr-late">
      {head}
      <p className="fw-pr-muted">{t('late.tiles', { late: answer.tiles.late, confirmedLate: answer.tiles.confirmedLate, notConfirmed: answer.tiles.notConfirmed, salesOrders: answer.tiles.salesOrdersAtRisk })}</p>
      <ListFrame<LateRow>
        label={t('section.late')}
        title={t('section.late')}
        listKey={null}
        rows={rows}
        rowId={(row) => row.lineId}
        rowKind="two-line"
        columns={columns}
        count={answer.complete ? t('late.count', { count: rows.length }) : t('late.countAtLeast', { count: rows.length })}
        selection={{
          selected,
          onChange: (ids) => actions?.onSelected?.(ids),
          actions: (
            <Button size="sm" variant="primary" onClick={() => actions?.onChase?.(groups)} heldReason={model.can.send ? (groups.length === 0 ? t('late.held.none') : null) : t('late.held.send')}>
              <Mail size={14} aria-hidden />
              <SelectionLabel>{t('late.chaseMany', { count: groups.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={(row) => chaseHeldOf(row, model.can, held)}
        onOpen={(row) => actions?.onChain?.(row.lineId)}
        more={model.lateCursor ? { label: t('late.showMore'), onMore: () => actions?.onLateMore?.(), held: model.lateMoreBusy ? t('late.busy') : null } : null}
        state={rows.length === 0 ? <EmptyState title={t('late.empty')} description={reason ? t('late.emptyReason') : t('late.emptyHint')} /> : undefined}
      />
      {!model.can.send ? <p className="fw-pr-muted">{t('late.held.send')}</p> : null}
      {chosen ? (
        <div className="fw-pr-chain" aria-labelledby="pr-chain">
          <div className="fw-pr-chain-head">
            <h3 className="fw-pr-h3" id="pr-chain">
              {t('chain.title', { number: chosen.number, seq: chosen.seq })}
            </h3>
            <Button size="sm" onClick={() => actions?.onChase?.([{ orderId: chosen.purchaseOrderId, number: chosen.number, supplierName: chosen.supplierName, version: chosen.version, lineIds: [], seqs: [] }])} heldReason={chaseOne}>
              <Mail size={14} aria-hidden /> {t('late.chaseSupplier', { supplier: chosen.supplierName })}
            </Button>
          </div>
          <Timeline label={t('chain.label', { number: chosen.number, seq: chosen.seq })} steps={chainOf(chosen, chainWords)} />
          {chaseOne ? <p className="fw-pr-muted">{chaseOne}</p> : null}
        </div>
      ) : null}
      <p className="fw-pr-muted">
        {[t('late.definition'), plans.length > 0 ? t('late.plans', { at: plans.map((plan) => formatDateTime(plan.finishedAt!, { locale })).join(', ') }) : t('late.noPlan'), answer.complete ? null : t('late.incomplete')].filter(Boolean).join(' ')}
      </p>
    </section>
  )
}
