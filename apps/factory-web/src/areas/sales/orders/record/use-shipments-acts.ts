'use client'

import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Order } from '../api'
// F-OS-101 (18-lead-settles L5): the deliveries READ stays (each Shipments row draws its delivery); its card "Delivered (from carrier)" went.
import { podDownload, readDeliveries, type Deliveries } from './shipments/delivered/api'
import { readCartons, type Bench } from '../../../warehouse/shipments/cartons/api' // F-OS-103: the Parcels (n) fold, read on open
import { storeUrl } from '../../../../record-panels/store'
import { useLiveBus } from '../../../../shell/live/use-live'
import { readProblem } from '../model'
import type { Part } from './record-model'
// F-OP-119: the tracking number of one shipment typed in place (the Warehouse's own hook and dialog).
import { depthAbilitiesOf } from '../../../warehouse/shipments/queue/shared/depth'
// F-OP-121: the order page loads its own catalogues only; New shipment brings the Warehouse's (shipments, its depth words).
import { DEPTH_NAMESPACES } from '../../../warehouse/shipments/queue/shared/depth'
import { WithMessages } from '../../../../record-panels/i18n'
import { ShipmentTransportDoor, type TransportDoorOpen } from './shipments/ShipmentTransportDoor'
// ---- F-OS-201 … F-OS-204 (order SHIPMENTS tab; 13-backend §7): Warehouse's OWN windows of one shipment, mounted in place (never copied)
import { Split } from '../../../warehouse/shipments/queue/split/Split'
import { Move } from '../../../warehouse/shipments/queue/move/Move'
import { ShipmentDoor, type ShipmentDoorDone, type ShipmentDoorKind } from '../../../warehouse/shipments/record/ShipmentDoor'
import { HoldsDoor } from '../../../warehouse/shipments/holds/HoldsDoor'
import { DeliveryDoor } from '../../../warehouse/shipments/pod/DeliveryDoor'
import { DOOR_NAMESPACES } from '../../../warehouse/shipments/queue/shared/door-words'
import type { RowActId } from './shipments/doors'
import type { NoticeWords } from './record-model'
import type { Words } from '../../../warehouse/shipments/queue/shared/depth' // F-OS-301: what the tracking write said
import { parcelWordsOf } from './shipments/rows' // F-OS-301: each parcel's contents of this order, in the Tracking numbers window
// ---- F-OS-303: the after-sales doors — the Returns and Quality pages' OWN windows, and the claim link, mounted in place ----
import type { AfterSalesKind } from './shipments/doors'
import { NewReturnDoor } from '../../returns/NewReturnDoor'
import { LogComplaintDoor } from '../../../quality/complaints/LogComplaintDoor'
import { ClaimLink } from '../../returns/claim-link/ClaimLink'
import { complaintHref, returnHref } from './links/model'
// ---- end F-OS-303
// ---- end F-OS-201
// F-OP-121 (order page plan N6): Create shipment… in place — the Warehouse's ONE New shipment hook and its dialog.
import type { ApiClient } from '../../../../lib/api/client'
import type { Shipment } from '../../../warehouse/shipments/api'
import { abilitiesOf } from '../../../warehouse/shipments/model'
import { useNewShipment } from '../../../warehouse/shipments/new/use-new-shipment'
import { NewShipmentDialog } from '../../../warehouse/shipments/list/view/NewShipmentDialog'
import type { OrderRecordModel } from './record-model'
// F-OP-122: the customer's DRAFT shipments this order may join (the walled joinable read), each held with why.
import { joinableShipments } from '../../../warehouse/shipments/api'
import type { NewShipmentDone } from '../../../warehouse/shipments/new/use-new-shipment'
import { mayCreateShipment } from '../model'
import { joinableRows, type JoinableRow } from './shipments/model'
// F-OP-123 (order page N5): "Record a shipment made elsewhere…" (its container, mounted only while open; its door held with words).
import { RecordElsewhere } from './shipments/elsewhere/RecordElsewhere'
import { elsewhereDoor } from './shipments/elsewhere/model'
import type { Phrase } from '../model'

