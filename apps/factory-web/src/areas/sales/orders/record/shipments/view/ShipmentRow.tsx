'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, Truck } from 'lucide-react'
import { Modal } from '@nexus/ui/components'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame' // B-SA-0xxb: the proof in the thread's ONE viewer
import { sizeGridWords } from '../../../../quotes/record/view/grid-copy'
import type { Order } from '../../../api'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { DiscussDoor } from '../../view/Discuss'
import { LineMenuButton } from '../../view/LineMenu'
import type { Chip, DateLine, RowModel } from '../rows'
// F-OS-202: the row ⋯ by state.
import type { MenuItemDef } from '@nexus/ui/components'
import type { DeliveryRow } from '../delivered/api'
import { rowActsOf, type RowAct, type RowActGroup } from '../doors'
import type { Say } from './say'
import type { ShipmentRow } from '../where'
import { copyLinkTo, shipmentHref, shipmentTabHref } from './hrefs'
import { ParcelsFold } from './ParcelsFold'
import { useShipSay } from './say'
import { noBreak } from '../../../../../warehouse/shipments/queue/shared/no-break' // os-fx7 (W-18): numbers whole in titles
// owb-ss3 step 3.2: the row's leg (to our warehouse first) and its act.
import type { Leg } from '../legs/api'
import type { LegAct } from '../legs/model'
import { LegMarks } from '../legs/view/LegMarks'

/**
 * F-OS-103 (order SHIPMENTS tab, 10-design §5) — one shipment's row: Shipment (its number opens it in Warehouse, its home; Discuss;
 * the chips) · What it carries (By size › opens a read-only centred window, one DS size grid per style) · State (the pill, each hold
 * in force with who placed it and who releases it, open tracking problems, came back, the cancel's reason, "Next: … ›" into the
 * Warehouse step — hidden without shipping.manage) · How it travels (the carrier, "Not shown to your role" when withheld, the typed
 * number or the first label number with Copy and Track ›, "3 parcels · 3 tracked", Tracking number… where it may be typed here, the
 * Parcels (n) fold) · Dates (packed, left, expected, delivered and how we know, the carrier's later word, Proof ›, came back) · ⋯.
 * Its anchor `about-Shipment-<id>` (the dock's "Show on the page"). Draws its model (shipments/rows.ts); reads nothing — the Parcels
 * (n) fold asks the container to read the cartons once it opens.
 */
