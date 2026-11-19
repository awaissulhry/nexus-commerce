'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation' // F-OP-119 (F-OP-210's tab links)
import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { sizeGridWords } from '../../../quotes/record/view/grid-copy'
import type { Order } from '../../api'
import { gridOf, styleGroups } from '../../model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { PointsAtOrder } from '../links/view/OrderLinks' // F-SA-230: Complaints & returns live here
// F-OP-119 (order page plan N5): each row's carrier and tracking, the tracking door, the cancelled rows behind "Show N".
import { carrierOf, shownShipments, trackingDoorOf, trackingOf, type ShipmentRow } from '../shipments/model'
import { createShipmentDoor } from '../shipments/model' // F-OP-121
// F-OP-122: shared shipments — the other orders a shipment carries, and the customer's DRAFTs this order may join (held with why).
import { alsoCarries } from '../shipments/model'
import { typedLinkOf } from '../shipments/model' // F-OP-135: the typed link's Track ›
import { DEPTH_NS } from '../../../../warehouse/shipments/queue/shared/depth'
import { WithMessages } from '../../../../../record-panels/i18n' // F-OP-122: the join reasons' catalogue (not one the order page loads)
import type { JoinableRow } from '../shipments/model'
import { tabHref } from '../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../lib/tab-link/TabLink'
// F-OP-123 (order page N5): Record a shipment made elsewhere…, and the "Made elsewhere" chip of a row.
import { Tag } from '@nexus/ui/primitives'
import { madeElsewhereChip } from '../shipments/elsewhere/model'

const SHIPMENT_TONE = { DRAFT: 'neutral', PACKED: 'info', SHIPPED: 'info', DELIVERED: 'success', RETURNED: 'warning', CANCELLED: 'danger' } as const

/**
 * Shipments (design `order.ship.left` + `order.ship.list`): per style, what is still to ship per size, beside what
 * quality released and what left; then every shipment of the order (its state, when it left, when it arrived), each a
 * real link to its record (Warehouse › Shipments). Create shipment opens Warehouse's New shipment with this order chosen.
 */
// F-SA-266: each shipment's Discuss (its reference: the customer reads its own shipment number) and its anchor ("Show on the page").
import { DiscussDoor } from './Discuss'
import { rowAnchor } from '../dock/discuss'