/**
 * F-OP-134 (N-5): the Shipments tab's container side, mounted by the container (OrderRecord.tsx), which hands the view what it returns as
 * plain props; a view never imports it. The hooks a shipment's acts need (the hand-booked carrier's tracking, a new shipment) are here.
 *
 * F-OS-101 (order SHIPMENTS tab; 18-lead-settles L5): the tab's own reads — the order's deliveries (`GET /sales/orders/:id/deliveries`:
 * how each shipment arrived, its proof, its tracking problems, came back), read with the order and again on a live change of ONE OF
 * THIS ORDER'S shipments (H3-B8: never another order's) or of the order, and on reconnect; each row's Parcels (n) fold reads
 * Warehouse's cartons of that shipment when it opens; the proof's image opens in a new tab (a presigned address of 60 seconds).
 *
 * F-OP-119 (order page plan N5): "Tracking number…" on a shipment row opens the Warehouse's tracking dialog for that ONE shipment
 * (useOwnTransport mounted lazily, only while it is open: `model.shipmentTracking`); a save reads the order again.
 *
 * F-OP-121 (order page plan N6): "Create shipment…" opens Warehouse's New shipment IN PLACE (useNewShipment, `together`): this
 * order and the same customer's other open orders beside it (each held with its reason, if any; B-OP-047: N6 on).
 * Create makes a DRAFT; the order is read again and the notice says where to pack it ("Pack and ship it in Warehouse ›").
 *
 * F-OP-122 (order page plan N6): the customer's DRAFT shipments this order may join (the joinable read, every rule passed;
 * B-OP-047: several orders in one shipment are on) each offer "Add this order's garments…" — the same step 2; a DRAFT only (the
 * API keeps the last word).
 */
