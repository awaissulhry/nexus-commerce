import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { BUNDLE_SCANS, bundlesOf, cutLogOf, NO_PRINTERS, ROLES, workOrder, type Role } from '../../_shared/fixtures'
import { recordCase, RecordDesign, type RecordCase } from '../record/fixtures'
import { dailyFor, FINISHED, HOLD, heldWorkOrder, NOTHING_TO_FINISH, YIELD } from '../daily/demo/fixtures'
import type { CutLogW2b } from './api'
// ---- F-PR-06: Cutting & bundles — the Cut record's recuts and cut orders (made-up) ----
import type { Replacement } from '../../cutting/api'
import { cuttingCanOf } from '../../cutting/model'
import { ORDER_CUTTING, ORDER_PLANNED } from '../../cutting/orders/demo/fixtures'
import type { CutPartsModel } from './use-cut-parts'
// ---- end F-PR-06

/**
 * SCR-071 — the work order's Cutting & bundles tab (F-PR-06: Cutting and Bundles as ONE tab, the Cut record merged in; design
 * wo-cutlog, wo-cutplan, wo-bundles; MES-056, MES-065) with made-up data only: ONE table of what is cut and bundled per size ×
 * colour (its parts, what is short, what waits for a recut), the recuts with Mark cut, each hide's area bar, the cut log per hide
 * (a closing cut, a corrected entry and its mirror), an entry's detail, the correction (a reason; a closing cut opens its hide
 * again; a cut of a used-up hide that is not its closing one is held with the reason), the cut orders this work order is in (one
 * shared with another work order), the yield per hide and per lot, every bundle and where it waits, Reprint N, a bundle's scans,
 * Split, finished to stock (its figures; Report finished is the band's), and the states. Roles: Production manager (corrects,
 * reprints), Team leader and Sales (read). B-W2b-130: an entry's detail with the photo of the hide taken at the table and the
 * thickness measured there, an entry without a photo, the photo being read, and a photo that could not be shown or may not be
 * opened.
 */

const ID = (n: number) => `0190f0e2-6161-7000-8000-${String(n).padStart(12, '0')}`
const cutting = (role: Parameters<typeof recordCase>[0], over: Parameters<typeof recordCase>[2] = {}): RecordCase => recordCase(role, 'IN_PROGRESS', { tab: 'cutting', ...over })

// B-W2b-130: entry 3 with the hide's photo (a made-up picture of a hide, no person) and its thickness measured at the table.
const PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#e9e4dc"/><path d="M40 60 C70 20 130 30 160 22 C200 30 250 18 285 55 C300 95 292 140 270 168 C230 186 180 176 160 182 C120 188 70 184 46 160 C24 130 26 92 40 60 Z" fill="#2b2622"/></svg>')}`
const withPhoto = (): CutLogW2b => {
  const log = cutLogOf()
  return { ...log, entries: log.entries.map((entry) => (entry.id === ID(3) ? { ...entry, photoFileId: ID(90), measuredThicknessMm: '1.20' } : entry)) }
}
const photo = (url: string | null, problem: string | null = null) => ({ entryId: ID(3), url, problem })

// ---- the bundles (moved from SCR-072: one tab) -----------------------------------------------------------------------------
const B = (n: number) => `0190f0e2-7171-7000-8000-${String(n).padStart(12, '0')}`
const bundles = cutting

