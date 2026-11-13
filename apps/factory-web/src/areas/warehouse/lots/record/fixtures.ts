import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import { at, canFor, COMPANY, inShell, ITEMS, LOCATIONS, named, NOW, PREFIX, SITE, TIME_ZONE, uid, WORK_ORDERS, type RoleCase } from '../../../_shared/stock/fixtures'
import { CHECKLIST_DONE, CHECKLIST_OPEN, CHECKLIST_RELEASED, LOT_ROWS, lotMoves, lotRecordOf } from '../demo/fixtures'
import { dailyFor, holdRow, HOLD_REASONS, writeOffDialog } from '../demo/daily/fixtures'
import { LARGE_TRACE, LOT_TRACE, OPENING_TRACE, UNUSED_TRACE } from '../demo/trace/fixtures'
import type { LotFigures, LotHolds, LotRecordModel, LotTab } from '../model'
import { part } from '../shared/model'
import { blankFind } from '../trace/model'
import type { Reservation } from '../../stock/daily/api'
import { LotRecordView } from './view/LotRecordView'
// B-W2b-320: the lot's W2b parts (made-up).
import { BEHIND_DEPTH, DEPLETED_CHILD, depthModel, FAMILY_READ, nappaDepth, NOT_KEPT_DEPTH, QUARANTINE_DEPTH, REPORT_DONE, reportDialog, REPORTS, SPLIT_DONE, SPLIT_READ, splitDraftFor } from '../depth/demo/fixtures'
import type { LotDepthModel } from '../depth/view-model'
import type { SplitDraft } from '../depth/model'

/**
 * SCR-201-record — a lot with made-up data only: the released nappa lot (its checklist, stock in two places, hides, used
 * by two work orders, one shipped to a customer), a lot in quarantine waiting for its Cr VI result (checklist open), a
 * suede lot whose Cr VI failed (blocked), an opening-stock lot (no receipt), a rejected lot (read only), the Moves tab with
 * the running balance, the Activity tab and the thread docked; the states (loading, not found, failed, no right). Roles:
 * Owner, Warehouse (sees the checklist read-only), Quality, Read-only, Sales (no inventory.stock.view). B-W2a-64: "Where
 * it is" with reserved and available at the site and who reserved it (one stale), the Quality status tab (holds of the
 * lot and of its hides; none; no right; failed), the Trace tab's tree (both ways with gaps, possible nodes, a hold, a
 * hidden customer; only affected customers; a large trace counted first; not used yet; opening stock; failed), a rejected
 * lot with stock (return to the supplier or write it off per place, its dialog) and the Trace dialog.
 */

interface LotCase {
  role: RoleCase
  record: LotRecordModel
}

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

function lotCase(role: RoleCase, row = LOT_ROWS[0]!, over: Partial<LotRecordModel> = {}, tab: LotTab = 'overview'): LotCase {
  const can = canFor(role)
  const checklist = row.qualityStatus === 'RELEASED' ? CHECKLIST_RELEASED : row.crVi.status === 'PENDING' ? CHECKLIST_OPEN : CHECKLIST_DONE
  return {
    role,
    record: {
      prefix: PREFIX,
      can,
      tab,
      record: can.stockView ? { status: 'ready', value: lotRecordOf(row) } : { status: 'forbidden' },
      checklist: can.lotsView ? part(checklist) : null,
      moves: part(lotMoves(row)),
      live: 'live',
      asOf: NOW,
      changed: null,
      dockOpen: false,
      timeZone: TIME_ZONE,
      panelsPreview: { ...conversation, record: { type: 'Lot', id: row.id, companyId: COMPANY, siteId: SITE.id }, title: row.code, party: null },
      daily: dailyFor(role),
      figures: part(FIGURES),
      trace: part(row.id === LOT_ROWS[0]!.id ? LOT_TRACE : row.opening ? OPENING_TRACE : UNUSED_TRACE),
      holds: dailyFor(role).holdsView ? part(HOLDS) : null,
      holdReasons: HOLD_REASONS,
      writeOff: null,
      find: null,
      ...over,
    },
  }
}

function LotDesign({ model }: { model: LotCase }) {
  const value = model.record.record.status === 'ready' ? model.record.record.value : null
  return inShell(`/warehouse/lots/${value?.lot.id ?? 'x'}`, createElement(LotRecordView, { model: model.record }), model.role)
}

