import { at, ITEMS, LOCATIONS, LOTS, named, PEOPLE, uid } from '../../../../_shared/stock/fixtures'
import { part } from '../../shared/model'
import type { DepthCounts, DepthFacts, LotDepth, SplitAnswer, SplitHide, SplitRead, TraceReportAnswer, TraceReportRow } from '../api'
import { blankReport, depthCan, draftOf, type SplitDraft } from '../model'
import type { LotDepthModel } from '../view-model'

/**
 * B-W2b-320 — made-up W2b facts of the demo lots (design-only): the lifecycle of each lot (the nappa lot in use, its split
 * children, a depleted lot), attributes, the incoming inspection and the separation of duties, documents ending soon,
 * Split into shade groups (the inspection's proposal, hides that cannot move, a regroup, the new tags), the trace report
 * and the reports made. Nothing here is real business data.
 */

export const DEPTH_COUNTS: DepthCounts = { lifecycle: { QUARANTINE: 1, RELEASED: 2, IN_USE: 2, DEPLETED: 3, BLOCKED: 1, RETURNED: 0 }, documentsExpiring: 2 }

/** The W2b columns of the demo list's rows (LOT_ROWS order: nappa, quarantine, suede failed, lining, protector, opening, rejected). */
export const DEPTH_FACTS: Readonly<Record<string, DepthFacts>> = {
  [LOTS.nappa.id]: { lifecycle: 'IN_USE', parentLot: null, childLots: 2, documentsExpiring: 1 },
  [LOTS.nappaQuarantine.id]: { lifecycle: 'QUARANTINE', parentLot: null, childLots: 0, documentsExpiring: 0 },
  [LOTS.suedeFail.id]: { lifecycle: 'BLOCKED', parentLot: null, childLots: 0, documentsExpiring: 0 },
  [LOTS.lining.id]: { lifecycle: 'RELEASED', parentLot: null, childLots: 0, documentsExpiring: 0 },
  [LOTS.protector.id]: { lifecycle: 'RELEASED', parentLot: null, childLots: 0, documentsExpiring: 1 },
}
export const factsFor = (ids: readonly string[]): Record<string, DepthFacts> => Object.fromEntries(ids.map((id) => [id, DEPTH_FACTS[id] ?? { lifecycle: 'DEPLETED' as const, parentLot: null, childLots: 0, documentsExpiring: 0 }]))

const CHILD_A = { id: uid('8181', 21), code: `${LOTS.nappa.code}-A` }
const CHILD_B = { id: uid('8181', 22), code: `${LOTS.nappa.code}-B` }

const history = (rows: LotDepth['lifecycle']['history']) => rows