export function useShipmentsActs(input: {
  readonly order: Order | null
  readonly prefix: string
  /* F-OP-119 */ readonly permissions: readonly string[]
  readonly reload: () => void
  /* F-OP-121 */ readonly api: ApiClient
  /* F-OP-121 */ readonly setNotice: (notice: OrderRecordModel['notice']) => void
  /** F-OS-303: a return or a complaint opened from the tab — the order's links (Complaints & returns) are read again. */
  readonly onCaseOpened?: () => void
}): {
  model: {
    /* F-OP-119 → F-OS-201: the one shipment window open (its container), whichever the row opened */ shipmentDoor: ReactNode | null
    /* F-OP-121 */ newShipment: ReactNode | null
    /* F-OP-122 */ joinable: JoinableRow[] | null
    /* F-OP-123 */ elsewhere: { readonly held: Phrase | null; readonly dialog: ReactNode | null } | null
    /* F-OS-101 */ shipmentDeliveries: Part<Deliveries> | null
    /* F-OS-103 */ shipmentParcels: Readonly<Record<string, Part<Bench>>>
    /* F-OS-303 */ afterSalesDoor: ReactNode | null
  }
  actions: {
    onShipmentTracking: (shipmentId: string) => void
    /* F-OP-121 */ onCreateShipment: () => void
    /* F-OP-122 */ onJoinShipment: (shipmentId: string) => void
    /* F-OP-123 */ onRecordElsewhere: () => void
    /* F-OS-101 */ shipmentsTab: { readonly onRetryDeliveries: () => void; readonly onOpenParcels: (shipmentId: string) => void; readonly onDownloadProof: (shipmentId: string) => void; /* F-OS-202 */ readonly onAct: (shipmentId: string, act: RowActId, holdId?: string) => void; /* F-OS-303 */ readonly onAfterSales: (kind: AfterSalesKind, shipmentId?: string) => void }
  }
} {
  const { order, prefix, permissions, reload, api, setNotice } = input
  // ---- F-OP-119 → F-OS-201 … F-OS-204: ONE shipment window open at a time, opened from its row (Tracking number… and the row ⋯) ----
  const [open, setOpen] = useState<{ readonly shipmentId: string; readonly act: RowActId | 'tracking'; readonly holdId?: string } | null>(null)
  // The shipment's own rights as Warehouse reads them (no label check from here: `pack` off).
  const can = useMemo(() => ({ ...depthAbilitiesOf(permissions), pack: false }), [permissions])
  const close = useCallback(() => setOpen(null), [])
  const onShipmentTracking = useCallback((shipmentId: string) => setOpen({ shipmentId, act: 'tracking' }), [])
  // ---- F-OS-303: Open a return… · Log a complaint… · Send a claim link… (the row's for its shipment, the head's for the order) ----
  const [after, setAfter] = useState<{ readonly kind: AfterSalesKind; readonly shipmentId: string | null } | null>(null)
  const onAfterSales = useCallback((kind: AfterSalesKind, shipmentId?: string) => setAfter({ kind, shipmentId: shipmentId ?? null }), [])
  const onAct = useCallback(
    (shipmentId: string, act: RowActId, holdId?: string) => (act === 'return' || act === 'complaint' || act === 'claim' ? setAfter({ kind: act, shipmentId }) : setOpen({ shipmentId, act, ...(holdId ? { holdId } : {}) })),
    [],
  )
  const row = open && order ? (order.chain.shipments.find((entry) => entry.id === open.shipmentId) ?? null) : null
  // F-OS-204: after each act the order reads itself again and says it ONCE, with the door to the shipment's home and, where the customer
  // sees it, what they were told (no e-mail by default).
  const said = useCallback(
    (shipment: { readonly id: string; readonly number: string }, words: NoticeWords, told: NoticeWords | null) => {
      setOpen(null)
      reload()
      setNotice({ tone: 'success', words, door: { href: `${prefix}/warehouse/shipments/${shipment.id}`, words: { key: 'ships.carries.notRead', ns: 'order-shipments' } }, ...(told ? { told } : {}) })
    },
    [prefix, reload, setNotice],
  )
  const shipmentDoor = row && open && order ? doorOf({ row: { id: row.id, number: row.number, version: row.version ?? 1 }, order: { id: order.id, companyId: order.companyId, partyId: order.partyId /* F-OS-302 */, shipComplete: order.shipComplete === true }, open, can, prefix, close, said, parcelWords: parcelWordsOf(row, order.lines) /* F-OS-301 */ }) : null
  // ---- end F-OP-119 → F-OS-201

  const closeAfter = useCallback(() => setAfter(null), [])
  const caseOpened = useRef(input.onCaseOpened)
  caseOpened.current = input.onCaseOpened
  // Opened: the list reads itself again and the order says it once, with the door to the case's own page.
  const opened = useCallback(
    (words: NoticeWords, href: string, tone: 'success' | 'warning' = 'success') => {
      setAfter(null)
      caseOpened.current?.()
      setNotice({ tone, words, door: { href, words: os('after.done.open') } })
    },
    [setNotice],
  )
  const afterSalesDoor = after && order ? afterSalesDoorOf({ after, order, prefix, close: closeAfter, opened }) : null
  // ---- end F-OS-303

  // ---- F-OP-121: Create shipment… in place ----
  const shipping = useMemo(() => abilitiesOf(permissions), [permissions])
  const created = useCallback(
    (shipment: Shipment, done: NewShipmentDone) => {
      reload()
      // F-OP-122: garments added to a DRAFT already there say so (how many, onto which shipment).
      const words: Phrase /* op-fx1: one phrase, either key */ = done.kind === 'joined' ? { key: 'ship.joined', params: { count: done.garments, number: shipment.number } } : { key: 'ship.created', params: { number: shipment.number } }
      setNotice({ tone: 'success', words, door: { href: `${prefix}/warehouse/shipments/${shipment.id}`, words: { key: 'ship.createdDoor' } } })
    },
    [prefix, reload, setNotice],
  )
  // The site's default carrier and service come from the API (blank here); who carries it: a carrier.
  const defaults = useCallback(() => ({ transportBy: 'CARRIER' as const, carrierCode: '', serviceCode: '' }), [])
  const create = useNewShipment({ api, defaults, onCreated: created })
  const onCreateShipment = useCallback(() => {
    if (order) create.open(order.id, { together: true })
  }, [create, order])
  const newShipment = create.model ? createElement(WithMessages, { namespaces: DEPTH_NAMESPACES }, createElement(NewShipmentDialog, { model: create.model, can: shipping, actions: create.actions })) : null
  // ---- end F-OP-121

  // ---- F-OP-122: the DRAFT shipments this order may join ----
  const [joinable, setJoinable] = useState<{ orderId: string; rows: JoinableRow[] } | null>(null)
  const mayJoin = !!order && shipping.view && mayCreateShipment(order, { createShipment: shipping.manage })
  // Read again whenever the order's shipments change (made, joined, left, cancelled).
  const shipmentsKey = order ? order.chain.shipments.map((row) => `${row.id}:${row.status}`).join(',') : ''
  const orderId = order?.id ?? null
  useEffect(() => {
    if (!orderId || !mayJoin) return
    let live = true
    joinableShipments(api, orderId)
      .then((answer) => {
        // The same customer, site and delivery address, every rule passed (B-OP-047): the DRAFTs this order may join.
        if (live) setJoinable({ orderId, rows: joinableRows(answer.shipments) })
      })
      .catch(() => live && setJoinable({ orderId, rows: [] }))
    return () => {
      live = false
    }
  }, [api, orderId, mayJoin, shipmentsKey])
  const onJoinShipment = useCallback(
    (shipmentId: string) => {
      const row = joinable?.rows.find((entry) => entry.shipmentId === shipmentId)
      if (order && row && !row.held) create.openJoin(order.id, { id: row.shipmentId, number: row.number })
    },
    [create, joinable, order],
  )
  // (merge op-21: a local name of its own — `joinableRows` is the imported rule the read above calls.)
  const joinableShown = mayJoin && joinable?.orderId === orderId ? joinable.rows : null
  // ---- end F-OP-122
  // ---- F-OP-123 (order page N5): Record a shipment made elsewhere… — held with words (the order's state, the rights: D4), else
  // the dialog's container while open; recorded, the order reads itself again.
  const [elsewhereOpen, setElsewhereOpen] = useState(false)
  const closeElsewhere = useCallback(() => setElsewhereOpen(false), [])
  const elsewhereHeld = order ? elsewhereDoor(order, permissions) : null
  const elsewhere = order
    ? { held: elsewhereHeld, dialog: elsewhereOpen && !elsewhereHeld ? createElement(RecordElsewhere, { key: order.id, order, prefix, onDone: () => { setElsewhereOpen(false); reload() }, onClose: closeElsewhere }) : null }
    : null
  const onRecordElsewhere = useCallback(() => setElsewhereOpen(true), [])
  // ---- end F-OP-123

  // ---- F-OS-101 (L5): the order's deliveries, drawn in each Shipments row (no card of its own any more) ----
  const [deliveries, setDeliveries] = useState<{ readonly orderId: string; readonly part: Part<Deliveries> } | null>(null)
  const [deliveriesAttempt, setDeliveriesAttempt] = useState(0)
  useEffect(() => {
    if (!orderId) return
    const abort = new AbortController()
    readDeliveries(api, orderId, abort.signal)
      .then((read) => setDeliveries({ orderId, part: { value: read, problem: null } }))
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        // A read again that fails keeps what is on screen; a first read that fails says so (never an empty "nothing delivered").
        setDeliveries((current) => (current?.orderId === orderId && current.part.value ? current : { orderId, part: { value: null, problem: readProblem(error) } }))
      })
    return () => abort.abort()
  }, [api, orderId, shipmentsKey, deliveriesAttempt])
  // H3-B8: only a change of THIS order's shipments (or of the order) reads them again — a proof, a tracking problem, a status.
  const shipmentIds = useMemo(() => new Set(order ? order.chain.shipments.map((row) => row.id) : []), [order])
  useLiveBus({
    onChange: (change) => {
      if (!orderId) return
      if (change.type === 'sales_order.status_changed') {
        if (change.fields.orderId === orderId) setDeliveriesAttempt((count) => count + 1)
        return
      }
      if (!DELIVERIES_LIVE.has(change.type)) return
      if (Object.values(change.fields).some((value) => typeof value === 'string' && shipmentIds.has(value))) setDeliveriesAttempt((count) => count + 1)
    },
    onReconnect: () => setDeliveriesAttempt((count) => count + 1),
  })
  const onRetryDeliveries = useCallback(() => setDeliveriesAttempt((count) => count + 1), [])
  const shipmentDeliveries = deliveries && deliveries.orderId === orderId ? deliveries.part : orderId ? { value: null, problem: null } : null
  // The proof's image: the tab opens at the click (a browser opens no window after an await), then goes to the address.
  const onDownloadProof = useCallback(
    (shipmentId: string) => {
      const tab = window.open('', '_blank')
      if (tab) tab.opener = null
      podDownload(api, shipmentId)
        .then((url) => {
          if (tab) tab.location.href = storeUrl(url)
          else window.location.assign(storeUrl(url))
        })
        .catch((error: unknown) => {
          tab?.close()
          setNotice({ tone: 'danger', words: { key: readProblem(error) } })
        })
    },
    [api, setNotice],
  )
  // ---- end F-OS-101

  // ---- F-OS-103: each row's Parcels (n) fold — Warehouse's cartons of that shipment, read when it opens (again on Try again) ----
  const [parcels, setParcels] = useState<{ readonly orderId: string | null; readonly parts: Readonly<Record<string, Part<Bench>>> }>({ orderId: null, parts: {} })
  const onOpenParcels = useCallback(
    (shipmentId: string) => {
      setParcels((current) => ({ orderId, parts: { ...(current.orderId === orderId ? current.parts : {}), [shipmentId]: { value: current.orderId === orderId ? (current.parts[shipmentId]?.value ?? null) : null, problem: null } } }))
      readCartons(api, shipmentId)
        .then((bench) => setParcels((current) => (current.orderId === orderId ? { orderId, parts: { ...current.parts, [shipmentId]: { value: bench, problem: null } } } : current)))
        .catch((error: unknown) => setParcels((current) => (current.orderId === orderId ? { orderId, parts: { ...current.parts, [shipmentId]: { value: null, problem: readProblem(error) } } } : current)))
    },
    [api, orderId],
  )
  const shipmentParcels = parcels.orderId === orderId ? parcels.parts : {}
  // ---- end F-OS-103
  return {
    model: { shipmentDoor, newShipment, joinable: joinableShown, elsewhere /* F-OP-123 */, shipmentDeliveries /* F-OS-101 */, shipmentParcels /* F-OS-103 */, afterSalesDoor /* F-OS-303 */ },
    actions: { onShipmentTracking, onCreateShipment, onJoinShipment, onRecordElsewhere /* F-OP-123 */, shipmentsTab: { onRetryDeliveries, onOpenParcels, onDownloadProof, onAct /* F-OS-202 */, onAfterSales /* F-OS-303 */ } /* F-OS-101 */ },
  }
}

