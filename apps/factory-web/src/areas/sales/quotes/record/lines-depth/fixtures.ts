import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { QuoteDetail, QuoteVersionRow } from '../../api'
import { CAN, GRAINS, model as recordModel, PEOPLE, PREFIX, QUOTE_ID, quote, SENT_VERSION, STYLE, version, withoutCost, ACCEPTED_VERSION } from '../fixtures'
import type { GoalAnswer } from '../goalseek/api'
import type { VersionsCompared } from '../versions-depth/api'
import type { FillAnswer, QuoteTerms, QuoteWarnings, SizeCurve, SizesAnswer } from './api'
import { tableRows, type Words } from './model'
import type { QuoteDepthModel } from './view/DepthSlots'
import { DepthRecordDesign, type DepthRecordDesignModel } from './view/DepthRecordDesign'

/**
 * SCR-035-depth — the quote record's W2b parts (B-W2b-316), made-up data only: the invented jacket DEMO-JKT-01 of W1's
 * fixtures (BLK 50 2 · 52 4 · 54 2 at 450, RED 50 1 · 52 3 · 54 2 at 440), an invented curve and template, invented people.
 * Each case is one state a person meets: Warnings, the Table view and its bulk reviews, the line drawer with its delivery
 * schedule, Fill by curve, Target price, Terms & delivery in depth, Versions with two selected, Compare, the deposit's
 * pay-online page — per role (the Owner with every grain, Sales without cost, Finance who records payments).
 */

const L1 = '0190f0e2-8888-7000-8000-000000000001'
const L2 = '0190f0e2-8888-7000-8000-000000000002'
const ready = (detail: QuoteDetail) => ({ status: 'ready' as const, value: detail })
const LINE_BASE = `${PREFIX}/sales/quotes/${QUOTE_ID}?tab=lines&line=`

export const WARNINGS: QuoteWarnings = {
  quoteId: QUOTE_ID,
  versionId: '0190f0e2-9999-7000-8000-100000000001',
  revision: 1,
  counts: { blocks: 1, warnings: 2, info: 1 },
  warnings: [
    { code: 'PRIVATE_LABEL', severity: 'BLOCKS', source: 'LINE_RULE', check: 'private-label', message: '', lineIds: [L2], seqs: [20], open: { recordType: 'Style', recordId: STYLE.id, tab: 'release' }, details: {} },
    { code: 'ACCOUNT_OVERDUE', severity: 'WARNING', source: 'QUOTE', check: null, message: '', lineIds: [], seqs: [], open: { recordType: 'Party', recordId: '0190f0e2-6666-7000-8000-000000000001', tab: null }, details: { invoices: 2, daysLate: 18, overdue: [{ currency: 'EUR', amount: 184000 }] } },
    { code: 'CERTIFICATE', severity: 'WARNING', source: 'QUOTE', check: null, message: '', lineIds: [L1], seqs: [10], open: null, details: { size: '56' } },
    { code: 'COST_ESTIMATE', severity: 'INFO', source: 'QUOTE', check: null, message: '', lineIds: [L1, L2], seqs: [10, 20], open: { recordType: 'Style', recordId: STYLE.id, tab: 'release' }, details: {} },
  ],
}

export const TERMS: QuoteTerms = {
  quoteId: QUOTE_ID,
  versionId: '0190f0e2-9999-7000-8000-100000000001',
  revision: 1,
  status: 'DRAFT',
  editable: true,
  language: 'it',
  incoterm: 'DAP',
  incotermPlace: 'Milano, magazzino demo',
  shipComplete: true,
  acceptanceMode: 'SIGN',
  depositPct: '30',
  promiseDate: '2026-12-15',
  customerIncoterm: 'EXW',
  validity: { validUntil: '2026-11-30', firmOffer: false, state: 'NOT_SENT', daysLeft: null, reminderOn: null, reminderSentAt: null, expiredAt: null },
  lines: [
    { lineId: L1, seq: 10, kind: 'SIZE_GRID', label: 'DEMO-JKT-01 BLK', quantity: 8, deliveries: [{ id: '0190f0e2-8888-7000-8000-900000000001', deliveryDate: '2026-12-02', sizes: { '50': 2, '52': 2 }, quantity: 4, note: 'Prima consegna per la fiera' }], atPromiseDate: { '52': 2, '54': 2 } },
    { lineId: L2, seq: 20, kind: 'SIZE_GRID', label: 'DEMO-JKT-01 RED', quantity: 6, deliveries: [], atPromiseDate: {} },
  ],
  quoteVersion: 3,
  incoterms: ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF'].map((code) => ({ code, seaOnly: ['FAS', 'FOB', 'CFR', 'CIF'].includes(code) })),
}

