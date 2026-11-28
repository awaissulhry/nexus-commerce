'use client'

import type { ReactElement, ReactNode } from 'react'
import Link from 'next/link'
import { Boxes, Plus } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Checkbox, FilterChip, Pill } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { PartReading, Quiet, Section } from '../../../../lib/record-sections/Kit'
import { STATUS_TONE } from '../../shipments/model'
import { SHIPMENT_CHIPS, type CustomerGroup, type Said, type ShipmentChip, type ShipmentLine } from '../model'
import '../ready-to-ship.css'

/**
 * owb-ss3 step 3.4 (design plan § 5n; ship.js `officeShip`) — Warehouse › Ready to ship, drawn: section "Ready to ship" — every order
 * with ready garments BY CUSTOMER (a card per customer: the box that ticks all its orders, each order with its box, its number, the
 * customer's reference and its ready pieces; "These orders can go in one shipment"), the head's acts **One shipment for the n orders**
 * (held with why: two customers never travel together) and **Add to SH-…** (the customer's drafts the ticked orders may join); section
 * "Shipments" — the chips Open · On the way · Arrived · All and one row per shipment. Phone: the cards stack; wide: the cards fill the
 * row (no dead space). Draws its model; fetches nothing.
 */

export type Part<T> = { readonly state: 'reading' } | { readonly state: 'failed'; readonly problem: string } | { readonly state: 'ready'; readonly value: T }

export interface ReadyToShipViewModel {
  readonly prefix: string
  readonly plan: boolean
  readonly groups: Part<readonly CustomerGroup[]>
  readonly ticked: ReadonlySet<string>
  readonly picked: { readonly orders: number; readonly customers: number; readonly pieces: number }
  readonly one: { readonly words: Said; readonly held: Said | null }
  /** The customer's DRAFT shipments the ticked orders may join ("Add to SH-…"). */
  readonly drafts: readonly { readonly shipmentId: string; readonly number: string }[]
  readonly busy: boolean
  /** A refused create or add, in the Warehouse's words (`shipments`: problem.write.*), with the API's sentence. */
  readonly problem: { readonly key: string; readonly detail: string | null } | null
  readonly chip: ShipmentChip
  readonly shipments: Part<readonly ShipmentLine[]>
}

export interface ReadyToShipViewActions {
  readonly onTick?: (salesOrderId: string) => void
  readonly onTickCustomer?: (group: CustomerGroup) => void
  readonly onOneShipment?: () => void
  readonly onAddTo?: (shipmentId: string) => void
  readonly onChip?: (chip: ShipmentChip) => void
  readonly onRetry?: (part: 'orders' | 'shipments') => void
}

export function ReadyToShipView({ model, actions = {} }: { model: ReadyToShipViewModel; actions?: ReadyToShipViewActions }): ReactElement {
  return (
    <div className="fw-pt fw-rts">
      <ReadySection model={model} actions={actions} />
      <ShipmentsSection model={model} actions={actions} />
    </div>
  )
}

function ReadySection({ model, actions }: { model: ReadyToShipViewModel; actions: ReadyToShipViewActions }): ReactElement {
  const t = useT('ready-to-ship')
  const s = useT('shipments')
  const groups = model.groups.state === 'ready' ? model.groups.value : []
  const orders = groups.reduce((sum, group) => sum + group.orders.length, 0)
  const buttons: ReactNode[] = model.plan
    ? [
        <Button key="one" size="sm" variant="primary" heldReason={model.one.held ? t(model.one.held.key, model.one.held.params) : null} onClick={() => actions.onOneShipment?.()}>
          <Boxes size={14} aria-hidden /> {t(model.one.words.key, model.one.words.params)}
        </Button>,
        ...model.drafts.map((draft) => (
          <Button key={draft.shipmentId} size="sm" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions.onAddTo?.(draft.shipmentId)}>
            <Plus size={14} aria-hidden /> {t('act.addTo', { number: draft.number })}
          </Button>
        )),
      ]
    : []
  const answer = model.groups.state !== 'ready' ? null : orders === 0 ? t('ready.empty') : model.plan ? (model.picked.orders > 0 ? t('ready.picked', { count: model.picked.orders, pieces: model.picked.pieces }) : t('ready.answer')) : t('ready.readOnly')
  return (
    <Section id="ready" title={t('ready.title')} answer={answer} buttons={buttons} info={<p>{t('ready.info')}</p>}>
      {model.groups.state === 'reading' ? <PartReading rows={3} height={56} /> : null}
      {model.groups.state === 'failed' ? <Failed part={t('ready.title')} problem={s(model.groups.problem)} onRetry={() => actions.onRetry?.('orders')} /> : null}
      {model.problem ? (
        <Banner tone="danger" title={s(model.problem.key)}>
          {model.problem.detail}
        </Banner>
      ) : null}
      {groups.length > 0 ? (
        <div className="fw-rts-groups">
          {groups.map((group) => (
            <CustomerCard key={group.partyId} group={group} model={model} actions={actions} />
          ))}
        </div>
      ) : model.groups.state === 'ready' ? (
        <Quiet>{t('ready.empty')}</Quiet>
      ) : null}
    </Section>
  )
}