// B-W2b-398: `delivered` is the card "Delivered (from carrier)" (its container reads it; the design cases need no session).
// F-SA-230 (10-order-page §2.6): Shipments = Left to ship · Shipments · Deliveries · Complaints & returns (B-TH-256's list, each by its
// own right); the invoices and payments it held before are on Money (a door at its foot).
export function ShipmentsTab({ order, model, actions, delivered }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; delivered?: ReactNode }) {
  const t = useT('orders')
  const sales = useT('sales')
  const locale = useLocale()
  const copy = sizeGridWords(sales)
  const groups = styleGroups(order.lines)
  const shipmentHref = (row: { id: string; number: string }) => `${model.prefix}${recordAddress({ type: 'Shipment', id: row.id, label: row.number, companyId: order.companyId }, OFFICE_PAGES)}`
  const figures = order.progress
  // ---- F-OP-119: cancelled rows behind "Show N cancelled"; the tab links keep the dock's scope (F-OP-210) ----
  const [showCancelled, setShowCancelled] = useState(false)
  const shown = shownShipments(order.chain.shipments, showCancelled)
  const search = useSearchParams()?.toString() ?? ''
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const createDoor = createShipmentDoor(order, model.can, model.prefix, !!actions?.onCreateShipment) // F-OP-121
  const carrierText = (row: ShipmentRow): string => {
    const carrier = carrierOf(row)
    return carrier ? t(carrier.key, carrier.params) : '—'
  }

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
        <div className="fw-so-card-head">
          <h2 className="fw-so-h2">{t('ship.listTitle')}</h2>
          {/* F-OP-121: Create shipment… in place (this order and the customer's others); without the container, Warehouse's page. */}
          {createDoor?.kind === 'inPlace' && (
            <Button size="sm" variant="primary" onClick={() => actions?.onCreateShipment?.()}>
              {t('step.createShipment')}
            </Button>
          )}
          {createDoor?.kind === 'warehouse' && (
            <Button size="sm" variant="primary" asChild>
              <Link href={createDoor.href}>{t('action.createShipment')}</Link>
            </Button>
          )}
          {/* F-OP-123: goods that left with a paper DDT written outside Nexus — held with words for who may not (D4). */}
          {model.elsewhere && (
            <Button size="sm" heldReason={model.elsewhere.held ? t(model.elsewhere.held.key, model.elsewhere.held.params) : null} onClick={() => actions?.onRecordElsewhere?.()}>
              {t('elsewhere.title')}
            </Button>
          )}
        </div>
        {order.chain.shipments.length === 0 ? (
          <EmptyState title={t('ship.empty.title')} description={t('ship.empty.body')} />
        ) : (
          <SummaryTable
            label={t('ship.listTitle')}
            columns={[t('ship.col.number'), t('ship.col.status'), t('ship.col.carrier'), t('ship.col.tracking'), t('ship.col.shipped'), t('ship.col.delivered')]}
            rows={shown.rows.map((row) => ({
              id: row.id,
              cells: [
                <span key="n" className="fw-so-inline" id={rowAnchor('Shipment', row.id) /* F-SA-266 */} tabIndex={-1}>
                  <Link className="fw-so-link" href={shipmentHref(row)}>
                    {row.number}
                  </Link>
                  <DiscussDoor order={order} part={t('discuss.shipment', { number: row.number })} target={{ kind: 'Shipment', id: row.id }} />
                  {/* F-OP-122: a shared shipment names the other orders it carries, each a link to its order. */}
                  {alsoCarries(row, order.id).map((other) => (
                    <Link key={other.id} className="fw-so-link" href={`${model.prefix}/sales/orders/${other.id}`}>
                      {t('ship.alsoCarries', { number: other.number })}
                    </Link>
                  ))}
                  {/* F-OP-123: made elsewhere, with its paper DDT. */}
                  {madeElsewhereChip(row) && <Tag tone="neutral">{t(madeElsewhereChip(row)!.key, madeElsewhereChip(row)!.params)}</Tag>}
                </span>,
                <Pill key="s" tone={SHIPMENT_TONE[row.status as keyof typeof SHIPMENT_TONE] ?? 'neutral'}>{t(`shipStatus.${row.status}`)}</Pill>,
                // F-OP-119: who carries it, its tracking and the tracking door (the carrier and tracking only as the read gives them).
                carrierText(row),
                <TrackingCell key="t" row={row} shipmentHref={shipmentHref(row)} onOpen={actions?.onShipmentTracking} />,
                row.shippedAt ? formatDate(row.shippedAt, { locale }) : '—',
                row.deliveredAt ? formatDate(row.deliveredAt, { locale }) : '—',
              ],
            }))}
            density="roomy"
            stackOnPhone
            align={['left', 'left', 'left', 'left', 'right', 'right']}
          />
        )}
        {shown.cancelled > 0 && (
          <Button size="sm" onClick={() => setShowCancelled((value) => !value)} aria-expanded={showCancelled}>
            {showCancelled ? t('ship.hideCancelled') : t('ship.showCancelled', { count: shown.cancelled })}
          </Button>
        )}
        {/* ── F-OP-122: the customer's DRAFT shipments of the same site and address this order may join (DRAFT only) ── */}
        {model.joinable && model.joinable.length > 0 && (
          <WithMessages namespaces={[DEPTH_NS]}>
            <JoinableDrafts rows={model.joinable} shipmentHref={shipmentHref} onJoin={actions?.onJoinShipment} />
          </WithMessages>
        )}
        {/* ── end F-OP-122 ── */}
      </Card>
      {model.shipmentTracking /* F-OP-119: the tracking dialog of the shipment opened (its container) */}
      {model.newShipment /* F-OP-121: Warehouse's New shipment, opened in place (its container) */}
      {model.elsewhere?.dialog /* F-OP-123: Record a shipment made elsewhere… (its container, while open) */}
      {delivered}
      <PointsAtOrder model={model.links} actions={actions?.links} prefix={model.prefix} />
      <p className="fw-so-hint">
        <TabLink className="fw-so-link" href={tabHref(recordHref, 'money', search) /* F-OP-119: F-OP-210's tab link */}>
          {t('ship.moneyDoor')}
        </TabLink>
      </p>
    </div>
  )
}