/** The nappa lot: released, in use, two child lots split by shade, its incoming inspection passed, kept separation. */
export function nappaDepth(over: Partial<LotDepth> = {}): LotDepth {
  return {
    lot: { id: LOTS.nappa.id, code: LOTS.nappa.code, companyId: uid('0000', 1), siteId: uid('2222', 1), version: 6, item: { ...ITEMS.leather, kind: 'LEATHER', baseUom: 'FT2' }, colour: { id: uid('7272', 1), code: 'BLK', name: 'Nero' }, shade: 'A', qualityStatus: 'RELEASED', lifecycle: 'IN_USE', onHand: '319.8000', hidesInStock: 6 },
    lifecycle: {
      state: 'IN_USE',
      since: at(24, 10),
      depletedAt: null,
      expected: 'IN_USE',
      history: history([
        { at: at(14, 9), kind: 'LIFECYCLE', from: null, to: 'QUARANTINE', cause: 'RECEIPT', action: 'inventory.lotLifecycle' },
        { at: at(16, 11), kind: 'QUALITY', from: null, to: 'RELEASED', cause: 'RELEASE', action: 'quality.lots.release' },
        { at: at(20, 15), kind: 'SPLIT', from: null, to: null, cause: null, action: 'inventory.splitLot' },
        { at: at(24, 10), kind: 'LIFECYCLE', from: 'RELEASED', to: 'IN_USE', cause: 'FIRST_ISSUE', action: 'inventory.lotLifecycle' },
      ]),
    },
    attributes: { kind: 'LEATHER', keys: ['thicknessMinMm', 'thicknessMaxMm', 'finish', 'tannage', 'gradeMix', 'origin'], values: { thicknessMinMm: '1.1', thicknessMaxMm: '1.3', finish: 'Pieno fiore', tannage: 'CHROME', gradeMix: { A: '75', B: '25' }, origin: 'Italia' }, canEdit: true },
    family: {
      parent: null,
      children: [
        { ...CHILD_A, qualityStatus: 'RELEASED', lifecycle: 'RELEASED', shade: '1', onHand: '96.4000', hidesInStock: 2 },
        { ...CHILD_B, qualityStatus: 'RELEASED', lifecycle: 'IN_USE', shade: '2', onHand: '51.1000', hidesInStock: 1 },
      ],
    },
    incoming: { state: 'PASSED', number: 'IC-D-0007', inspections: [{ id: uid('6464', 7), number: 'IC-D-0007', status: 'DECIDED', result: 'PASS', decidedAt: at(15, 16), from: 'LOT' }] },
    separation: { state: 'KEPT', viewerReceived: false, receivedBy: { id: uid('1111', 1), name: PEOPLE.anna }, decidedBy: { id: uid('1111', 2), name: PEOPLE.marco } },
    documents: { rows: [{ id: uid('6565', 1), kind: 'LWG_CERTIFICATE', fileId: uid('6666', 1), validTo: '2026-11-20', state: 'EXPIRING', daysLeft: 21, from: 'LOT' }], expiring: 1, expired: 0 },
    may: { manage: true, split: true, report: true },
    ...over,
  }
}

/** The quarantined lot: the person reading it received it (another person releases it); inspection still open. */
export const QUARANTINE_DEPTH: LotDepth = nappaDepth({
  lot: { ...nappaDepth().lot, id: LOTS.nappaQuarantine.id, code: LOTS.nappaQuarantine.code, qualityStatus: 'QUARANTINE', lifecycle: 'QUARANTINE', onHand: '386.4000', hidesInStock: 8 },
  lifecycle: { state: 'QUARANTINE', since: at(28, 10), depletedAt: null, expected: 'QUARANTINE', history: [{ at: at(28, 10), kind: 'LIFECYCLE', from: null, to: 'QUARANTINE', cause: 'RECEIPT', action: 'inventory.lotLifecycle' }] },
  attributes: { kind: 'LEATHER', keys: ['thicknessMinMm', 'thicknessMaxMm', 'finish', 'tannage', 'gradeMix', 'origin'], values: {}, canEdit: true },
  family: { parent: null, children: [] },
  incoming: { state: 'OPEN', number: 'IC-D-0009', inspections: [{ id: uid('6464', 9), number: 'IC-D-0009', status: 'OPEN', result: null, decidedAt: null, from: 'LOT' }] },
  separation: { state: 'WAITING', viewerReceived: true, receivedBy: { id: uid('1111', 1), name: PEOPLE.anna }, decidedBy: null },
  documents: { rows: [], expiring: 0, expired: 0 },
})

/** A child lot (split from the nappa lot), whose last hide went out: depleted, and the ledger says so. */
export const DEPLETED_CHILD: LotDepth = nappaDepth({
  lot: { ...nappaDepth().lot, id: CHILD_B.id, code: CHILD_B.code, shade: '2', lifecycle: 'DEPLETED', onHand: '0.0000', hidesInStock: 0 },
  lifecycle: {
    state: 'DEPLETED',
    since: at(29, 17),
    depletedAt: at(29, 17),
    expected: 'DEPLETED',
    history: [
      { at: at(20, 15), kind: 'SPLIT', from: null, to: null, cause: null, action: 'inventory.lotMadeBySplit' },
      { at: at(26, 9), kind: 'LIFECYCLE', from: 'RELEASED', to: 'IN_USE', cause: 'FIRST_ISSUE', action: 'inventory.lotLifecycle' },
      { at: at(29, 17), kind: 'LIFECYCLE', from: 'IN_USE', to: 'DEPLETED', cause: 'LAST_UNIT_OUT', action: 'inventory.lotLifecycle' },
    ],
  },
  family: { parent: { id: LOTS.nappa.id, code: LOTS.nappa.code, qualityStatus: 'RELEASED', lifecycle: 'IN_USE', shade: 'A' }, children: [] },
  incoming: { state: 'PASSED', number: 'IC-D-0007', inspections: [{ id: uid('6464', 7), number: 'IC-D-0007', status: 'DECIDED', result: 'PASS', decidedAt: at(15, 16), from: 'PARENT' }] },
})