export function ShipmentRowView({ row, view, delivery, order, model, actions, leg = null, legActs = [], onLegAct }: { row: ShipmentRow; view: RowModel; /* F-OS-202 */ delivery: DeliveryRow | null; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; /* owb-ss3 */ leg?: Leg | null; legActs?: readonly LegAct[]; onLegAct?: (act: LegAct) => void }) {
  const t = useT('order-shipments')
  const o = useT('orders')
  const depth = useT('warehouse-shipments-depth')
  const say = useShipSay() // F-OS-202
  const frame = useRecordFrame() // os-fx7 (W-10): Show in the thread
  const f = useT('record-frame')
  const [fold, setFold] = useState(false)
  const [bySize, setBySize] = useState(false)
  const href = shipmentHref(model.prefix, order.companyId, view)
  const cancelled = view.status === 'CANCELLED'
  const openFold = () => {
    const next = !fold
    setFold(next)
    if (next) actions?.shipmentsTab?.onOpenParcels?.(view.id)
  }
  return (
    <div className={`fw-os-sr${cancelled ? ' is-cancelled' : ''}`} role="row" id={view.anchor /* F-SA-266 */} tabIndex={-1}>
      <div className="fw-os-c-n" role="cell">
        <span className="fw-os-nb">
          <Link className="fw-pt-link" href={href}>
            {view.number}
          </Link>
          {model.can.threadsPost ? <DiscussDoor order={order} part={o('discuss.shipment', { number: view.number })} target={{ kind: 'Shipment', id: view.id }} /> : null}
        </span>
        {view.chips.length > 0 ? (
          <span className="fw-os-chips">
            {view.chips.map((chip) => (
              <ChipView key={chipKey(chip)} chip={chip} prefix={model.prefix} />
            ))}
          </span>
        ) : null}
      </div>
      <div className="fw-os-c-c" role="cell" data-l={t('ships.col.carries')}>
        <CarriesCell view={view} href={href} onBySize={() => setBySize(true)} />
      </div>
      <div className="fw-os-c-s" role="cell">
        <StateCellView view={view} order={order} model={model} />
        {leg ? <LegMarks leg={leg} status={row.status} acts={legActs} onAct={onLegAct} /> : null}
      </div>
      <div className="fw-os-c-t" role="cell" data-l={depth('transport.title')}>
        <TravelsCellView view={view} row={row} fold={fold} onFold={openFold} onTracking={() => actions?.onShipmentTracking?.(view.id)} />
      </div>
      <div className="fw-os-c-d" role="cell" data-l={t('ships.col.dates')}>
        {view.dates.map((line) => (
          <DateLineView key={line.kind} line={line} view={view} actions={actions} />
        ))}
      </div>
      <div className="fw-os-c-o" role="cell">
        {/* F-OS-202: the row's acts by state (each Warehouse's own window, in place; hidden without the right, held only by state),
            then its read doors. */}
        <LineMenuButton label={t('ships.row.more', { number: view.number })} items={rowMenuOf(rowActsOf(row, order.id, delivery, model.can /* F-OS-303: the after-sales doors */, leg /* owb-ss3 */), say, (act) => actions?.shipmentsTab?.onAct?.(view.id, act.id, act.holdId), [
          { id: 'open', label: t('ships.carries.notRead'), href },
          // os-fx7 (W-10): Show in the thread — a read door, where the page has the conversation (hidden without it), at the row's newest moment.
          ...(view.showAt && frame?.showInThread ? [{ id: 'show', label: f('discuss.showInThread'), onSelect: () => frame.showInThread?.({ record: { type: 'SalesOrder', id: order.id }, at: view.showAt ?? '' }) }] : []),
          { id: 'copy', label: t('ships.row.copyLink'), onSelect: () => copyLinkTo(view.anchor) },
        ])} />
      </div>
      <div className="fw-os-c-f" role="cell">
        {fold && view.fold !== null ? <ParcelsFold row={row} order={order} part={model.shipmentParcels?.[view.id] ?? null} onRetry={() => actions?.shipmentsTab?.onOpenParcels?.(view.id)} /> : null}
      </div>
      {bySize && view.carries ? <CarriesWindow view={view} order={order} onClose={() => setBySize(false)} /> : null}
    </div>
  )
}

const chipKey = (chip: Chip): string => ('id' in chip ? `${chip.kind}-${chip.id}` : 'number' in chip ? `${chip.kind}-${chip.number}` : chip.kind)

function ChipView({ chip, prefix }: { chip: Chip; prefix: string }) {
  const t = useT('order-shipments')
  const o = useT('orders')
  const s = useT('shipments')
  const say = useShipSay()
  switch (chip.kind) {
    case 'also':
      // F-OP-122: a shared shipment names the other orders it carries (all of this customer's), each a link to its order.
      return (
        <Tag tone="neutral">
          <Link className="fw-pt-link" href={`${prefix}/sales/orders/${encodeURIComponent(chip.id)}`}>
            {o('ship.alsoCarries', { number: chip.number })}
          </Link>
        </Tag>
      )
    case 'splitFrom':
      return (
        <Tag tone="info">
          <a className="fw-pt-link" href={`#about-Shipment-${chip.id}`}>
            {t('ships.chip.splitFrom', { number: chip.number })}
          </a>
        </Tag>
      )
    case 'mergedInto':
      return <Tag tone="neutral">{t('ships.chip.mergedInto', { number: chip.number })}</Tag>
    case 'ddt':
      return <Tag tone="neutral">{s('ready.ddt.ok', { number: chip.number })}</Tag>
    case 'elsewhere':
      return <Tag tone="neutral">{say(chip.words)}</Tag>
    case 'noDdt':
      return <Tag tone="info">{t('ships.chip.noDdt')}</Tag>
  }
}

