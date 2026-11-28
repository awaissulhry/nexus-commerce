'use client'

import type { ReactElement } from 'react'
import Link from 'next/link'
import { CheckCircle2, Hourglass, Truck } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { StateChip } from '../../../../lib/order-cells/view/StateChip'
import { PartReading, Quiet, Section } from '../../../../lib/record-sections/Kit'
import { answerOf, type WarehouseSection } from '../model'
import '../../ready-to-ship/ready-to-ship.css'

/**
 * owb-ss3 step 3.4 (design plan § 7; office.js `officeWarehouse`) — Warehouse › Our warehouses, drawn: one section per warehouse (its name
 * and place, "2 at our warehouse · 1 on the way"), then **At our warehouse** — a card per shipment: the customer (name and code), its
 * orders (each opens the order's Shipments tab), the pieces, since when, the customer's label here or awaited, and **Send on to the
 * customer** — and **On the way** — the customer, the pieces, the day it left, and **It arrived at the warehouse**. The acts show for pack
 * and send only. Phone: the cards stack; wide: they fill the row. Draws its model; fetches nothing.
 */

export type Part<T> = { readonly state: 'reading' } | { readonly state: 'failed'; readonly problem: string } | { readonly state: 'ready'; readonly value: T }

export interface OurWarehousesViewModel {
  readonly prefix: string
  readonly sections: Part<readonly WarehouseSection[]>
  readonly acts: { readonly sendOn: boolean; readonly arrived: boolean }
}

export interface OurWarehousesViewActions {
  readonly onSendOn?: (shipmentId: string) => void
  readonly onArrived?: (shipmentId: string) => void
  readonly onRetry?: () => void
}

export function OurWarehousesView({ model, actions = {} }: { model: OurWarehousesViewModel; actions?: OurWarehousesViewActions }): ReactElement {
  const t = useT('our-warehouses')
  const s = useT('shipments')
  return (
    <div className="fw-pt fw-ows">
      {model.sections.state === 'reading' ? <PartReading rows={4} height={56} /> : null}
      {model.sections.state === 'failed' ? (
        <Banner
          tone="danger"
          title={t('failed')}
          action={
            actions.onRetry ? (
              <Button size="sm" onClick={actions.onRetry}>
                {t('retry')}
              </Button>
            ) : undefined
          }
        >
          {s(model.sections.problem)}
        </Banner>
      ) : null}
      {model.sections.state === 'ready' && model.sections.value.length === 0 ? <Quiet>{t('none')}</Quiet> : null}
      {model.sections.state === 'ready'
        ? model.sections.value.map((section) => <WarehouseBlock key={section.siteId} section={section} model={model} actions={actions} />)
        : null}
    </div>
  )
}

function WarehouseBlock({ section, model, actions }: { section: WarehouseSection; model: OurWarehousesViewModel; actions: OurWarehousesViewActions }): ReactElement {
  const t = useT('our-warehouses')
  const locale = useLocale()
  const answer = answerOf(section)
  return (
    <Section id={`warehouse-${section.siteId}`} title={section.place ? `${section.name} · ${section.place}` : section.name} answer={t(answer.key, answer.params)} info={<p>{t('section.info')}</p>}>
      <h3 className="fw-ows-h3">{t('at.title', { count: section.pieces.at })}</h3>
      {section.at.length > 0 ? (
        <div className="fw-ows-rows">
          {section.at.map((row) => (
            <article key={row.shipmentId} className="fw-ows-card" aria-label={row.number}>
              <header className="fw-ows-card-h">
                <Link className="fw-ows-link" href={`${model.prefix}/warehouse/shipments/${encodeURIComponent(row.shipmentId)}`}>
                  {row.number}
                </Link>
                <StateChip life="AT_OUR_WAREHOUSE" />
                <span className="fw-ows-sp" />
                <Pill tone="neutral">{t('pieces', { count: row.pieces })}</Pill>
              </header>
              <span className="fw-ows-card-t">
                <b>{row.customer.name}</b> <span className="fw-ows-mu">{row.customer.code}</span>
              </span>
              <span className="fw-ows-mu">
                {row.salesOrders.map((order, index) => (
                  <span key={order.id}>
                    {index > 0 ? ', ' : ''}
                    <Link className="fw-ows-link" href={`${model.prefix}/sales/orders/${encodeURIComponent(order.id)}?tab=shipments`}>
                      {order.number}
                    </Link>
                  </span>
                ))}
              </span>
              <span className="fw-ows-mu">{t('at.since', { day: formatDate(row.arrivedAt, { locale }) })}</span>
              <span className="fw-ows-item">
                <Tag tone={row.label ? 'success' : 'warning'}>
                  {row.label ? <CheckCircle2 size={12} aria-hidden /> : <Hourglass size={12} aria-hidden />} {row.label ? t('at.labelYes') : t('at.labelNo')}
                </Tag>
                <span className="fw-ows-sp" />
                {model.acts.sendOn ? (
                  <Button size="sm" variant={row.label ? 'primary' : undefined} onClick={() => actions.onSendOn?.(row.shipmentId)}>
                    {t('act.sendOn')}
                  </Button>
                ) : null}
              </span>
            </article>
          ))}
        </div>
      ) : (
        <Quiet>{t('at.empty')}</Quiet>
      )}
      <h3 className="fw-ows-h3">{t('way.title', { count: section.pieces.onTheWay })}</h3>
      {section.onTheWay.length > 0 ? (
        <ul className="fw-ows-list">
          {section.onTheWay.map((row) => (
            <li key={row.shipmentId} className="fw-ows-item">
              <Truck size={14} aria-hidden />
              <Link className="fw-ows-link" href={`${model.prefix}/warehouse/shipments/${encodeURIComponent(row.shipmentId)}`}>
                {row.number}
              </Link>
              <span className="fw-ows-t">{row.customer.name}</span>
              <span className="fw-ows-mu">{row.customer.code}</span>
              <span className="fw-ows-mu">{t('pieces', { count: row.pieces })}</span>
              <span className="fw-ows-mu">{t('way.left', { day: formatDate(row.shippedAt, { locale }) })}</span>
              <span className="fw-ows-sp" />
              {model.acts.arrived ? (
                <Button size="sm" onClick={() => actions.onArrived?.(row.shipmentId)}>
                  {t('act.arrived')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <Quiet>{t('way.empty')}</Quiet>
      )}
    </Section>
  )
}