// ── F-OP-122 (order page plan N6): the DRAFTs this order may join, each "Add this order's garments…" held with why ─────────────────
function JoinableDrafts({ rows, shipmentHref, onJoin }: { rows: readonly JoinableRow[]; shipmentHref: (row: { id: string; number: string }) => string; onJoin?: (shipmentId: string) => void }) {
  const t = useT('orders')
  const depth = useT(DEPTH_NS) // the join reasons, in the Warehouse's own words
  return (
    <div className="fw-so-stack">
      <h3 className="fw-so-h3">{t('ship.join.title')}</h3>
      {rows.map((row) => (
        <div key={row.shipmentId} className="fw-so-card-head">
          <span className="fw-so-inline">
            <Link className="fw-so-link" href={shipmentHref({ id: row.shipmentId, number: row.number })}>
              {row.number}
            </Link>
            <Pill tone="neutral">{t('shipStatus.DRAFT')}</Pill>
          </span>
          {/* Held, never hidden: a held row says why in words (B-OP-047: the offered rows may join). */}
          <Button size="sm" heldReason={row.held ? depth(row.held.key, row.held.params) : null} onClick={() => onJoin?.(row.shipmentId)}>
            {t('ship.join.add')}
          </Button>
        </div>
      ))}
    </div>
  )
}
// ── end F-OP-122 ──

// ── F-OP-119 (order page plan N5; 10-order-page §8.1, §8.2) ──────────────────────────────────────────────────────────────────────────
/**
 * A shipment's Tracking cell: the number typed for a carrier booked by hand (Copy, and "No live tracking": no carrier feeds it), or its
 * labels' parcel numbers (each to its carrier's https page), then "Tracking number…" — held with the read's words and, where one
 * fixes it, the door: the shipment's page (a label to void), "Change how it travels…" there before the goods leave.
 */
function TrackingCell({ row, shipmentHref, onOpen }: { row: ShipmentRow; shipmentHref: string; onOpen?: (shipmentId: string) => void }) {
  const t = useT('orders')
  const tracking = trackingOf(row)
  const door = trackingDoorOf(row)
  const link = typedLinkOf(row) // F-OP-135
  return (
    <span className="fw-so-inline">
      {tracking?.typed ? (
        <>
          <span>{tracking.typed}</span>
          <CopyNumber text={tracking.typed} />
          <Pill tone="neutral">{t('ship.noLive')}</Pill>
          {/* F-OP-135: the carrier's page typed beside the number (https only), in a new tab. */}
          {link && (
            <a className="fw-so-link" href={link} target="_blank" rel="noopener noreferrer" aria-label={t('ship.trackLink', { number: row.number })}>
              {t('ship.track')}
            </a>
          )}
        </>
      ) : null}
      {tracking?.parcels.map((parcel) =>
        parcel.url ? (
          <a key={parcel.number} className="fw-so-link" href={parcel.url} target="_blank" rel="noopener noreferrer">
            {parcel.number}
          </a>
        ) : (
          <span key={parcel.number}>{parcel.number}</span>
        ),
      )}
      {!tracking && <span>—</span>}
      <Button size="sm" heldReason={door.kind === 'held' ? t(door.words.key, door.words.params) : null} onClick={() => onOpen?.(row.id)}>
        {t('ship.trackingOpen')}
      </Button>
      {door.kind === 'held' && door.door === 'shipment' && (
        <Link className="fw-so-link" href={shipmentHref}>
          {t('ship.tracking.door.shipment')}
        </Link>
      )}
      {door.kind === 'held' && door.door === 'arrange' && (
        <Link className="fw-so-link" href={`${shipmentHref}?tab=carrier`}>
          {t('ship.tracking.door.arrange')}
        </Link>
      )}
    </span>
  )
}

/** Copy a typed number; "Copied" for a moment (said to a screen reader too). */
function CopyNumber({ text }: { text: string }) {
  const t = useT('orders')
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      aria-live="polite"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 3000)
          })
          .catch(() => setCopied(false))
      }}
    >
      {copied ? t('ship.copied') : t('ship.copy')}
    </Button>
  )
}
// ── end F-OP-119 ──