const [released, quarantine, failed, , , opening, rejected] = LOT_ROWS

const reservation = (n: number, over: Partial<Reservation>): Reservation => ({
  id: uid('7777', n),
  siteId: SITE.id,
  siteCode: SITE.code,
  kind: 'AREA',
  status: 'ACTIVE',
  item: ITEMS.leather,
  colour: null,
  lot: { id: LOT_ROWS[0]!.id, code: LOT_ROWS[0]!.code, qualityStatus: 'RELEASED' },
  hide: null,
  quantity: '96.0000',
  issuedQuantity: '0.0000',
  open: '96.0000',
  demand: { type: 'WorkOrder', id: WORK_ORDERS.b.id, number: WORK_ORDERS.b.number, status: 'RELEASED' },
  stale: false,
  needDate: '2026-11-12',
  note: null,
  createdAt: at(28, 9),
  createdBy: { id: uid('1111', 1), name: 'Anna Esempio' },
  version: 1,
  ...over,
})
const FIGURES: LotFigures = {
  lot: { onHand: '319.8000', held: '0.0000', reserved: '148.4000', available: '171.4000', overReserved: false },
  reservations: [
    reservation(1, {}),
    reservation(2, { kind: 'HIDE', hide: { id: uid('8282', 1), code: 'HD-DEMO-0001' }, quantity: '52.4000', open: '52.4000', demand: { type: 'WorkOrder', id: WORK_ORDERS.a.id, number: WORK_ORDERS.a.number, status: 'COMPLETED' }, stale: true, needDate: null }),
  ],
}
const HOLDS: LotHolds = {
  lot: [holdRow(1, { subjectType: 'Lot', subjects: [{ id: LOT_ROWS[0]!.id, label: LOT_ROWS[0]!.code, state: 'RELEASED' }], status: 'RELEASED', reasonCode: 'SUSPECT_DEFECT', placedAt: at(20, 11), releasedAt: at(21, 9) })],
  hides: [holdRow(2, { subjectType: 'Hide', subjects: [{ id: uid('8282', 4), label: 'HD-DEMO-0004', state: 'FULL' }], reasonCode: 'QUALITY_CHECK', reasonNote: 'Venature da verificare con la conceria' })],
}
const rejectedStock = { ...rejected!, onHand: '96.3000', hides: 2 }
const REJECTED_RECORD = lotRecordOf(rejectedStock, { stock: [{ location: named(LOCATIONS.quarantine), onHand: '96.3000', held: '96.3000', hides: 2 }] })

