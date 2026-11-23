'use client'

import { Fragment } from 'react'
import Link from 'next/link'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { NewShipmentDialog } from '../../../../warehouse/shipments/list/view/NewShipmentDialog'
import { SHIP_TOGETHER_MAX, type AskedLine } from '../../../../warehouse/shipments/model'
import type { NewShipmentActions } from '../../../../warehouse/shipments/new/use-new-shipment'
import { DEPTH_NAMESPACES, DEPTH_NS } from '../../../../warehouse/shipments/queue/shared/depth'
import type { OrderRow } from '../../api'
import { NAMESPACE as SHEET } from '../sheet/model'
import { completeWarnings, shipSummaryOf, type ShipNotice, type ShipTogetherModel } from '../sheet/ship'
import './ship-together.css'

/**
 * F-CW-301 (customer Work tab plan §4; 10-design §6 W1) — Warehouse's ONE New shipment window on the Orders sheet (its third mount:
 * the dialog below is Warehouse's own component, never a copy) with the sheet's own lines over its steps:
 *
 *   Runs on 4 · Not on 2: why is beside each        the ticked orders (the approved words of the bulk commands)
 *   SEED-SO-0010 · Nothing released to ship          each one it does not run on, with why in the existing words
 *   One shipment carries at most 20 orders …         the cap, said before the click
 *   Seed Racing wants SEED-SO-0009 all in one delivery. This shipment would carry 24 of its 244 pieces still to ship.
 *   A draft of Seed Racing exists: SEED-SH-0011 ›    a door (joining several orders to it is a later job)
 *
 * and, after Create, ONE notice: the draft's number, the orders it carries (each a door to its thread) and the way to Warehouse. A
 * draft is never shown to the customer: the notice says so. Draws its model; the containers read and write.
 */

type Row = Pick<OrderRow, 'id' | 'number' | 'customerRef' | 'partyName' | 'units' | 'shippedUnits'>

export function ShipWindow({ model, actions, rows, prefix }: { model: ShipTogetherModel; actions?: NewShipmentActions; rows: readonly Row[]; prefix: string }) {
  if (!model.window) return null
  return (
    <WithMessages namespaces={[...DEPTH_NAMESPACES, SHEET]}>
      <NewShipmentDialog model={model.window} can={model.can} actions={actions} above={<ShipAbove model={model} rows={rows} prefix={prefix} />} />
    </WithMessages>
  )
}

function ShipAbove({ model, rows, prefix }: { model: ShipTogetherModel; rows: readonly Row[]; prefix: string }) {
  const s = useT(SHEET)
  const sh = useT('shipments')
  const d = useT(DEPTH_NS)
  const open = model.window
  if (!open) return null
  const summary = shipSummaryOf(open)
  const warnings = completeWarnings(open, rows, model.complete)
  if (!summary && warnings.length === 0 && !model.draft) return null
  /** An order as the sheet names it: its number, and the customer's PO when it gave one. */
  const nameOf = (id: string): string => {
    const row = rows.find((entry) => entry.id === id)
    const read = open.orders?.find((order) => order.salesOrderId === id)
    const number = row?.number ?? read?.number ?? ''
    const ref = row?.customerRef ?? read?.customerRef ?? null
    return ref ? `${number} (${ref})` : number
  }
  const first = open.orders?.find((order) => order.salesOrderId === open.salesOrderId)
  const customer = rows.find((entry) => entry.id === open.salesOrderId)?.partyName ?? first?.party.legalName ?? ''
  // Why a ticked order is not on the shipment, each in the words that already say it.
  const why = (line: AskedLine): string =>
    line.why?.kind === 'held' ? d(line.why.held.key) : line.why?.kind === 'cap' ? s('ship.cap', { max: SHIP_TOGETHER_MAX }) : line.why?.kind === 'off' ? s('ship.off') : sh('new.empty.title')
  return (
    <div className="fw-sst">
      {summary && (
        <>
          <p className="fw-sst-sum" role="status">
            <b>{s('commands.runs', { count: summary.runs })}</b>
            {summary.notOn.length > 0 && ` · ${s('commands.notOn', { count: summary.notOn.length })}`}
          </p>
          {summary.notOn.length > 0 && (
            <ul className="fw-sst-list" aria-label={s('ship.notOnLabel')}>
              {summary.notOn.map((line) => (
                <li key={line.id}>
                  <b>{nameOf(line.id)}</b> · {why(line)}
                </li>
              ))}
            </ul>
          )}
          <p className="fw-sst-hint">{s('ship.capLine', { max: SHIP_TOGETHER_MAX, count: summary.asked })}</p>
        </>
      )}
      {warnings.map((warning) => (
        <Banner key={warning.id} tone="warning" title={s('ship.complete', { customer, order: nameOf(warning.id) })}>
          {s('ship.completeCarries', { carried: warning.carried, owed: warning.owed })}
        </Banner>
      ))}
      {model.draft && (
        <p className="fw-sst-hint">
          {s('ship.draft', { customer })}{' '}
          <Link href={`${prefix}/warehouse/shipments/${encodeURIComponent(model.draft.shipmentId)}`} target="_blank" rel="noopener noreferrer">
            {model.draft.number} ›
          </Link>
        </p>
      )}
    </div>
  )
}

/** The ONE notice after Create: the draft, its orders (each a door to its thread), the way to Warehouse — and that nobody is told. */
export function ShipNoticeBanner({ notice, prefix, onOrder, onDismiss }: { notice: ShipNotice; prefix: string; onOrder?: (orderId: string) => void; onDismiss?: () => void }) {
  const s = useT(SHEET)
  const t = useT('orders')
  return (
    <Banner
      tone="success"
      title={s('ship.created', { number: notice.number, count: notice.orders.length })}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.dismiss')}
          </Button>
        ) : undefined
      }
    >
      <span className="fw-sst-made">
        {notice.orders.map((order, index) => (
          <Fragment key={order.id}>
            {index > 0 && ', '}
            <Button size="sm" variant="link" title={s('ship.showThread', { number: order.number })} onClick={() => onOrder?.(order.id)}>
              {order.number}
            </Button>
          </Fragment>
        ))}
        {' — '}
        {notice.customer ? s('ship.createdDraft', { customer: notice.customer }) : s('ship.createdDraftAny')}{' '}
        <Link href={`${prefix}/warehouse/shipments/${encodeURIComponent(notice.shipmentId)}`}>{t('ship.createdDoor')}</Link>
      </span>
    </Banner>
  )
}