/** F-OS-101: the live events after which the deliveries are read again — when they name one of this order's shipments (H3-B8). */
const DELIVERIES_LIVE = new Set(['shipment.status_changed', 'shipment.pod_recorded', 'shipment.tracking_problem_raised', 'shipment.tracking_problem_resolved', 'shipment.tracking_recorded'])

// ── F-OS-201 … F-OS-204 (order SHIPMENTS tab; 13-backend §7; 18-lead-settles L6, L7) ─────────────────────────────────────────────────
/** What the customer is told after an act (where they see it), in the lane's words; null: nothing to say. */
const TOLD: Partial<Record<RowActId, string>> = {
  split: 'ships.told.draft',
  move: 'ships.told.draft',
  merge: 'ships.told.draft',
  takeOff: 'ships.told.draft',
  delivered: 'ships.told.portal',
  returned: 'ships.told.portal',
  ddtOff: 'ships.told.ddtOff',
}
const os = (key: string, params?: Record<string, string | number>): NoticeWords => ({ key, ns: 'order-shipments', ...(params ? { params } : {}) })
const toldOf = (act: RowActId): NoticeWords | null => (TOLD[act] ? os(TOLD[act]!) : null)
/** F-OS-301: after Tracking numbers…, what the customer was told — the portal at once; the notice again when ticked (sent, or held). */
const trackingTold = (done: Words | undefined): NoticeWords => os(done?.key === 'door.tracking.doneNotice' ? 'ships.told.noticeSent' : done?.key === 'door.tracking.doneNoticeHeld' ? 'ships.told.noticeHeld' : 'ships.told.tracking')

