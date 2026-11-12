import { phrase } from '@nexus/factory-domain/insights/words'
import { approvalRow, CAN, GRAINS, PEOPLE, PREFIX, pending } from '../../../sales/quotes/record/fixtures'
import type { TodayItem } from '../../today/model'
import type { TaskDetail, TaskRow } from '../api'
import { rowsOf, type InboxRow } from '../inbox'
import type { BulkLine, InboxViewModel } from '../model'
import type { HistoryLine } from '../../../../shell/panels/approvals/api'

/**
 * SCR-030 — Home › Approvals in depth (B-W2b-307) — the cases the screen's `../fixtures.ts` draws (this file exports no
 * design screen of its own) — made-up data only (PLAN §3.1): invented people, records and numbers.
 * Finance's inbox with every kind in one list: three price changes of the approval engine (Approve 3), a purchase order
 * whose rule signs "Released" with a fresh code, a quote under the margin floor (W1), and the approvals decided on their
 * own page (a change order, an SMV change, an inspection plan version).
 */

const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()
const NOW = at(12, 10, 42)
const COMPANY = '0190f0e2-1111-7000-8000-000000000001'
const id = (n: number) => `0190f0e2-3070-7000-8000-${String(n).padStart(12, '0')}`
const BRUNO = { kind: 'PERSON' as const, id: id(901), name: 'Bruno Esempio', me: false }
const ME = { kind: 'PERSON' as const, id: PEOPLE.finance, name: 'Fiona Conti', me: true }
const words = (en: string, it: string) => ({ en, it })

const task = (n: number, overrides: Partial<TaskRow> = {}): TaskRow => ({
  id: id(n),
  kind: 'PRICE_CHANGE',
  kindLabel: words('Price change', 'Cambio di prezzo'),
  status: 'PENDING',
  summary: `PRICE-DEMO-00${n} · Giacca Demo ${n}: list price 249.00 → 269.00`,
  record: { type: 'PriceListLine', id: id(100 + n) },
  companyId: COMPANY,
  siteId: null,
  requester: { ...BRUNO },
  approver: { kind: 'ROLE', id: id(950), name: 'Finance', me: false },
  rule: { id: id(960), name: 'Price rises over 5 %', sentence: words("Price change: rise over 5 → Finance", "Cambio di prezzo: aumento oltre 5 → Finanza") },
  signatureMeaning: null,
  requireStepUp: false,
  changeSize: words('1 field', '1 campo'),
  facts: [
    { field: 'rise', label: words('rise', 'aumento'), value: '8.0', grain: null },
    { field: 'newPrice', label: words('new price', 'nuovo prezzo'), value: '269.00', grain: 'price' },
    { field: 'currency', label: words('currency', 'valuta'), value: 'EUR', grain: null },
  ],
  requestedAt: at(11, 9 + n),
  dueAt: at(13, 9),
  overdue: false,
  decidedAt: null,
  recheck: 'CURRENT',
  approve: { allowed: true, why: null },
  version: 1,
  ...overrides,
})

const PRICE_1 = task(1)
const PRICE_2 = task(2)
const PRICE_3 = task(3)
const PO = task(4, {
  kind: 'PURCHASE_ORDER',
  kindLabel: words('Purchase order', "Ordine d'acquisto"),
  summary: 'PO-DEMO-0042 to Conceria Esempio: 3 lines, to be sent',
  record: { type: 'PurchaseOrder', id: id(140) },
  rule: { id: id(961), name: 'Orders over 5,000', sentence: words("Purchase order: order value over 5000 → Finance, signed 'Released'", "Ordine d'acquisto: valore dell'ordine oltre 5000 → Finanza, firmato 'Rilasciato'") },
  signatureMeaning: 'RELEASED',
  requireStepUp: true,
  changeSize: words('2 fields', '2 campi'),
  facts: [
    { field: 'orderValue', label: words('order value', "valore dell'ordine"), value: '6120', grain: 'cost' },
    { field: 'currency', label: words('currency', 'valuta'), value: 'EUR', grain: null },
    { field: 'lineCount', label: words('lines', 'righe'), value: 3, grain: null },
    { field: 'supplierStatus', label: words('supplier status', 'stato del fornitore'), value: 'ACTIVE', grain: null },
  ],
  requestedAt: at(10, 15, 30),
  dueAt: at(11, 15, 30),
  overdue: true,
})
const CHANGED = task(5, { summary: 'PRICE-DEMO-005 · Pantalone Demo: list price 189.00 → 199.00', recheck: 'CHANGED', approve: { allowed: false, why: 'It changed since you looked.' }, requestedAt: at(9, 11) })

