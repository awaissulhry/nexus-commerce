import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, CANCELLED, CARRIER, CLOSED, DRAFT, DRAFT_EMPTY, DRAFT_READY, inShell, LATE, NOW, PARTLY, PDF_MISSING, PLACES, PREFIX, RECEIVED, SHIPPED, SHIPPED_SENDER, STOCK, TODAY, type RoleCase } from '../demo/fixtures'
import { emptyShipDraft, receiveDraftOf, type RecordTab, type TransferView } from '../model'
import { stockKeyOf } from './view/PickerDialog'
import { TransferRecordView, type TransferRecordModel } from './view/TransferRecordView'
import type { RecordDialog } from './view-model'

/**
 * SCR-361 — a transfer's record (design warehouse.transfers "Record: Transfer"), made-up data only: Lines (a draft with its
 * stock and a line short of stock: Ship held with the reason; autosave per cell, saving and refused), the stock picker,
 * Ship transfer (own van, a carrier, held), In transit (the DDT issued, its PDF missing, a carrier, late), Received (all
 * arrived, a short line with its reason, settled: closed), Receive transfer (hides scanned, a short line), Settle a
 * difference, Cancel a draft, a cancelled transfer, loading, not found, a failed read, changed elsewhere, offline, the
 * sender who cannot receive, and no access.
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: TransferRecordModel
}

function page(transfer: TransferView, over: Partial<TransferRecordModel> = {}, role: RoleCase = 'owner'): DesignModel {
  return {
    role,
    model: { prefix: PREFIX, can: canFor(role), tab: 'lines', today: TODAY, loaded: { status: 'ready', transfer }, asOf: NOW, live: 'live', notice: null, lines: [], busy: false, stale: null, cells: {}, dialog: null, toPlaces: [PLACES.b1Store, PLACES.b1Cut], ...over },
  }
}
const tab = (transfer: TransferView, which: RecordTab, over: Partial<TransferRecordModel> = {}, role: RoleCase = 'owner') => page(transfer, { tab: which, ...over }, role)

const SHIP: RecordDialog = { kind: 'ship', draft: { ...emptyShipDraft(DRAFT_READY), packages: '3', grossWeightKg: '48,5', trackingRef: 'VAN-DEMO-07' }, busy: false, notice: null, lines: [] }
const RECEIVE_DRAFT = receiveDraftOf(SHIPPED)
const RECEIVE: RecordDialog = { kind: 'receive', draft: RECEIVE_DRAFT, scan: '', scanNote: null, busy: false, notice: null, lines: [] }
const RECEIVE_SHORT: RecordDialog = {
  kind: 'receive',
  draft: {
    ...RECEIVE_DRAFT,
    [SHIPPED.lines[0]!.id]: { quantity: '28', reason: 'SHORT', note: 'Two metres missing from the roll (demo).', toLocationId: null },
    [SHIPPED.lines[1]!.id]: { quantity: '52.6', reason: null, note: '', toLocationId: PLACES.b1Cut.id },
  },
  scan: '',
  scanNote: { key: 'receive.scanned', params: { tag: 'HD-DEMO-0101', seq: 20 } },
  busy: false,
  notice: null,
  lines: [],
}
const picker = (over: Partial<Extract<RecordDialog, { kind: 'pick' }>['picker']> = {}): RecordDialog => ({ kind: 'pick', picker: { q: '', locationId: null, stock: STOCK, problem: null, picked: {}, busy: false, notice: null, ...over } })

function RecordDesign({ model }: { model: DesignModel }) {
  const [state, setState] = useState(model.model)
  useEffect(() => setState(model.model), [model])
  const view = createElement(TransferRecordView, {
    model: state,
    actions: {
      onDialog: (dialog) => setState((now) => ({ ...now, dialog })),
      onShip: () => setState((now) => ({ ...now, dialog: null })),
      onReceive: () => setState((now) => ({ ...now, dialog: null })),
      onSettle: () => setState((now) => ({ ...now, dialog: null })),
      onCancel: () => setState((now) => ({ ...now, dialog: null })),
      onAddPicked: () => setState((now) => ({ ...now, dialog: null })),
      onDismissNotice: () => setState((now) => ({ ...now, notice: null })),
    },
  })
  return inShell('/warehouse/transfers', view, model.role)
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-361',
  title: 'Transfer',
  view: RecordDesign,
  holdsPage: true,
  cases: [
    { id: 'draft', label: 'A draft’s lines: lot, hide, untracked; what each place holds; Ship held (a line is short of stock)', model: page(DRAFT), note: 'Type a quantity: Enter or leaving the cell saves it on the line’s version.' },
    { id: 'draft-ready', label: 'A draft ready to ship', model: page(DRAFT_READY) },
    { id: 'draft-saving', label: 'A cell saving, one saved, one refused', model: page(DRAFT_READY, { cells: { [DRAFT.lines[0]!.id]: { state: 'saving' }, [DRAFT.lines[2]!.id]: { state: 'failed', words: { key: 'refusal.NOT_ENOUGH_STOCK' } } } }) },
    { id: 'draft-empty', label: 'A draft with no lines yet (Add from stock)', model: page(DRAFT_EMPTY) },
    { id: 'picker', label: 'Add from stock: the sending site’s stock, a blocked lot and what is taken held', model: page(DRAFT, { dialog: picker() }) },
    { id: 'picker-picked', label: 'Add from stock: two rows picked, one quantity typed', model: page(DRAFT, { dialog: picker({ picked: { [stockKeyOf(STOCK.rows[0]!)]: '10', [stockKeyOf(STOCK.rows[2]!)]: '49.8' } }) }) },
    { id: 'picker-loading', label: 'Add from stock while the stock is read', model: page(DRAFT, { dialog: picker({ stock: null }) }) },
    { id: 'ship', label: 'Ship transfer: own van, 3 packages, the gross weight; the DDT number is taken now', model: page(DRAFT_READY, { dialog: SHIP }) },
    { id: 'ship-carrier', label: 'Ship transfer by a carrier: held until it is named', model: page(DRAFT_READY, { dialog: { ...SHIP, draft: { ...(SHIP as Extract<RecordDialog, { kind: 'ship' }>).draft, transportBy: 'CARRIER' } } as RecordDialog }) },
    { id: 'ship-refused', label: 'Ship refused: the company has no DDT series (our words)', model: page(DRAFT_READY, { dialog: { ...SHIP, notice: { key: 'refusal.NO_DDT_SERIES', tone: 'danger' } } as RecordDialog }) },
    { id: 'shipped-lines', label: 'Shipped: the lines read-only, all in transit', model: page(SHIPPED) },
    { id: 'transit', label: 'In transit: the DDT issued (Print DDT), own van, the tracking, the transit place', model: tab(SHIPPED, 'transit') },
    { id: 'transit-carrier', label: 'In transit by a carrier, late, with its tracking page', model: tab({ ...LATE, ddt: CARRIER.ddt }, 'transit') },
    { id: 'transit-pdf-missing', label: 'The DDT issued but its PDF not stored: Print again', model: tab(PDF_MISSING, 'transit') },
    { id: 'transit-draft', label: 'In transit of a draft: the DDT is issued when it ships', model: tab(DRAFT, 'transit') },
    { id: 'received-waiting', label: 'Received tab while in transit (Receive…)', model: tab(SHIPPED, 'received') },
    { id: 'receive', label: 'Receive transfer: everything by default, the hide scanned one by one', model: tab(SHIPPED, 'received', { dialog: RECEIVE }) },
    { id: 'receive-short', label: 'Receive transfer: a short line with its reason, the hide scanned and put in the cutting room', model: tab(SHIPPED, 'received', { dialog: RECEIVE_SHORT }) },
    { id: 'partly', label: 'Partly received: one line arrived, two still on their way', model: tab(PARTLY, 'received') },
    { id: 'received', label: 'Received with a difference waiting (Settle…)', model: tab(RECEIVED, 'received') },
    { id: 'settle', label: 'Settle a difference: written off, claimed from the carrier, or sent back (held: part arrived)', model: tab(RECEIVED, 'received', { dialog: { kind: 'settle', draft: { lineId: RECEIVED.lines[0]!.id, resolution: 'ADJUSTMENT', note: '' }, busy: false, notice: null } }) },
    { id: 'closed', label: 'Closed: the difference settled (written off)', model: tab(CLOSED, 'received') },
    { id: 'cancel', label: 'Cancel a draft: held until the reason is said', model: page(DRAFT, { dialog: { kind: 'cancel', reason: '', busy: false, notice: null } }) },
    { id: 'cancelled', label: 'A cancelled transfer', model: page(CANCELLED) },
    { id: 'sender', label: 'The sending site’s people: Receive held (the receiving site receives)', model: tab(SHIPPED_SENDER, 'received') },
    { id: 'shipped-done', label: 'Shipped (the receipt)', model: tab(SHIPPED, 'transit', { notice: { key: 'ship.done', params: { ddt: 'DEMO-144' }, tone: 'success' } }) },
    { id: 'stale', label: 'Changed by someone else (Reload)', model: page(SHIPPED, { stale: '09:58' }) },
    { id: 'offline', label: 'Offline: every step held with the reason', model: page(DRAFT_READY, { live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: page(DRAFT, { loaded: { status: 'loading' }, asOf: null }) },
    { id: 'not-found', label: 'Not found (or of another company)', model: page(DRAFT, { loaded: { status: 'notFound' } }) },
    { id: 'error', label: 'A failed read (Try again)', model: page(DRAFT, { loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'buyer', label: 'Buyer: reads it; every step held (no right)', model: page({ ...SHIPPED, actions: { ...SHIPPED.actions, receive: { allowed: false, refusal: 'NO_RIGHT_TO' }, track: { allowed: false, refusal: 'NO_RIGHT_FROM' } } }, {}, 'buyer') },
    { id: 'no-permission', label: 'Sales: no access (the missing permission in words)', model: page(DRAFT, { loaded: { status: 'forbidden' } }, 'sales') },
  ],
})