export const CURVES: SizeCurve[] = [
  { id: '0190f0e2-7100-7000-8000-000000000001', companyId: null, company: null, sizeScale: { id: '0190f0e2-7200-7000-8000-000000000001', code: 'EU-DEMO', name: 'Taglie EU demo', sizes: ['48', '50', '52', '54', '56'] }, name: 'Curva moto uomo', shares: { '50': '25.0000', '52': '45.0000', '54': '30.0000' }, status: 'ACTIVE', version: 1, updatedAt: '2026-11-02T09:00:00.000Z' },
  { id: '0190f0e2-7100-7000-8000-000000000002', companyId: '0190f0e2-1111-7000-8000-000000000001', company: { id: '0190f0e2-1111-7000-8000-000000000001', code: 'DEMO', name: 'Demo Pelletteria S.r.l.' }, sizeScale: { id: '0190f0e2-7200-7000-8000-000000000001', code: 'EU-DEMO', name: 'Taglie EU demo', sizes: ['48', '50', '52', '54', '56'] }, name: 'Curva taglie piccole', shares: { '48': '20.0000', '50': '40.0000', '52': '40.0000' }, status: 'ACTIVE', version: 2, updatedAt: '2026-11-05T09:00:00.000Z' },
]

const line = (lineId: string, seq: number, before: Record<string, number>, after: Record<string, number>) => ({
  lineId,
  seq,
  label: '',
  before,
  after,
  moves: Object.keys({ ...before, ...after }).filter((size) => (before[size] ?? 0) !== (after[size] ?? 0)).map((size) => ({ size, from: before[size] ?? 0, to: after[size] ?? 0 })),
  pieces: { before: Object.values(before).reduce((a, b) => a + b, 0), after: Object.values(after).reduce((a, b) => a + b, 0) },
  problems: [] as SizesAnswer['lines'][number]['problems'],
})

const FILL: FillAnswer = {
  preview: true,
  source: { kind: 'CURVE', id: CURVES[0]!.id, name: CURVES[0]!.name },
  lines: [
    { ...line(L1, 10, { '50': 2, '52': 4, '54': 2 }, { '50': 5, '52': 9, '54': 6 }), fill: { leftOut: [], remainder: { size: '52', pieces: 1 } } },
    { ...line(L2, 20, { '50': 1, '52': 3, '54': 2 }, { '50': 3, '52': 5, '54': 4 }), fill: { leftOut: [], remainder: null } },
  ],
  counts: { lines: 2, changing: 2, problems: 0 },
}

const SIZES: SizesAnswer = {
  preview: true,
  lines: [line(L1, 10, { '50': 2, '52': 4, '54': 2 }, { '50': 3, '52': 6, '54': 3 }), { ...line(L2, 20, { '50': 1, '52': 3, '54': 2 }, { '50': 1, '52': 3, '54': 2 }), problems: [{ code: 'SCHEDULE', path: 'lines/1', message: '' }] }],
  counts: { lines: 2, changing: 1, unchanged: 0, problems: 1 },
}

const goalLine = (lineId: string, seq: number, from: string, to: string, discount: string, margin: string, extra: Partial<GoalAnswer['lines'][number]> = {}): GoalAnswer['lines'][number] => ({ lineId, seq, styleId: STYLE.id, colourwayId: '', pieces: 8, start: { kind: 'LIST', unitPrice: '470' }, from: { unitPrice: from, marginPct: '35.3272' }, to: { unitPrice: to, marginPct: margin, marginAmount: 98000 }, discountPct: discount, belowFloor: false, belowCost: false, ...extra })

