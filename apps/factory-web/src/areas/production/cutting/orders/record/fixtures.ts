import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { inShell, PREFIX, type Role } from '../../demo/fixtures'
import {
  CANDIDATES,
  ordersCanAs,
  PRINTERS,
  RECONCILIATION,
  RECONCILIATION_CUTTING,
  RECONCILIATION_DONE,
  RECONCILIATION_LEATHER,
  RECONCILIATION_UNCONFIRMED,
  RECORD,
  RECORD_CANCELLED,
  RECORD_CUT,
  RECORD_LEATHER,
  RECORD_PLANNED,
  RECORD_READ_ONLY,
  RECORD_RECONCILED,
  RECORD_RELEASED,
  RECORD_SHADES,
} from '../demo/fixtures'
import { NO_RECONCILE } from '../model'
import { CutOrderRecordView, type CutOrderRecordModel } from './view/CutOrderRecordView'

/**
 * SCR-238-order — a cut order (design production.cutting "Record: Cut", W2b: a cut order of several work orders), with made-up
 * data only: Lay or hides (the marker, the Lays grid — lay · marker · sizes in the marker · plies · length · rolls —, Allocate
 * rolls where a roll of another shade or shrinkage group cannot be ticked with why; leather: each work order's hides), Pieces
 * (ordered, cut and recut per size and line), Yield (fabric issued vs used vs returned, per lay), Tickets (print, show the
 * label, void), Reconcile cut (a reason per line that differs, held with why), Release, Back to planning, Cancel, and the
 * states (loading, a part that failed, not found, no permission). Roles: production manager (plans, releases, reconciles),
 * floor supervisor (reads; every write held with the missing permission).
 */

interface OrderCase {
  role: Role
  model: CutOrderRecordModel
}

const ready = <T,>(value: T) => ({ value, problem: null })

const record = (role: Role, over: Partial<CutOrderRecordModel> = {}): OrderCase => ({
  role,
  model: {
    prefix: PREFIX,
    can: ordersCanAs(role),
    tab: 'lay',
    timeZone: 'Europe/Rome',
    record: { status: 'ready', value: RECORD, problem: null },
    recon: ready(RECONCILIATION_CUTTING),
    live: 'live',
    dialog: null,
    candidates: ready(CANDIDATES),
    printers: ready(PRINTERS),
    reconcile: NO_RECONCILE,
    shown: null,
    busy: false,
    problem: null,
    notice: null,
    ...over,
  },
})

const cut = (over: Partial<CutOrderRecordModel> = {}) => record('manager', { record: { status: 'ready', value: RECORD_CUT, problem: null }, recon: ready(RECONCILIATION), ...over })
const LAY_2 = RECORD.lays[1]!