function CarriesCell({ view, href, onBySize }: { view: RowModel; href: string; onBySize: () => void }) {
  const t = useT('order-shipments')
  const carries = view.carries
  if (!carries)
    return (
      <Link className="fw-pt-link" href={href}>
        {t('ships.carries.notRead')}
      </Link>
    )
  return (
    <>
      <span>
        <b>{t('ships.carries.pieces', { count: carries.pieces })}</b> · {t('ships.carries.styles', { count: carries.styles })}
      </span>
      {carries.lines.map((line) => (
        <span key={line.lineId} className="fw-os-cl">
          {line.style} {line.colour} {line.mtm ? t('where.units', { count: line.pieces }) : line.pieces}
        </span>
      ))}
      {/* os-fx7 (W-12): "+ 18 pcs of SEED-SO-0003 (SEED-JKT-02 Black 18)" once Warehouse's read says what; else the count and numbers. */}
      {carries.others
        ? carries.others.map((other) => (
            <span key={other.number} className="fw-os-mu">
              {t('ships.carries.otherWhat', { count: other.pieces, order: other.number, what: other.what })}
            </span>
          ))
        : carries.other ? <span className="fw-os-mu">{t('ships.carries.other', { count: carries.other.pieces, orders: carries.other.orders.join(', ') })}</span> : null}
      {carries.grids.length > 0 ? (
        <button type="button" className="fw-pt-link" onClick={onBySize} aria-label={t('ships.carries.bySizeOf', { number: view.number })}>
          {t('ships.carries.bySize')}
        </button>
      ) : null}
    </>
  )
}

/**
 * "What SEED-SH-0012 carries": a read-only centred window (never a drawer) — os-fx7 (W-09): its subtitle "SEED-SO-0002 · 12 pcs ·
 * Draft"; each style NAMED above its DS size grid, and its facts beside the grid (the style's pieces, one line per colour).
 */