export const GOAL_LINE: GoalAnswer = {
  preview: true,
  quoteId: QUOTE_ID,
  revision: 1,
  currency: 'EUR',
  priceBasis: 'NET',
  lines: [goalLine(L1, 10, '450', '395', '15.9574', '26.3291')],
  totals: { before: { netAmount: 624000, vatAmount: 137280, grossAmount: 761280 }, after: { netAmount: 580000, vatAmount: 127600, grossAmount: 707600 }, target: null, gap: null },
  margin: { before: '34.5357', after: '29.5684', floorPct: '25' },
  approval: { neededBefore: false, neededAfter: false },
  held: [],
}

const GOAL_TOTAL: GoalAnswer = {
  ...GOAL_LINE,
  lines: [goalLine(L1, 10, '450', '384.62', '18.1660', '24.0918', { belowFloor: true }), goalLine(L2, 20, '440', '376.07', '14.5295', '22.1113', { belowFloor: true })],
  totals: { before: { netAmount: 624000, vatAmount: 137280, grossAmount: 761280 }, after: { netAmount: 533338, vatAmount: 117334, grossAmount: 650672 }, target: 533333, gap: 5 },
  margin: { before: '34.5357', after: '23.2700', floorPct: '25' },
  approval: { neededBefore: false, neededAfter: true },
}

const GOAL_HELD: GoalAnswer = { ...GOAL_LINE, lines: [goalLine(L1, 10, '450', '180', '61.7021', '-60.0000', { belowFloor: true, belowCost: true })], held: [{ lineId: L1, seq: 10, code: 'BELOW_COST' }], approval: { neededBefore: false, neededAfter: true } }

export const VERSIONS: QuoteVersionRow[] = [
  version({ id: '0190f0e2-9999-7000-8000-100000000002', revision: 2, documentNumber: 'Q-2026-0142 v2', changeNote: 'Aggiunto il colore rosso.', createdAt: '2026-10-30T09:00:00.000Z' }),
  SENT_VERSION,
]

const ln = (id: string, label: string, before: Record<string, string | null> | null, after: Record<string, string | null> | null, sizesBefore?: Record<string, string>, sizesAfter?: Record<string, string>) => ({ id, label, detail: null, before: before ? { fields: before, ...(sizesBefore ? { sizes: sizesBefore } : {}) } : null, after: after ? { fields: after, ...(sizesAfter ? { sizes: sizesAfter } : {}) } : null })

export const COMPARED: VersionsCompared = {
  quote: { id: QUOTE_ID, number: 'Q-2026-0142', currentRevision: 2 },
  before: { id: SENT_VERSION.id, revision: 1, documentNumber: 'Q-2026-0142 v1' },
  after: { id: '0190f0e2-9999-7000-8000-100000000002', revision: 2, documentNumber: 'Q-2026-0142 v2' },
  currency: 'EUR',
  sections: [
    {
      id: 'terms',
      fields: [{ id: 'validUntil' }, { id: 'promiseDate' }, { id: 'acceptanceMode' }, { id: 'incoterm' }, { id: 'shipComplete' }],
      sizes: [],
      lines: [ln('terms', 'Terms', { validUntil: '2026-11-15', promiseDate: '2026-12-10', acceptanceMode: 'SIGN', incoterm: null, shipComplete: null }, { validUntil: '2026-11-30', promiseDate: '2026-12-15', acceptanceMode: 'SIGN_AND_PAY', incoterm: 'DAP Milano', shipComplete: '✓' })],
      totals: [],
      summary: { added: 0, removed: 0, changed: 1, unchanged: 0 },
    },
    {
      id: 'lines',
      fields: [{ id: 'seq' }, { id: 'deliveries' }],
      sizes: ['50', '52', '54'],
      lines: [ln(L1, '10 · DEMO-JKT-01 Giacca pelle demo · BLK Nero', { seq: '10', deliveries: null }, { seq: '10', deliveries: '2026-12-02 50 2, 52 2' }, { '50': '2', '52': '3', '54': '2' }, { '50': '2', '52': '4', '54': '2' }), ln(L2, '20 · DEMO-JKT-01 Giacca pelle demo · RED Rosso', null, { seq: '20', deliveries: null }, undefined, { '50': '1', '52': '3', '54': '2' })],
      totals: [{ id: 'lines', before: '1', after: '2' }, { id: 'pieces', before: '7', after: '14' }],
      summary: { added: 1, removed: 0, changed: 1, unchanged: 0 },
    },
  ],
  prices: {
    id: 'prices',
    fields: [{ id: 'unitPrice' }, { id: 'net' }, { id: 'adjustmentReason' }],
    sizes: [],
    lines: [ln(L1, '10 · DEMO-JKT-01 Giacca pelle demo · BLK Nero', { unitPrice: '470', net: '3290', adjustmentReason: null }, { unitPrice: '450', net: '3600', adjustmentReason: 'TARGET_PRICE' }), ln(L2, '20 · DEMO-JKT-01 Giacca pelle demo · RED Rosso', null, { unitPrice: '440', net: '2640', adjustmentReason: null })],
    totals: [{ id: 'net', before: '3290.00', after: '6240.00' }, { id: 'gross', before: '4013.80', after: '7612.80' }],
    summary: { added: 1, removed: 0, changed: 1, unchanged: 0 },
  },
  differs: [{ section: 'terms', added: 0, removed: 0, changed: 1 }, { section: 'lines', added: 1, removed: 0, changed: 1 }],
}