function CustomerCard({ group, model, actions }: { group: CustomerGroup; model: ReadyToShipViewModel; actions: ReadyToShipViewActions }): ReactElement {
  const t = useT('ready-to-ship')
  const all = group.orders.every((row) => model.ticked.has(row.salesOrderId))
  const some = group.orders.some((row) => model.ticked.has(row.salesOrderId))
  return (
    <section className="fw-rts-card" aria-label={group.name}>
      <header className="fw-rts-card-h">
        {model.plan ? (
          <Checkbox
            checked={all}
            ref={(box) => {
              if (box) box.indeterminate = some && !all
            }}
            onChange={() => actions.onTickCustomer?.(group)}
            aria-label={t('ready.tickCustomer', { name: group.name })}
          />
        ) : null}
        <span className="fw-rts-card-t">
          <b>{group.name}</b> <span className="fw-rts-mu">{group.code}</span>
        </span>
        <Pill tone="success">{t('ready.pieces', { count: group.pieces })}</Pill>
      </header>
      {group.orders.length > 1 ? <p className="fw-rts-mu">{t('ready.together')}</p> : null}
      <ul className="fw-rts-orders">
        {group.orders.map((row) => (
          <li key={row.salesOrderId} className="fw-rts-order">
            {model.plan ? <Checkbox checked={model.ticked.has(row.salesOrderId)} onChange={() => actions.onTick?.(row.salesOrderId)} aria-label={t('ready.tickOrder', { number: row.number })} /> : null}
            <Link className="fw-rts-link" href={`${model.prefix}/sales/orders/${encodeURIComponent(row.salesOrderId)}?tab=shipments`}>
              {row.number}
            </Link>
            {row.customerRef ? <span className="fw-rts-mu">{row.customerRef}</span> : null}
            <span className="fw-rts-sp" />
            <span>{t('ready.pieces', { count: row.pieces })}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ShipmentsSection({ model, actions }: { model: ReadyToShipViewModel; actions: ReadyToShipViewActions }): ReactElement {
  const t = useT('ready-to-ship')
  const s = useT('shipments')
  const locale = useLocale()
  const rows = model.shipments.state === 'ready' ? model.shipments.value : []
  return (
    <Section id="shipments" title={t('ships.title')} answer={model.shipments.state === 'ready' ? (rows.length > 0 ? t('ships.answer', { count: rows.length }) : t('ships.empty')) : null} info={<p>{t('ships.info')}</p>}>
      <div className="fw-rts-chips" role="group" aria-label={t('ships.chips')}>
        {SHIPMENT_CHIPS.map((chip) => (
          <FilterChip key={chip} pressed={model.chip === chip} count={model.chip === chip && model.shipments.state === 'ready' ? rows.length : undefined} onClick={() => actions.onChip?.(chip)}>
            {t(`ships.chip.${chip}`)}
          </FilterChip>
        ))}
      </div>
      {model.shipments.state === 'reading' ? <PartReading rows={3} /> : null}
      {model.shipments.state === 'failed' ? <Failed part={t('ships.title')} problem={s(model.shipments.problem)} onRetry={() => actions.onRetry?.('shipments')} /> : null}
      {rows.length > 0 ? (
        <ul className="fw-rts-ships">
          {rows.map((row) => (
            <li key={row.id} className="fw-rts-ship">
              <Link className="fw-rts-link" href={`${model.prefix}/warehouse/shipments/${encodeURIComponent(row.id)}`}>
                {row.number}
              </Link>
              <Pill tone={STATUS_TONE[row.status]}>{s(`status.${row.status}`)}</Pill>
              <span className="fw-rts-t">{row.customer}</span>
              <span className="fw-rts-mu">{row.orders.join(', ')}</span>
              <span className="fw-rts-mu">
                {t('ships.garments', { count: row.garments })} · {t('ships.parcels', { count: row.parcels })}
              </span>
              {row.carrier ? <span className="fw-rts-mu">{row.carrier}</span> : null}
              <span className="fw-rts-mu">{formatDate(row.at, { locale })}</span>
            </li>
          ))}
        </ul>
      ) : model.shipments.state === 'ready' ? (
        <Quiet>{t('ships.none')}</Quiet>
      ) : null}
    </Section>
  )
}

/** A part that could not be read: one danger line with its own Try again (the rest of the page still draws). */
function Failed({ part, problem, onRetry }: { part: string; problem: string; onRetry?: () => void }): ReactElement {
  const t = useT('ready-to-ship')
  return (
    <Banner
      tone="danger"
      title={t('failed', { part })}
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            {t('retry')}
          </Button>
        ) : undefined
      }
    >
      {problem}
    </Banner>
  )
}