/** A lot whose ledger moved on before the handler did (a move not handled yet): "Check". */
export const BEHIND_DEPTH: LotDepth = nappaDepth({ lifecycle: { ...nappaDepth().lifecycle, state: 'RELEASED', expected: 'IN_USE' } })

/** The receiver who released it themselves (an opening lot recorded by hand): the separation was not kept. */
export const NOT_KEPT_DEPTH: LotDepth = nappaDepth({ separation: { state: 'NOT_KEPT', viewerReceived: false, receivedBy: { id: uid('1111', 1), name: PEOPLE.anna }, decidedBy: { id: uid('1111', 1), name: PEOPLE.anna } } })

export function depthModel(depth: LotDepth | null, over: Partial<LotDepthModel> = {}, permissions: readonly string[] = ['inventory.lots.manage', 'inventory.trace.report', 'files.read']): LotDepthModel {
  return { can: depthCan(permissions), depth: depth ? part(depth) : { value: null, problem: null }, reports: null, attributes: null, split: null, report: null, checking: false, notice: null, ...over }
}

// ---- split ------------------------------------------------------------------------------------------------------------------

const hide = (n: number, over: Partial<SplitHide> = {}): SplitHide => ({
  id: uid('8282', 40 + n),
  code: `HD-DEMO-01${String(n).padStart(2, '0')}`,
  supplierCode: `CNC-${4400 + n}`,
  lot: { id: LOTS.nappa.id, code: LOTS.nappa.code },
  state: 'FULL',
  onHand: '52.4000',
  area: '52.4000',
  areaUom: 'FT2',
  location: named(n % 2 === 0 ? LOCATIONS.binA2 : LOCATIONS.binA1),
  grade: n % 3 === 0 ? 'B' : 'A',
  shade: null,
  shadeGroupId: null,
  marks: 0,
  inspection: { number: 'IC-D-0007', decision: 'ACCEPTED', shadeGroupId: n <= 3 ? uid('6767', 1) : uid('6767', 2), shade: n <= 3 ? '1' : '2' },
  refusal: null,
  ...over,
})

export const SPLIT_READ: SplitRead = {
  parent: { id: LOTS.nappa.id, code: LOTS.nappa.code, qualityStatus: 'RELEASED', lifecycle: 'RELEASED', shade: 'A', version: 6 },
  lots: [{ id: LOTS.nappa.id, code: LOTS.nappa.code, qualityStatus: 'RELEASED', lifecycle: 'RELEASED', shade: 'A', hidesInStock: 7 }],
  hides: [
    hide(1),
    hide(2),
    hide(3),
    hide(4),
    hide(5),
    hide(6, { inspection: { number: 'IC-D-0007', decision: 'REJECTED', shadeGroupId: null, shade: null } }),
    hide(7, { refusal: 'Hide HD-DEMO-0107 is reserved for a work order or an order line: release the reservation first.', inspection: null }),
  ],
  shadeGroups: [
    { id: uid('6767', 1), label: '1', outOfShade: false, lotId: null, active: true },
    { id: uid('6767', 2), label: '2', outOfShade: false, lotId: null, active: true },
    { id: uid('6767', 3), label: '3', outOfShade: true, lotId: null, active: true },
  ],
  proposal: {
    inspection: { id: uid('6464', 7), number: 'IC-D-0007', status: 'DECIDED' },
    groups: [
      { shadeGroupId: uid('6767', 1), label: '1', hideIds: [hide(1).id, hide(2).id, hide(3).id] },
      { shadeGroupId: uid('6767', 2), label: '2', hideIds: [hide(4).id, hide(5).id] },
      { shadeGroupId: null, label: 'Rejected', hideIds: [hide(6).id] },
    ],
  },
  may: true,
}
export const splitDraftFor = (read: SplitRead, words: (key: string) => string = (key) => (key === 'ld.split.apart.REJECTED' ? 'Scartate dal controllo' : key)): SplitDraft => draftOf(read, words)