function CarriesWindow({ view, order, onClose }: { view: RowModel; order: Order; onClose: () => void }) {
  const t = useT('order-shipments')
  const o = useT('orders')
  const sales = useT('sales')
  const locale = useLocale()
  const carries = view.carries
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={noBreak(t('ships.carries.title', { number: view.number }))}
      subtitle={noBreak(t('ships.carries.subtitle', { order: order.number, pieces: t('ships.carries.pieces', { count: carries?.pieces ?? 0 }), status: o(`shipStatus.${view.state.status}`) }))}
      footer={
        <Button size="sm" onClick={onClose}>
          {t('ships.carries.close')}
        </Button>
      }
    >
      <div className="fw-os-grids">
        {(carries?.grids ?? []).map((grid) => {
          const name = `${grid.code}${grid.name ? ` · ${grid.name}` : ''}`
          return (
            <section key={grid.styleId} className="fw-os-cg" aria-label={name}>
              <h3 className="fw-os-cg-h">{name}</h3>
              <div className="fw-os-cg-b">
                <SizeGridView colours={grid.colours} sizes={grid.sizes} value={grid.value} caption={name} locale={INTL_LOCALE[locale]} copy={sizeGridWords(sales)} />
                <ul className="fw-os-cg-f">
                  <li>
                    <b>{t('ships.carries.pieces', { count: grid.pieces })}</b>
                  </li>
                  {grid.colours.map((colour) => (
                    <li key={colour.key}>
                      {colour.label} · {grid.byColour[colour.key] ?? 0}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )
        })}
      </div>
    </Modal>
  )
}

function StateCellView({ view, order, model }: { view: RowModel; order: Order; model: OrderRecordModel }) {
  const t = useT('order-shipments')
  const o = useT('orders')
  const depth = useT('warehouse-shipments-depth')
  const dv = useT('shipping-delivery')
  const locale = useLocale()
  const state = view.state
  const reasons = state.holds.map((hold) => depth(`holdReason.${hold.reason}`)).join(', ')
  const out: ReactNode[] = [
    <Pill key="pill" tone={state.tone}>
      {o(`shipStatus.${state.status}`)}
    </Pill>,
  ]
  for (const [index, hold] of state.holds.entries()) {
    out.push(
      <Tag key={`hold-${index}`} tone="warning">
        {depth('holds.banner', { reasons: depth(`holdReason.${hold.reason}`) })}
      </Tag>,
      <span key={`hold-why-${index}`} className="fw-os-hw">
        {[hold.bySystem ? t('ships.state.bySystem') : t('ships.state.byPerson'), ...(hold.words ? [hold.words] : []), t('ships.state.since', { day: formatDate(hold.placedAt, { locale }) }), ...(hold.finance ? [t('ships.state.finance')] : [])].join(' · ')}
      </span>,
    )
  }
  if (state.problems > 0)
    out.push(
      <Tag key="problems" tone="danger">
        {/* os-fx7 (W-06): the chip names what — Warehouse's own kind words ("1 tracking problem: Delayed"); not read: the count alone. */}
        {state.problemKinds
          ? t('ships.state.problemsWhat', { count: state.problems, what: state.problemKinds.kinds.map((kind) => depth(`problemKind.${kind}`, { days: state.problemKinds?.noScanDays ?? 0 })).join(', ') })
          : t('ships.state.problems', { count: state.problems })}
      </Tag>,
    )
  if (state.cameBack) {
    out.push(
      <Tag key="back" tone="warning">
        {state.cameBack.received === true ? t('ships.state.received') : state.cameBack.received === false ? t('ships.state.notReceived') : dv('dv.arrival.returned')}
      </Tag>,
    )
    if (state.cameBack.received !== true && model.can.createShipment)
      out.push(
        <span key="receive" className="fw-os-hw">
          <Link className="fw-pt-link" href={shipmentTabHref(model.prefix, order.companyId, view, 'carrier')}>
            {t('where.door.receive')}
          </Link>
        </span>,
      )
  }
  if (state.cancelled?.reason)
    out.push(
      <span key="cancelled" className="fw-os-hw">
        {t('ships.state.cancelled', { reason: state.cancelled.reason })}
      </span>,
    )
  // Next › — a link into the Warehouse step (the step stays there): only for the warehouse's own people (shipping.manage, D2).
  if (state.next && model.can.createShipment) {
    const next = state.next
    out.push(
      next.kind === 'held' ? (
        <span key="next" className="fw-os-hw">
          {depth('holds.stepHeld', { reasons })}
        </span>
      ) : (
        <span key="next">
          <Link className="fw-pt-link" href={shipmentTabHref(model.prefix, order.companyId, view, next.tab)}>
            {t(`ships.next.${next.step}`)}
          </Link>
        </span>
      ),
    )
    // W3 → os-fx7 (W-07, plan D6): ONLY where the DDT cannot be issued — worded from the DDT's refusal (the company's missing details).
    if (state.ddtBlocked)
      out.push(
        <span key="ddt-choice" className="fw-os-hw">
          {t('ships.next.ddtBlocked', { missing: state.ddtBlocked.map((field) => t(`ships.next.ddtMissing.${field}`)).join(', ') })}
        </span>,
      )
  }
  return <>{out}</>
}

function TravelsCellView({ view, row, fold, onFold, onTracking }: { view: RowModel; row: ShipmentRow; fold: boolean; onFold: () => void; onTracking: () => void }) {
  const t = useT('order-shipments')
  const o = useT('orders')
  const say = useShipSay()
  const locale = useLocale() // F-OS-305
  const travels = view.travels
  return (
    <>
      {travels.carrier ? (
        <span className="fw-os-tn">
          <Truck size={14} aria-hidden />
          <span>{say(travels.carrier)}</span>
        </span>
      ) : travels.withheld ? (
        <span className="fw-os-mu">{t('ships.travels.withheld')}</span>
      ) : null}
      {travels.hints.map((hint) => (
        <span key={hint.key} className="fw-os-mu">
          {say(hint)}
        </span>
      ))}
      {travels.typed ? (
        <span className="fw-os-tn">
          <code className="fw-os-code">{travels.typed.number}</code>
          <CopyNumber text={travels.typed.number} />
          {/* F-OP-135: the carrier's page typed beside the number (https only), in a new tab. */}
          {travels.typed.url ? (
            <a className="fw-pt-link" href={travels.typed.url} target="_blank" rel="noopener noreferrer" aria-label={o('ship.trackLink', { number: view.number })}>
              {o('ship.track')}
            </a>
          ) : null}
          <Pill tone="neutral">{o('ship.noLive')}</Pill>
        </span>
      ) : null}
      {travels.labels ? (
        <span className="fw-os-tn">
          <code className="fw-os-code">{travels.labels.first}</code>
          {travels.labels.more > 0 ? <span className="fw-os-mu">{t('ships.travels.more', { count: travels.labels.more })}</span> : null}
          <CopyNumber text={travels.labels.first} />
          {travels.labels.url ? (
            <a className="fw-pt-link" href={travels.labels.url} target="_blank" rel="noopener noreferrer" aria-label={o('ship.trackLink', { number: view.number })}>
              {o('ship.track')}
            </a>
          ) : null}
        </span>
      ) : null}
      {travels.parcels || travels.toldAt ? (
        <span className="fw-os-mu">
          {[
            // os-fx7 (W-11): "1 parcel" alone where nothing tracks a parcel (our van) — never "· 0 tracked".
            ...(travels.parcels ? [travels.parcels.tracked === null ? t('ships.travels.parcelCount', { count: travels.parcels.count }) : t('ships.travels.parcels', { parcels: t('ships.travels.parcelCount', { count: travels.parcels.count }), tracked: t('ships.travels.tracked', { count: travels.parcels.tracked }) })] : []),
            // F-OS-305 (os-fx3): "customer told 12 Nov" — when the shipping notice last went; never told: nothing said.
            ...(travels.toldAt ? [t('ships.travels.told', { day: formatDate(travels.toldAt, { locale }) })] : []),
          ].join(' · ')}
        </span>
      ) : null}
      {travels.trackingDoor || view.fold !== null ? (
        <span className="fw-os-acts">
          {/* F-OP-119: drawn only where the number may be typed here (never held for a right, never on a final row: P0-B3, D2).
              F-OS-301: "Tracking numbers…" — the consignment number and one per parcel, in Warehouse's own window. */}
          {travels.trackingDoor && row.status !== 'CANCELLED' ? (
            <Button size="sm" onClick={onTracking}>
              {t('ships.act.tracking')}
            </Button>
          ) : null}
          {view.fold !== null ? (
            <button type="button" className="fw-os-fold" aria-expanded={fold} onClick={onFold}>
              {fold ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
              {t('ships.travels.fold', { count: view.fold })}
            </button>
          ) : null}
        </span>
      ) : null}
    </>
  )
}

function DateLineView({ line, view, actions }: { line: DateLine; view: RowModel; actions?: OrderRecordActions }) {
  const t = useT('order-shipments')
  const o = useT('orders')
  const depth = useT('warehouse-shipments-depth')
  const locale = useLocale()
  const frame = useRecordFrame()
  const day = (at: string) => formatDate(at, { locale })
  switch (line.kind) {
    case 'notPacked':
      return <span className="fw-os-mu">{t('ships.dates.notPacked')}</span>
    case 'packed':
      return (
        <span className="fw-os-dl">
          <b>{t('ships.dates.packed')}</b> {day(line.at)}
        </span>
      )
    case 'left':
      return (
        <span className="fw-os-dl">
          <b>{o('ship.col.shipped')}</b> {day(line.at)}
        </span>
      )
    case 'expected':
      return (
        <span className="fw-os-dl">
          <b>{t('ships.dates.expected')}</b> {day(line.at)}
          {line.how === 'hand' ? <Tag tone="info">{t('ships.dates.setByHand')}</Tag> : line.how === 'carrier' ? <span className="fw-os-mu">{t('ships.dates.fromCarrier')}</span> : null}
        </span>
      )
    case 'delivered':
      return (
        <>
          <span className="fw-os-dl">
            <b>{depth('pod.deliveredAt')}</b> {day(line.at)}
            {line.how === 'HAND' ? <Tag tone="info">{t('ships.dates.setByHand')}</Tag> : line.how === 'COLLECTED' ? <Tag tone="neutral">{t('ships.dates.collected')}</Tag> : line.how ? <Tag tone="neutral">{depth(`pod.via.${line.how}`)}</Tag> : null}
          </span>
          {line.reason ? <span className="fw-os-mu">«{line.reason}»</span> : null}
        </>
      )
    case 'carrierLater':
      return <span className="fw-os-mu">{t('ships.dates.carrierLater', { status: o(`shipStatus.${line.status}`) })}</span>
    case 'proof': {
      // B-SA-0xxb / F-SA-266b: the proof opens in the thread's ONE viewer when the reader has its file; else its image (shipping.view).
      const openFiles = frame?.openFiles
      const proof = line.file
      const door =
        proof && openFiles ? (
          <button type="button" className="fw-pt-link" aria-label={t('ships.dates.proofOf', { number: view.number })} onClick={() => openFiles({ files: [proof], fileId: proof.id, returnTo: document.activeElement as HTMLElement | null })}>
            {t('ships.dates.proof')}
          </button>
        ) : line.download && actions?.shipmentsTab?.onDownloadProof ? (
          <button type="button" className="fw-pt-link" aria-label={t('ships.dates.proofOf', { number: view.number })} onClick={() => actions?.shipmentsTab?.onDownloadProof?.(view.id)}>
            {t('ships.dates.proof')}
          </button>
        ) : null
      if (!door && !line.signedBy) return null
      return (
        <span className="fw-os-dl">
          {door}
          {line.signedBy ? <span className="fw-os-mu">{t('ships.dates.signedBy', { name: line.signedBy })}</span> : null}
        </span>
      )
    }
    case 'cameBack':
      return (
        <span className="fw-os-dl">
          <b>{t('ships.dates.cameBack')}</b> {line.at ? day(line.at) : null}
        </span>
      )
    case 'noStatus':
      return <span className="fw-os-mu">{t('ships.dates.noStatus')}</span>
  }
}

/** Copy a number; "Copied" for a moment (said to a screen reader too). F-OP-119's, moved with the row (P0-B12: label numbers too). */
function CopyNumber({ text }: { text: string }) {
  const o = useT('orders')
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
      {copied ? o('ship.copied') : o('ship.copy')}
    </Button>
  )
}

// ── F-OS-202 (10-design §5 "Row ⋯"): the acts in their groups (a rule between groups), each held item with its words; the read doors last ──
const GROUPS: readonly RowActGroup[] = ['garments', 'travel', 'hold', 'arrive', /* F-OS-303 */ 'after', 'danger']

function rowMenuOf(acts: readonly RowAct[], say: Say, run: (act: RowAct) => void, doors: readonly MenuItemDef[]): MenuItemDef[] {
  const items: MenuItemDef[] = []
  for (const group of GROUPS) {
    const own = acts.filter((entry) => entry.group === group)
    if (own.length === 0) continue
    if (items.length > 0) items.push({ id: `rule-${group}`, separator: true })
    for (const entry of own) {
      items.push({
        id: entry.holdId ? `${entry.id}-${entry.holdId}` : entry.id,
        label: say(entry.label),
        ...(entry.group === 'danger' ? { tone: 'danger' as const } : {}),
        disabled: !!entry.held,
        description: entry.held ? say(entry.held) : undefined,
        onSelect: entry.held ? undefined : () => run(entry),
      })
    }
  }
  if (items.length > 0) items.push({ id: 'rule-doors', separator: true })
  return [...items, ...doors]
}
// ── end F-OS-202 ──
