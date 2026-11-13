'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { PackageOpen, RefreshCw } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { WithMessages } from '../../../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { Order } from '../../api'
import { materialRows, NAMESPACE, planHeld, quantityText, type MaterialRow } from '../../depth/model'
import type { OrderDepthActions, OrderDepthModel } from '../../depth/use-order-depth'
import '../../depth/depth.css'

/**
 * Customer-supplied materials (design order.lines.owned, SAL-306; on B-W2b-309's API): the leather, trims or labels the brand
 * sends for this order — Material · Colour · Expected · Received · Used · Left, in the material's unit — each row with the
 * customer's own lots of it (a link to the lot and to the receipt that brought it). "Plan from the BOM" makes the rows from the
 * styles' BOM (orders.manage); a row whose material the BOM asks more of than the order keeps is said apart. Never valued: no
 * money anywhere. Fetches nothing.
 */
export function MaterialsCard({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel | undefined; actions?: OrderDepthActions; prefix: string }) {
  if (!model?.materials) return null
  return (
    <WithMessages namespaces={[NAMESPACE, 'lists']}>
      <Materials order={order} model={model} actions={actions} prefix={prefix} />
    </WithMessages>
  )
}

function Materials({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions; prefix: string }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const part = model.materials!
  const view = part.value
  const rows = useMemo(() => (view ? materialRows(view) : []), [view])
  const held = planHeld(model.can, order.status)
  const open = (type: string, id: string, label: string) => `${prefix}${recordAddress({ type, id, label, companyId: order.companyId }, OFFICE_PAGES)}`
  const columns = useMemo<ColDef<MaterialRow>[]>(() => {
    const q = (value: string, uom: string) => `${quantityText(value, locale)} ${uom}`
    const Material = ({ data }: ICellRendererParams<MaterialRow>) =>
      data ? (
        <span className="fw-sod-cell">
          <span>{data.item}</span>
          <span className="fw-sod-hint">{data.itemCode}</span>
        </span>
      ) : null
    const Received = ({ data }: ICellRendererParams<MaterialRow>) =>
      data ? (
        <span className="fw-sod-cell">
          <span>{q(data.received, data.uom)}</span>
          {data.lots.length > 0 && (
            <span className="fw-sod-links">
              {data.lots.slice(0, 3).map((lot) => (
                <span key={lot.id} className="fw-sod-inline">
                  <Link className="fw-sod-link" href={open('Lot', lot.id, lot.code)}>
                    {d('materials.lot', { code: lot.code })}
                  </Link>
                  {lot.receiptId && lot.receiptNumber && (
                    <Link className="fw-sod-link fw-sod-hint" href={open('GoodsReceipt', lot.receiptId, lot.receiptNumber)}>
                      {lot.receiptNumber}
                    </Link>
                  )}
                </span>
              ))}
              {data.lots.length > 3 && <span className="fw-sod-hint">{d('materials.moreLots', { count: data.lots.length - 3 })}</span>}
            </span>
          )}
        </span>
      ) : null
    const Left = ({ data }: ICellRendererParams<MaterialRow>) =>
      data ? (
        <span className="fw-sod-inline">
          {q(data.left, data.uom)}
          {data.short && <Tag tone="danger">{d('materials.short')}</Tag>}
        </span>
      ) : null
    return [
      { colId: 'material', headerName: d('materials.col.material'), minWidth: 180, flex: 1.6, cellRenderer: Material },
      { colId: 'colour', headerName: d('materials.col.colour'), minWidth: 120, flex: 1, valueGetter: ({ data }) => data?.colour ?? '—' },
      { colId: 'expected', headerName: d('materials.col.expected'), minWidth: 110, flex: 0.8, type: 'rightAligned', valueGetter: ({ data }) => (data ? q(data.expected, data.uom) : '') },
      { colId: 'received', headerName: d('materials.col.received'), minWidth: 170, flex: 1.2, cellRenderer: Received },
      { colId: 'used', headerName: d('materials.col.used'), minWidth: 110, flex: 0.8, type: 'rightAligned', valueGetter: ({ data }) => (data ? q(data.used, data.uom) : '') },
      { colId: 'left', headerName: d('materials.col.left'), minWidth: 130, flex: 0.9, cellRenderer: Left },
    ]
    // The links depend on the order and the prefix only.
  }, [d, locale, order.companyId, prefix])

  return (
    <Card padded>
      <div className="fw-sod-head">
        <h2 className="fw-sod-h2">
          <PackageOpen size={15} aria-hidden /> {d('materials.title')}
        </h2>
        {model.can.manage && (
          <Button size="sm" heldReason={held ? d(held.key) : model.busy ? d('held.busy') : !view ? d('held.reading') : null} onClick={() => actions?.onPlan?.()}>
            <RefreshCw size={13} aria-hidden /> {d('materials.plan')}
          </Button>
        )}
      </div>
      {part.problem ? (
        <Banner
          tone="danger"
          title={d('materials.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.('materials')}>
              {d('common.retry')}
            </Button>
          }
        >
          {d(part.problem)}
        </Banner>
      ) : !view ? (
        <p className="fw-sod-hint" role="status">
          <Spinner size={14} /> {d('materials.reading')}
        </p>
      ) : view.rows.length === 0 && view.notPlanned.length === 0 ? (
        <EmptyState title={d('materials.empty')} description={d('materials.emptyBody')} />
      ) : (
        <>
          {view.rows.length > 0 && <ListFrame<MaterialRow> label={d('materials.title')} rows={rows} rowId={(row) => row.id} columns={columns} count={d('materials.count', { count: rows.length })} listKey={null} />}
          {view.notPlanned.length > 0 && (
            <Banner tone="warning" title={d('materials.notPlanned', { count: view.notPlanned.length })}>
              <ul className="fw-sod-list">
                {view.notPlanned.map((row) => (
                  <li key={`${row.orderLineId}-${row.bomLineId}`}>{d('materials.notPlannedRow', { item: `${row.item.code} · ${row.item.name}`, expected: `${quantityText(row.expected, locale)} ${row.uom}` })}</li>
                ))}
              </ul>
            </Banner>
          )}
          {view.problems.length > 0 && <p className="fw-sod-hint">{d('materials.problems', { count: view.problems.length })}</p>}
          <p className="fw-sod-hint">{d('materials.never')}</p>
        </>
      )}
    </Card>
  )
}
