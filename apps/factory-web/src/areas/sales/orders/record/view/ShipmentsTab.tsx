'use client'

import Link from 'next/link'
import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { Pill } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { sizeGridWords } from '../../../quotes/record/view/grid-copy'
import type { Order } from '../../api'
import { gridOf, styleGroups } from '../../model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'

const SHIPMENT_TONE = { DRAFT: 'neutral', PACKED: 'info', SHIPPED: 'info', DELIVERED: 'success', RETURNED: 'warning', CANCELLED: 'danger' } as const

/**
 * Shipments (design `order.ship.left` + `order.ship.list`): per style, what is still to ship per size, beside what
 * quality released and what left; then every shipment of the order (its state, when it left, when it arrived), each a
 * real link to its record. Shipments are made in Warehouse (its pages come with their step).
 */
export function ShipmentsTab({ order, model }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const sales = useT('sales')
  const locale = useLocale()
  const copy = sizeGridWords(sales)
  const groups = styleGroups(order.lines)
  const shipmentHref = (row: { id: string; number: string }) => `${model.prefix}${recordAddress({ type: 'Shipment', id: row.id, label: row.number, companyId: order.companyId }, OFFICE_PAGES)}`
  const figures = order.progress

  return (
    <div className="fw-so-stack">
      <Card padded>
        <div className="fw-so-card-head">
          <h2 className="fw-so-h2">{t('ship.leftTitle')}</h2>
          <span className="fw-so-hint">{t('ship.figures', { ordered: figures.ordered, released: figures.released, shipped: figures.shipped, toShip: figures.toShip })}</span>
        </div>
        <div className="fw-so-cards">
          {groups.map((group) => {
            const grid = gridOf(group, 'toShip')
            return (
              <div key={group.styleId} className="fw-so-card-plain">
                <h3 className="fw-so-h3">
                  {group.code} · {group.name}
                </h3>
                <div className="fw-so-gridbox">
                  <SizeGridView colours={grid.colours} sizes={grid.sizes} value={grid.value} caption={t('ship.gridCaption', { style: group.code })} locale={INTL_LOCALE[locale]} copy={copy} />
                </div>
              </div>
            )
          })}
        </div>
      </Card>
      <Card padded>
        <h2 className="fw-so-h2">{t('ship.listTitle')}</h2>
        {order.chain.shipments.length === 0 ? (
          <EmptyState title={t('ship.empty.title')} description={t('ship.empty.body')} />
        ) : (
          <SummaryTable
            label={t('ship.listTitle')}
            columns={[t('ship.col.number'), t('ship.col.status'), t('ship.col.shipped'), t('ship.col.delivered')]}
            rows={order.chain.shipments.map((row) => ({
              id: row.id,
              cells: [
                <Link key="n" className="fw-so-link" href={shipmentHref(row)}>
                  {row.number}
                </Link>,
                <Pill key="s" tone={SHIPMENT_TONE[row.status as keyof typeof SHIPMENT_TONE] ?? 'neutral'}>{t(`shipStatus.${row.status}`)}</Pill>,
                row.shippedAt ? formatDate(row.shippedAt, { locale }) : '—',
                row.deliveredAt ? formatDate(row.deliveredAt, { locale }) : '—',
              ],
            }))}
            density="roomy"
            stackOnPhone
            align={['left', 'left', 'right', 'right']}
          />
        )}
      </Card>
    </div>
  )
}