const HISTORY: HistoryLine[] = [
  { id: id(301), source: 'ApprovalEvent', action: 'REQUESTED', at: at(10, 15, 30), by: BRUNO, words: 'Lines updated after the call with the tannery.', reasonCode: null, meaning: null, taskId: PO.id },
  { id: id(300), source: 'ApprovalEvent', action: 'STALE', at: at(10, 14, 2), by: { kind: 'SYSTEM', id: null, name: 'System', me: false }, words: null, reasonCode: null, meaning: null, taskId: id(399) },
  { id: id(299), source: 'ApprovalEvent', action: 'REQUESTED', at: at(10, 9, 10), by: BRUNO, words: null, reasonCode: null, meaning: null, taskId: id(399) },
]

export const PO_DETAIL: TaskDetail = {
  ...PO,
  changes: [
    { field: 'status', label: words('status', 'stato'), from: 'DRAFT', to: 'SENT', grain: null },
    { field: 'line2Quantity', label: words('line 2 quantity', 'quantità riga 2'), from: '120', to: '140', grain: null },
  ],
  fingerprint: '9f2c4a7be01d55aa31c0e9f4d2b7a611',
  recheckLine: { checkedAt: NOW, words: 'Still current', changed: [] },
  rules: [PO.rule!],
  deciders: [
    { id: PEOPLE.finance, name: 'Fiona Conti' },
    { id: id(902), name: 'Marco Demo' },
  ],
  decided: null,
  withdrawn: null,
  staleAt: null,
  history: HISTORY,
  reject: { allowed: true, why: null },
  withdraw: { allowed: false, why: 'Only the person who asked for this request takes it back.' },
}

const item = (n: number, kind: string, state: string, record: TodayItem['record'], said: { key: string; params: Record<string, string | number | string[]> }, why: string, due: TodayItem['due'] = null): TodayItem => ({
  key: `${kind}:${record.id}`,
  kind,
  state,
  category: 'APPROVAL',
  severity: 'MEDIUM',
  severityWord: 'Medium',
  group: 'TODAY',
  record,
  companyId: COMPANY,
  siteId: null,
  partyId: null,
  sentence: '',
  why: '',
  blocks: null,
  words: { sentence: said, why: { key: why, params: {} }, blocks: null },
  sentenceFigure: null,
  due,
  since: at(11, 8 + n),
  ageDays: 1,
  decide: 'OPEN',
  figures: null,
  condition: `c${n}`,
  actions: { version: 0, verbs: [], assigned: null, acknowledged: null },
})
const ref = (value: ReturnType<typeof phrase>) => ({ key: value.key, params: value.params as Record<string, string | number | string[]> })
const CHANGE_ORDER = item(1, 'CHANGE_ORDER', 'SUBMITTED', { type: 'ChangeOrder', id: id(201), label: 'ECO-DEMO-0007' }, ref(phrase('CHANGE_ORDER.SUBMITTED', { number: 'ECO-DEMO-0007', style: 'GIACCA-DEMO', title: 'Collar 2 mm higher' })), 'why.CHANGE_ORDER.product_changes_approve', { date: '2026-11-14', days: 2, word: 'SOON' })
const SMV = item(2, 'SMV_CHANGE', 'PROPOSED', { type: 'OperationTimeVersion', id: id(202), label: 'CUT v3' }, ref(phrase('SMV_CHANGE.PROPOSED', { code: 'CUT', minutes: '4.25', effectiveDate: '2026-11-16' })), 'why.SMV_CHANGE.product_smv_approve')
const PLAN = item(3, 'PLAN_VERSION', 'SUBMITTED', { type: 'InspectionPlan', id: id(203), label: 'IP-DEMO-003' }, ref(phrase('PLAN_VERSION.SUBMITTED', { code: 'IP-DEMO-003', number: '4' })), 'why.PLAN_VERSION.quality_plans_approve')
const QUOTE = approvalRow({ askedAt: at(11, 16) })