function OrderDesign({ model }: { model: OrderCase }) {
  return inShell('/production/cutting', createElement(CutOrderRecordView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<OrderCase>({
  screen: 'SCR-238-order',
  title: 'Cutting: a cut order — lays, pieces, yield, tickets, Reconcile cut (Production)',
  view: OrderDesign,
  cases: [
    { id: 'lays', label: 'Lay or hides: the marker, two lays (one cut, one with a roll), the work orders and sizes', model: record('manager'), note: 'Every size of the marker is cut on every ply; each lay from one shade and one shrinkage group.' },
    { id: 'rolls', label: 'Allocate rolls to lay 2: another shade, another shrinkage group, too narrow, a held lot — each with why', model: record('manager', { dialog: { kind: 'rolls', layId: LAY_2.id } }), note: 'Mixing shade groups in one lay is refused with the reason (design ct-lays).' },
    { id: 'rolls-picked', label: 'Allocate rolls: the proposal picked (9 plies from DEMO-RL-0004)', model: record('manager', { dialog: { kind: 'rolls', layId: LAY_2.id }, rollsPicked: [CANDIDATES.rolls[0]!.id] }) },
    { id: 'rolls-refused', label: 'Allocate rolls: refused by the API (mixed shade), in words', model: record('manager', { dialog: { kind: 'rolls', layId: LAY_2.id }, rollsPicked: [CANDIDATES.rolls[0]!.id], problem: { key: 'refusal.MIXED_SHADE' } }) },
    { id: 'rolls-loading', label: 'Allocate rolls: the rolls being read', model: record('manager', { dialog: { kind: 'rolls', layId: LAY_2.id }, candidates: { value: null, problem: null } }) },
    { id: 'shades', label: 'Released with two shade groups across the lays: the warning', model: record('manager', { record: { status: 'ready', value: RECORD_SHADES, problem: null } }) },
    { id: 'planned', label: 'Planned: Release is the primary; no ticket yet', model: record('manager', { record: { status: 'ready', value: RECORD_PLANNED, problem: null }, recon: ready({ ...RECONCILIATION_CUTTING, lines: RECONCILIATION_CUTTING.lines.map((line) => ({ ...line, cut: 0, difference: -line.ordered })), garments: { ordered: 120, cut: 0 } }) }) },
    { id: 'released', label: 'Released: tickets made, Back to planning offered', model: record('manager', { record: { status: 'ready', value: RECORD_RELEASED, problem: null } }) },
    { id: 'back', label: 'Back to planning: the reason', model: record('manager', { record: { status: 'ready', value: RECORD_RELEASED, problem: null }, dialog: { kind: 'back' } }) },
    { id: 'cancel', label: 'Cancel the cut order: the reason', model: record('manager', { record: { status: 'ready', value: RECORD_RELEASED, problem: null }, dialog: { kind: 'cancel' } }) },
    { id: 'pieces', label: 'Pieces: ordered and cut per size and line (one lay cut)', model: record('manager', { tab: 'pieces' }) },
    { id: 'yield', label: 'Yield: fabric issued vs used vs returned, per lay (lay 1 cut)', model: record('manager', { tab: 'yield' }) },
    { id: 'tickets', label: 'Tickets: one done, one open; Print, Lay sheet, Void per row', model: record('manager', { tab: 'tickets' }) },
    { id: 'tickets-selected', label: 'Tickets: both selected — Print 2 held (one is done)', model: record('manager', { tab: 'tickets', ticketsSelected: RECORD.tickets.map((ticket) => ticket.id) }) },
    { id: 'print', label: 'Print a ticket: the printer (default, a printer, show only) and the language', model: record('manager', { tab: 'tickets', dialog: { kind: 'print', ticketIds: [LAY_2.ticket!.id] } }) },
    {
      id: 'shown',
      label: 'The label shown (not printed), as the printer would print it',
      model: record('manager', {
        tab: 'tickets',
        shown: {
          ticket: LAY_2.ticket!,
          label: { heading: 'Demo Factory · Buono di taglio', title: 'Materasso 2/2 · 15 strati · DEMO-JKT-01', fields: [{ label: 'Ordine di taglio', value: RECORD.cutOrder.number }, { label: 'Materiale', value: 'DEMO-LIN-200 GRI Fodera grigia demo' }, { label: 'Piazzamento', value: 'DEMO-MK-3S · 2.4 m' }, { label: 'Taglie', value: '48:1 · 50:2 · 52:1' }, { label: 'Ordini di lavoro', value: 'WO-26-0040, WO-26-0041' }, { label: 'Consegna', value: '2026-11-20' }] },
          job: null,
          problem: null,
        },
      }),
    },
    { id: 'void', label: 'Void a ticket: the reason, a new one for the same lay', model: record('manager', { tab: 'tickets', dialog: { kind: 'void', ticketId: LAY_2.ticket!.id } }) },
    { id: 'cut', label: 'Cut: Reconcile cut is the record’s primary', model: cut(), note: 'Lay 2 counted 13 of 15 plies: 112 of 120 garments cut.' },
    { id: 'cut-yield', label: 'Cut: Yield — 68.9 m used against 67.2 m estimated, 3.6 m of ends back on their rolls', model: cut({ tab: 'yield' }) },
    { id: 'reconcile', label: 'Reconcile cut: planned vs cut per size, fabric issued vs used vs returned, a reason per line (held until given)', model: cut({ dialog: { kind: 'reconcile' } }) },
    {
      id: 'reconcile-ready',
      label: 'Reconcile cut: reasons given (Other with words) — Reconcile goes',
      model: cut({ dialog: { kind: 'reconcile' }, reconcile: { reason: Object.fromEntries(RECONCILIATION.lines.map((line, index) => [line.id, index === 1 ? 'OTHER' : 'PLIES_SHORT'])), note: { [RECONCILIATION.lines[1]!.id]: 'Lay 2 spread short: roll end flawed' } } }),
    },
    { id: 'reconcile-unconfirmed', label: 'Reconcile cut: a lay’s fabric not confirmed at the table — held with why', model: cut({ dialog: { kind: 'reconcile' }, recon: ready(RECONCILIATION_UNCONFIRMED) }) },
    { id: 'reconcile-refused', label: 'Reconcile cut: refused (changed meanwhile), in words', model: cut({ dialog: { kind: 'reconcile' }, problem: { key: 'problem.changed' } }) },
    { id: 'reconciled', label: 'Reconciled: Pieces with the reasons kept', model: record('manager', { tab: 'pieces', record: { status: 'ready', value: RECORD_RECONCILED, problem: null }, recon: ready(RECONCILIATION_DONE), notice: { tone: 'success', words: { key: 'notice.reconciled', params: { number: RECORD_CUT.cutOrder.number, ordered: 120, cut: 112 } } } }) },
    { id: 'cancelled', label: 'Cancelled: the reason in the band', model: record('manager', { record: { status: 'ready', value: RECORD_CANCELLED, problem: null } }) },
    { id: 'leather', label: 'Leather cut order: the work orders’ hides (each work order’s cut)', model: record('manager', { record: { status: 'ready', value: RECORD_LEATHER, problem: null }, recon: ready(RECONCILIATION_LEATHER) }) },
    { id: 'leather-yield', label: 'Leather cut order: Yield is each work order’s, per hide', model: record('manager', { tab: 'yield', record: { status: 'ready', value: RECORD_LEATHER, problem: null }, recon: ready(RECONCILIATION_LEATHER) }) },
    { id: 'supervisor', label: 'Floor supervisor: reads; Reconcile, rolls and tickets held with the missing permission', model: record('supervisor', { record: { status: 'ready', value: RECORD_READ_ONLY, problem: null }, tab: 'tickets' }) },
    { id: 'supervisor-rolls', label: 'Floor supervisor: Allocate rolls held', model: record('supervisor', { record: { status: 'ready', value: RECORD_READ_ONLY, problem: null }, dialog: { kind: 'rolls', layId: LAY_2.id } }) },
    { id: 'part-failed', label: 'A part failed: the reconciliation could not be read (Pieces)', model: record('manager', { tab: 'pieces', recon: { value: null, problem: 'problem.offline' } }) },
    { id: 'offline', label: 'Offline: the last figures', model: record('manager', { live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: record('manager', { record: { status: 'loading', value: null, problem: null } }) },
    { id: 'missing', label: 'Not found', model: record('manager', { record: { status: 'missing', value: null, problem: null } }) },
    { id: 'error', label: 'The read failed', model: record('manager', { record: { status: 'error', value: null, problem: 'problem.offline' } }) },
    { id: 'no-permission', label: 'Sales: no production.cutting.view', model: record('sales') },
  ],
})
