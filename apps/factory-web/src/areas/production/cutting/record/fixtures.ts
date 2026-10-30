import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { cutOf } from '../model'
import { ALLOCATED, AVAILABILITY, BUNDLES, canAs, CUT_LOG, EMPTY_LOG, EMPTY_YIELD, HELD_WORK_ORDER, inShell, PREFIX, PRINTERS, RECUTS, WORK_ORDER, WORK_ORDER_YIELD, type Role } from '../demo/fixtures'
import { CutRecordView, type CutRecordModel } from './view/CutRecordView'

/**
 * SCR-238-record — a cut (design production.cutting "Record: Cut"), with made-up data only: Lay or hides (each hide's
 * area with its AreaBalanceBar, the hides allocated), Pieces (part × size with short and recut; the recuts and Mark
 * cut), Yield (bars per hide against the plan; per lot and supplier) and Tickets (print states, reprints, a void);
 * Allocate hides, a work order on hold (said in the band and in Allocate hides), and the states (loading, a part that
 * failed, not found, no permission). Roles: production manager, floor supervisor (reads; no reprint, no recut), buyer.
 */

interface RecordCase {
  role: Role
  model: CutRecordModel
}

const ready = <T,>(value: T) => ({ value, problem: null })

const record = (role: Role, over: Partial<CutRecordModel> = {}): RecordCase => {
  const workOrder = over.workOrder?.value ?? WORK_ORDER
  const log = over.log?.value ?? CUT_LOG
  const figures = over.figures?.value ?? WORK_ORDER_YIELD
  return {
    role,
    model: {
      prefix: PREFIX,
      can: canAs(role),
      tab: 'lay',
      timeZone: 'Europe/Rome',
      workOrder: { status: 'ready', value: WORK_ORDER, problem: null },
      cut: cutOf(workOrder, log, figures, ALLOCATED.length),
      log: ready(CUT_LOG),
      figures: ready(WORK_ORDER_YIELD),
      recuts: ready(RECUTS),
      allocated: ready(ALLOCATED),
      bundles: ready(BUNDLES),
      printers: ready(PRINTERS),
      live: 'live',
      dialog: null,
      alloc: null,
      busy: false,
      problem: null,
      notice: null,
      ...over,
    },
  }
}

function RecordDesign({ model }: { model: RecordCase }) {
  return inShell('/production/cutting', createElement(CutRecordView, { model: model.model }), model.role)
}

const cut = cutOf(WORK_ORDER, CUT_LOG, WORK_ORDER_YIELD, ALLOCATED.length)
const heldCut = cutOf(HELD_WORK_ORDER, CUT_LOG, WORK_ORDER_YIELD, 0)

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-238-record',
  title: 'Cutting: a cut — lay or hides, pieces, yield, tickets (Production)',
  view: RecordDesign,
  cases: [
    { id: 'lay', label: 'Lay or hides: the hides, their area bars, allocated hides', model: record('manager'), note: 'Fabric lays are W2b: said in their card.' },
    { id: 'pieces', label: 'Pieces: part × size with short and recut; the recuts', model: record('manager', { tab: 'pieces' }) },
    { id: 'recut', label: 'Mark a recut cut: the entry that cut it', model: record('manager', { tab: 'pieces', dialog: { kind: 'recut', id: RECUTS[0]!.id } }) },
    { id: 'yield', label: 'Yield: a bar per hide, the plan line, per lot and supplier', model: record('manager', { tab: 'yield' }), note: 'Never by cutter. Single parts are left out of the yield, said under the figures.' },
    { id: 'tickets', label: 'Tickets: printed, reprinted with the reason, a failed print, a void', model: record('manager', { tab: 'tickets' }) },
    { id: 'reprint', label: 'Print a ticket again: the printer and the reason', model: record('manager', { tab: 'tickets', dialog: { kind: 'reprint', id: BUNDLES.bundles[2]!.id } }) },
    { id: 'void', label: 'Void a bundle before its first scan', model: record('manager', { tab: 'tickets', dialog: { kind: 'void', id: BUNDLES.bundles[2]!.id } }) },
    { id: 'alloc', label: 'Allocate hides from the record', model: record('manager', { alloc: { cut, material: { itemId: cut.materials[0]!.itemId, itemColourId: cut.materials[0]!.itemColourId }, availability: { value: AVAILABILITY, problem: null }, busy: false, problem: null } }) },
    {
      id: 'held',
      label: 'On hold: the band says why; the table refuses every cut in those words',
      model: record('manager', { workOrder: { status: 'ready', value: HELD_WORK_ORDER, problem: null }, cut: heldCut }),
    },
    {
      id: 'held-alloc',
      label: 'On hold: Allocate hides says the hold first',
      model: record('manager', { workOrder: { status: 'ready', value: HELD_WORK_ORDER, problem: null }, cut: heldCut, alloc: { cut: heldCut, material: { itemId: heldCut.materials[0]!.itemId, itemColourId: heldCut.materials[0]!.itemColourId }, availability: { value: AVAILABILITY, problem: null }, busy: false, problem: null } }),
    },
    { id: 'notice', label: 'After a reprint: the notice', model: record('manager', { tab: 'tickets', notice: { tone: 'success', words: { key: 'notice.reprinted' } } }) },
    { id: 'waiting', label: 'Nothing cut yet: Allocate hides is the primary', model: record('manager', { log: ready(EMPTY_LOG), figures: ready(EMPTY_YIELD), cut: cutOf(WORK_ORDER, EMPTY_LOG, EMPTY_YIELD, 0), allocated: ready([]) }) },
    { id: 'waiting-yield', label: 'Nothing cut yet: Yield', model: record('manager', { tab: 'yield', log: ready(EMPTY_LOG), figures: ready(EMPTY_YIELD), cut: cutOf(WORK_ORDER, EMPTY_LOG, EMPTY_YIELD, 0) }) },
    { id: 'supervisor', label: 'Floor supervisor: reads; reprint and recut held with why', model: record('supervisor', { tab: 'tickets' }) },
    { id: 'supervisor-pieces', label: 'Floor supervisor: Pieces (Mark cut held)', model: record('supervisor', { tab: 'pieces' }) },
    { id: 'part-failed', label: 'A part failed: Yield could not be read (the others show)', model: record('manager', { tab: 'yield', figures: { value: null, problem: 'problem.offline' } }) },
    { id: 'part-loading', label: 'A part still loading: Tickets', model: record('manager', { tab: 'tickets', bundles: { value: null, problem: null } }) },
    { id: 'offline', label: 'Offline: the last figures', model: record('manager', { live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: record('manager', { workOrder: { status: 'loading', value: null, problem: null }, cut: null }) },
    { id: 'missing', label: 'Not found', model: record('manager', { workOrder: { status: 'missing', value: null, problem: null }, cut: null }) },
    { id: 'error', label: 'The read failed', model: record('manager', { workOrder: { status: 'error', value: null, problem: 'problem.offline' }, cut: null }) },
    { id: 'buyer', label: 'Buyer: no workorders.view — the record names it', model: record('buyer') },
  ],
})