const withHref = (row: InboxRow): InboxRow => ({
  ...row,
  href: row.task ? `${PREFIX}/records/${row.task.record.type}/${row.task.record.id}` : row.quote ? `${PREFIX}/sales/quotes/${row.quote.quoteId}?tab=approval` : row.kind === 'CHANGE_ORDER' ? `${PREFIX}/products/changes?tile=MINE_TO_APPROVE&decide=order:${row.item!.record.id}` : row.kind === 'SMV_CHANGE' ? `${PREFIX}/products/changes?decide=smv:${row.item!.record.id}` : `${PREFIX}/quality/plans/${row.item!.record.id}`,
})
const WAITING_ROWS = rowsOf('waiting', { tasks: [PRICE_1, PRICE_2, PRICE_3, PO, CHANGED], quotes: [QUOTE], items: [CHANGE_ORDER, SMV, PLAN] }).map(withHref)

export function depthModel(overrides: Partial<InboxViewModel> = {}): InboxViewModel {
  return {
    prefix: PREFIX,
    me: PEOPLE.finance,
    grains: GRAINS.finance,
    can: { quotes: CAN.finance, tasks: true, decide: true, today: true, rules: true },
    controls: { view: 'waiting', kind: null, q: '', changed: false, open: null },
    rows: { items: WAITING_ROWS, problem: null },
    counts: { waiting: 9, overdue: 1, mine: 2, decided: 6 },
    changedSinceAsked: 1,
    capped: false,
    companies: { [COMPANY]: 'Demo Pelletteria S.r.l.' },
    asOf: NOW,
    offline: false,
    busy: false,
    notice: null,
    quoteReview: null,
    quoteRejecting: false,
    taskReview: null,
    dialog: null,
    ...overrides,
  }
}

const review = (tab: 'change' | 'context' | 'conversation' | 'history' = 'change', detail: TaskDetail = PO_DETAIL): InboxViewModel['taskReview'] => ({
  id: detail.id,
  detail: { status: 'ready', value: detail },
  history: { allowed: true, now: Date.parse(NOW), read: { status: 'ready', lines: HISTORY, more: false } },
  tab,
})

const PRICE_KEYS = [PRICE_1, PRICE_2, PRICE_3].map((row) => `task:${row.id}`)
const BULK_LINES: BulkLine[] = [
  { key: PRICE_KEYS[0]!, id: PRICE_1.id, version: 1, label: 'PRICE-DEMO-001 · Giacca Demo 1', summary: PRICE_1.summary, leftOut: null },
  { key: PRICE_KEYS[1]!, id: PRICE_2.id, version: 1, label: 'PRICE-DEMO-002 · Giacca Demo 2', summary: PRICE_2.summary, leftOut: null },
  { key: PRICE_KEYS[2]!, id: PRICE_3.id, version: 2, label: 'PRICE-DEMO-003 · Giacca Demo 3', summary: PRICE_3.summary, leftOut: 'inbox.held.changed' },
]

const mineRows = rowsOf('mine', {
  tasks: [
    task(11, { requester: { ...ME }, approver: { kind: 'ROLE', id: id(951), name: 'Purchasing manager', me: false }, approve: { allowed: false, why: 'You asked for this.' } }),
    task(12, { status: 'REJECTED', requester: { ...ME }, decidedAt: at(10, 12), approve: { allowed: false, why: 'Decided.' } }),
  ],
  quotes: [],
  items: [],
}).map(withHref)
const decidedRows = rowsOf('decided', {
  tasks: [task(21, { status: 'APPROVED', decidedAt: at(11, 10), approver: { kind: 'ROLE', id: id(950), name: 'Finance', me: true } }), task(22, { kind: 'PURCHASE_ORDER', kindLabel: words('Purchase order', "Ordine d'acquisto"), summary: 'PO-DEMO-0039 to Conceria Esempio: 1 line, to be sent', status: 'APPROVED', signatureMeaning: 'RELEASED', decidedAt: at(10, 9) })],
  quotes: [approvalRow({ status: 'APPROVED', decidedBy: { id: PEOPLE.finance, name: 'Fiona Conti', you: true }, decidedAt: at(9, 10, 12), mayDecide: false, held: 'NOT_WAITING' })],
  items: [],
}).map(withHref)