// ---- F-PR-06: the Cut record's parts — the recuts asked for scrapped pieces, the cut orders of this work order ---------------
const WO = workOrder('IN_PROGRESS')
const CELL = WO.cells[1]!
const recut = (n: number, over: Partial<Replacement> = {}): Replacement => ({
  id: ID(70 + n),
  workOrder: { id: WO.id, number: WO.number, status: 'IN_PROGRESS' },
  cell: { id: CELL.id, colourwayCode: CELL.colourwayCode, size: CELL.size, quantity: CELL.quantity },
  kind: 'RECUT',
  quantity: 1,
  part: 'Maniche',
  sourceScanId: null,
  reworkOrderId: null,
  reason: 'Macchia sulla manica in cucitura',
  status: 'OPEN',
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  cutLogId: null,
  doneAt: null,
  note: null,
  version: 1,
  createdAt: '2026-10-28T14:20:00.000Z',
  createdBy: { id: 'user-bea', name: 'Bea Esempio' },
  ...over,
})
const RECUTS: Replacement[] = [recut(1), recut(2, { part: 'Collo', status: 'DONE', cutLogId: ID(2), doneAt: '2026-10-29T09:00:00.000Z', reason: 'Tagliato contro vena' })]
// One cut order cuts for this work order alone; one shares its lays with another work order (named as the API named it).
const OWN = { id: WO.id, number: WO.number }
const ORDERS = [
  { order: { ...ORDER_PLANNED, workOrders: [OWN] }, others: [] },
  { order: { ...ORDER_CUTTING, workOrders: [OWN, { id: ID(99), number: 'WO-00011' }] }, others: [{ id: ID(99), number: 'WO-00011' }] },
]
// Design: the production manager also reads the cutting room and scrap, marks a recut cut, sees stock and raises a supplier claim.
const CUT_ROLE: Record<Role, readonly string[]> = {
  owner: ROLES.owner,
  manager: [...ROLES.manager, 'production.cutting.view', 'production.scrap.view', 'production.scrap', 'inventory.stock.view', 'purchasing.claims.manage'],
  teamLeader: ROLES.teamLeader,
  sales: ROLES.sales,
}
const cutParts = (role: Role, over: Partial<CutPartsModel> = {}): CutPartsModel => {
  const can = cuttingCanOf(CUT_ROLE[role])
  return { can, recuts: can.scrap ? { value: RECUTS, problem: null } : null, orders: can.view ? { value: ORDERS, problem: null } : null, recut: null, busy: false, problem: null, ...over }
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-071',
  title: 'Work order › Cutting & bundles (one table, hides or lays, yield, bundles)',
  view: RecordDesign,
  cases: [
    { id: 'log', label: 'Production manager: cut against plan, the hides, the cut log (newest first)', model: cutting('manager'), note: 'Enter on an entry opens it; ⋯ Correct entry… (held with the reason when it may not be corrected).' },
    { id: 'entry', label: 'An entry: pieces per size and part, area, station, who cut it (a site that records workers)', model: cutting('manager', { cutOpen: ID(3) }) },
    { id: 'entry-closing', label: 'The closing cut of a used-up hide: correcting it opens the hide again', model: cutting('manager', { cutOpen: ID(4) }) },
    { id: 'entry-correction', label: 'A correction (the mirror entry), in words', model: cutting('manager', { cutOpen: ID(6) }) },
    { id: 'correct', label: 'Correct an entry: the reason, what it takes back, the bundle rule', model: cutting('manager', { dialog: { kind: 'correct', entryId: ID(3) } }) },
    { id: 'correct-closing', label: 'Correct the closing cut: the hide opens again', model: cutting('manager', { dialog: { kind: 'correct', entryId: ID(4) }, draft: { reason: 'Wrong size typed at the table' } }) },
    { id: 'correct-refused', label: 'Refused: bundles were made from this cut (void them first) — inside the dialog', model: cutting('manager', { dialog: { kind: 'correct', entryId: ID(1) }, draft: { reason: 'Size 48 cut twice' }, dialogProblem: { key: 'refusal.cut.IN_BUNDLE' } }) },
    { id: 'corrected', label: 'After a correction: the notice, the mirror in the log', model: cutting('manager', { notice: { tone: 'success', words: { key: 'notice.corrected' } } }) },
    { id: 'empty', label: 'Not cut yet', model: cutting('manager', { cutLog: { value: cutLogOf('empty'), problem: null } }) },
    { id: 'loading', label: 'Loading the cut log', model: cutting('manager', { cutLog: { value: null, problem: null } }) },
    { id: 'error', label: 'The cut log failed: in words, with Try again', model: cutting('manager', { cutLog: { value: null, problem: 'error.read' } }) },
    { id: 'draft', label: 'A draft: nothing is cut before the release', model: recordCase('manager', 'DRAFT', { tab: 'cutting' }) },
    { id: 'team-leader', label: 'Team leader: reads the log; Correct is held (production.cut.correct)', model: cutting('teamLeader', { cutOpen: ID(3) }) },
    { id: 'sales', label: 'Sales (read-only)', model: cutting('sales') },
    // ---- B-W2a-46: yield (wo-yield) and the cutting list (wo-docs) ----
    // ---- B-W2b-130: the hide photo in an entry's detail (wo-cutlog W2b) ----
    { id: 'w2b-entry-photo', label: 'W2b · An entry: the photo of the hide taken at the table, the thickness measured there', model: cutting('manager', { cutLog: { value: withPhoto(), problem: null }, cutOpen: ID(3), cutPhoto: photo(PHOTO) }), note: 'A picture of the leather only (COL-017). Esc closes.' },
    { id: 'w2b-entry-photo-loading', label: 'W2b · An entry: its photo being read', model: cutting('manager', { cutLog: { value: withPhoto(), problem: null }, cutOpen: ID(3), cutPhoto: photo(null) }) },
    { id: 'w2b-entry-photo-failed', label: 'W2b · An entry: the photo could not be shown', model: cutting('manager', { cutLog: { value: withPhoto(), problem: null }, cutOpen: ID(3), cutPhoto: photo(null, 'error.offline') }) },
    { id: 'w2b-entry-photo-forbidden', label: 'W2b · Team leader without files.read: the photo is not opened, said', model: cutting('teamLeader', { cutLog: { value: withPhoto(), problem: null }, cutOpen: ID(3), cutPhoto: photo(null, 'error.forbidden') }) },
    { id: 'w2b-entry-no-photo', label: 'W2b · An entry cut without a photo (optional at the site)', model: cutting('manager', { cutOpen: ID(2) }) },
    { id: 'w2a-yield', label: 'W2a · Yield: area in, pattern, remnant, waste %; planned vs actual; a bar per hide (never by cutter)', model: cutting('manager'), note: 'Scroll below the cut log: Yield, then Print cutting list.' },
    { id: 'w2a-yield-none', label: 'W2a · Yield before any cut', model: cutting('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { yield: { value: { ...YIELD, hides: [] }, problem: null } }) }) },
    { id: 'w2a-yield-loading', label: 'W2a · Yield loading', model: cutting('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { yield: { value: null, problem: null } }) }) },
    { id: 'w2a-yield-error', label: 'W2a · Yield could not be read (Try again)', model: cutting('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { yield: { value: null, problem: 'problem.read' } }) }) },
    { id: 'w2a-print-cutting', label: 'W2a · Print cutting list: garments per colourway and size, with the parts', model: cutting('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'print', what: 'cutting' } }) }) },
    // ---- the bundles (SCR-072's until F-PR-06: Cutting and Bundles are one tab) ----
    { id: 'bundles', label: 'Production manager: the bundles, where each waits, last scan, ticket', model: bundles('manager'), note: 'Tick bundles: Reprint N tickets. The void bundle’s box is off and says why.' },
    { id: 'reprint', label: 'Reprint 2 tickets: the reason, the label printer', model: bundles('manager', { dialog: { kind: 'reprint', bundleIds: [B(3), B(5)] } }) },
    { id: 'reprint-other', label: 'Reprint with another reason, typed', model: bundles('manager', { dialog: { kind: 'reprint', bundleIds: [B(3)] }, draft: { reason: 'Ticket wet at the washing station' } }) },
    {
      id: 'reprint-results',
      label: 'Reprint: one new code, one refused in words',
      model: bundles('manager', { dialog: { kind: 'reprint', bundleIds: [B(3), B(5)] }, reprint: { running: false, done: true, results: { [B(3)]: { state: 'done', code: 'BN-DEMO-2003-R' }, [B(5)]: { state: 'failed', words: { key: 'refusal.bundle.WORK_ORDER_NOT_OPEN' } } } } }),
    },
    { id: 'reprint-no-printer', label: 'Reprint at a site with no label printer: held with the reason', model: bundles('manager', { dialog: { kind: 'reprint', bundleIds: [B(3)] }, printers: { value: NO_PRINTERS, problem: null } }) },
    { id: 'bundle', label: 'A bundle: scans per operation (undo and its report), hides and lot, earlier tickets', model: bundles('manager', { bundleOpen: { bundleId: B(3), scans: { value: BUNDLE_SCANS, problem: null } } }) },
    { id: 'bundle-reprinted', label: 'A reprinted bundle: the reprint with its reason', model: bundles('manager', { bundleOpen: { bundleId: B(2), scans: { value: [], problem: null } } }) },
    { id: 'waiting-at', label: 'The bundles waiting at 20 ASM-CORPO (from Floor now)', model: bundles('manager', { waitingAt: 20 }) },
    { id: 'bundles-empty', label: 'No bundles yet', model: bundles('manager', { bundles: { value: bundlesOf('empty'), problem: null } }) },
    { id: 'bundles-loading', label: 'Loading the bundles', model: bundles('manager', { bundles: { value: null, problem: null } }) },
    { id: 'bundles-error', label: 'The bundles failed: in words, with Try again', model: bundles('manager', { bundles: { value: null, problem: 'error.read' } }) },
    { id: 'bundles-team-leader', label: 'Team leader: reads the bundles (no reprint: production.bundles)', model: bundles('teamLeader') },
    { id: 'bundles-sales', label: 'Sales (read-only)', model: bundles('sales') },
    // ---- B-W2a-46: finished to stock (its figures), split a bundle, bundles on hold ----
    { id: 'w2a-finished', label: 'W2a · Finished to stock — released, in stock, can go now (Report finished is the band’s main step, not this card’s)', model: bundles('manager') },
    { id: 'w2a-finish-dialog', label: 'W2a · Report finished to stock: per size what can go now, the finished-goods place', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'finish' } }) }) },
    { id: 'w2a-finish-over', label: 'W2a · Report finished: a size asks for more than can go (held, in words)', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'finish' }, draft: { asked: { [FINISHED.cells[0]!.cellId]: 99 } } }) }) },
    { id: 'w2a-finish-refused', label: 'W2a · Report finished refused (changed meanwhile): inside the dialog', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'finish' }, problem: { key: 'problem.conflict' } }) }) },
    { id: 'w2a-finish-nothing', label: 'W2a · Nothing released by quality yet: no Report finished in the band (the next step instead)', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { finished: { value: NOTHING_TO_FINISH, problem: null } }) }) },
    { id: 'w2a-finish-held-on-hold', label: 'W2a · A work order on hold: Split held with the reason; no Report finished', model: bundles('manager', { workOrder: { status: 'ready', value: heldWorkOrder() }, daily: dailyFor('manager', 'IN_PROGRESS', { holds: { value: [HOLD], problem: null } }) }) },
    { id: 'w2a-finish-no-right', label: 'W2a · Team leader: Report held (production.finish)', model: bundles('teamLeader') },
    { id: 'w2a-split', label: 'W2a · Split bundle (from the bundle’s ⋯): garments into a child bundle with its own ticket', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'split', bundleId: B(3) }, draft: { quantity: 2, splitReason: 'REWORK', note: 'Cucitura da rifare' } }) }) },
    { id: 'w2a-split-held', label: 'W2a · Split held until a reason is chosen and the garments are 1 … n − 1', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { dialog: { kind: 'split', bundleId: B(3) }, draft: { quantity: 99 } }) }) },
    { id: 'w2a-bundle-on-hold', label: 'W2a · A bundle under a hold of its own: the On hold column', model: bundles('manager', { daily: dailyFor('manager', 'IN_PROGRESS', { bundleHolds: [{ ...HOLD, id: B(90), subjectType: 'Bundle', subjects: [{ id: B(3), label: null, state: null }] }] }) }) },
    // ---- F-PR-06: ONE cut-and-bundled table; the Cut record merged in (recuts, cut orders, yield per lot); an old ?tab=bundles ----
    { id: 'merged', label: 'F-PR-06 · ONE table: Planned · Cut · Bundled · Short per size × colour, the parts under each size, a Total', model: cutting('manager', { cut: cutParts('manager') }), note: 'The cut-vs-plan grid and the bundles’ per-size card were the same figures twice.' },
    { id: 'recuts', label: 'F-PR-06 · Recuts asked for scrapped pieces (the Cut record’s): open and done, Mark cut; the open one counted under its size', model: cutting('manager', { cut: cutParts('manager') }) },
    { id: 'recut-dialog', label: 'F-PR-06 · Mark cut: the cut log entry of its size that cut it', model: cutting('manager', { cut: cutParts('manager', { recut: ID(71) }) }) },
    { id: 'recut-refused', label: 'F-PR-06 · Mark cut refused (the entry is not of its size): said inside the dialog', model: cutting('manager', { cut: cutParts('manager', { recut: ID(71), problem: { key: 'problem.recut.notOfCell' } }) }) },
    { id: 'cut-orders', label: 'F-PR-06 · The cut orders this work order is in (its fabric lays): one shared with another work order, named as the API named it', model: cutting('manager', { cut: cutParts('manager') }), note: 'A reader limited to some customers is never sent another customer’s work order, so it is never named.' },
    { id: 'cut-orders-failed', label: 'F-PR-06 · The cut orders could not be read: Try again (the rest stays)', model: cutting('manager', { cut: cutParts('manager', { orders: { value: null, problem: 'problem.offline' } }) }) },
    { id: 'lot-yield', label: 'F-PR-06 · Yield per lot and supplier (Raise with the supplier) and the leather issued against used against returned', model: cutting('manager', { cut: cutParts('manager') }) },
    { id: 'old-bundles-address', label: 'F-PR-06 · An old ?tab=bundles&at=20 (Floor now): Cutting & bundles, the bundles waiting at 20 ASM-CORPO', model: bundles('manager', { waitingAt: 20, cut: cutParts('manager') }) },
    { id: 'cut-log-failed', label: 'F-PR-06 · The cut log failed, the bundles read: the table and the bundles stay, the log says why', model: cutting('manager', { cutLog: { value: null, problem: 'error.offline' } }) },
    { id: 'team-leader-parts', label: 'F-PR-06 · Team leader: no recuts or cut orders read (production.scrap.view, production.cutting.view)', model: cutting('teamLeader', { cut: cutParts('teamLeader') }) },
  ],
})
