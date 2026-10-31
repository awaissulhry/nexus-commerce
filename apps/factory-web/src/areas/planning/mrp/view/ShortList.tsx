'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CalendarClock, FilePlus2, Megaphone } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { dayAt, quantity } from '../../../_shared/buying/model'
import type { Shortage } from '../api'
import { buyLinesOf, fixHeld, MRP_NAMESPACE, shortageId, type PlanActions, type PlanModel } from '../model'

/**
 * Short on open work orders (design planning.mrp sec:short-wo; B-W2a-70 on GET /planning/shortages of B-W2a-22): open
 * and planned work orders missing material now, one row per work order and material — the work order and its style,
 * its dates, the material and its readiness word, what is short and by when, the purchase line it waits for — with the
 * fix beside each: Buy (the plan's same one-click Draft PO), Expedite PO-… (the order's page, where Remind chases the
 * supplier), Move the firm order earlier. Swap to another lot or an approved alternate is a later wave. No money.
 */
export function ShortList({ model, actions, tools, search }: { model: PlanModel; actions?: PlanActions; tools: ReactNode; search?: ReactNode }) {
  const t = useT('buying')
  const w = useT(MRP_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const loaded = model.shortages ?? { status: 'loading' as const }
  const plan = model.plan.status === 'ready' ? model.plan.value : null
  const lines = plan?.lines ?? []
  const q = model.q.trim().toLowerCase()
  const rows = useMemo(
    () => (loaded.status === 'ready' ? loaded.value.rows.filter((row) => !q || [row.workOrder.number, row.workOrder.style.code, row.workOrder.style.name, row.material.label, row.expected?.purchaseOrderNumber].some((text) => !!text && text.toLowerCase().includes(q))) : null),
    [loaded, q],
  )
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const picked = (rows ?? []).filter((row) => selected.includes(shortageId(row)))
  const toBuy = buyLinesOf(picked, lines)
  const can = { ...model.can, planFirm: model.canFirm ?? false }

  const WorkOrderCell = ({ data }: ICellRendererParams<Shortage>) =>
    data ? (
      <span className="fw-by-cell">
        <Link className="fw-by-link fw-by-ellipsis" href={`${model.prefix}/production/work-orders/${encodeURIComponent(data.workOrder.id)}`}>
          {data.workOrder.number}
        </Link>
        <span className="fw-by-cell-sub fw-by-ellipsis">
          {data.workOrder.style.code} · {data.workOrder.style.name}
        </span>
      </span>
    ) : null
  const DatesCell = ({ data }: ICellRendererParams<Shortage>) =>
    data ? (
      <span className="fw-by-cell">
        <span>{data.workOrder.startedAt ? w('short.started', { date: formatDate(data.workOrder.startedAt, place) }) : w('short.notStarted')}</span>
        <span className="fw-by-cell-sub">{data.workOrder.dueDate ? w('short.due', { date: formatDate(dayAt(data.workOrder.dueDate), place) }) : w('short.noDue')}</span>
      </span>
    ) : null
  const MaterialCell = ({ data }: ICellRendererParams<Shortage>) =>
    data ? (
      <span className="fw-by-cell">
        <span className="fw-by-ellipsis">{data.material.label}</span>
        <span>
          <Pill tone={data.word === 'NOT_ENOUGH' ? 'danger' : 'warning'}>{w(`short.word.${data.word}`)}</Pill>
        </span>
      </span>
    ) : null
  const ShortCell = ({ data }: ICellRendererParams<Shortage>) =>
    data ? (
      <span className="fw-by-cell">
        <span className="fw-by-num">
          {quantity(data.short, locale)} {t(`uom.${data.material.uom}`)}
        </span>
        <span className="fw-by-cell-sub">{w('short.neededBy', { date: formatDate(dayAt(data.neededBy), place) })}</span>
      </span>
    ) : null
  const ExpectedCell = ({ data }: ICellRendererParams<Shortage>) =>
    data ? (
      <span className="fw-by-cell">
        {data.expected ? (
          <>
            <span className="fw-by-ellipsis">{data.expected.purchaseOrderNumber}</span>
            <span className="fw-by-cell-sub fw-by-warning">{w('short.arrives', { date: formatDate(dayAt(data.expected.date), place) })}</span>
          </>
        ) : (
          <span className="fw-by-cell-sub">{w('short.nothingOnOrder')}</span>
        )}
      </span>
    ) : null
  const FixCell = ({ data }: ICellRendererParams<Shortage>) => {
    if (!data) return null
    if (data.fixes.length === 0) return <span className="fw-by-cell-sub">{w('short.noFix')}</span>
    return (
      <span className="fw-by-inline">
        {data.fixes.map((fix) => {
          const held = fixHeld(fix, lines, can)
          if (fix.kind === 'EXPEDITE' && fix.purchaseOrder) {
            return held ? (
              <Button key={`e-${fix.purchaseOrder.lineId}`} size="sm" variant="quiet" heldReason={w(held)}>
                <Megaphone size={13} aria-hidden /> {w('short.fix.EXPEDITE', { number: fix.purchaseOrder.number })}
              </Button>
            ) : (
              <Button key={`e-${fix.purchaseOrder.lineId}`} size="sm" asChild>
                <Link href={`${model.prefix}/purchasing/orders/${encodeURIComponent(fix.purchaseOrder.id)}`} aria-label={w('short.fix.expediteLabel', { number: fix.purchaseOrder.number, workOrder: data.workOrder.number })}>
                  <Megaphone size={13} aria-hidden /> {w('short.fix.EXPEDITE', { number: fix.purchaseOrder.number })}
                </Link>
              </Button>
            )
          }
          if (fix.kind === 'BUY' && fix.requirementId) {
            const busy = model.drafting.includes(fix.requirementId)
            return (
              <Button key={`b-${fix.requirementId}`} size="sm" variant={held ? 'quiet' : 'secondary'} heldReason={held ? w(held) : busy ? t('held.busy') : null} onClick={() => actions?.onDraftOne?.(fix.requirementId!)} aria-label={w('short.fix.buyLabel', { material: data.material.label, workOrder: data.workOrder.number })}>
                {busy ? <Spinner size={12} /> : <FilePlus2 size={13} aria-hidden />} {w('short.fix.BUY')}
              </Button>
            )
          }
          if (fix.kind === 'MOVE_FIRM' && fix.requirementId) {
            return (
              <Button key={`m-${fix.requirementId}`} size="sm" variant="quiet" heldReason={held ? w(held) : null} onClick={() => actions?.onMoveFirm?.(fix.requirementId!)}>
                <CalendarClock size={13} aria-hidden /> {w('short.fix.MOVE_FIRM')}
              </Button>
            )
          }
          return null
        })}
      </span>
    )
  }
  const columns: ColDef<Shortage>[] = [
    { colId: 'workOrder', headerName: w('short.col.workOrder'), minWidth: 190, flex: 1.2, cellRenderer: WorkOrderCell },
    { colId: 'dates', headerName: w('short.col.dates'), minWidth: 150, flex: 0.9, cellRenderer: DatesCell },
    { colId: 'material', headerName: w('short.col.material'), minWidth: 190, flex: 1.2, cellRenderer: MaterialCell },
    { colId: 'short', headerName: w('short.col.short'), minWidth: 150, flex: 0.9, cellRenderer: ShortCell },
    { colId: 'expected', headerName: w('short.col.expected'), minWidth: 160, flex: 1, cellRenderer: ExpectedCell },
    { colId: 'fix', headerName: w('short.col.fix'), minWidth: 280, flex: 1.8, sortable: false, cellRenderer: FixCell },
  ]

  let state: ReactNode = undefined
  if (loaded.status === 'error') {
    state = <EmptyState title={w('short.failed')} description={t(loaded.problem)} action={<Button size="sm" onClick={() => actions?.onRetryShortages?.()}>{t('common.retry')}</Button>} />
  } else if (rows && rows.length === 0) {
    state = q ? <EmptyState title={t('plan.empty.noMatch.title')} description={t('plan.empty.noMatch.body')} /> : <EmptyState title={w('short.empty.title')} description={w('short.empty.body')} />
  }

  return (
    <ListFrame<Shortage>
      label={w('short.title')}
      listKey="planning.mrp.short-wo"
      rows={state ? [] : rows}
      rowId={shortageId}
      columns={columns}
      count={rows ? w('short.count', { count: rows.length }) : '—'}
      search={search}
      tools={tools}
      selection={{
        selected,
        onChange: setSelected,
        actions: (
          <Button
            size="sm"
            variant="primary"
            aria-label={w('short.bulk.draft', { count: toBuy.length })}
            heldReason={!model.can.poManage ? w('held.noPurchasingRequests') : toBuy.length === 0 ? w('held.noBuyFix') : null}
            onClick={() => actions?.onDraftMany?.(toBuy)}
          >
            <FilePlus2 size={13} aria-hidden /> <SelectionLabel>{w('short.bulk.draft', { count: toBuy.length })}</SelectionLabel>
          </Button>
        ),
      }}
      onOpen={(row) => {
        const buy = row.fixes.find((fix) => fix.requirementId)
        if (buy?.requirementId) actions?.onWhy?.(buy.requirementId)
      }}
      state={state}
      focusRow={model.focusRow}
      keysOpen={model.keysOpen}
    />
  )
}