/** The SHIPMENT door kinds (Warehouse's record dialogs, ShipmentDoor.tsx) and the How it travels ones (useOwnTransport). */
const SHIPMENT_DOORS: Partial<Record<RowActId, ShipmentDoorKind['kind']>> = { unpack: 'unpack', cancel: 'cancel', ddtOff: 'ddtRequired', ddtBack: 'ddtRequired', receiveBack: 'receiveBack' }
const TRANSPORT_DOORS: Partial<Record<RowActId | 'tracking', TransportDoorOpen>> = { tracking: 'tracking', arrange: 'arrange', eta: 'eta', delivered: 'delivered', returned: 'returned' }

/** The element of the one window open: each Warehouse's own container, mounted lazily (only while open), keyed by its shipment. */
function doorOf(input: {
  readonly row: { readonly id: string; readonly number: string; readonly version: number }
  readonly order: { readonly id: string; readonly companyId: string; /* F-OS-302: the customer (Split's delivery addresses) and its ship complete */ readonly partyId: string; readonly shipComplete: boolean }
  readonly open: { readonly act: RowActId | 'tracking'; readonly holdId?: string }
  readonly can: ReturnType<typeof depthAbilitiesOf>
  readonly prefix: string
  readonly close: () => void
  readonly said: (shipment: { readonly id: string; readonly number: string }, words: NoticeWords, told: NoticeWords | null) => void
  /** F-OS-301: each parcel's contents of this order, by parcel id (the Tracking numbers window's rows). */
  readonly parcelWords: Readonly<Record<string, string>>
}): ReactNode {
  const { row, order, open, can, prefix, close, said } = input
  const key = `${row.id}:${open.act}`
  const act = open.act
  const transport = TRANSPORT_DOORS[act]
  // Warehouse's How it travels windows: the hook writes and closes; the order reads itself again and says it once. F-OS-301: Tracking
  // numbers… says what the customer was told (the portal at once; the shipping notice again only when ticked, and whether it went).
  if (transport) return createElement(ShipmentTransportDoor, { key, shipmentId: row.id, version: row.version, can, open: transport, onChanged: act === 'tracking' ? (done?: Words) => said(row, os('ships.done.tracking', { number: row.number }), trackingTold(done)) : () => said(row, os(`ships.done.${act}`, { number: row.number }), toldOf(act)), onClose: close, ...(act === 'tracking' ? { parcelWords: input.parcelWords } : {}) })
  if (act === 'tracking') return null
  const kind = SHIPMENT_DOORS[act]
  const done = (result: ShipmentDoorDone) => said(result.shipment, os(result.words.key, result.words.params), toldOf(act))
  const shipmentDoor = (door: ShipmentDoorKind) => createElement(ShipmentDoor, { key, shipmentId: row.id, door, onDone: done, onClose: close })
  if (kind === 'unpack' || kind === 'cancel' || kind === 'ddtRequired' || kind === 'receiveBack') return shipmentDoor({ kind })
  switch (act) {
    case 'takeOff':
      return shipmentDoor({ kind: 'takeOff', salesOrderId: order.id })
    case 'split':
      // F-OS-302: into several, another delivery address of this customer, the customer's "all in one delivery" said.
      return createElement(WithMessages, { key, namespaces: DOOR_NAMESPACES }, createElement(Split, { shipmentId: row.id, prefix, onClose: close, onDone: () => said(row, os('ships.done.split', { number: row.number }), toldOf('split')), partyId: order.partyId, shipComplete: order.shipComplete }))
    case 'move':
    case 'merge':
      return createElement(Move, { key, shipmentId: row.id, number: row.number, mode: act, onClose: close, onDone: (result) => said(result.target, os(result.words.key, result.words.params), toldOf(act)) })
    case 'placeHold':
    case 'releaseHold':
      return createElement(WithMessages, { key, namespaces: DOOR_NAMESPACES }, createElement(HoldsDoor, { shipmentId: row.id, version: row.version, can, open: act === 'placeHold' || !open.holdId ? { kind: 'place' } : { kind: 'release', holdId: open.holdId }, onChanged: () => said(row, os(act === 'placeHold' ? 'ships.done.placeHold' : 'ships.done.releaseHold', { number: row.number }), null), onClose: close }))
    case 'proof':
    case 'resolve':
      return createElement(WithMessages, { key, namespaces: DOOR_NAMESPACES }, createElement(DeliveryDoor, { shipment: { id: row.id, companyId: order.companyId }, version: row.version, can, open: act === 'proof' ? 'pod' : 'resolve', onChanged: () => said(row, os(`ships.done.${act}`, { number: row.number }), null), onClose: close }))
    default:
      return null
  }
}
// ── end F-OS-201 … F-OS-204 ──