export const designScreen = defineDesignScreen<LotCase>({
  screen: 'SCR-201-record',
  title: 'A lot (release checklist, where it is, trace both ways, moves)',
  view: LotDesign,
  cases: [
    { id: 'released', label: 'Released nappa lot: checklist done, stock in two places, hides', model: lotCase('owner') },
    { id: 'quarantine', label: 'In quarantine: waits for its Cr VI result (checklist open)', model: lotCase('quality', quarantine), note: 'Release checklist in Tests & substances opens the one place where the lot is released.' },
    { id: 'cr-vi-failed', label: 'Cr VI failed: blocked, can never be issued', model: lotCase('owner', failed) },
    { id: 'opening', label: 'Opening stock (no receipt): came from says so', model: lotCase('warehouse', opening) },
    { id: 'rejected', label: 'Rejected: nothing left, read only', model: lotCase('owner', rejected) },
    { id: 'warehouse', label: 'Warehouse: sees the checklist read-only', model: lotCase('warehouse') },
    { id: 'read-only', label: 'Read-only', model: lotCase('readOnly') },
    { id: 'no-quality', label: 'A role without quality.lots.view: the checklist link is held in words', model: lotCase('owner', released, { can: { ...canFor('owner'), lotsView: false }, checklist: null }) },
    { id: 'trace', label: 'Trace: from the supplier and receipt to two work orders, one shipment, one customer', model: lotCase('owner', released, {}, 'trace') },
    { id: 'trace-empty', label: 'Trace: not used yet', model: lotCase('quality', quarantine, {}, 'trace') },
    { id: 'trace-opening', label: 'Trace of opening stock', model: lotCase('warehouse', opening, {}, 'trace') },
    { id: 'moves', label: 'Moves: the ledger of the lot with the running balance', model: lotCase('warehouse', released, {}, 'moves') },
    { id: 'moves-loading', label: 'Moves loading', model: lotCase('warehouse', released, { moves: { value: null, problem: null } }, 'moves') },
    { id: 'moves-error', label: "Moves couldn't be read", model: lotCase('warehouse', released, { moves: { value: null, problem: 'problem.offline' } }, 'moves') },
    { id: 'activity', label: 'Activity: thread, files and history', model: lotCase('owner', released, {}, 'activity') },
    { id: 'docked', label: 'Thread beside the overview (wide screen, ⌘J)', model: lotCase('owner', released, { dockOpen: true }) },
    { id: 'checklist-error', label: "The checklist couldn't be read", model: lotCase('quality', quarantine, { checklist: { value: null, problem: 'problem.read' } }) },
    { id: 'changed', label: 'Changed by someone else meanwhile', model: lotCase('owner', released, { changed: { at: NOW } }) },
    { id: 'loading', label: 'Loading', model: lotCase('owner', released, { record: { status: 'loading' } }) },
    { id: 'not-found', label: 'Not found (or another company)', model: lotCase('owner', released, { record: { status: 'not_found' } }) },
    { id: 'error', label: "The lot couldn't be read", model: lotCase('owner', released, { record: { status: 'error', problem: 'problem.offline' } }) },
    { id: 'reserved', label: 'B-W2a-64 — Where it is: reserved and available at the site; who reserved it (one done: release it)', model: lotCase('warehouse') },
    { id: 'figures-loading', label: 'B-W2a-64 — The site figures still reading', model: lotCase('warehouse', released, { figures: { value: null, problem: null } }) },
    { id: 'over-reserved', label: 'B-W2a-64 — More reserved than there is (said, never hidden)', model: lotCase('owner', released, { figures: part({ ...FIGURES, lot: { onHand: '96.0000', held: '0.0000', reserved: '148.4000', available: '-52.4000', overReserved: true } }) }) },
    { id: 'quality-tab', label: 'B-W2a-64 — Quality status: the status (decided in Compliance) and the holds of the lot and its hides', model: lotCase('quality', released, {}, 'quality') },
    { id: 'quality-none', label: 'B-W2a-64 — Quality status: no holds', model: lotCase('warehouse', quarantine, { holds: part({ lot: [], hides: [] }) }, 'quality') },
    { id: 'quality-no-right', label: 'B-W2a-64 — Quality status for a role without quality.holds.view', model: lotCase('owner', released, { holds: null }, 'quality') },
    { id: 'quality-error', label: "B-W2a-64 — Quality status: the holds couldn't be read", model: lotCase('quality', released, { holds: { value: null, problem: 'problem.offline' } }, 'quality') },
    { id: 'trace-tree', label: 'B-W2a-64 — Trace tree both ways: levels with counts, gaps, may-hold-it nodes, a hide on hold, a hidden customer', model: lotCase('owner', released, {}, 'trace') },
    { id: 'trace-affected', label: 'B-W2a-64 — Trace tree: only affected customers', model: lotCase('quality', released, { affectedOnly: true }, 'trace') },
    { id: 'trace-large', label: 'B-W2a-64 — A large trace: 30 garments of a bundle counted first, listed when opened', model: lotCase('owner', released, { trace: part(LARGE_TRACE) }, 'trace') },
    { id: 'trace-tree-loading', label: 'B-W2a-64 — Trace tree reading', model: lotCase('warehouse', released, { trace: { value: null, problem: null } }, 'trace') },
    { id: 'trace-tree-error', label: "B-W2a-64 — Trace tree couldn't be read", model: lotCase('warehouse', released, { trace: { value: null, problem: 'problem.offline' } }, 'trace') },
    { id: 'trace-dialog', label: 'B-W2a-64 — Trace… from the lot band', model: lotCase('warehouse', released, { find: blankFind() }) },
    {
      id: 'rejected-stock',
      label: 'B-W2a-64 — Rejected lot with stock: return to the supplier (a claim) or write it off at its place',
      model: lotCase('quality', rejectedStock, { record: { status: 'ready', value: REJECTED_RECORD }, figures: part({ lot: null, reservations: [] }) }),
    },
    {
      id: 'rejected-write-off',
      label: 'B-W2a-64 — Write off the rejected lot at its place: quantity, reason, photo, NCR',
      model: lotCase('quality', rejectedStock, {
        record: { status: 'ready', value: REJECTED_RECORD },
        figures: part({ lot: null, reservations: [] }),
        writeOff: writeOffDialog({ kind: 'quantity', siteId: SITE.id, item: ITEMS.leather, colour: null, lot: { id: rejectedStock.id, code: rejectedStock.code }, location: named(LOCATIONS.quarantine), onHand: '96.3000' }, { draft: { reasonCode: 'OTHER', note: 'Lotto rifiutato: la conceria non lo riprende', reference: '', quantity: '96,3', photo: null, photoStep: false, openNcr: true, ncrSeverity: 'MAJOR' } }),
      }),
    },
    { id: 'sales', label: 'Sales: no inventory.stock.view', model: lotCase('sales') },
    // ---- B-W2b-320: the W2b parts (lifecycle, attributes, incoming inspection, separation, split, trace report) ----------
    { id: 'w2b-overview', label: 'B-W2b-320 — In use: lifecycle and its history, two child lots, attributes, incoming inspection passed, a document ending', model: lotCase('quality', released, { depth: depthModel(nappaDepth()) }) },
    { id: 'w2b-warehouse', label: 'B-W2b-320 — Warehouse: sorts hides and records attributes, no trace report (held in words)', model: lotCase('warehouse', released, { depth: depthModel(nappaDepth({ may: { manage: true, split: true, report: false } }), {}, ['inventory.lots.manage']) }) },
    { id: 'w2b-read-only', label: 'B-W2b-320 — Read-only: attributes and split held (inventory.lots.manage), no report', model: lotCase('readOnly', released, { depth: depthModel(nappaDepth({ may: { manage: false, split: false, report: false }, attributes: { ...nappaDepth().attributes, canEdit: false } }), {}, []) }) },
    { id: 'w2b-quarantine', label: 'B-W2b-320 — In quarantine: inspection still open; you received it, another person releases it', model: lotCase('quality', quarantine, { depth: depthModel(QUARANTINE_DEPTH) }) },
    { id: 'w2b-quality-tab', label: 'B-W2b-320 — Quality status: separation kept (received and decided by two people), holds and incoming inspections', model: lotCase('quality', released, { depth: depthModel(nappaDepth()) }, 'quality') },
    { id: 'w2b-not-kept', label: 'B-W2b-320 — Quality status: separation not kept (the receiver decided)', model: lotCase('owner', released, { depth: depthModel(NOT_KEPT_DEPTH) }, 'quality') },
    {
      id: 'w2b-depleted',
      label: 'B-W2b-320 — A child lot depleted: nothing left · depleted 29 Oct, split from its parent, the parent’s inspection',
      model: lotCase('warehouse', released, {
        record: { status: 'ready', value: lotRecordOf({ ...released!, id: DEPLETED_CHILD.lot.id, code: DEPLETED_CHILD.lot.code, onHand: '0.0000', hides: 0 }, { stock: [] }) },
        figures: part({ lot: null, reservations: [] }),
        depth: depthModel(DEPLETED_CHILD),
      }),
    },
    { id: 'w2b-behind', label: 'B-W2b-320 — The ledger moved on: “Check” the lifecycle', model: lotCase('warehouse', released, { depth: depthModel(BEHIND_DEPTH) }) },
    { id: 'w2b-checked', label: 'B-W2b-320 — Checked: the lifecycle moved (notice)', model: lotCase('warehouse', released, { depth: depthModel(nappaDepth(), { notice: { tone: 'success', words: { key: 'ld.life.checked', params: { from: 'RELEASED', to: 'IN_USE' } } } }) }) },
    { id: 'w2b-depth-loading', label: 'B-W2b-320 — The W2b facts still reading', model: lotCase('owner', released, { depth: depthModel(null) }) },
    { id: 'w2b-depth-error', label: "B-W2b-320 — The W2b facts couldn't be read (Try again)", model: lotCase('owner', released, { depth: depthModel(null, { depth: { value: null, problem: 'problem.offline' } }) }) },
    { id: 'w2b-attributes', label: 'B-W2b-320 — Edit attributes: thickness range, finish, tannage, grade mix, origin', model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { attributes: { draft: { thicknessMinMm: '1.1', thicknessMaxMm: '1.3', finish: 'Pieno fiore', tannage: 'CHROME', gradeMix: 'A 75, B 25', origin: 'Italia' }, busy: false, problem: null } }) }) },
    { id: 'w2b-attributes-refused', label: 'B-W2b-320 — Edit attributes refused in words (a grade mix over 100 %)', model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { attributes: { draft: { thicknessMinMm: '1,1', thicknessMaxMm: '1,3', finish: 'Pieno fiore', tannage: 'CHROME', gradeMix: 'A 75, B 40', origin: 'Italia' }, busy: false, problem: { key: 'ld.attr.problem.gradeMix' } } }) }) },
    { id: 'w2b-split', label: 'B-W2b-320 — Split into shade groups: the inspection’s groups (1, 2, rejected apart), a reserved hide that cannot move', model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { split: splitOf({}) }) }) },
    { id: 'w2b-split-loading', label: 'B-W2b-320 — Split: reading the family’s hides', model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { split: { read: { value: null, problem: null }, draft: null, busy: false, problem: null, done: null } }) }) },
    { id: 'w2b-split-error', label: "B-W2b-320 — Split: the hides couldn't be read", model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { split: { read: { value: null, problem: 'problem.offline' }, draft: null, busy: false, problem: null, done: null } }) }) },
    { id: 'w2b-split-held', label: 'B-W2b-320 — Split held: a group without a name', model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { split: splitOf({ groups: [{ key: 'g1', shadeGroupId: null, label: '' }], assign: { [SPLIT_READ.hides[0]!.id]: 'g1' } }) }) }) },
    { id: 'w2b-split-refused', label: 'B-W2b-320 — Split refused: a place blocked by a count (said in words)', model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { split: { ...splitOf({}), problem: { key: 'ld.split.refused.warehouse' } } }) }) },
    { id: 'w2b-regroup', label: 'B-W2b-320 — Move between lots of the family (regroup): a hide into child -A; a partly cut hide stays', model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { split: { read: part(FAMILY_READ), draft: { mode: 'regroup', groups: [], assign: { [FAMILY_READ.hides[0]!.id]: FAMILY_READ.lots[1]!.id }, inspectionId: null, note: 'Tonalità più vicina al lotto A' }, busy: false, problem: null, done: null } }) }) },
    { id: 'w2b-split-done', label: 'B-W2b-320 — Split done: two child lots made, the new tags to print', model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { split: { ...splitOf({}), done: SPLIT_DONE } }) }) },
    { id: 'w2b-trace', label: 'B-W2b-320 — Trace tab: Trace report…, the reports made (who, for whom, as of, the file)', model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { reports: part(REPORTS) }) }, 'trace') },
    { id: 'w2b-trace-none', label: 'B-W2b-320 — Trace tab: no report yet; the warehouse may not make one', model: lotCase('warehouse', released, { depth: depthModel(nappaDepth({ may: { manage: true, split: true, report: false } }), { reports: part([]) }, ['inventory.lots.manage']) }, 'trace') },
    { id: 'w2b-report', label: 'B-W2b-320 — Trace report: direction, as of, for an authority, PDF', model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { reports: part(REPORTS), report: reportDialog({ draft: { ...reportDialog().draft, audience: 'AUTHORITY', recipient: 'Autorità di vigilanza di esempio', reference: 'Prot. 2026/014', requestedOn: '2026-10-29', asOf: '2026-10-28' } }) }) }, 'trace') },
    { id: 'w2b-report-problems', label: 'B-W2b-320 — Trace report held: nobody named who asked; "as of" after today', model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { report: reportDialog({ draft: { ...reportDialog().draft, asOf: '2026-11-04' } }) }) }, 'trace') },
    { id: 'w2b-report-done', label: 'B-W2b-320 — Trace report made: counts, the child lots included, open the file again', model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { reports: part(REPORTS), report: reportDialog({ done: REPORT_DONE }) }) }, 'trace') },
    { id: 'w2b-report-error', label: "B-W2b-320 — Trace reports couldn't be read", model: lotCase('quality', released, { depth: depthModel(nappaDepth(), { reports: { value: null, problem: 'problem.offline' } }) }, 'trace') },
  ],
})

function splitOf(over: Partial<SplitDraft>): NonNullable<LotDepthModel['split']> {
  return { read: part(SPLIT_READ), draft: { ...splitDraftFor(SPLIT_READ), ...over }, busy: false, problem: null, done: null }
}
