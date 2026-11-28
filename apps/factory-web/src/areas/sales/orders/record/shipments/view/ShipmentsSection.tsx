'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Button, Pill } from '@nexus/ui/primitives'
import { useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { LineMenuButton } from '../../view/LineMenu'
import { PartFailed, Quiet, Section } from '../../../../../../lib/record-sections/Kit' // F-OS-101: the Production kit, in place
import { createDoorOf, elsewhereDoorOf } from '../doors'
import { shownShipments, type JoinableRow } from '../model'
import { rowOf, shipmentsAnswer } from '../rows'
import type { WhereModel } from '../where'
import { copyLinkTo, kitId, shipmentHref } from './hrefs'
import { sentenceOf, useShipSay } from './say'
import { ShipmentRowView } from './ShipmentRow'

/**
 * F-OS-103 (order SHIPMENTS tab, 10-design §5) — section 2 "Shipments" (#shipments; the old #deliveries lands here, L5: its card went
 * into the rows), drawn: the answer ("3 shipments · 1 shipped · 1 packed · 1 draft · SEED-SH-0011 expected 14 Nov"); the head's doors —
 * Create shipment… ONCE on this tab (L10; Warehouse's New shipment in place, F-OP-121; held with its true words only by the order's
 * state, hidden without shipping.manage: D2) · Record a shipment made elsewhere… (F-OP-123) · ⋯ · ⓘ; one row per shipment
 * (ShipmentRow.tsx; content-sized columns that follow the LIST's room); "Show N cancelled"; the customer's drafts this order can join
 * (F-OP-122, shipping.manage). Draws its model (shipments/rows.ts, doors.ts); reads nothing.
 */
export function ShipmentsSection({ order, model, actions, where }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; where: WhereModel }) {
  const t = useT('order-shipments')
  const o = useT('orders')
  const depth = useT('warehouse-shipments-depth')
  const say = useShipSay()
  const [showCancelled, setShowCancelled] = useState(false)
  const rows = order.chain.shipments
  const shown = shownShipments(rows, showCancelled)
  const deliveries = model.shipmentDeliveries ?? null
  const byId = new Map((deliveries?.value?.shipments ?? []).map((row) => [row.id, row]))
  const create = createDoorOf(order, model.can, where, model.prefix, !!actions?.onCreateShipment)
  const elsewhere = elsewhereDoorOf(model.elsewhere, model.can)
  const title = o('ship.listTitle')
  const buttons: ReactNode[] = []
  if (create.kind === 'open')
    buttons.push(
      create.inPlace ? (
        <Button key="create" size="sm" variant="primary" onClick={() => actions?.onCreateShipment?.()}>
          {o('step.createShipment')}
        </Button>
      ) : (
        <Button key="create" size="sm" variant="primary" asChild>
          <Link href={create.href}>{o('action.createShipment')}</Link>
        </Button>
      ),
    )
  if (create.kind === 'held')
    buttons.push(
      <Button key="create" size="sm" heldReason={say(create.words)}>
        {o('step.createShipment')}
      </Button>,
    )
  // F-OP-123: goods that left with a paper DDT written outside Nexus — hidden without the rights (D2), held with words by the order's state.
  if (elsewhere)
    buttons.push(
      <Button key="elsewhere" size="sm" heldReason={elsewhere.held ? o(elsewhere.held.key, elsewhere.held.params) : null} onClick={() => actions?.onRecordElsewhere?.()}>
        {o('elsewhere.title')}
      </Button>,
    )
  const more = <LineMenuButton label={t('ships.more')} items={[{ id: 'warehouse', label: t('ships.openWarehouse'), href: `${model.prefix}/warehouse/shipments` }, { id: 'copy', label: t('ships.copyLink'), onSelect: () => copyLinkTo('shipments') }]} />
  const info = <p>{t('ships.info')}</p>
  const answer = shipmentsAnswer(rows).map(say)
  // One quiet line when nothing is shown (never a box; an order whose every shipment is cancelled shows it with the toggle, H2-B1).
  const empty = !model.can.createShipment ? t('ships.empty.warehouse') : where.mode === 'today' ? t('ships.empty.plain') : where.totals.ready > 0 ? t('ships.empty.ready', { count: where.totals.ready }) : t('ships.empty.nothing')
  return (
    <Section id={kitId('shipments')} title={title} answer={answer.length > 0 ? sentenceOf(answer) : null} buttons={buttons} more={more} info={info}>
      {/* L5: the old Deliveries card's address lands here (its card is in the rows now). */}
      <span id="deliveries" className="fw-os-alias" tabIndex={-1} />
      {create.kind === 'held' ? (
        <p className="fw-os-held">
          {say(create.words)} {t('ships.create.hint')}
        </p>
      ) : null}
      {deliveries?.problem ? <PartFailed part={t('ships.deliveriesPart')} problem={deliveries.problem} onRetry={actions?.shipmentsTab?.onRetryDeliveries} /> : null}
      {shown.rows.length > 0 ? (
        <div className="fw-os-sl" role="table" aria-label={t('ships.tableOf', { number: order.number })}>
          <div className="fw-os-sr is-hd" role="row">
            <span role="columnheader">{o('ship.col.number')}</span>
            <span role="columnheader" className="fw-os-lab-c">
              {t('ships.col.carries')}
            </span>
            <span role="columnheader">{o('ship.col.status')}</span>
            <span role="columnheader">{depth('transport.title')}</span>
            <span role="columnheader">{t('ships.col.dates')}</span>
            <span role="columnheader">
              <span className="nds-vh">{t('ships.col.more')}</span>
            </span>
          </div>
          {shown.rows.map((row) => (
            <ShipmentRowView key={row.id} row={row} view={rowOf(row, order, byId.get(row.id) ?? null, model.shipmentFacts?.[row.id] ?? null /* os-fx7 */)} delivery={byId.get(row.id) ?? null} order={order} model={model} actions={actions} />
          ))}
        </div>
      ) : (
        <Quiet>{empty}</Quiet>
      )}
      {/* ── F-OP-122: the customer's DRAFT shipments of the same site and address this order may join (DRAFT only, shipping.manage) ── */}
      {model.joinable && model.joinable.length > 0 ? <JoinableDrafts rows={model.joinable} order={order} model={model} onJoin={actions?.onJoinShipment} /> : null}
      {shown.cancelled > 0 ? (
        <div className="fw-os-foot">
          <button type="button" className="fw-pt-link" onClick={() => setShowCancelled((value) => !value)} aria-expanded={showCancelled}>
            {showCancelled ? o('ship.hideCancelled') : o('ship.showCancelled', { count: shown.cancelled })}
          </button>
        </div>
      ) : null}
    </Section>
  )
}

// ── F-OP-122 (order page plan N6): the DRAFTs this order may join, each "Add this order's garments…" (B-OP-047: only those that may) ──
function JoinableDrafts({ rows, order, model, onJoin }: { rows: readonly JoinableRow[]; order: Order; model: OrderRecordModel; onJoin?: (shipmentId: string) => void }) {
  const o = useT('orders')
  const depth = useT('warehouse-shipments-depth') // the join reasons, in the Warehouse's own words
  return (
    <div className="fw-os-jl">
      <span className="fw-os-jl-t">{o('ship.join.title')}</span>
      {rows.map((row) => (
        <span key={row.shipmentId} className="fw-os-jr">
          <Link className="fw-pt-link" href={shipmentHref(model.prefix, order.companyId, { id: row.shipmentId, number: row.number })}>
            {row.number}
          </Link>
          <Pill tone="neutral">{o('shipStatus.DRAFT')}</Pill>
          <span className="fw-os-sp" />
          <Button size="sm" heldReason={row.held ? depth(row.held.key, row.held.params) : null} onClick={() => onJoin?.(row.shipmentId)}>
            {o('ship.join.add')}
          </Button>
        </span>
      ))}
    </div>
  )
}
// ── end F-OP-122 ──