/** A family with children already: hides of the parent and of child -A; regroup offered. */
export const FAMILY_READ: SplitRead = {
  ...SPLIT_READ,
  lots: [...SPLIT_READ.lots, { id: CHILD_A.id, code: CHILD_A.code, qualityStatus: 'RELEASED', lifecycle: 'RELEASED', shade: '1', hidesInStock: 2 }],
  hides: [...SPLIT_READ.hides.slice(3, 6), hide(8, { lot: CHILD_A, inspection: null }), hide(9, { lot: CHILD_A, state: 'PARTLY_CUT', onHand: '30.1000', refusal: 'Hide HD-DEMO-0109 is partly cut: only a whole hide moves to another lot.', inspection: null })],
  proposal: { inspection: null, groups: [] },
}

export const SPLIT_DONE: SplitAnswer = {
  parent: { id: LOTS.nappa.id, code: LOTS.nappa.code, version: 7 },
  lots: [
    { id: CHILD_A.id, code: CHILD_A.code, qualityStatus: 'RELEASED', lifecycle: 'RELEASED', shade: '1', made: true },
    { id: CHILD_B.id, code: CHILD_B.code, qualityStatus: 'RELEASED', lifecycle: 'RELEASED', shade: '2', made: true },
  ],
  hides: [1, 2, 3, 4, 5].map((n) => ({
    fromHideId: hide(n).id,
    fromCode: hide(n).code,
    hideId: uid('8282', 60 + n),
    code: `HD-DEMO-02${String(n).padStart(2, '0')}`,
    lot: n <= 3 ? CHILD_A : CHILD_B,
    area: '52.4000',
    areaUom: 'FT2' as const,
    grade: n % 3 === 0 ? 'B' : 'A',
    shade: n <= 3 ? '1' : '2',
    marks: 0,
  })),
}

// ---- trace report -----------------------------------------------------------------------------------------------------------

export const TODAY = '2026-10-30'
export const reportDialog = (over: Partial<NonNullable<LotDepthModel['report']>> = {}): NonNullable<LotDepthModel['report']> => ({ draft: blankReport(TODAY, 'it'), today: TODAY, busy: false, problem: null, done: null, ...over })

export const REPORT_DONE: TraceReportAnswer = {
  report: {
    recordType: 'Lot',
    recordId: LOTS.nappa.id,
    start: { kind: 'LOT', id: LOTS.nappa.id, code: LOTS.nappa.code },
    madeAt: at(30, 9, 30),
    asOf: '2026-10-28',
    format: 'PDF',
    includes: [
      { kind: 'LOT', id: CHILD_A.id, code: CHILD_A.code },
      { kind: 'LOT', id: CHILD_B.id, code: CHILD_B.code },
    ],
    counts: { nodes: 41, customersExact: 1, customersPossible: 1, customersByAsOfExact: 1, customersByAsOfPossible: 0, gaps: 2 },
  },
  file: { id: uid('6666', 9), name: 'trace-LOT-D-000101-2026-10-30.pdf', contentType: 'application/pdf', sizeBytes: 48211 },
}

export const REPORTS: TraceReportRow[] = [
  { at: at(30, 9, 30), madeBy: { id: uid('1111', 2), name: PEOPLE.marco }, fileId: uid('6666', 9), audience: 'AUTHORITY', recipient: 'Autorità di vigilanza di esempio', reference: 'Prot. 2026/014', requestedOn: '2026-10-29', asOf: '2026-10-28', direction: 'BOTH', format: 'PDF' },
  { at: at(22, 14), madeBy: { id: uid('1111', 2), name: PEOPLE.marco }, fileId: uid('6666', 8), audience: 'CUSTOMER', recipient: 'Cliente Demo Moto S.r.l.', reference: null, requestedOn: '2026-10-22', asOf: '2026-10-22', direction: 'FORWARD', format: 'CSV' },
]