export const DEPTH_CASES: readonly { id: string; label: string; model: InboxViewModel; note?: string }[] = [
  { id: 'w2b-307-inbox', label: 'B-W2b-307 · Finance · every request in one inbox', model: depthModel(), note: 'Price changes and a purchase order of the approval engine, a quote (W1), a change order, an SMV change and an inspection plan version (each decided on its own page). The notice: 1 request changed since it was asked.' },
  { id: 'w2b-307-selected', label: 'B-W2b-307 · three price changes ticked: Approve 3', model: depthModel({ selected: PRICE_KEYS, focusRow: 0 }), note: 'Only requests of one kind with no signature may be ticked; the signed purchase order and the rows decided on their own page say why their box is held.' },
  { id: 'w2b-307-bulk', label: 'B-W2b-307 · Approve 3 price changes: each re-read, one left out', model: depthModel({ selected: PRICE_KEYS, dialog: { kind: 'bulk', keys: PRICE_KEYS, lines: BULK_LINES, state: { phase: 'ready' } } }), note: 'Two still current are approved together; the third changed since it was asked and is left out with the reason.' },
  { id: 'w2b-307-bulk-done', label: 'B-W2b-307 · Approve 2: what became of each', model: depthModel({ dialog: { kind: 'bulk', keys: PRICE_KEYS, lines: BULK_LINES, state: { phase: 'done', results: { [PRICE_KEYS[0]!]: { ok: true, words: 'approved' }, [PRICE_KEYS[1]!]: { ok: false, words: 'refusal.STALE' } } } } }) },
  { id: 'w2b-307-review', label: 'B-W2b-307 · the review of a purchase order (Change)', model: depthModel({ controls: { view: 'waiting', kind: null, q: '', changed: false, open: PO.id }, taskReview: review('change') }), note: "Still current · checked 10:42; status DRAFT → SENT and a quantity; the rule that asked; who can decide; Approve as 'Released' (A) and Reject (R)." },
  { id: 'w2b-307-review-context', label: 'B-W2b-307 · the review: Context', model: depthModel({ controls: { view: 'waiting', kind: null, q: '', changed: false, open: PO.id }, taskReview: review('context') }) },
  { id: 'w2b-307-review-conversation', label: 'B-W2b-307 · the review: Conversation', model: depthModel({ controls: { view: 'waiting', kind: null, q: '', changed: false, open: PO.id }, taskReview: review('conversation') }), note: 'In the Office this is the request’s own thread (the record panels of the request).' },
  { id: 'w2b-307-review-history', label: 'B-W2b-307 · the review: History', model: depthModel({ controls: { view: 'waiting', kind: null, q: '', changed: false, open: PO.id }, taskReview: review('history') }) },
  { id: 'w2b-307-sign', label: "B-W2b-307 · Approve as 'Released' (a fresh code)", model: depthModel({ controls: { view: 'waiting', kind: null, q: '', changed: false, open: PO.id }, taskReview: review(), dialog: { kind: 'sign', busy: false, problem: null } }), note: 'The meaning, the version it binds to, a fresh authenticator code.' },
  { id: 'w2b-307-sign-wrong', label: 'B-W2b-307 · the signature: a wrong code', model: depthModel({ controls: { view: 'waiting', kind: null, q: '', changed: false, open: PO.id }, taskReview: review(), dialog: { kind: 'sign', busy: false, problem: 'sign.codeWrong' } }) },
  { id: 'w2b-307-reject', label: 'B-W2b-307 · Reject — a reason and words', model: depthModel({ controls: { view: 'waiting', kind: null, q: '', changed: false, open: PO.id }, taskReview: review(), dialog: { kind: 'reject', busy: false, reasons: { status: 'ready', value: [{ code: 'OVER_BUDGET', labelEn: 'Over budget', labelIt: 'Oltre il budget', needsDetail: false }, { code: 'WRONG_SUPPLIER', labelEn: 'Wrong supplier', labelIt: 'Fornitore sbagliato', needsDetail: false }] } } }) },
  {
    id: 'w2b-307-own',
    label: 'B-W2b-307 · my own request (four eyes, the Owner included)',
    model: depthModel({ controls: { view: 'mine', kind: null, q: '', changed: false, open: PO.id }, rows: { items: mineRows, problem: null }, taskReview: review('change', { ...PO_DETAIL, requester: { ...ME }, approve: { allowed: false, why: 'You asked for this.' }, reject: { allowed: false, why: 'You asked for this.' }, deciders: [{ id: id(902), name: 'Marco Demo' }, { id: id(903), name: 'Lucia Prova' }] }) }),
    note: 'Approve and Reject are held: "You asked for this; Marco Demo or Lucia Prova can approve it."',
  },
  {
    id: 'w2b-307-changed',
    label: 'B-W2b-307 · changed since asked (held)',
    model: depthModel({ controls: { view: 'waiting', kind: null, q: '', changed: false, open: CHANGED.id }, taskReview: { id: CHANGED.id, detail: { status: 'ready', value: { ...PO_DETAIL, ...CHANGED, recheckLine: { checkedAt: NOW, words: 'Changed', changed: [{ field: 'newPrice', label: words('new price', 'nuovo prezzo'), was: '199.00', now: '209.00', grain: 'price' }] }, rules: [CHANGED.rule!] } }, history: null, tab: 'change' } }),
    note: 'The re-check line names what moved; Approve is held until someone asks again.',
  },
  { id: 'w2b-307-filtered', label: 'B-W2b-307 · filtered to one kind', model: depthModel({ controls: { view: 'waiting', kind: 'PRICE_CHANGE', q: '', changed: false, open: null } }) },
  { id: 'w2b-307-changed-filter', label: 'B-W2b-307 · the notice’s link: only the changed ones', model: depthModel({ controls: { view: 'waiting', kind: null, q: '', changed: true, open: null } }) },
  { id: 'w2b-307-mine', label: 'B-W2b-307 · Asked by me', model: depthModel({ controls: { view: 'mine', kind: null, q: '', changed: false, open: null }, rows: { items: mineRows, problem: null }, changedSinceAsked: 0 }), note: 'With the approver and the state.' },
  { id: 'w2b-307-decided', label: 'B-W2b-307 · Decided in the last 7 days', model: depthModel({ controls: { view: 'decided', kind: null, q: '', changed: false, open: null }, rows: { items: decidedRows, problem: null }, changedSinceAsked: 0 }) },
  { id: 'w2b-307-empty', label: 'B-W2b-307 · nothing waits for my yes', model: depthModel({ rows: { items: [], problem: null }, counts: { waiting: 0, overdue: 0, mine: 2, decided: 6 }, changedSinceAsked: 0 }), note: '"Asked by me: 2 waiting · Show".' },
  { id: 'w2b-307-loading', label: 'B-W2b-307 · loading', model: depthModel({ rows: { items: null, problem: null }, counts: { waiting: null, overdue: null, mine: null, decided: null }, asOf: null, changedSinceAsked: 0 }) },
  { id: 'w2b-307-error', label: 'B-W2b-307 · error', model: depthModel({ rows: { items: null, problem: 'problem.read.unavailable' }, counts: { waiting: null, overdue: null, mine: null, decided: null }, changedSinceAsked: 0 }) },
  { id: 'w2b-307-offline', label: 'B-W2b-307 · offline (decisions held)', model: depthModel({ offline: true, controls: { view: 'waiting', kind: null, q: '', changed: false, open: PO.id }, taskReview: review() }), note: '"Offline — decide when back online."' },
  {
    id: 'w2b-307-no-permission',
    label: 'B-W2b-307 · a planner without approvals.view or quotes',
    model: depthModel({ can: { quotes: { view: false, manage: false, approve: false, send: false }, tasks: false, decide: false, today: true, rules: false }, grains: GRAINS.priceOnly, rows: { items: rowsOf('waiting', { tasks: [], quotes: [], items: [CHANGE_ORDER] }).map(withHref), problem: null }, counts: { waiting: 1, overdue: 0, mine: 0, decided: 0 }, changedSinceAsked: 0 }),
    note: 'Only Today’s approvals (decided on their own page); no tick boxes, no Amount; Approval rules is held in ⋯.',
  },
  { id: 'w2b-307-quote', label: 'B-W2b-307 · a quote opens its W1 review here', model: depthModel({ controls: { view: 'waiting', kind: null, q: '', changed: false, open: QUOTE.id }, quoteReview: { id: QUOTE.id, quote: { status: 'ready', value: pending() } } }) },
]

/** The rows of the depth cases (tests read them). */
const inboxRow = (key: string): InboxRow => WAITING_ROWS.find((entry) => entry.key === key)!
export const DEPTH_ROWS = { WAITING_ROWS, PRICE_KEYS, PO: inboxRow(`task:${PO.id}`), CHANGED: inboxRow(`task:${CHANGED.id}`), QUOTE: inboxRow(`quote:${QUOTE.id}`), CHANGE_ORDER: inboxRow(CHANGE_ORDER.key) }