const blank: QuoteDepthModel = { notice: null, linesTop: null, table: null, composer: { inquiry: { number: 'INQ-2026-0042', href: `${PREFIX}/sales/inquiries/0190f0e2-4100-7000-8000-000000000042` } }, canFill: true, goal: null, terms: null, versions: null, deposit: null, drawer: null, bulk: null, paste: null, compare: null }
const top = (extra: Partial<NonNullable<QuoteDepthModel['linesTop']>> = {}): QuoteDepthModel['linesTop'] => ({ warnings: { state: { status: 'ready', value: WARNINGS }, prefix: PREFIX, lineBase: LINE_BASE, price: true }, view: 'blocks', ...extra })
const READ_ONLY_SENT: Words = { ns: 'sales', key: 'readOnly.sent', params: { revision: 1, next: 2, date: '30/11/2026' } }

function depth(extra: Partial<QuoteDepthModel>): QuoteDepthModel {
  return { ...blank, ...extra }
}
function record(extra: Partial<DepthRecordDesignModel['record']> = {}) {
  return recordModel({ grains: GRAINS.owner, can: CAN.owner, ...extra })
}
const QUOTE = quote()
const SENT = quote({ status: 'SENT', current: { status: 'SENT' } })
const ACCEPTED = quote({ status: 'ACCEPTED', current: { status: 'ACCEPTED' } })
const table = (detail: QuoteDetail, selected: string[] = [], readOnly: Words | null = null, grains = GRAINS.owner) => ({ rows: tableRows(detail, TERMS, WARNINGS.warnings), currency: 'EUR', priceBasis: 'NET' as const, grains, readOnly, selected, busy: false })
const bulkLines = [
  { id: L1, label: '10 · DEMO-JKT-01 BLK', sizes: { '50': 2, '52': 4, '54': 2 }, order: ['48', '50', '52', '54', '56'], delivery: { first: '2026-12-02', count: 1 } },
  { id: L2, label: '20 · DEMO-JKT-01 RED', sizes: { '50': 1, '52': 3, '54': 2 }, order: ['48', '50', '52', '54', '56'], delivery: null },
]
const bulk = (extra: Partial<NonNullable<QuoteDepthModel['bulk']>>): QuoteDepthModel['bulk'] => ({ kind: 'price', lines: bulkLines, currency: 'EUR', value: '', sizeKind: 'PERCENT', preview: null, state: { phase: 'ready' }, leadHeld: null, today: '2026-10-29', grains: { price: true, margin: true }, ...extra })
const drawer = (extra: Partial<NonNullable<QuoteDepthModel['drawer']>> = {}): QuoteDepthModel['drawer'] => ({
  line: QUOTE.lines[0]!,
  style: STYLE,
  currency: 'EUR',
  priceBasis: 'NET',
  grains: GRAINS.owner,
  readOnly: null,
  schedule: { status: 'ready', value: TERMS.lines[0]!, promiseDate: '2026-12-15' },
  rows: [{ key: 'd1', date: '2026-12-02', sizes: { '50': '2', '52': '2' }, note: 'Prima consegna per la fiera' }],
  saving: false,
  problem: null,
  today: '2026-10-29',
  position: { index: 1, count: 2 },
  sections: [],
  ...extra,
})
const goal = (extra: Partial<NonNullable<QuoteDepthModel['goal']>> = {}): QuoteDepthModel['goal'] => ({ target: 'line', lineId: L1, lines: [{ id: L1, label: '10 · DEMO-JKT-01 BLK' }, { id: L2, label: '20 · DEMO-JKT-01 RED' }], value: '395', currency: 'EUR', priceBasis: 'NET', grains: GRAINS.owner, preview: GOAL_LINE, state: 'ready', problem: null, readOnly: null, inquiry: { number: 'INQ-2026-0042', targetUnitPrice: '395' }, open: true, ...extra })
const terms = (extra: Partial<NonNullable<QuoteDepthModel['terms']>> = {}): QuoteDepthModel['terms'] => ({ terms: { status: 'ready', value: TERMS }, readOnly: null, draft: { incoterm: 'DAP', place: 'Milano, magazzino demo', shipComplete: true }, saving: null, problem: null, capacityHref: `${PREFIX}/planning/promise?calc=1&quote=${QUOTE_ID}`, lineBase: LINE_BASE, ...extra })
const versionsList = (selected: string[] = []): QuoteDepthModel['versions'] => ({ items: VERSIONS, people: { [PEOPLE.sales]: 'Sara Vendite' }, me: PEOPLE.sales, grains: GRAINS.owner, problem: null, selected })
const DEPOSIT = ACCEPTED_VERSION.deposit!