// ── F-OS-303 (order SHIPMENTS tab, 10-design §5 / §6; 18-lead-settles L8) ─────────────────────────────────────────────────────────────
/** The after-sales window open: Returns' New return, Quality's Log complaint (this customer, order and shipment), or the claim link. */
function afterSalesDoorOf(input: {
  readonly after: { readonly kind: AfterSalesKind; readonly shipmentId: string | null }
  readonly order: Order
  readonly prefix: string
  readonly close: () => void
  readonly opened: (words: NoticeWords, href: string, tone?: 'success' | 'warning') => void
}): ReactNode {
  const { after, order, prefix, close, opened } = input
  const key = `${after.kind}:${after.shipmentId ?? order.id}`
  // The customer is the order's (the only choice in the window); the shipment chosen when it came from a row.
  const party = { id: order.partyId, code: order.party?.code ?? '—', legalName: order.party?.legalName ?? '—', tradeName: null }
  const seed = { party, salesOrderId: order.id, ...(after.shipmentId ? { shipmentId: after.shipmentId } : {}) }
  switch (after.kind) {
    case 'return':
      return createElement(NewReturnDoor, { key, seed, companyId: order.companyId, onClose: close, onCreated: (made) => opened(os('after.done.return', { number: made.number }), returnHref(prefix, made.id)) })
    case 'complaint':
      return createElement(LogComplaintDoor, { key, seed, companyId: order.companyId, prefix, onClose: close, onLogged: (made, failed) => opened(failed > 0 ? os('after.done.complaintPhotos', { number: made.number, count: failed }) : os('after.done.complaint', { number: made.number }), complaintHref(prefix, made.id), failed > 0 ? 'warning' : 'success') })
    case 'claim': {
      const shipment = after.shipmentId ? order.chain.shipments.find((row) => row.id === after.shipmentId) : null
      return createElement(ClaimLink, { key, partyId: order.partyId, record: shipment ? { type: 'Shipment' as const, id: shipment.id, number: shipment.number } : { type: 'SalesOrder' as const, id: order.id, number: order.number }, onClose: close })
    }
  }
}
// ── end F-OS-303 ──