const c = (id: string, label: string, recordExtra: Partial<DepthRecordDesignModel['record']>, depthExtra: Partial<QuoteDepthModel>, note?: string) => ({ id, label, model: { record: record(recordExtra), depth: depth(depthExtra) }, ...(note ? { note } : {}) })

export const designScreen = defineDesignScreen<DepthRecordDesignModel>({
  screen: 'SCR-035-depth',
  title: 'Quote record in depth: warnings, table view, line drawer, fill by curve, target price, terms in depth, compare (B-W2b-316)',
  view: DepthRecordDesign,
  cases: [
    c('warnings', 'Owner · Lines: Warnings (stops the send, to check, to know)', {}, { linesTop: top() }, 'Each warning in the send dialog\'s words, the lines it names and Fix / Open; the overdue amount is the price grain.'),
    c('warnings-price-only', 'A role with prices only: the overdue amount stays (price grain)', { grains: GRAINS.priceOnly, can: CAN.viewer, quote: ready(withoutCost(QUOTE)) }, { linesTop: top({ warnings: { state: { status: 'ready', value: WARNINGS }, prefix: PREFIX, lineBase: LINE_BASE, price: false } }) }, 'Without the price grain the amount is left out, never 0.'),
    c('warnings-error', 'Warnings could not be read', {}, { linesTop: top({ warnings: { state: { status: 'error' }, prefix: PREFIX, lineBase: LINE_BASE, price: true } }) }),
    c('composer-paste', 'Sales · Add a style: Paste lines, From inquiry', { grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(QUOTE)) }, { linesTop: top() }, 'The composer\'s "Also": Paste lines (SCR-416) and the inquiry the quote came from.'),
    c('table', 'Owner · Table view', {}, { linesTop: top({ view: 'table' }), table: table(QUOTE) }, 'The same lines flat in the list frame; t switches Blocks | Table.'),
    c('table-selected', 'Owner · Table view, two lines selected (bulk actions)', {}, { linesTop: top({ view: 'table' }), table: table(QUOTE, [L1, L2]) }),
    c('table-sales', 'Sales · Table view (no cost column)', { grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(QUOTE)) }, { linesTop: top({ view: 'table' }), table: table(withoutCost(QUOTE), [], null, GRAINS.sales) }),
    c('table-sent', 'Table view of a sent version: actions held with the reason', { quote: ready(SENT) }, { linesTop: top({ view: 'table' }), table: table(SENT, [L1], READ_ONLY_SENT), canFill: false }),
    c('drawer', 'Owner · The line drawer with its delivery schedule', {}, { linesTop: top(), drawer: drawer() }, 'Docked beside the record (?line=): sizes and price, certificate cover, the schedule with the rest at the promise date; ⌘↑ / ⌘↓.'),
    c('drawer-editing', 'The drawer: a schedule being typed, a problem said', {}, { linesTop: top(), drawer: drawer({ rows: [{ key: 'd1', date: '2026-12-02', sizes: { '50': '2', '52': '5' }, note: '' }, { key: 'd2', date: '', sizes: {}, note: '' }] }) }),
    c('drawer-sent', 'The drawer of a sent version: read only', { quote: ready(SENT) }, { linesTop: top(), drawer: drawer({ readOnly: READ_ONLY_SENT, line: SENT.lines[0]! }), canFill: false }),
    c('drawer-loading', 'The drawer while the schedule is read', {}, { linesTop: top(), drawer: drawer({ schedule: { status: 'loading' } }) }),
    c('fill', 'Fill by curve: the curve, the totals, the review', {}, { linesTop: top(), bulk: bulk({ kind: 'fill', curves: { status: 'ready', items: CURVES }, curveId: CURVES[0]!.id, totals: { [L1]: '20', [L2]: '12' }, preview: FILL }) }, 'A style block\'s ⋯ › Fill by curve; the sizes stay editable; the rest on the base size.'),
    c('fill-no-curves', 'Fill by curve without a curve for the scale', {}, { linesTop: top(), bulk: bulk({ kind: 'fill', curves: { status: 'ready', items: [] }, curveId: '', totals: { [L1]: '8', [L2]: '6' }, leadHeld: { key: 'review.held.curve' } }) }),
    c('bulk-price', 'Table · Set price for 2 lines (one held below cost)', {}, { linesTop: top({ view: 'table' }), table: table(QUOTE, [L1, L2]), bulk: bulk({ kind: 'price', value: '395', preview: { ...GOAL_TOTAL, held: [{ lineId: L2, seq: 20, code: 'BELOW_COST' }] } }) }),
    c('bulk-sizes', 'Table · Change sizes +50 % (a line\'s schedule holds it)', {}, { linesTop: top({ view: 'table' }), table: table(QUOTE, [L1, L2]), bulk: bulk({ kind: 'sizes', value: '50', preview: SIZES }) }),
    c('bulk-delivery', 'Table · Set delivery date for 2 lines', {}, { linesTop: top({ view: 'table' }), table: table(QUOTE, [L1, L2]), bulk: bulk({ kind: 'delivery', value: '2026-12-20' }) }),
    c('bulk-done', 'Table · Remove 2 lines: done', {}, { linesTop: top({ view: 'table' }), table: table(QUOTE), bulk: bulk({ kind: 'remove', state: { phase: 'done', results: { [L1]: { ok: true, words: { key: 'review.result.removed' } }, [L2]: { ok: true, words: { key: 'review.result.removed' } } } } }) }),
    c('goal-line', 'Owner · Price & margin: Target price for a line', { tab: 'price' }, { goal: goal() }, 'Discount needed, the margin € (cost grain) and %, the lines under the floor, the totals; the customer\'s target from the inquiry.'),
    c('goal-total', 'Owner · Target price: the quote total (needs approval after)', { tab: 'price' }, { goal: goal({ target: 'total', value: '5333.33', preview: GOAL_TOTAL }) }),
    c('goal-held', 'Target price under cost: Apply held', { tab: 'price' }, { goal: goal({ value: '180', preview: GOAL_HELD }) }),
    c('goal-sales', 'Sales · Target price (margin %, no margin €)', { tab: 'price', grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(QUOTE)) }, { goal: goal({ grains: GRAINS.sales, preview: { ...GOAL_LINE, lines: GOAL_LINE.lines.map((entry) => ({ ...entry, to: { ...entry.to, marginAmount: undefined } })) } }) }),
    c('goal-closed', 'Target price collapsed (design: until opened)', { tab: 'price' }, { goal: goal({ value: '', preview: null, state: 'idle', open: false }) }),
    c('terms', 'Sales · Terms & delivery in depth (draft)', { tab: 'terms', grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(QUOTE)) }, { terms: terms() }, 'Acceptance mode, Check capacity (Planning › Promise dates), Incoterm and place, ship complete, the schedule per line.'),
    c('terms-changed', 'Terms in depth: Incoterm changed, Save delivery terms', { tab: 'terms', grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(QUOTE)) }, { terms: terms({ draft: { incoterm: 'FCA', place: '', shipComplete: false } }) }),
    c('terms-no-deposit', 'Terms in depth: sign and pay held without a deposit', { tab: 'terms', grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(QUOTE)) }, { terms: terms({ terms: { status: 'ready', value: { ...TERMS, depositPct: null } } }) }),
    c('terms-sent', 'Terms in depth of a sent version (ends soon, reminder sent)', { tab: 'terms', quote: ready(SENT) }, { terms: terms({ readOnly: READ_ONLY_SENT, terms: { status: 'ready', value: { ...TERMS, status: 'SENT', editable: false, acceptanceMode: 'SIGN_AND_PAY', validity: { validUntil: '2026-11-01', firmOffer: true, state: 'ENDS_SOON', daysLeft: 3, reminderOn: '2026-10-29', reminderSentAt: '2026-10-29T06:15:00.000Z', expiredAt: null } } } }) }),
    c('terms-no-planning', 'Terms in depth: Check capacity held without the planning right', { tab: 'terms', grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(QUOTE)) }, { terms: terms({ capacityHref: null }) }),
    c('terms-error', 'Terms in depth could not be read', { tab: 'terms' }, { terms: terms({ terms: { status: 'error' } }) }),
    c('versions', 'Versions in the list frame', { tab: 'versions', quote: ready(quote({ currentRevision: 2, current: { revision: 2 } })), versions: { items: VERSIONS, people: { [PEOPLE.sales]: 'Sara Vendite' }, problem: null } }, { versions: versionsList() }),
    c('versions-two', 'Versions: two selected → Compare', { tab: 'versions', quote: ready(quote({ currentRevision: 2, current: { revision: 2 } })) }, { versions: versionsList(VERSIONS.map((entry) => entry.id)) }),
    c('compare', 'Compare versions (SCR-415) over the record', { tab: 'versions', quote: ready(quote({ currentRevision: 2, current: { revision: 2 } })) }, { versions: versionsList(), compare: { from: 1, to: 2, versions: VERSIONS.map((entry) => ({ revision: entry.revision, status: entry.status, sentAt: entry.sentAt })), state: { status: 'ready', value: COMPARED }, noteHeld: null, noteSaving: false, noteDone: false } }),
    c('deposit-finance', 'Finance · Documents: send the pay-online page', { tab: 'documents', me: PEOPLE.finance, grains: GRAINS.finance, can: CAN.finance, quote: ready(ACCEPTED), versions: { items: [ACCEPTED_VERSION], people: {}, problem: null } }, { deposit: { deposit: { id: DEPOSIT.id, status: 'OPEN' }, mayRecord: true, to: 'anna@squadra-fittizia.example.com', confirm: false, sending: false, sent: null, problem: null } }),
    c('deposit-confirm', 'Finance · Send the pay-online page? (confirm)', { tab: 'documents', me: PEOPLE.finance, grains: GRAINS.finance, can: CAN.finance, quote: ready(ACCEPTED), versions: { items: [ACCEPTED_VERSION], people: {}, problem: null } }, { deposit: { deposit: { id: DEPOSIT.id, status: 'OPEN' }, mayRecord: true, to: 'anna@squadra-fittizia.example.com', confirm: true, sending: false, sent: null, problem: null } }),
    c('deposit-sent', 'Finance · The pay-online page sent', { tab: 'documents', me: PEOPLE.finance, grains: GRAINS.finance, can: CAN.finance, quote: ready(ACCEPTED), versions: { items: [ACCEPTED_VERSION], people: {}, problem: null } }, { deposit: { deposit: { id: DEPOSIT.id, status: 'OPEN' }, mayRecord: true, to: 'anna@squadra-fittizia.example.com', confirm: false, sending: false, sent: { to: 'anna@squadra-fittizia.example.com', expiresAt: '2026-11-28T22:59:59.000Z', delivery: 'sent' }, problem: null } }),
    c('deposit-sales', 'Sales · The pay-online page held (finance sends it)', { tab: 'documents', grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(ACCEPTED)), versions: { items: [ACCEPTED_VERSION], people: {}, problem: null } }, { deposit: { deposit: { id: DEPOSIT.id, status: 'OPEN' }, mayRecord: false, to: 'anna@squadra-fittizia.example.com', confirm: false, sending: false, sent: null, problem: null } }),
    c('notice', 'A W2b notice under the record\'s band', {}, { linesTop: top(), notice: { words: { key: 'notice.scheduleSaved', params: { line: '10 · DEMO-JKT-01 BLK' } }, tone: 'success' } }),
  ],
})
