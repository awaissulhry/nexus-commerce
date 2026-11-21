import { createElement, Fragment } from 'react'
import { CHANGE_WORDS } from '@nexus/factory-domain/order-apply/rules' // op-fx1: the preview's own words
import { Building2, Eye, Lock, ShoppingBag } from 'lucide-react' // F-OP-217: the dock's segments
import { defineDesignScreen, type DesignCase } from '../../../../lib/design/design-screen'
import type { OpenApproval, Order, OrderLine } from '../api' // F-OP-101: OpenApproval
import type { AmendPreview, WorkOrderPlan } from '../api' // F-OP-129: the edit strip's previews
import { newKey, type DraftLine } from '../daily-model'
import { STEP_UP_CLOSED } from '../hooks'
import type { NewOrderModel } from '../new/new-model'
import { NewOrderView } from '../new/view/NewOrderView'
// B-TH-231: the fold's held files.
import { holdFiles, type HeldFile } from '../new/new-files'
import {
  AMEND_PREVIEW,
  AMEND_PREVIEW_PROBLEMS,
  AMENDED_SUMMARY,
  amendmentsFor,
  at,
  BLK,
  BRN,
  COMPANY,
  CANCEL_BLOCKED,
  CANCEL_CHECK,
  CANCEL_CONFIRMED,
  canOf,
  deposit,
  forRole,
  inShell,
  LINE_BLK,
  LINE_RED,
  MANUAL_PREVIEW,
  MANUAL_PROBLEMS,
  NO_AMENDMENTS,
  order,
  PAID,
  PARTY,
  PREFIX,
  SCHEDULE,
  SCHEDULE_NONE,
  SCHEDULE_OVERDUE,
  SCHEDULE_REMADE,
  sdi,
  SENT_LINK,
  SETTLEMENT_OPEN,
  SETTLEMENT_SHIPPED,
  STYLE,
  STYLE_ID,
  STYLE_ROWS,
  TD02,
  TD02_ID,
  TODAY,
  VERSIONS,
  WORK_ORDERS,
  type Role,
} from '../_demo/fixtures'
import { COMPOSER_EMPTY, type OrderRecordModel } from './record-model'
// ---- F-OL-05 (Order LINES lane): the new Lines tab's cases — the draft of my changes, Review and save, two people, Add a style ----
import { addLines, EMPTY_HISTORY, newLineKey, removeLine, setCell, setNewLine, type DraftHistory, type NewLine } from './lines-draft'
import type { LinesTabModel, ReviewState } from './lines-tab-model'
import { serverFiguresOf } from './lines-table' // F-OL-09
// ---- end F-OL-05
import { OrderRecordView } from './view/OrderRecordView'
// ---- B-TH-214: the docked thread the order's cases show (RecordFrame beside every tab) ----
import { dockedThread } from '../../../../lib/record-thread/fixtures'
import { ThreadCase } from '../../../../lib/record-thread/ThreadCase'
// ---- B-TH-256: what points at the order (complaints, returns, planning's re-promise, a gate refusal) ----
import { LINKS_FULL, LINKS_MANAGER, LINKS_NONE, linksModel } from './links/fixtures'
import { BRAND_ALPHA, type BrandFixture } from '../../../../lib/testing/two-brands'
import { useRecordFrame } from '../../../_shared/record-frame/RecordFrame'
// ---- F-OP-217: the dock's scopes in the design screen (the pick band in the one card, General, a work order's notes, All of)
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { designAllOfCustomer, designDockedThread } from '../../../_shared/record-frame/fixtures'
import { ThreadPick, useDockTop, type ThreadChoice } from '../../../_shared/record-thread/ThreadPick'
import { ALL_OF_CUSTOMER_NS } from '../../../_shared/record-thread/all-of-customer/view/AllOfCustomerFeed'
import type { ScopeChoice } from './dock/model'
// ---- end F-OP-217
// B-W2b-380 (XF6:02): cost changed since priced on the lines.
import { CostChangedMark } from '../../_shared/cost-changed/view/CostChangedMark'
import { MARGIN, marginAs } from './margin/fixtures'
// F-SA-232: Overview's made-up production reads.
import { CONFIRMED_READ, FAILED_STATE, LOADING_STATE, NO_WORK_READ, ORDER_FILES, QUALITY_ASKS, QUALITY_READ, ready, WORK_READ } from './overview/fixtures'
// F-OP-113: the work-order rows' acts (a read with each row's version and rights; the acts' model as the container holds it).
import { workActsRead, type WorkRights } from './overview/fixtures'
// T.1 (order PRODUCTION tab): the states the seed lacks (made up), for the Production cases below.
import { ASK_BUYERS, ASKED_BUYERS, ASKS_ANSWERED_BATCH, ASKS_CUSTOMER_PROBLEM, ASKS_ESCALATED, ASKS_OPEN, GATE_ACTS, GATES_READ, GOODS_ALL_HERE, GOODS_MISSING, GOODS_WITH_LEATHER, HOLDS_READ, PROBLEM_READ, promiseMovedOf, READINESS_SHORT, RECEIPT_OPEN, SPEC_READ, STYLE_REPLACED } from './production/fixtures'
import { ROLES } from '../_demo/fixtures'
import { actsCanOf } from '../../../../lib/production/work-order-acts/model'
import { orderHoldOf } from '../../../../lib/production/work-order-acts/model' // F-OO-108: the domain's plan, as the page makes it
import type { ActsDialog, WorkOrderActsModel } from '../../../../lib/production/work-order-acts/use-work-order-acts'
// ---- F-OO-105: the strips' cases — a work order shared with another customer, the deposit the order asked, a Read-only reader ----
import { SHARED_WO_ID } from './overview/fixtures'
import { DEPOSIT_ID } from '../_demo/fixtures'
import { abilitiesOf } from '../model'
import { rolePermissions } from '../../../../shell/design-data'
// ---- end F-OO-105
import type { CreditCustomer, CreditHeld } from './credit/api' // F-OO-106: the order's credit read (made up; no amount)
import type { CancelCheck } from '../api' // F-OO-110: a waiting order's cancel check
// F-OP-114 / F-OP-115: the row's dialogs on a work order read afresh (the production lane's own fixtures).
import { releaseCheck, workOrder as productionWorkOrder } from '../../../production/_shared/fixtures'
import { HOLD_REASONS, PRODUCTION_HOLD_REASONS } from '../../../production/work-orders/daily/demo/fixtures'
import { CUSTOMER_PAUSE, plainHolds } from '../../../production/work-orders/daily/demo/fixtures' // F-OO-109: each work order's pause as read
// F-SA-243: the order's requests (the shared request fixtures) and its production read with Still to do.
import type { OfficeRequest } from '../../../../record-panels/approvals/api' // F-OO-204: the approvals we asked the customer
import { PRODUCTION_READ } from './overview/fixtures'
import { PEOPLE } from './overview/fixtures' // F-OO-133: the overview case draws the real People card
import { HAND_FREE_READ, HAND_NOWORK_READ, HAND_OLD_READ, HAND_PAUSED_READ, HAND_READ } from './overview/fixtures' // F-MS-102
import { HAND_BACK_READ, HAND_QUALITY_READ } from './overview/fixtures' // F-SC-W1: a set back; the floor at Quality check (Ready by hand)
// ---- F-OO-211 / F-OO-213: the order's custom fields beside Order facts (the shared panel and its own design data, SCR-520) ----
import { CustomFieldsPanel, type CustomFieldsModel } from '../../../../record-panels/custom-fields/view/CustomFieldsPanel'
import { designScreen as fieldsScreen } from '../../../../record-panels/custom-fields/fixtures'
// ---- end F-OO-211
import { brandRequest } from '../../../home/approvals/requests/fixtures'
import { ORDER_ID } from '../_demo/fixtures'
// F-CP-142: Money's Price check card — the ONE window's made-up check and its states (so/price-check, F-CP-114).
import { PRICE_CHECK, priceWindowOf } from '../price-check/fixtures'
import type { PriceCheckCardModel, PriceCheckRead } from './price-check-card'
// ---- B-W2b-323 (orders in depth on screen) ----
import { APPROVAL_CREDIT, APPROVAL_NOBODY, APPROVAL_PENDING, CHANGES, CHANGES_NONE, CHANGES_WAITING_YES, CONFIRMATION_NONE, CONFIRMATION_OUTDATED, CONFIRMATION_WAITING, depthModel, FREEZE_FINISHED, FREEZE_NONE, MATERIALS_EMPTY, MATERIALS_NOT_PLANNED, orderDepth, PRICED_BLOCKED, pricedOpen } from '../depth/demo/fixtures'

/**
 * SCR-039 — the order studio (design sales.orders "Record: Sales order") with made-up data only: every tab, the states
 * (loading, error, not found, no permission, held with its reason, read-only, closed, cancelled, changed meanwhile), the
 * deposit end to end (asked → bank-details page sent → payment recorded → TD02 issued → SDI) with each dialog and the
 * step-up, and the roles: Owner, Sales (prices and margin %, no cost: S2), Finance (records payments, issues the TD02)
 * and the Production manager (read-only, no money; makes work orders). B-W2a-50: Amend order (the lines as an amendment
 * draft, the review), Close remaining lines and Reopen, Cancel order with its impact and the typed number, Copy as new
 * quote, the payment schedule, the amended band — and a typed New order (the draft studio before "Confirm order").
 */

// ---- B-TH-214: the order's docked thread in the design cases (SCR-039, SCR-107, SCR-039-review-banner) ----------------------------
/**
 * The made-up thread of the order's customer with the Head, the files line and the box, inside the RecordFrame the case draws (whose
 * width menu it drives). Design only: the page mounts the office's OfficeRecordThread docked.
 */
const ORDER_BRAND: BrandFixture = {
  ...BRAND_ALPHA,
  legalName: 'Moto Demo S.r.l.',
  tradeName: 'Moto Demo S.r.l.',
  code: 'MOTO-DEMO',
  contact: { name: 'Giulia Esempio', email: 'ordini@moto-demo.example.com' },
  portalPerson: { name: 'Marta Esempio', email: 'marta@moto-demo.example.com' },
  fileName: 'Moto Demo tech pack AX-100.pdf',
  customerRef: 'PO-ESEMPIO-88',
  message: 'Please keep the yellow piping on the collar of AX-100.',
  numbers: { ...BRAND_ALPHA.numbers, order: 'SO-2026-0088' },
}

function OrderThread() {
  const frame = useRecordFrame()
  const top = useDockTop() // F-OP-217: under a design pick, the band is the card's first (none without one)
  const model = dockedThread(ORDER_BRAND, { width: frame?.width ?? null }, true)
  return createElement(ThreadCase, { model, onWidth: frame?.choose, top })
}

/** The element a design case passes to OrderRecordView as its `thread`. */
export const orderDesignThread = () => createElement(OrderThread)

type RecordCase = { role: Role; record: OrderRecordModel; draft?: undefined; /** F-OP-217: the dock's scope (absent: the order's thread alone). */ dock?: DockScope; /** F-OO-211: the order's custom fields beside Order facts (the panel's own model; absent: none apply). */ customFields?: CustomFieldsModel } | { role: Role; draft: NewOrderModel; record?: undefined; dock?: undefined; customFields?: undefined }

// ---- F-OP-217 (order page plan N4; 11-dock §2, §3, §7): the dock's scopes in SCR-039 — the pick band inside the ONE card on This order,
// <Customer> (general), a work order's notes (office only: its line in the office tone) and All of <Customer> (read only: its Head, the
// compact lines, the foot "Read only. Write in:"). Design only: the page's OrderDock draws the same parts from its reads.
type DockScope = 'order' | 'general' | 'wo' | 'all'
const DESIGN_WO = 'WO-00021'

function DesignDock({ scope, prefix }: { scope: DockScope; prefix: string }) {
  const t = useT('orders')
  const rt = useT('record-thread')
  const customer = ORDER_BRAND.tradeName
  const icon = (Icon: typeof Eye) => createElement(Icon, { size: 14, 'aria-hidden': true })
  const choices: ThreadChoice<ScopeChoice>[] = [
    { value: 'order', label: t('record.dock.order'), icon: icon(ShoppingBag), count: 2, line: t('record.dock.orderLine', { customer }) },
    { value: 'general', label: t('record.dock.general', { customer }), short: t('record.dock.writeGeneral'), icon: icon(Building2), count: 1, line: t('record.dock.generalLine', { customer }) },
    { value: 'workOrders', label: t('record.dock.workOrders'), icon: icon(Lock), tone: 'office', line: t('record.dock.workOrderLine', { wo: DESIGN_WO }) },
    { value: 'all', label: t('record.dock.all', { customer }), short: rt('allOfCustomer.view.all'), title: t('record.dock.readOnly'), icon: icon(Eye), line: rt('allOfCustomer.line', { customer }) },
  ]
  const foot = createElement(
    Fragment,
    null,
    createElement('span', null, `${t('record.dock.readOnly')}. ${t('record.dock.writeIn')}`),
    createElement(Button, { size: 'sm', variant: 'secondary' }, t('record.dock.order')),
    createElement(Button, { size: 'sm', variant: 'secondary' }, t('record.dock.writeGeneral')),
  )
  const shown =
    scope === 'all'
      ? designAllOfCustomer({
          label: `${t('record.dock.all', { customer })} · ${t('record.dock.readOnly')}`,
          prefix,
          customer: { id: '0190f0e2-7a00-7000-8000-0000000000c1', name: customer, code: ORDER_BRAND.code },
          order: { id: ORDER_ID, number: ORDER_BRAND.numbers.order, ownNumber: 12 },
          other: { id: '0190f0e2-7a00-7000-8000-0000000000c2', number: 'SO-2026-0061' },
          at: '2026-11-19T10:30:00.000Z',
          foot,
        })
      : scope === 'general'
        ? designDockedThread({ recordType: 'Party', record: ORDER_BRAND.code, party: { name: customer, role: 'customer' } })
        : scope === 'wo'
          ? designDockedThread({ recordType: 'WorkOrder', record: DESIGN_WO, party: null })
          : orderDesignThread()
  const value: ScopeChoice = scope === 'wo' ? 'workOrders' : scope
  return createElement(WithMessages, { namespaces: [...ALL_OF_CUSTOMER_NS, 'orders'] }, createElement(ThreadPick<ScopeChoice>, { label: t('record.dock.label'), choices, value, children: shown }))
}
// ---- end F-OP-217

const CHAIN_SDI = (code: Parameters<typeof sdi>[0], action: Parameters<typeof sdi>[1], canSend = false) => ({ [TD02_ID]: { value: sdi(code, action, canSend), problem: null } })

export const base = (role: Role, value: Order, over: Partial<OrderRecordModel> = {}): { role: Role; record: OrderRecordModel } => {
  const can = canOf(role)
  return {
    role,
    record: {
      prefix: PREFIX,
      can,
      today: TODAY,
      tab: 'lines',
      order: { status: 'ready', value: forRole(value, role) },
      workOrders: can.viewWorkOrders ? { value: value.chain.workOrders.length > 0 ? WORK_ORDERS : [], problem: null } : null,
      settlement: can.viewInvoices ? { value: forRole(value.status === 'SHIPPED' || value.status === 'CLOSED' ? SETTLEMENT_SHIPPED : SETTLEMENT_OPEN, role), problem: null } : null,
      sdi: can.viewInvoices ? (value.chain.invoices.some((invoice) => invoice.id === TD02_ID) ? CHAIN_SDI('DELIVERED', 'NONE') : {}) : null,
      versions: can.viewQuotes ? { value: VERSIONS, problem: null } : null,
      changed: null,
      notice: null,
      busy: false,
      dialog: null,
      dialogProblem: null,
      sentLink: null,
      recorded: null,
      stepUp: STEP_UP_CLOSED,
      schedule: { value: forRole(value.status === 'CONFIRMED' ? { ...SCHEDULE, steps: SCHEDULE.steps.map((step) => (step.kind === 'DEPOSIT' ? { ...step, status: 'OPEN' as const, paidAt: null } : step)) } : SCHEDULE, role), problem: null },
      amendments: { value: value.amendments.count > 0 ? amendmentsFor(role) : NO_AMENDMENTS, problem: null },
      changeStyles: {},
      cancelCheck: null,
      closedLines: null,
      copied: null,
      ...over,
    },
  }
}

const confirmed = order('CONFIRMED')
const pageSent = order('CONFIRMED', { chain: { ...confirmed.chain, depositRequests: [deposit({ link: SENT_LINK })] } })
const partPaid = order('CONFIRMED', { chain: { ...confirmed.chain, depositRequests: [deposit({ link: SENT_LINK, paidAmount: 100000 })] } })
const paidNotSent = order('CONFIRMED', { chain: { ...confirmed.chain, depositRequests: [PAID], invoices: [TD02] } })
const paidDraft = order('CONFIRMED', { chain: { ...confirmed.chain, depositRequests: [PAID], invoices: [{ ...TD02, number: null, status: 'DRAFT', issueDate: null }] } })
const noTd02 = order('CONFIRMED', { chain: { ...confirmed.chain, depositRequests: [deposit({ fiscalDocument: 'NONE', fiscalRule: 'DEPOSIT_EU_B2B_GOODS', status: 'PAID', paidAt: at(29, 9), paidAmount: 228384, link: SENT_LINK })] } })
const noDeposit = order('CONFIRMED', { depositRequired: false, chain: { ...confirmed.chain, depositRequests: [] } })
const production = order('IN_PRODUCTION')
// ---- F-OO-112 (order overview N13, Owner D1; B-OO-002): Mark ready only after quality released every piece ----
/** The order in production as the API answers it now: quality released 7 of the 14 pieces, so Mark ready is held with the counts. */
const qualityHeld: Order = {
  ...production,
  actions: production.actions.map((action) => (action.action === 'markReady' ? { ...action, allowed: false, held: 'Quality releases the garments: 7 of 14 released. The order turns Ready by itself when all are.' } : action)),
}
/** …and once quality released every piece (the release handler has not moved it yet): Mark ready… is the by-hand catch-up. */
const everyReleased: Order = {
  ...production,
  lines: production.lines.map((line) => ({ ...line, sizes: line.sizes.map((size) => ({ ...size, progress: { ...size.progress, released: size.progress.ordered } })), progress: { ...line.progress, released: line.progress.ordered } })),
  progress: { ...production.progress, released: production.progress.ordered },
}
// ---- end F-OO-112
// ---- F-CP-148: the order's files with two priced documents (made up): named for a price holder, counted (pricedLeftOut) for anyone else.
const PRICED_NAMES = ['Conferma d’ordine SO-2026-0088 v1.pdf', 'Ordine del cliente PO-ESEMPIO-88.pdf'] as const
const PRICED_FILES: typeof ORDER_FILES = {
  ...ORDER_FILES,
  groups: ORDER_FILES.groups.map((group, index) => (index === 0 ? { ...group, files: [...group.files, ...PRICED_NAMES.map((name, n) => ({ ...group.files[0]!, id: `0190f0e2-8181-7000-8000-00000000009${n}`, name, audience: 'OFFICE_ONLY' as const, inThread: null }))], pricedLeftOut: 0 } : group)),
  total: ORDER_FILES.total + PRICED_NAMES.length,
}
const PRICED_LOCKED: typeof ORDER_FILES = { ...ORDER_FILES, groups: ORDER_FILES.groups.map((group, index) => (index === 0 ? { ...group, pricedLeftOut: PRICED_NAMES.length } : group)) }
// ---- end F-CP-148
// ---- F-SA-231b: the order read names each line's artwork files (the chip opens them in the thread's viewer) and, with
// sales.measurements.view, a made-to-measure line's rider (name, garment, revision — never a measurement) ----
const ARTWORK_FILES = [
  { fileId: '0190f0e2-5353-7000-8000-000000000001', name: 'Logo ricamo petto.pdf', contentType: 'application/pdf', sizeBytes: 182_000 },
  { fileId: '0190f0e2-5353-7000-8000-000000000002', name: 'Toppa manica.png', contentType: 'image/png', sizeBytes: 96_000 },
]
const DEMO_RIDER = { profileId: '0190f0e2-5454-7000-8000-000000000001', name: 'Demo Rider Uno', garmentType: 'JACKET', revision: 2 }
const withUnit = (value: Order, rider: OrderLine['rider']): Order => {
  const red = value.lines[value.lines.length - 1]!
  const one = { ordered: 1, inWorkOrders: 1, made: null, released: 0, shipped: 0, invoiced: '0', toShip: 1, closedShort: 0 }
  const unit: OrderLine = { ...red, id: '0190f0e2-7171-7000-8000-000000000030', seq: 30, kind: 'MADE_TO_MEASURE', measurementProfileId: DEMO_RIDER.profileId, baseSize: '52', quantity: 1, netAmount: 61_000, vatAmount: 13_420, sizes: [{ size: null, quantity: 1, unitPrice: null, progress: one }], progress: one, closedShort: null, artwork: [], artworkCount: 0, rider }
  return { ...value, lines: [...value.lines, unit] }
}
const withArtwork = (value: Order): Order => ({ ...value, lines: value.lines.map((line, index) => (index === 0 ? { ...line, artwork: ARTWORK_FILES, artworkCount: ARTWORK_FILES.length } : line)) })
// ---- end F-SA-231b
const shipped = order('SHIPPED')
const settled = order('SHIPPED', { settled: true })
const closed = order('CLOSED', { settled: true, actions: [] })
const cancelled = order('CANCELLED', { actions: [], chain: { ...confirmed.chain, depositRequests: [deposit({ status: 'CANCELLED' })] } })
// B-W2b-16: a typed order (no quote): its deposit's page goes to the customer's invoices contact.
const typed = order('CONFIRMED', { chain: { ...confirmed.chain, quote: null, depositRequests: [deposit({ quoteVersionId: null })] } })

// ---- F-CP-142 (customer page plan C3; picture 21): Money's "Price check" card — made-up checks for each state ----
const priceCard = (read: PriceCheckRead, canHistory = true): Pick<OrderRecordModel, 'priceCheck'> => ({ priceCheck: { read, canHistory } satisfies PriceCheckCardModel })
// F-CP-142 (end-check fix): its own name — `ready` is overview/fixtures' production read, imported above.
const priceReady = (check = PRICE_CHECK, extra: Partial<Extract<PriceCheckRead, { state: 'ready' }>> = {}): PriceCheckRead => ({ state: 'ready', check, stale: false, taking: false, problem: null, ...extra })
const EMPTY_CHECK = {
  ...PRICE_CHECK,
  lines: PRICE_CHECK.lines.map((line) => ({ ...line, brandAmount: null, priceMatch: 'NO_BRAND_PRICE' as const, priceDiff: null, row: null })),
  total: { ...PRICE_CHECK.total, brandPrice: null, priceMatch: 'NO_BRAND_PRICE' as const, priceDiff: null, priceNotEqualLines: 0, priceMissingLines: 3 },
  fromRequest: { requestId: '0190f0e2-5555-7000-8000-000000000087', number: 'RQ-0087', lines: 2 },
}
const CLOSED_CHECK = { ...PRICE_CHECK, status: 'CLOSED', mayWrite: { allowed: false, why: 'closed' } }
// ---- end F-CP-142
const CANCEL_REASONS = [
  { code: 'CUSTOMER_REQUEST', labelIt: 'Richiesta del cliente', labelEn: 'Customer request', needsDetail: false },
  { code: 'LEAD_TIME', labelIt: 'Tempi di consegna', labelEn: 'Lead time', needsDetail: false },
  { code: 'OTHER', labelIt: 'Altro', labelEn: 'Other', needsDetail: true },
]
const WAIVE_STEPS = { can: { manageOrders: true, manageInvoices: true, waive: true }, opening: null, busy: false, problem: null }
const BALANCE = SCHEDULE.steps[1]!
const late = order('IN_PRODUCTION', { promiseDate: '2026-10-24', daysLate: 5 })
// F-SA-232: the band's health is the production read's: an order 5 days past its promise reads Late there too (the shared demo
// read says At risk, for an order still before its promise).
const LATE_READ = { ...WORK_READ, headline: { ...WORK_READ.headline!, health: { code: 'LATE' as const, words: { en: 'Late', it: 'In ritardo' }, computed: 'LATE' as const, raise: null } } }

const RECORDED = {
  payment: { id: '0190f0e2-1717-7000-8000-000000000001', amount: 228384, receivedOn: TODAY, externalRef: 'CRO-0000-ESEMPIO-88' },
  depositRequest: { id: PAID.id, status: 'PAID' },
  depositInvoice: { required: true, invoice: { id: TD02_ID, number: TD02.number, docType: 'TD02', status: 'ISSUED', issueDate: TODAY }, filesPending: false },
}

// ---- B-W2a-50 ---------------------------------------------------------------------------------------------------------

export const amended = (value: Order): Order => ({ ...value, amendments: AMENDED_SUMMARY, reapprovalNeededAt: at(30, 11, 5), customerRef: 'PO-ESEMPIO-88B' })


// ---- F-OL-05 (Order LINES lane): the Lines tab's state for a case — the draft of MY changes, Review and save, Add a style ----
/** The tab's model with nothing typed yet (the style read), changed by `over`. */
export function tabOf(over: Partial<LinesTabModel> = {}): LinesTabModel {
  return { draft: EMPTY_HISTORY.draft, canUndo: false, clashes: [], moved: null, styles: { [STYLE_ID]: STYLE }, unlisted: new Set<string>(), review: null, addStyle: null, addColour: null, askFailed: false, portalGone: false, options: null, saving: false, leaving: false, figures: null, ...over }
}
/** Brown of the demo style as a new row (Add a style / + Add a colour), its pieces typed in the table. */
const BROWN_ROW: NewLine = { key: newLineKey(STYLE_ID, BRN.id), styleId: STYLE_ID, colourwayId: BRN.id, colour: `${BRN.code} · ${BRN.name}`, style: { code: STYLE.code, name: STYLE.name }, sizes: {}, price: '', description: '', note: '' }
/** Three changes: black 50 and 52 one more, red removed, brown new with 50: 2 · 52: 2. */
const threeChanges = (value: Order): DraftHistory => removeLine(blackAndBrown(value), value, LINE_RED)
/** F-OL-09: black 50 and 52 one more, brown new with 50: 2 · 52: 2 — the draft AMEND_PREVIEW answers (its figures). */
const blackAndBrown = (value: Order): DraftHistory => {
  let history = setCell(EMPTY_HISTORY, value, LINE_BLK, '50', 3)
  history = setCell(history, value, LINE_BLK, '52', 3)
  history = addLines(history, value, [BROWN_ROW])
  history = setNewLine(history, BROWN_ROW.key, { size: '50', pieces: 2 })
  return setNewLine(history, BROWN_ROW.key, { size: '52', pieces: 2 })
}
/** Black 50 one more (a cut size: a company rule may freeze it). */
const oneMore50 = (value: Order): DraftHistory => setCell(EMPTY_HISTORY, value, LINE_BLK, '50', 3)
/** Red 52 and 54 one fewer each (6 → 4 pieces). */
const fewerRed = (value: Order): DraftHistory => setCell(setCell(EMPTY_HISTORY, value, LINE_RED, '52', 1), value, LINE_RED, '54', 1)
/** Black 50 one fewer under cut. */
const fewerBlack50 = (value: Order): DraftHistory => setCell(EMPTY_HISTORY, value, LINE_BLK, '50', 1)
/** The Review window with the server's preview of the draft. */
const reviewOf = (preview: AmendPreview | null, over: Partial<ReviewState> = {}): ReviewState => ({ phase: preview ? 'ready' : 'reading', key: 'design', preview, problem: null, why: null, words: '', ask: null, tell: { words: '', chosen: null }, extraOutcome: null, fee: '', changedMeanwhile: false, ...over })
/** The same preview as the API answers it to Sales (no price grain): no prices, no amounts — only "The amount changes". */
const SALES_PREVIEW: AmendPreview = { ...AMEND_PREVIEW, amountChanges: true, diff: AMEND_PREVIEW.diff ? { lines: AMEND_PREVIEW.diff.lines, header: AMEND_PREVIEW.diff.header, prices: [], reacceptanceNeeded: AMEND_PREVIEW.diff.reacceptanceNeeded } : null }
/** A case's tab holding `history` (Undo offered once something was typed). */
const tabWith = (history: DraftHistory, over: Partial<LinesTabModel> = {}): LinesTabModel => tabOf({ draft: history.draft, canUndo: history.undo.length > 0, ...over })
// ---- end F-OL-05

/** A partly shipped order whose red line was closed short (2 pieces of 54 will not be made). */
export const closedShort = (() => {
  const value = order('PARTLY_SHIPPED')
  return {
    ...value,
    lines: value.lines.map((line) => (line.id === LINE_RED ? { ...line, closedShort: { quantity: 2, at: at(30, 16), byId: null, reason: 'Pelle rossa finita: il cliente accetta meno pezzi.', reasonCode: 'CUSTOMER_REQUEST' } } : line)),
    progress: { ...value.progress, closedShort: 2 },
    dailyActions: value.dailyActions.map((entry) => (entry.action === 'reopenLines' ? { ...entry, allowed: true, held: null } : entry)),
  }
})()

const COPIED = { quote: { id: '0190f0e2-4141-7000-8000-000000000201', number: 'QT-2026-00201' }, dropped: [{ seq: 20, size: '56' }], warnings: [] }

/** The typed New order (the draft studio before "Confirm order"). */
function draftCase(role: Role, over: Partial<NewOrderModel> = {}): RecordCase {
  const can = canOf(role)
  return {
    role,
    draft: {
      prefix: PREFIX,
      can,
      today: TODAY,
      header: { companyId: COMPANY, partyId: PARTY.id, contactId: PARTY.contacts[0]!.id, customerRef: 'PO-ESEMPIO-89' },
      party: { status: 'ready', value: PARTY },
      number: 'SO-2026-0089',
      draft: { lines: [], requestedDate: '', promiseDate: '', internalNote: '' },
      styles: {},
      composer: COMPOSER_EMPTY,
      preview: { phase: 'idle', value: null, problem: null },
      busy: false,
      problem: null,
      ...over,
    },
  }
}
const TYPED: DraftLine[] = [
  { key: newKey(STYLE_ID, BLK.id), lineId: null, styleId: STYLE_ID, colourwayId: BLK.id, sizes: { '48': 2, '50': 2, '52': 2, '54': 2 }, price: '', locked: false },
  { key: newKey(STYLE_ID, BRN.id), lineId: null, styleId: STYLE_ID, colourwayId: BRN.id, sizes: { '50': 2, '52': 2 }, price: '430', locked: false },
]
const typedDraft = { lines: TYPED, requestedDate: '2026-12-01', promiseDate: '2026-12-08', internalNote: 'Etichetta del cliente sulle giacche.' }
// B-TH-231: the customer's files held in the new order (made up).
const HELD: HeldFile[] = holdFiles(
  [],
  [
    { name: 'Rider sheet (made up).pdf', type: 'application/pdf', size: 320_000 },
    { name: 'Collar detail.jpg', type: 'image/jpeg', size: 2_100_000 },
    { name: 'Logo.ai', size: 4_200_000 },
    { name: 'logo.svg', type: 'image/svg+xml', size: 12_000 },
  ],
  (index) => `held-${index}`,
).held.map((file, index): HeldFile => (index === 0 ? { ...file, sheet: true } : file))

// ---- B-W2b-323 ----
const waitingOrder = order('CONFIRMED', { status: 'PENDING_APPROVAL' })
// ---- F-OP-101: the order read's open yes (B-OP-020: the engine's rows) — for an approver who did not ask, for the asker, for others ----
const OWN_WORDS = 'You asked for this: nobody approves their own request, the Owner included. Marco Demo can approve it.'
const YES_TASK: OpenApproval = {
  taskId: '0190f0e2-9595-7000-8000-000000000001',
  kind: 'SALES_ORDER',
  kindLabel: { en: 'Sales order', it: 'Ordine di vendita' },
  requestedAt: '2026-11-18T09:30:00Z',
  requester: { name: 'Luca Prova', me: false },
  approver: { kind: 'ROLE', name: 'Finance', me: false },
  version: 1,
  requireStepUp: false,
  approve: { allowed: true, why: null },
  reject: { allowed: true, why: null },
  withdraw: { allowed: false, why: 'Only the person who asked for this request takes it back.' },
}
const YES_SELF_ASKED: OpenApproval = { ...YES_TASK, requester: { name: 'Giulia Esempio', me: true }, approve: { allowed: false, why: OWN_WORDS }, reject: { allowed: false, why: OWN_WORDS }, withdraw: { allowed: true, why: null } }
const YES_OTHERS: OpenApproval = { ...YES_TASK, approve: { allowed: false, why: 'This request waits for another approver: it is not addressed to you or to a role you hold over its company.' }, reject: { allowed: false, why: 'This request waits for another approver: it is not addressed to you or to a role you hold over its company.' } }
const APPROVAL_ASKED_BY_OTHER = { ...APPROVAL_PENDING, requests: APPROVAL_PENDING.requests.map((request) => ({ ...request, mine: false, requestedBy: 'Luca Prova' })), may: { ask: false, withdraw: false } }
const REFUSE_REASONS = [
  { code: 'PRICE', labelEn: 'Price below the agreed list', labelIt: 'Prezzo sotto il listino concordato', needsDetail: false },
  { code: 'TERMS', labelEn: 'Payment terms not agreed', labelIt: 'Condizioni di pagamento non concordate', needsDetail: false },
]
// ---- end F-OP-101
const d323 = (role: Role, value: Order, over: Partial<OrderRecordModel> = {}, depth: Parameters<typeof depthModel>[1] = {}): RecordCase => base(role, value, { ...over, depth: depthModel(role, depth) })
const frozenPreview = { ok: false, revision: 4, version: 7, problems: [{ path: 'body/lines/10/SIZE_QUANTITY', message: 'x' }], diff: null, workOrders: null }
/** F-CP-149: a case as a reader without the price grain (the Sales role since B-CP-011): no price, no margin, no cost. */
const noPrice = (item: RecordCase): RecordCase => (item.record ? { ...item, record: { ...item.record, can: { ...item.record.can, price: false, margin: false, cost: false } } } : item)
// B-CP-011 (the money wall, Owner O1; follow-up 17): the order as the real Sales role reads it (no price, no margin). An edit mode
// starts from what its reader reads: a draft made from the priced order would differ from Sales' order in every price (the bar
// counted changes nobody typed, the review read as stale). A case that types or shows prices is the Owner's.
const asSales = (value: Order): Order => forRole(value, 'sales')
const W2B_323 = [
  { id: 'w2b-323-lines', label: 'W2b · Sales · Lines: urgent with its reason, season FW27, confirmation v2 sent; black 48 · 50 locked “Cutting started — size frozen”; Customer-supplied materials', model: d323('sales', production), note: 'The materials grid links each lot and the receipt that brought it; Plan from the BOM makes the rows.' },
  { id: 'w2b-323-materials-empty', label: 'W2b · Sales · Customer-supplied materials: the customer supplies nothing', model: d323('sales', production, {}, { materials: { value: MATERIALS_EMPTY, problem: null }, freeze: { value: FREEZE_NONE, problem: null } }) },
  { id: 'w2b-323-materials-not-planned', label: 'W2b · Sales · Customer-supplied materials: the BOM asks a material the order does not keep yet', model: d323('sales', production, {}, { materials: { value: MATERIALS_NOT_PLANNED, problem: null } }) },
  { id: 'w2b-323-materials-error', label: "W2b · Sales · Customer materials couldn't load (Try again; the rest stays usable)", model: d323('sales', production, {}, { materials: { value: null, problem: 'problem.read.unavailable' } }) },
  { id: 'w2b-323-materials-loading', label: 'W2b · Sales · Customer materials reading', model: d323('sales', production, {}, { materials: { value: null, problem: null } }) },
  { id: 'w2b-323-manager-lines', label: 'W2b · Production manager · Lines: frozen sizes and materials read-only (Plan held)', model: d323('manager', production) },
  // ---- F-OL-05 (Order LINES lane): the company's lock said on the cell before typing; a frozen change is the SAME Review window ----
  { id: 'lines-locked', label: 'Lines · Sales · Black 48 · 50 locked by the company\'s rule (the lock line, the 🔒 on the cell, said before typing)', model: d323('sales', asSales(production), { linesTab: tabOf() }) }, // B-CP-011
  { id: 'lines-review-locked', label: 'Lines · Owner · Review and save: locked by the company\'s rule — the customer is asked (the rule), the change fee optional (0 allowed)', model: d323('owner', production, { linesTab: tabWith(oneMore50(production), { review: reviewOf(frozenPreview as unknown as AmendPreview) }) }) },
  { id: 'lines-review-locked-sales', label: 'Lines · Sales · Review and save, locked: no money anywhere — no fee, the customer is asked (no charge)', model: noPrice(d323('sales', asSales(production), { linesTab: tabWith(oneMore50(asSales(production)), { review: reviewOf(frozenPreview as unknown as AmendPreview) }) })) },
  { id: 'lines-changing', label: 'Lines · Owner · Three changes in place: "was 2" on black 50 and 52, red struck with Put back, brown New — the bar "3 changes not saved"', model: d323('owner', confirmed, { linesTab: tabWith(threeChanges(confirmed)) }) },
  { id: 'lines-review-blocked', label: 'Lines · Sales · Review and save: locked for good (finished pieces) — Save changes held', model: d323('sales', asSales(production), { linesTab: tabWith(oneMore50(asSales(production)), { review: reviewOf(frozenPreview as unknown as AmendPreview) }) }, { freeze: { value: FREEZE_FINISHED, problem: null } }) },
  { id: 'w2b-323-priced', label: 'W2b · Owner · Priced change: one more in 50 priced, the fee, the extra deposit (30 % of the growth), it waits for a yes', model: d323('owner', production, {}, { dialog: { kind: 'priced' }, priced: pricedOpen() }), note: 'The kind lists the caparra penitenziale held: off until the accountant confirms it.' }, // B-CP-011
  { id: 'w2b-323-priced-blocked', label: 'W2b · Owner · Priced change refused: the size cannot change any more', model: d323('owner', production, {}, { dialog: { kind: 'priced' }, priced: pricedOpen(PRICED_BLOCKED) }) }, // B-CP-011
  { id: 'w2b-323-priced-reading', label: 'W2b · Owner · Priced change: pricing', model: d323('owner', production, {}, { dialog: { kind: 'priced' }, priced: { ...pricedOpen(), preview: { phase: 'reading', value: null, problem: null } } }) }, // B-CP-011
  { id: 'w2b-323-changes', label: 'W2b · Sales · Changes: What is frozen beside Priced change requests (waiting for the customer; turned down: Put back)', model: d323('sales', amended(production), { tab: 'changes' }) },
  { id: 'w2b-323-changes-yes', label: 'W2b · Sales · Changes: a change waits for a yes (nothing else is taken meanwhile)', model: d323('sales', amended(production), { tab: 'changes' }, { changes: { value: CHANGES_WAITING_YES, problem: null } }) },
  { id: 'w2b-323-changes-no-rules', label: 'W2b · Sales · Changes: the company keeps no freeze rule; no priced change yet', model: d323('sales', production, { tab: 'changes' }, { freeze: { value: FREEZE_NONE, problem: null }, changes: { value: CHANGES_NONE, problem: null } }) },
  { id: 'w2b-323-changes-manager', label: 'W2b · Production manager · Changes: no money column; Put back held', model: d323('manager', amended(production), { tab: 'changes' }) },
  { id: 'w2b-323-put-back', label: 'W2b · Sales · Put back revision 2 (turned down)', model: d323('sales', amended(production), { tab: 'changes' }, { dialog: { kind: 'putBack', changeId: CHANGES.changes[1]!.id, reason: 'Respinta dall’amministrazione.' } }) },
  { id: 'w2b-323-dates', label: 'W2b · Owner · Production: Production finish forecast per line (6 days to spare; 7 days short) and the milestones', model: d323('owner', production, { tab: 'production', production: ready(WORK_READ) }) },
  { id: 'w2b-323-dates-sales', label: 'W2b · Sales · Production: the forecast (the milestones are the planner’s)', model: d323('sales', production, { tab: 'production', production: ready(WORK_READ) }) },
  // F-SA-234b: the forecast comes with the order's own production read (`dates.forecast`, planning.promise.view): its failure is the
  // read's (production-error), said once; without the promise right the read withholds it and the column says "—".
  { id: 'w2b-323-dates-withheld', label: 'F-SA-234b · Sales · Production: the finish forecast withheld (no promise right): "—" per line, the milestones still there', model: d323('sales', production, { tab: 'production', production: ready({ ...WORK_READ, withheld: ['dates.forecast'], dates: { ...WORK_READ.dates!, forecast: null } }) }) },
  { id: 'w2b-323-documents', label: 'W2b · Sales · Changes: the confirmation (v2, sent) in the PDF viewer; the brand tech pack in force (a newer version)', model: d323('sales', production, { tab: 'changes' }) },
  { id: 'w2b-323-documents-none', label: 'W2b · Sales · Changes: no confirmation yet — Make confirmation', model: d323('sales', production, { tab: 'changes' }, { confirmation: { value: CONFIRMATION_NONE, problem: null }, confirmationPdf: null }) },
  { id: 'w2b-323-documents-outdated', label: 'W2b · Sales · Changes: the order changed since v2 — Make version 3', model: d323('sales', production, { tab: 'changes' }, { confirmation: { value: CONFIRMATION_OUTDATED, problem: null } }) },
  { id: 'w2b-323-documents-error', label: "W2b · Sales · Changes: the confirmation couldn't be read", model: d323('sales', production, { tab: 'changes' }, { confirmation: { value: null, problem: 'problem.read.unavailable' }, confirmationPdf: null }) },
  { id: 'w2b-323-send', label: 'W2b · Sales · Send the confirmation (the one send dialog): to the orders contact, the PDF, the checks', model: d323('sales', production, { tab: 'changes' }, { dialog: { kind: 'send', cc: '', subject: '', message: 'Buongiorno, in allegato la conferma d’ordine.' }, send: { recipient: { name: 'Giulia Esempio', email: 'ordini@moto-demo.example.com' }, pdf: null, result: null } }) },
  { id: 'w2b-323-send-no-recipient', label: 'W2b · Sales · Send held: the customer has no orders contact with an e-mail', model: d323('sales', production, { tab: 'changes' }, { dialog: { kind: 'send', cc: '', subject: '', message: '' }, send: { recipient: null, pdf: null, result: null } }) },
  { id: 'w2b-323-waiting', label: 'W2b · Sales · Waiting for a yes: asked of Finance, you asked (Take the request back); the confirmation waits', model: d323('sales', waitingOrder, { tab: 'changes' }, { approval: { value: APPROVAL_PENDING, problem: null }, depth: { value: orderDepth({ status: 'PENDING_APPROVAL', priority: { level: 'NORMAL', urgentReason: null, number: 0 }, confirmation: { versions: 0, sentAt: null, sentVersion: null } }), problem: null }, confirmation: { value: CONFIRMATION_WAITING, problem: null }, confirmationPdf: null }) },
  { id: 'w2b-323-waiting-nobody', label: 'W2b · Sales · Waiting for a yes, nobody asked yet: Ask for a yes', model: d323('sales', waitingOrder, {}, { approval: { value: APPROVAL_NOBODY, problem: null } }) },
  { id: 'w2b-323-waiting-credit', label: 'W2b · Sales · Waiting: the customer’s credit holds it too (Finance decides; not yours to take back)', model: d323('sales', waitingOrder, {}, { approval: { value: APPROVAL_CREDIT, problem: null } }) },
  { id: 'w2b-323-ask', label: 'W2b · Sales · Ask for a yes (a note for who decides)', model: d323('sales', waitingOrder, {}, { approval: { value: APPROVAL_NOBODY, problem: null }, dialog: { kind: 'ask', note: 'Cliente storico, prezzo concordato con il titolare.' } }) },
  { id: 'w2b-323-priority', label: 'W2b · Sales · Set priority (⋯): Urgent with its reason', model: d323('sales', production, {}, { dialog: { kind: 'priority', level: 'URGENT', reason: 'Il cliente apre il negozio il 1° dicembre.' } }) },
  { id: 'w2b-323-season', label: 'W2b · Sales · Set season (⋯): the open seasons', model: d323('sales', production, {}, { dialog: { kind: 'season', seasonId: '' }, seasons: [{ id: '0190f0e2-5353-7000-8000-000000000001', companyId: COMPANY, code: 'FW27', name: 'Autunno-inverno 2027', startsOn: '2027-07-01', endsOn: '2028-01-31', orderBookClosesOn: '2027-03-31', status: 'OPEN', state: 'OPEN', version: 1 }, { id: '0190f0e2-5353-7000-8000-000000000002', companyId: COMPANY, code: 'SS27', name: 'Primavera-estate 2027', startsOn: '2027-01-15', endsOn: '2027-06-30', orderBookClosesOn: '2026-10-15', status: 'OPEN', state: 'BOOK_CLOSED', version: 2 }] }) },
  // ---- F-OP-101 (10-order-page §2.4): the approver's yes in place; the asker sees it held (rule 42); Refuse… with its reason ----
  { id: 'f-op-101-approver-yes', label: 'F-OP-101 · Owner · Waiting for a yes: asked of Finance by Luca Prova — Confirm the order (primary) and Refuse… here', model: d323('owner', { ...waitingOrder, openApprovals: [YES_TASK] }, { tab: 'overview' }, { approval: { value: APPROVAL_ASKED_BY_OTHER, problem: null } }) },
  { id: 'f-op-101-self-asked', label: 'F-OP-101 · Sales · Waiting for a yes you asked: Confirm the order held ("another person decides"), Take the request back', model: d323('sales', { ...waitingOrder, openApprovals: [YES_SELF_ASKED] }, { tab: 'overview' }, { approval: { value: APPROVAL_PENDING, problem: null } }) },
  { id: 'f-op-101-who-decides', label: 'F-OP-101 · Production manager · Waiting for a yes: not theirs to decide — "Who decides: Finance"', model: d323('manager', { ...waitingOrder, openApprovals: [YES_OTHERS] }, { tab: 'overview' }, { approval: { value: APPROVAL_ASKED_BY_OTHER, problem: null } }) },
  { id: 'f-op-101-refuse', label: 'F-OP-101 · Owner · Refuse… the yes: a reason from the list and words (required)', model: d323('owner', { ...waitingOrder, openApprovals: [YES_TASK] }, { tab: 'overview', dialog: { kind: 'refuseYes', taskId: YES_TASK.taskId }, refuseReasons: { value: REFUSE_REASONS, problem: null }, draft: { reasonCode: 'PRICE', reason: 'Il prezzo è sotto il listino concordato.' } }, { approval: { value: APPROVAL_ASKED_BY_OTHER, problem: null } }) },
  // ---- end F-OP-101
  // B-OP-010: a priced change applies at once (no yes is asked any more).
  { id: 'w2b-323-notice', label: 'W2b · Owner · After the priced change: recorded, applied at once', model: d323('owner', amended(production), { tab: 'changes' }, { notice: { tone: 'success', words: { key: 'notice.priced', params: { revision: 3 } } } }) }, // B-CP-011
]

function OrderDesign({ model }: { model: RecordCase }) {
  if (model.draft) return inShell('/sales/orders/new', createElement(NewOrderView, { model: model.draft }), model.role)
  // F-OP-217: a case may dock a scope of the pick (the order page's dock), else the order's thread alone.
  const thread = model.dock ? createElement(DesignDock, { scope: model.dock, prefix: model.record.prefix }) : orderDesignThread()
  // F-OO-211: a case may give the order's custom fields (drawn by Overview beside Order facts, as the container's RecordCustomFields).
  const customFields = model.customFields ? createElement(CustomFieldsPanel, { model: model.customFields }) : undefined
  return inShell(`/sales/orders/${model.record.order.status === 'ready' ? model.record.order.value.id : 'x'}`, createElement(OrderRecordView, { model: model.record, thread, customFields }), model.role)
}

// ---- F-SA-243: Brand Alpha asks on this order (M 40 → 36); a change accepted yesterday still has a work-order change for planning
// (the reader's turn) and an extra-pieces scrap; the window's door is the order page itself (`?open=`), here a stub of its parts. ----
const ASK = brandRequest(7, {
  kind: 'CHANGE',
  orderId: ORDER_ID,
  orderNumber: 'SO-2026-0088',
  requestedDate: null,
  answeredWith: 'orders.manage',
  answeredIn: 'SALES',
  cells: [{ lineId: LINE_BLK, seq: 10, style: { code: 'JKT-DEMO-01', name: 'Giacca Demo' }, colourway: { code: 'NERO', name: 'Nero' }, size: '50', before: 6, asked: 4, askedColourway: null }],
})
const ASKED_ALSO = brandRequest(8, { ...ASK, id: '0190f0e2-3080-7000-8000-000000000808', askedAt: '2026-11-18T09:00:00Z' })
const ACCEPTED_ASK = brandRequest(9, { ...ASK, id: '0190f0e2-3080-7000-8000-000000000809', status: 'ACCEPTED', waitingOn: null, answeredAt: '2026-11-17T13:02:00Z' })
const STILL_ROWS = [
  { kind: 'WORK_ORDER_CHANGE', ref: { type: 'WorkOrderChange', id: '0190f0e2-9090-7000-8000-000000000001', number: 'WO-00021' }, words: { en: 'WO-00021: make 50 6 → 4', it: 'WO-00021: produci 50 6 → 4' }, since: '2026-11-17T13:02:00Z', waitingOn: 'PLANNER', mayAct: true, requestId: ACCEPTED_ASK.id },
  { kind: 'EXTRA_PIECES', ref: { type: 'WorkOrder', id: '0190f0e2-9090-7000-8000-000000000002', number: 'WO-00021' }, words: { en: 'Scrap the 2 extra pieces of WO-00021, with their approval', it: 'Scarta i 2 pezzi in più di WO-00021, con la loro approvazione' }, since: '2026-11-17T13:02:00Z', waitingOn: 'PLANNER', mayAct: false, requestId: ACCEPTED_ASK.id },
]
// F-OP-301 (walk #1): the read's blockers are the two requests the page reads (the ONE waiting list names what the Changes tab lists).
const askBlocker = (request: typeof ASK) => ({ kind: 'BRAND_REQUEST', on: 'US' as const, words: { en: 'A customer request waits for our answer', it: 'Una richiesta del cliente aspetta la nostra risposta' }, since: request.askedAt, ref: { type: 'OrderChangeRequest', id: request.id }, sub: 'REQUEST' as const })
const STILL_READ = {
  ...PRODUCTION_READ,
  headline: { ...PRODUCTION_READ.headline!, waiting: { ...PRODUCTION_READ.headline!.waiting, since: ASK.askedAt, blockers: [askBlocker(ASK), askBlocker(ASKED_ALSO)] } },
  changes: { openRequests: [{ id: ASK.id, kind: 'CHANGE', status: 'OPEN', since: ASK.askedAt, batchId: null }], stillToDo: { rows: STILL_ROWS, count: STILL_ROWS.length, workOrdersLeftOut: 0 } },
}
const DOOR_STUB = { parts: { window: { review: null, grains: { price: true }, offline: false, nav: { ids: [ASK.id, ASKED_ALSO.id] } }, notice: null, lift: null, can: { lift: true, rush: true } }, hrefOf: (id: string) => `${PREFIX}/sales/orders/${ORDER_ID}?tab=changes&open=${id}` }
const F_SA_243: DesignCase<RecordCase>[] = [
  { id: 'f-sa-243-band', label: 'F-SA-243 · Sales · Overview: the band "Brand Alpha asks: Change · line 10 · 50 6 → 4 · Answer…" (1 more request), Waiting on us · Answer…, Still to do: 2 with its rows', model: base('sales', production, { tab: 'overview', production: ready(STILL_READ), requests: { value: [ASK, ASKED_ALSO, ACCEPTED_ASK], problem: null }, requestDoor: DOOR_STUB, liveState: 'live' }) },
  { id: 'f-sa-243-changes', label: 'F-SA-243 · Sales · Changes: Waiting on us with Answer… (the window here), Still to do under the change of 17 Nov: the work-order change is your turn, the scrap waits for planning', model: base('sales', production, { tab: 'changes', production: ready(STILL_READ), requests: { value: [ASK, ASKED_ALSO, ACCEPTED_ASK], problem: null }, requestDoor: DOOR_STUB, liveState: 'live' }) },
  { id: 'f-sa-243-nothing-mine', label: 'F-SA-243 · Sales · no row asks this reader: no "needs a decision" band (R-5)', model: base('sales', production, { tab: 'changes', production: ready({ ...STILL_READ, headline: { ...STILL_READ.headline, waiting: { ...STILL_READ.headline.waiting, blockers: [] } } /* F-OP-301: no request open */, changes: { openRequests: [], stillToDo: { rows: STILL_ROWS.map((row) => ({ ...row, mayAct: false })), count: 2, workOrdersLeftOut: 1 } } }), requests: { value: [ACCEPTED_ASK], problem: null }, requestDoor: DOOR_STUB, liveState: 'live' }) },
]
// ---- end F-SA-243

// ---- F-OP-301 (walk #1, #2): the walk's two orders in made-up words — "SO-0002": two gates not passed and a change request wait on
// us, a yes we asked waits on the customer (header, card, badge and the Changes tab all say 3 + 1); "SO-0003": nothing waits, while
// the kept state still says "Waiting on us" since 5 days (the header must not say it beside a card that says nothing waits).
// F-OO-202: the gates are dates now (Next dates), so the card, the badge and the Changes tab say 1 + 1. ----
const SO2_REQUEST = brandRequest(21, { ...ASK, id: '0190f0e2-3080-7000-8000-000000000821', askedAt: '2026-11-04T09:00:00Z', note: 'One more black 52 instead of the 54.' })
const blockerOf = (kind: string, on: 'US' | 'BRAND', en: string, since: string, ref: { type: string; id: string } | null, sub: 'REQUEST' | null = null) => ({ kind, on, words: { en, it: `${en} (it)` }, since, ref, sub })
export const SO2_BLOCKERS = [
  blockerOf('GATE', 'US', 'A gate is not passed yet', '2026-11-02T08:00:00Z', { type: 'OrderGate', id: '0190f0e2-6161-7000-8000-000000000001' }),
  blockerOf('GATE', 'US', 'A gate is not passed yet', '2026-11-02T08:00:00Z', { type: 'OrderGate', id: '0190f0e2-6161-7000-8000-000000000002' }),
  blockerOf('BRAND_REQUEST', 'US', 'A customer request waits for our answer', SO2_REQUEST.askedAt, { type: 'OrderChangeRequest', id: SO2_REQUEST.id }, 'REQUEST'),
  // Walk #3: the API names what an approval we asked asks (its kind) — production-read blockerWordsOf.
  blockerOf('APPROVAL', 'BRAND', "Waiting for the customer's yes: Artwork", '2026-11-05T09:00:00Z', { type: 'ApprovalRequest', id: '0190f0e2-6262-7000-8000-000000000001' }),
]
// F-OO-205 (lead note, W03): SO-0002 has one step still to do (planning lowers WO-00021's 54 to 0) — the design screen shows its real
// Changes count, 3 (1 on us, 1 on the customer, 1 still to do), the same as the unit test.
const SO2_STILL = [{ kind: 'WORK_ORDER_CHANGE', ref: { type: 'WorkOrderChange', id: '0190f0e2-9090-7000-8000-000000000021', number: 'WO-00021' }, words: { en: 'WO-00021: make 54 → 0', it: 'WO-00021: produci 54 → 0' }, since: '2026-11-16T09:00:00Z', waitingOn: 'PLANNER', mayAct: false, requestId: null }]
const SO2_READ = { ...PRODUCTION_READ, headline: { ...PRODUCTION_READ.headline!, waiting: { on: 'BRAND' as const, words: { en: 'Waiting on customer', it: 'Tocca al cliente' }, since: '2026-11-05T09:00:00Z', blockers: SO2_BLOCKERS } }, changes: { openRequests: [], stillToDo: { rows: SO2_STILL, count: SO2_STILL.length, workOrdersLeftOut: 0 } } }
const SO3_READ = { ...PRODUCTION_READ, headline: { ...PRODUCTION_READ.headline!, waiting: { on: 'US' as const, words: { en: 'Waiting on us', it: 'Tocca a noi' }, since: '2026-11-14T17:00:00Z', blockers: [] } }, changes: { openRequests: [], stillToDo: { rows: [], count: 0, workOrdersLeftOut: 0 } } }
// F-OP-304 (walk #7): line 10 cut one piece beyond what its first size now wants. F-OO-121: in the API's words since B-OO-015.
const EXTRA_READ = {
  ...SO2_READ,
  changes: { openRequests: [], stillToDo: { rows: [], count: 0, workOrdersLeftOut: 0 } }, // F-OO-205: no step left (SO-0002's own is not here)
  lines: PRODUCTION_READ.lines!.map((line, index) => (index === 0 ? { ...line, madeExtra: 1, sizes: line.sizes.map((size, at) => (at === 0 ? { ...size, madeExtra: 1, madeExtraWords: { en: `Size ${size.size ?? ''}: 1 more than ordered (cut or planned to cut)`, it: `Taglia ${size.size ?? ''}: 1 in più dell'ordine (tagliati o da tagliare)` } /* the API's MADE_EXTRA_WORDS, word for word */ } : size)) } : line)),
}
const F_OP_301: DesignCase<RecordCase>[] = [
  { id: 'f-op-301-so2-overview', label: 'F-OP-301 · Production manager · Overview: Waiting on us 1 (a change request), on the customer 1, Still to do 1 — "Changes (3) ›", the badge\'s number (F-OO-205); the two gates are dates (F-OO-202)', model: base('manager', production, { tab: 'overview', production: ready(SO2_READ), requests: { value: [SO2_REQUEST], problem: null }, requestDoor: DOOR_STUB, liveState: 'live' }) },
  { id: 'f-op-301-so2-changes', label: 'F-OP-301 · Production manager · Changes: the same request waiting on us, the yes we asked of the customer and the step still to do (never "Nothing waits on the customer"); the gates are not requests (F-OO-202)', model: base('manager', production, { tab: 'changes', production: ready(SO2_READ), requests: { value: [SO2_REQUEST], problem: null }, requestDoor: DOOR_STUB, liveState: 'live' }) },
  { id: 'f-op-301-so3-overview', label: 'F-OP-301 · Production manager · Overview: nothing waits — Requests & changes says so once, and nothing says the kept "Waiting on us · 5 d" (F-OO-103)', model: base('manager', production, { tab: 'overview', production: ready(SO3_READ), requests: null, liveState: 'live' }) },
  { id: 'f-op-301-reading-changes', label: 'F-OP-301 · Changes while the production read is out: both cards read (never "Nothing waits" before it)', model: base('sales', production, { tab: 'changes', production: LOADING_STATE, liveState: 'connecting' }) },
  // F-OP-304 (walk #7): no step left, but pieces of line 10 were made extra — their own list, never rows under "Nothing left to do".
  { id: 'f-op-304-still-extra', label: 'F-OP-304 · Production manager · Changes › Still to do: no step left; "Made extra" lists line 10\'s pieces under its own heading', model: base('manager', production, { tab: 'changes', production: ready(EXTRA_READ), requests: { value: [SO2_REQUEST], problem: null }, requestDoor: DOOR_STUB, liveState: 'live' }) },
]
// ---- end F-OP-301

// ---- F-OO-204 (order overview §5.2, §5.3): the order's requests and changes as one made-up world — Moto Demo's change waits on us
// (said whole: "Change · line 10 · M 40 → 36", 15 d), its agreed counter-offer too, and a problem it reported; our counter-offer on
// line 20 waits on the customer (Open…: the ONE review window), so do the artwork, the sample and the proof we asked (each its own
// question and due day: "Their turn") and a task on its portal; Still to do: four steps. The order's holds (a quality hold, the
// customer's pause on two work orders) and a gate are not requests: Where it is now and Next dates draw them. ----
const rqId = (n: number) => `0190f0e2-3131-7000-8000-${String(n).padStart(12, '0')}`
const rqCell = (seq: 10 | 20, size: string, before: number, asked: number) => ({ ...ASK.cells[0]!, lineId: seq === 10 ? LINE_BLK : LINE_RED, seq, size, before, asked })
const rqCounter = (n: number, state: 'WAITING' | 'AGREED', at: string) => ({ approvalRequestId: rqId(700 + n), at, date: null, fee: null, note: null, priced: false, offer: { en: 'Our counter-offer', it: 'La nostra controproposta' }, state, words: state === 'AGREED' ? { en: 'The customer said yes: accept to carry it out.', it: 'Il cliente ha detto sì: accetta per eseguirla.' } : { en: "Waits for the customer's answer", it: 'Aspetta la risposta del cliente' } })
export const RQ_ASK = brandRequest(31, { ...ASK, id: rqId(31), askedAt: '2026-11-03T09:00:00Z', cells: [rqCell(10, 'M', 40, 36)], note: 'Four fewer M: the shop cut its order.' })
export const RQ_AGREED = brandRequest(32, { ...ASK, id: rqId(32), status: 'COUNTERED', askedAt: '2026-11-08T09:00:00Z', cells: [rqCell(10, 'L', 30, 32)], counter: rqCounter(32, 'AGREED', '2026-11-10T09:00:00Z') })
export const RQ_COUNTERED = brandRequest(33, { ...ASK, id: rqId(33), status: 'COUNTERED', waitingOn: 'CUSTOMER', askedAt: '2026-11-12T09:00:00Z', cells: [rqCell(20, 'L', 2, 3)], counter: rqCounter(33, 'WAITING', '2026-11-13T09:00:00Z') })
const rqAsked = (n: number, kind: OfficeRequest['kind'], question: string, dueAt: string, createdAt: string): OfficeRequest => ({
  id: rqId(600 + n),
  companyId: COMPANY,
  kind,
  record: { type: 'SalesOrder', id: ORDER_ID, words: { it: 'SO-2026-0088', en: 'SO-2026-0088' } },
  party: { id: PARTY.id, name: 'Moto Demo S.r.l.' },
  contactId: null,
  question,
  dueAt,
  status: 'OPEN',
  answer: null,
  withdrawn: null,
  askedBy: 'Carlo Prova',
  createdAt,
  files: [],
  links: [],
  may: { withdraw: true },
  version: 1,
})
export const RQ_ASKED: OfficeRequest[] = [
  rqAsked(1, 'ARTWORK', 'Artwork for the hang tag', '2026-12-02T16:00:00Z', '2026-11-04T09:00:00Z'),
  rqAsked(2, 'SAMPLE', 'The second fit sample of the black jacket', '2026-11-28T16:00:00Z', '2026-11-06T09:00:00Z'),
  rqAsked(3, 'PROOF', 'The print proof of the inner label', '2026-11-30T16:00:00Z', '2026-11-16T09:00:00Z'),
]
const rqBlocker = (kind: string, on: 'US' | 'BRAND', en: string, it: string, since: string, ref: { type: string; id: string; messageId?: string } | null, sub: 'REQUEST' | 'COUNTER' | 'PROBLEM' | null = null) => ({ kind, on, words: { en, it }, since, ref, sub })
export const RQ_BLOCKERS = [
  rqBlocker('GATE', 'US', 'A gate is not passed yet', 'Un controllo non è ancora superato', '2026-11-02T08:00:00Z', { type: 'OrderGate', id: rqId(801) }),
  rqBlocker('BRAND_REQUEST', 'US', 'A customer request waits for our answer', 'Una richiesta del cliente aspetta la nostra risposta', RQ_ASK.askedAt, { type: 'OrderChangeRequest', id: RQ_ASK.id }, 'REQUEST'),
  rqBlocker('APPROVAL', 'BRAND', "Waiting for the customer's yes: Artwork", 'In attesa del sì del cliente: Grafica', RQ_ASKED[0]!.createdAt, { type: 'ApprovalRequest', id: RQ_ASKED[0]!.id }), // walk #3: the API's words (its kind)
  rqBlocker('APPROVAL', 'BRAND', "Waiting for the customer's yes: Sample", 'In attesa del sì del cliente: Campione', RQ_ASKED[1]!.createdAt, { type: 'ApprovalRequest', id: RQ_ASKED[1]!.id }), // walk #3: the API's words (its kind)
  rqBlocker('BRAND_REQUEST', 'US', 'A customer request waits for our answer', 'Una richiesta del cliente aspetta la nostra risposta', '2026-11-10T09:00:00Z', { type: 'OrderChangeRequest', id: RQ_AGREED.id }, 'COUNTER'),
  rqBlocker('APPROVAL', 'BRAND', "Waiting for the customer's yes", 'Aspetta il sì del cliente', '2026-11-13T09:00:00Z', { type: 'OrderChangeRequest', id: RQ_COUNTERED.id }),
  rqBlocker('BRAND_PAUSE', 'BRAND', 'The customer paused the work', 'Il cliente ha messo in pausa il lavoro', '2026-11-13T15:00:00Z', { type: 'WorkOrder', id: WORK_ORDERS[0]!.id }),
  rqBlocker('BRAND_PAUSE', 'BRAND', 'The customer paused the work', 'Il cliente ha messo in pausa il lavoro', '2026-11-13T15:00:00Z', { type: 'WorkOrder', id: WORK_ORDERS[1]!.id }),
  rqBlocker('QUALITY_HOLD', 'US', 'A quality hold stops the work', 'Un blocco qualità ferma il lavoro', '2026-11-14T08:30:00Z', { type: 'WorkOrder', id: WORK_ORDERS[1]!.id }),
  rqBlocker('BRAND_REQUEST', 'US', 'The customer reported a problem', 'Il cliente ha segnalato un problema', '2026-11-14T11:00:00Z', { type: 'ProductionIssue', id: rqId(802), messageId: rqId(803) }, 'PROBLEM'),
  rqBlocker('PARTNER_TASK', 'BRAND', "An open task on the customer's portal", 'Un compito aperto nel portale del cliente', '2026-11-15T09:00:00Z', { type: 'PartnerTask', id: rqId(804) }),
  rqBlocker('APPROVAL', 'BRAND', "Waiting for the customer's yes: Design proof", 'In attesa del sì del cliente: Bozza del design', RQ_ASKED[2]!.createdAt, { type: 'ApprovalRequest', id: RQ_ASKED[2]!.id }), // walk #3: the API's words (its kind)
]
const rqStill = (n: number, kind: string, ref: { type: string; id: string; number: string | null; version?: number }, en: string, it: string, since: string, waitingOn: string, mayAct: boolean) => ({ kind, ref, words: { en, it }, since, waitingOn, mayAct, requestId: n <= 2 ? RQ_ASK.id : null })
export const RQ_STILL = [
  rqStill(1, 'WORK_ORDER_CHANGE', { type: 'WorkOrderChange', id: rqId(901), number: 'WO-00021' }, 'WO-00021: make 54 → 0', 'WO-00021: produci 54 → 0', '2026-11-14T09:00:00Z', 'PLANNER', false),
  rqStill(2, 'EXTRA_PIECES', { type: 'WorkOrder', id: WORK_ORDERS[0]!.id, number: 'WO-00021' }, 'Scrap the 2 extra pieces of WO-00021, with their approval', 'Scarta i 2 pezzi in più di WO-00021, con la loro approvazione', '2026-11-15T09:00:00Z', 'PLANNER', false),
  rqStill(3, 'WORK_IN_PROGRESS_TASK', { type: 'Task', id: rqId(902), number: null, version: 2 }, 'Tell the floor about the new collar', 'Avvisa il reparto del nuovo collo', '2026-11-16T09:00:00Z', 'SALES', true),
  rqStill(4, 'STYLE_CHANGE', { type: 'Style', id: rqId(903), number: 'DEMO-JKT-01' }, 'Change the collar on DEMO-JKT-01', 'Cambia il collo di DEMO-JKT-01', '2026-11-17T09:00:00Z', 'PRODUCT', false),
]
export const RQ_READ = {
  ...PRODUCTION_READ,
  headline: { ...PRODUCTION_READ.headline!, waiting: { ...PRODUCTION_READ.headline!.waiting, on: 'BRAND' as const, since: RQ_ASK.askedAt, blockers: RQ_BLOCKERS } },
  changes: { openRequests: [{ id: RQ_ASK.id, kind: 'CHANGE', status: 'OPEN', since: RQ_ASK.askedAt, batchId: null }], stillToDo: { rows: RQ_STILL, count: RQ_STILL.length, workOrdersLeftOut: 0 } },
}
/** Nothing waits for an answer, while the order's quality hold and a gate do (Where it is now and Next dates say them). */
const RQ_NONE_READ = { ...RQ_READ, headline: { ...RQ_READ.headline, waiting: { ...RQ_READ.headline.waiting, on: 'US' as const, blockers: RQ_BLOCKERS.filter((row) => row.kind === 'QUALITY_HOLD' || row.kind === 'GATE') } }, changes: { openRequests: [], stillToDo: { rows: [], count: 0, workOrdersLeftOut: 0 } } }
const RQ_DOOR = { ...DOOR_STUB, parts: { ...DOOR_STUB.parts, window: { ...DOOR_STUB.parts.window, nav: { ids: [RQ_ASK.id, RQ_AGREED.id, RQ_COUNTERED.id] } } } }
/** The world's model on a tab (the reader's own rights; the order's requests, the approvals we asked, the review window's door). */
export const requestsWorld = (role: Role, tab: 'overview' | 'changes', read: Parameters<typeof ready>[0] = RQ_READ, over: Partial<OrderRecordModel> = {}) =>
  base(role, production, { tab, production: ready(read), requests: { value: [RQ_ASK, RQ_AGREED, RQ_COUNTERED], problem: null }, askedOfCustomer: { value: RQ_ASKED, problem: null }, requestDoor: RQ_DOOR, liveState: 'live', ...over })
const F_OO_204: DesignCase<RecordCase>[] = [
  { id: 'f-oo-204-changes', label: 'F-OO-204 · Sales · Changes: the head says where the holds and dates are; on us the change (Answer…), the agreed counter-offer, the problem; on the customer our counter-offer (Open…: the ONE review window), what we asked (its question, due day, state); Still to do with its state pills', model: requestsWorld('sales', 'changes') },
  { id: 'f-oo-204-changes-nothing', label: 'F-OO-204 · Sales · Changes: no request waits — said as such (never "Nothing waits": a quality hold and a gate do, on Overview)', model: requestsWorld('sales', 'changes', RQ_NONE_READ, { requests: { value: [], problem: null }, askedOfCustomer: { value: [], problem: null } }) },
]
// ---- end F-OO-204

// ---- F-OO-205 (order overview §5.2): the Requests & changes card — three groups with their counts (every row on us; the customer's
// and Still to do: 3, then "N more on Changes ›"), "Changes (N) ›" in the head, "Told about changes: 4 people" at the foot; nothing to
// answer while a hold and a gate wait; and Read-only (no door). Walk them at 375 / 1440 / 1920, light and dark, the dock open and closed.
const RQ_TOLD = { value: { order: { id: ORDER_ID, number: 'SO-2026-0088' }, people: 4, changes: [{ batchId: rqId(950), messageId: rqId(951), occurredAt: '2026-11-17T13:02:00Z', at: '2026-11-17T13:02:02Z', eventType: 'order_change_request.answered', requestId: RQ_AGREED.id, people: 4, floor: { at: '2026-11-17T13:02:02Z', workOrders: [{ id: WORK_ORDERS[0]!.id, number: 'WO-00021' }], leftOut: 0 }, workshop: { at: null, told: 0, waiting: 0 } }] }, problem: null }
/** Read-only: the order's facts and links, no acting right on the page (the page's own rule, readOnlyOnPage). */
const readOnlyWorld = (read: Parameters<typeof ready>[0] = RQ_READ) => {
  const world = requestsWorld('manager', 'overview', read, { told: RQ_TOLD })
  return { ...world, record: { ...world.record, can: abilitiesOf(rolePermissions('read_only')) } }
}
const F_OO_205: DesignCase<RecordCase>[] = [
  { id: 'f-oo-205-requests', label: 'F-OO-205 · Sales · Overview › Requests & changes: Waiting on us · 3 (each with its door), Waiting on Moto Demo · 5 (3, then "2 more on Changes ›"), Still to do · 4 (3, then "1 more"), "Changes (12) ›", "Told about changes: 4 people"', model: requestsWorld('sales', 'overview', RQ_READ, { told: RQ_TOLD }) },
  { id: 'f-oo-205-nothing', label: 'F-OO-205 · Sales · Overview: no request or change waits — the quality hold and the gate are said where they are (Where it is now, Next dates)', model: requestsWorld('sales', 'overview', RQ_NONE_READ, { requests: { value: [], problem: null }, askedOfCustomer: { value: [], problem: null } }) },
  { id: 'f-oo-205-read-only', label: 'F-OO-205 · Read-only · Overview › Requests & changes: the same rows with their ages, no door (Their turn is words)', model: readOnlyWorld() },
]
// ---- end F-OO-205

// ---- F-OP-129 (order page plan N2, N5, N6; 10-order-page §13 design cases): what the strip says each work order does, per reader
// (Sales: a released one waits; the Owner: both follow, R-4), the extra pieces' outcome under cut, and the Shipments rows — a typed
// number ("No live tracking"), labels, the number held for Sales, a shared shipment and one made elsewhere. The yes in place is
// F-OP-101's (f-op-101-*), the work-order rows' acts F-OP-113's; each case is looked at in light and dark at 375, 1440 and 1920. ----
const RED_ID = production.lines.find((line) => line.id === LINE_RED)!.colourwayId
/** WO-00023: a DRAFT of the red 54 (the demo's two work orders are WO-00021 in progress, WO-00022 released). */
const DRAFT_WO_ID = '0190f0e2-9191-7000-8000-000000000023'
const RELEASED_WAITS = { en: 'WO-00022 is released: production applies the change (a planner or a production manager).', it: 'WO-00022 è rilasciato: la modifica la applica la produzione (un pianificatore o un responsabile di produzione).' }
const RED_DIFF: NonNullable<AmendPreview['diff']> = {
  lines: [{ change: 'CHANGED', lineId: LINE_RED, seq: 20, styleId: STYLE_ID, colourwayId: RED_ID, piecesBefore: 6, piecesAfter: 4, sizes: [{ size: '52', before: 2, after: 1 }, { size: '54', before: 2, after: 1 }], priceChanged: false, textChanged: false }],
  header: [],
  prices: [{ lineId: LINE_RED, unitPrice: null, netBefore: 264000, netAfter: 176000 }],
  netAmountBefore: 624000,
  netAmountAfter: 536000,
  grossAmountBefore: 761280,
  grossAmountAfter: 653920,
  reacceptanceNeeded: true,
}
/** What the work orders do with the red change: WO-00022 (released) follows only for a reader with workorders.manage; the DRAFT always. */
const redPlan = (releasedFollows: boolean): WorkOrderPlan[] => [
  { kind: 'LOWER_TO_ORDER', workOrderId: WORK_ORDERS[1]!.id, number: 'WO-00022', status: 'RELEASED', route: 'LOWER_RELEASED', cells: [{ lineId: LINE_RED, size: '52', from: 2, to: 1, cut: 0 }], extra: 0, appliesNow: releasedFollows, held: releasedFollows ? null : RELEASED_WAITS, reprint: true },
  { kind: 'LOWER_TO_ORDER', workOrderId: DRAFT_WO_ID, number: 'WO-00023', status: 'DRAFT', route: 'SET_DRAFT_CELLS', cells: [{ lineId: LINE_RED, size: '54', from: 2, to: 1, cut: 0 }], extra: 0, appliesNow: true, held: null, reprint: false },
]
const redPreview = (releasedFollows: boolean): AmendPreview => ({ ...AMEND_PREVIEW, diff: RED_DIFF, workOrders: { extra: [], needsOutcome: false, words: null, plan: redPlan(releasedFollows) } })
const OUTCOME_PREVIEW: AmendPreview = {
  ...AMEND_PREVIEW,
  ok: false,
  diff: {
    lines: [{ change: 'CHANGED', lineId: LINE_BLK, seq: 10, styleId: STYLE_ID, colourwayId: BLK.id, piecesBefore: 8, piecesAfter: 7, sizes: [{ size: '50', before: 2, after: 1 }], priceChanged: false, textChanged: false }],
    header: [],
    prices: [{ lineId: LINE_BLK, unitPrice: null, netBefore: 360000, netAfter: 315000 }],
    netAmountBefore: 624000,
    netAmountAfter: 579000,
    grossAmountBefore: 761280,
    grossAmountAfter: 706380,
    reacceptanceNeeded: true,
  },
  workOrders: {
    extra: [{ workOrderSizeId: '0190f0e2-9191-7000-8000-0000000021c1', salesOrderLineId: LINE_BLK, size: '50', count: 1, words: { en: '1 piece of 50 is already cut', it: '1 pezzo della 50 è già tagliato' } }],
    needsOutcome: true,
    words: CHANGE_WORDS.chooseExtra(1), // op-fx1: the API's own words of this view (work-order-plan.ts), as every fixture is an answer it gives
    plan: [{ kind: 'LOWER_TO_ORDER', workOrderId: WORK_ORDERS[0]!.id, number: 'WO-00021', status: 'IN_PROGRESS', route: 'LOWER_RELEASED', cells: [{ lineId: LINE_BLK, size: '50', from: 2, to: 2, cut: 2 }], extra: 1, appliesNow: true, held: null, reprint: true }],
  },
}

type ShipmentRow = Order['chain']['shipments'][number]
const OTHER_ORDER = { id: '0190f0e2-5151-7000-8000-000000000151', number: 'SO-2026-0151', customerRef: 'PO-ESEMPIO-151' }
const THIS_ORDER = { id: ORDER_ID, number: 'SO-2026-0088', customerRef: 'PO-ESEMPIO-88' }
const TYPED_ROW: ShipmentRow = {
  id: '0190f0e2-8181-7000-8000-000000000051',
  number: 'SH-2026-0051',
  status: 'SHIPPED',
  shippedAt: at(18, 9, 0, 11),
  deliveredAt: null,
  version: 3,
  transportBy: 'CARRIER',
  carrier: { code: 'BRT', name: 'BRT' },
  tracking: { number: '0123456789', source: 'TYPED', parcels: [], live: false, url: 'https://vas.brt.example.com/track?n=0123456789' },
  expectedDeliveryAt: null,
  ddt: { number: '151/2026', date: '2026-11-18' },
  mayTypeTracking: { allowed: true, code: null, why: null },
  withheld: [],
  orders: [THIS_ORDER],
  origin: 'NEXUS',
  externalDdt: null,
}
const LABELLED_ROW: ShipmentRow = {
  ...TYPED_ROW,
  id: '0190f0e2-8181-7000-8000-000000000052',
  number: 'SH-2026-0052',
  carrier: { code: 'GLS', name: 'GLS' },
  tracking: { number: null, source: 'PARCELS', parcels: [{ number: 'GLS-778899', url: 'https://gls.example.com/track/GLS-778899' }], live: true },
  ddt: { number: '152/2026', date: '2026-11-19' },
  mayTypeTracking: { allowed: false, code: 'LABELLED', why: null },
}
const SHARED_ROW: ShipmentRow = { ...TYPED_ROW, id: '0190f0e2-8181-7000-8000-000000000053', number: 'SH-2026-0053', tracking: null, orders: [THIS_ORDER, OTHER_ORDER] }
const ELSEWHERE_ROW: ShipmentRow = {
  ...TYPED_ROW,
  id: '0190f0e2-8181-7000-8000-000000000054',
  number: 'SH-2026-0054',
  carrier: { code: null, name: 'Corriere Esempio' },
  tracking: null,
  ddt: null,
  mayTypeTracking: { allowed: true, code: null, why: null },
  origin: 'ELSEWHERE',
  externalDdt: { number: '123/2026', date: '2026-11-17' },
}
const withShipments = (rows: ShipmentRow[]): Order => ({ ...shipped, chain: { ...shipped.chain, shipments: rows } })
const F_OP_129: DesignCase<RecordCase>[] = [
  // ---- F-OL-05: the Review window's production part (was the edit strip): each work order follows now or waits for production ----
  { id: 'lines-review-wo-sales', label: 'Lines · Sales · Review and save: WO-00023 (a draft) follows now; WO-00022 is released — it waits for production, decided on this page', model: base('sales', asSales(production), { linesTab: tabWith(fewerRed(asSales(production)), { review: reviewOf(redPreview(false)) }) }) }, // B-CP-011
  { id: 'lines-review-wo-owner', label: 'Lines · Owner · Review and save: both work orders follow in the click (R-4); WO-00022\'s work sheet is printed again', model: base('owner', production, { linesTab: tabWith(fewerRed(production), { review: reviewOf(redPreview(true)) }) }) },
  { id: 'lines-review-outcome', label: 'Lines · Owner · Review and save under cut: 1 piece of 50 is already cut — "Keep for this customer" picked for you', model: base('owner', production, { linesTab: tabWith(fewerBlack50(production), { review: reviewOf(OUTCOME_PREVIEW, { extraOutcome: 'LEFTOVER' }) }) }) },
  { id: 'lines-review-outcome-none', label: 'Lines · Owner · Review and save under cut, nothing picked yet: Save changes held until its outcome is picked', model: base('owner', production, { linesTab: tabWith(fewerBlack50(production), { review: reviewOf(OUTCOME_PREVIEW) }) }) },
  { id: 'f-op-129-ship-tracking', label: 'F-OP-129 · Owner · Shipments: "BRT, booked by hand" with its typed number, No live tracking and Track ›; GLS labels with their parcel numbers (typing held: labels bought)', model: base('owner', withShipments([TYPED_ROW, LABELLED_ROW]), { tab: 'shipments' }) },
  { id: 'f-op-129-ship-tracking-sales', label: 'F-OP-129 · Sales · Shipments: the typed number read only — "A warehouse person adds tracking"', model: base('sales', withShipments([{ ...TYPED_ROW, mayTypeTracking: { allowed: false, code: 'NO_RIGHT', why: null } }]), { tab: 'shipments' }) },
  { id: 'f-op-129-ship-shared', label: 'F-OP-129 · Owner · Shipments: a shared shipment — "Also carries SO-2026-0151" (its link)', model: base('owner', withShipments([SHARED_ROW, TYPED_ROW]), { tab: 'shipments' }) },
  { id: 'f-op-129-ship-elsewhere', label: 'F-OP-129 · Owner · Shipments: made elsewhere — "Made elsewhere · DDT 123/2026", no Nexus DDT', model: base('owner', withShipments([ELSEWHERE_ROW, TYPED_ROW]), { tab: 'shipments' }) },
]
// ---- end F-OP-129
// ---- F-OP-113 ----
const MANAGE_ALL: WorkRights = { manage: true, release: true, hold: true }
const NO_RIGHTS: WorkRights = { manage: false, release: false, hold: false }
const WORK_ORDERS_IDS = [WORK_ORDERS[0]!.id, WORK_ORDERS[1]!.id] as const
/** T.1: who may ask on the Production tab (threads.post; the note dialog closed). */
const PT_PEOPLE: NonNullable<OrderRecordModel['people']> = { mayAssign: false, mayNote: true, assign: null, note: null }
function woActs(role: keyof typeof ROLES, over: Partial<WorkOrderActsModel> = {}): WorkOrderActsModel {
  // F-OO-108: the Owner reads Quality's holds (the real role holds every right; the design list here names the order page's only).
  return { can: actsCanOf(role === 'owner' ? [...ROLES[role], 'quality.holds.view'] : ROLES[role]), saves: {}, toldAt: {}, dialog: null, reasons: null, split: null, close: CLOSE_NONE, ...over }
}
// ---- end F-OP-113
// ---- F-OP-114 / F-OP-115: a row's dialog on its work order read afresh; the close's model when nothing is open ----
const CLOSE_NONE: WorkOrderActsModel['close'] = { can: { manage: true, reopen: false, costView: false, cost: false }, check: null, dialog: null, busy: false, problem: null, undo: null }
function woDialog(kind: ActsDialog['kind'], value: ReturnType<typeof productionWorkOrder>, over: Partial<ActsDialog> = {}): ActsDialog {
  return { kind, workOrderId: value.id, number: value.number, workOrder: { value, problem: null }, busy: false, problem: null, ...over }
}
const CANCEL_CUT = {
  workOrderId: WORK_ORDERS[0]!.id,
  number: 'WO-00021',
  status: 'IN_PROGRESS',
  version: 7,
  cancellable: false,
  refusal: { en: '8 pieces are cut: lower the work order to the cut instead', it: "8 pezzi sono già tagliati: riduci l'ordine di lavoro al tagliato" },
  cut: { pieces: 8, cells: [{ cellId: '0190f0e2-7a7a-7000-8000-0000000021c1', size: 'M', colourwayId: '0190f0e2-7a7a-7000-8000-0000000000b1', quantity: 4, cut: 4 }, { cellId: '0190f0e2-7a7a-7000-8000-0000000021c2', size: 'L', colourwayId: '0190f0e2-7a7a-7000-8000-0000000000b1', quantity: 4, cut: 4 }] },
  issued: [{ itemId: '0190f0e2-7a7a-7000-8000-0000000000e1', itemColourId: null, label: 'DEMO-LEATHER-BLK', baseUom: 'dm2', quantity: '96.0' }],
  atWorkshop: [],
}
// ---- end F-OP-114 / F-OP-115
// ---- F-OO-102 (order overview §1.2; review F11): "Where it is now" before, after and without production — the headline and the dots
// read ONE state (the domain's officeStripStateOf): waiting for a yes (no dots: none is now; the quiet line says when production
// starts), shipped (every stage done), cancelled at Cutting (no dots; where the work had reached). Light and dark, 375 / 1440 / 1920. ----
const CUT_READ = { ...PRODUCTION_READ, headline: { ...PRODUCTION_READ.headline!, stage: { ...PRODUCTION_READ.headline!.stage!, code: 'CUTTING' as const, words: { en: 'Cutting', it: 'Taglio' } } } }
const F_OO_102: DesignCase<RecordCase>[] = [
  { id: 'f-oo-102-waiting', label: 'F-OO-102 · Sales · Overview of an order waiting for a yes: "Waiting for a yes" and when production starts — no dots (no stage is now)', model: base('sales', waitingOrder, { tab: 'overview', production: ready(CONFIRMED_READ), liveState: 'live' }) },
  { id: 'f-oo-102-shipped', label: 'F-OO-102 · Sales · Overview of a shipped order: "Shipped 20/11/2026", every stage done, "set by the floor and quality"', model: base('sales', shipped, { tab: 'overview', production: ready(), liveState: 'live' }) },
  { id: 'f-oo-102-cancelled', label: 'F-OO-102 · Sales · Overview of a cancelled order: "Cancelled", the work had reached Cutting — no dots', model: base('sales', order('CANCELLED'), { tab: 'overview', production: ready(CUT_READ), liveState: 'live' }) },
]
// ---- end F-OO-102

// ---- F-OO-105 (order overview §1.3; review F1, F8, F13): the strips with their real doors. An order in work: a quality hold on
// WO-00022 (Release on Quality ›), our production hold on WO-00021 (Lift the hold…), the customer's pause on WO-00019 — shared with
// another customer (its own page) — and on one work order this reader does not reach (counted, never named). Seen by the Owner, by
// Sales (Lift held: production does it) and Read-only (the words only). A confirmed order's deposit: Finance records the payment, the
// production manager reads it held beside Money ›. The credit hold's yes for its approver. Five strips: four, then "Show 1 more".
// The yes for its approver, its asker and anyone else: the F-OP-101 cases (on Overview already). Look at 375 / 1440 / 1920, light + dark.
const W105 = (en: string, it: string) => ({ en, it })
const HOLD_BLOCKERS = [
  blockerOf('QUALITY_HOLD', 'US', 'On a quality hold', '2026-11-14T08:30:00Z', { type: 'WorkOrder', id: WORK_ORDERS[1]!.id }),
  blockerOf('NO_MOVE', 'US', 'Production hold', '2026-11-12T09:00:00Z', { type: 'WorkOrder', id: WORK_ORDERS[0]!.id }),
  blockerOf('BRAND_PAUSE', 'BRAND', "Paused at the customer's request", '2026-11-13T09:00:00Z', { type: 'WorkOrder', id: SHARED_WO_ID }),
  blockerOf('BRAND_PAUSE', 'BRAND', "Paused at the customer's request", '2026-11-13T09:00:00Z', null),
]
const holdsRead = (rights: WorkRights, more: ReturnType<typeof blockerOf>[] = []) => {
  const read = workActsRead(rights)
  return {
    ...read,
    headline: {
      ...read.headline!,
      held: true,
      holds: [
        { kind: 'QUALITY' as const, words: W105('Shade difference on the leather', 'Differenza di tonalità della pelle'), since: '2026-11-14' },
        { kind: 'PRODUCTION' as const, words: W105('Leather check with the tannery', 'Verifica della pelle con la conceria'), since: '2026-11-12' },
        { kind: 'BRAND' as const, words: W105("Paused at the customer's request", 'In pausa su richiesta del cliente'), since: '2026-11-13' },
      ],
      waiting: { ...read.headline!.waiting, blockers: [...HOLD_BLOCKERS, ...more] },
    },
    // WO-00021 is on our production hold (its row's ⋯ offers Lift… to who may).
    work: { ...read.work!, workOrders: read.work!.workOrders.map((row) => (row.id === WORK_ORDERS[0]!.id ? { ...row, held: true, status: 'ON_HOLD' } : row)) },
  }
}
const DEPOSIT_READ = { ...CONFIRMED_READ, headline: { ...CONFIRMED_READ.headline!, waiting: { ...CONFIRMED_READ.headline!.waiting, blockers: [blockerOf('DEPOSIT', 'BRAND', 'Deposit not paid yet', '2026-10-28T15:00:00Z', { type: 'DepositRequest', id: DEPOSIT_ID })] } } }
const CREDIT_TASK: OpenApproval = { ...YES_TASK, taskId: '0190f0e2-9595-7000-8000-000000000002', kind: 'CREDIT_OVERRIDE', kindLabel: { en: 'Credit override', it: 'Sblocco fido' } }
const READ_ONLY_PERMISSIONS = rolePermissions('read_only')
/** A case seen by a Read-only person: no right that changes anything on the page (the band's readOnlyOnPage). */
const readOnlyCase = (item: RecordCase): RecordCase => (item.record ? { ...item, record: { ...item.record, can: abilitiesOf(READ_ONLY_PERMISSIONS), workOrderActs: item.record.workOrderActs ? { ...item.record.workOrderActs, can: actsCanOf(READ_ONLY_PERMISSIONS) } : null } } : item)
const F_OO_105: DesignCase<RecordCase>[] = [
  { id: 'f-oo-105-holds', label: 'F-OO-105 · Owner · Overview in work: Quality hold on WO-00022 (Release on Quality ›), Production hold on WO-00021 (Lift the hold…), the customer’s pause on WO-00019 — shared (Open WO-00019 ›) — and on 1 work order outside what you can open', model: base('owner', production, { tab: 'overview', production: ready(holdsRead(MANAGE_ALL)), workOrderActs: woActs('owner'), liveState: 'live' }) },
  { id: 'f-oo-105-holds-sales', label: 'F-OO-105 · Sales · the same holds: Lift the hold… held — production does it (a planner or the production manager)', model: base('sales', production, { tab: 'overview', production: ready(holdsRead(NO_RIGHTS)), workOrderActs: woActs('sales'), liveState: 'live' }) },
  { id: 'f-oo-105-read-only', label: 'F-OO-105 · Read-only · the same holds: the words only — no door, no button', model: readOnlyCase(base('sales', production, { tab: 'overview', production: ready(holdsRead(NO_RIGHTS)), workOrderActs: woActs('sales'), liveState: 'live' })) },
  { id: 'f-oo-105-deposit', label: 'F-OO-105 · Finance · a confirmed order: "Deposit not paid yet · due 04/11/2026" — Record the payment', model: base('finance', confirmed, { tab: 'overview', production: ready(DEPOSIT_READ), liveState: 'live' }) },
  { id: 'f-oo-105-deposit-manager', label: 'F-OO-105 · Production manager · the same deposit: Record the payment held (the finance right) beside Money ›', model: base('manager', confirmed, { tab: 'overview', production: ready(DEPOSIT_READ), liveState: 'live' }) },
  { id: 'f-oo-105-credit', label: 'F-OO-105 · Owner · a credit hold: "Credit hold — waits for Finance’s yes" — Approve: Credit override and Refuse…', model: d323('owner', { ...waitingOrder, openApprovals: [CREDIT_TASK] }, { tab: 'overview' }, { approval: { value: { ...APPROVAL_CREDIT, reasons: [{ reason: 'CREDIT_HOLD' }] }, problem: null } }) }, // F-OO-106: no `waits` (the order read sends none: the yes's read says why)
  { id: 'f-oo-105-more', label: 'F-OO-105 · Owner · five strips (a release held by the credit, the three holds, an open nonconformance): four, then "Show 1 more"', model: base('owner', { ...production, openApprovals: [CREDIT_TASK] }, { tab: 'overview', production: ready(holdsRead(MANAGE_ALL, [blockerOf('NONCONFORMANCE', 'US', 'An open nonconformance', '2026-11-15T10:00:00Z', { type: 'WorkOrder', id: WORK_ORDERS[1]!.id })])), workOrderActs: woActs('owner'), liveState: 'live' }) },
]
// ---- end F-OO-105

// ---- F-OO-106 (order overview §1.3, §1.4; review F8, F16; B-OO-004): the order's own credit hold, decided from its strip. Sales after
// Finance's no (no price grain: the no's words are not sent) — Check credit again, Ask for a yes…; the Owner reads the no's words; the
// approver of an open credit yes — Approve, Refuse…, Check credit again (no Ask beside an open yes), and what a no does; the production
// manager — no credit right: who checks it, in words; the read failed — Try again; the two dialogs, one with "nobody to ask".
// Never an amount. Look at 375 / 1440 / 1920, light + dark.
const CREDIT_CHECK_ID = '0190f0e2-9797-7000-8000-000000000001'
const creditOf = (over: Partial<CreditCustomer> = {}, held: Partial<CreditHeld> = {}): CreditCustomer => ({
  party: { id: '0190f0e2-7a00-7000-8000-0000000000c1', code: 'MOTO-DEMO', name: 'Moto Demo S.r.l.' },
  onHold: false,
  findings: ['OVER_LIMIT', 'OVERDUE'],
  held: { checkId: CREDIT_CHECK_ID, step: 'ORDER', checkedAt: '2026-11-10T09:00:00Z', request: null, lastAnswer: null, ...held },
  may: { checkAgain: true, ask: true },
  ...over,
})
const SAID_NO = { status: 'REJECTED' as const, at: '2026-11-18T10:00:00Z', by: 'Marco Demo' }
/** The yes's read of an order held for credit with no yes open (Finance said no): only the credit hold, nobody asked. */
const APPROVAL_CREDIT_NONE = { ...APPROVAL_CREDIT, reasons: [{ reason: 'CREDIT_HOLD' as const }], creditHold: { checkId: CREDIT_CHECK_ID, requestTaskId: null }, requests: [] }
const creditCase = (role: Role, credit: OrderRecordModel['credit'], over: { readonly open?: boolean; readonly dialog?: OrderRecordModel['dialog'] } = {}): RecordCase =>
  d323(role, { ...waitingOrder, openApprovals: over.open ? [CREDIT_TASK] : [] }, { tab: 'overview', credit, dialog: over.dialog ?? null }, { approval: { value: over.open ? { ...APPROVAL_CREDIT, reasons: [{ reason: 'CREDIT_HOLD' }] } : APPROVAL_CREDIT_NONE, problem: null } })
const F_OO_106: DesignCase<RecordCase>[] = [
  { id: 'f-oo-106-credit-sales', label: 'F-OO-106 · Sales · a credit hold after Finance said no: "Found: Over the limit · Invoices overdue", "Marco Demo said no on 18/11/2026" — Check credit again, Ask for a yes…', model: creditCase('sales', { view: true, record: { value: creditOf({}, { lastAnswer: SAID_NO }), problem: null } }) },
  { id: 'f-oo-106-credit-owner', label: 'F-OO-106 · Owner · the same hold: the no with its words (the price grain), the customer on hold', model: creditCase('owner', { view: true, record: { value: creditOf({ onHold: true, findings: ['OVER_LIMIT', 'ON_HOLD'] }, { lastAnswer: { ...SAID_NO, reason: 'Two invoices are overdue since October' } }), problem: null } }) },
  { id: 'f-oo-106-credit-approver', label: 'F-OO-106 · Owner · a credit yes open for you: Approve, Refuse…, Check credit again — no Ask beside it; "A no leaves it held"', model: creditCase('owner', { view: true, record: { value: creditOf({ may: { checkAgain: true, ask: false } }, { request: { taskId: CREDIT_TASK.taskId, status: 'PENDING', approver: 'Finance', requestedAt: CREDIT_TASK.requestedAt, dueAt: null } }), problem: null } }, { open: true }) },
  { id: 'f-oo-106-credit-manager', label: 'F-OO-106 · Production manager · no credit right: nothing read — "Sales or Finance check the credit again or ask for a yes"', model: creditCase('manager', { view: false, record: null }) },
  { id: 'f-oo-106-credit-failed', label: 'F-OO-106 · Sales · the credit could not be read: said, with Try again', model: creditCase('sales', { view: true, record: { value: null, problem: 'problem.read.unavailable' } }) },
  { id: 'f-oo-106-check-dialog', label: 'F-OO-106 · Sales · Check credit again: what it does — the order confirmed at once, or a yes asked', model: creditCase('sales', { view: true, record: { value: creditOf(), problem: null } }, { dialog: { kind: 'creditCheck' } }) },
  { id: 'f-oo-106-ask-nobody', label: 'F-OO-106 · Sales · Ask for a yes…: nobody to ask — the customer pays, or Finance raises the limit (Ask held)', model: creditCase('sales', { view: true, record: { value: creditOf(), problem: null } }, { dialog: { kind: 'creditAsk', checkId: CREDIT_CHECK_ID, refused: { key: 'where.credit.refused.nobody' } } }) },
]
// ---- end F-OO-106

// ---- F-OO-108 (order overview §1.4, §1.5; B-OO-005, review F13, F16): "Hold the whole order…" in the moves row — the Owner (it holds
// WO-00021; WO-00022 is on hold already, WO-00019 is shared: hold it on its page, 1 outside what you can open, 12 made-to-measure
// units from their own pages), Sales (held: Production does this), nothing in work yet (held, the plan's words), the dialog open on
// the plan and refused because a work order changed since it was read. Look at 375 / 1440 / 1920, light + dark.
const HOLD_READ = workActsRead(MANAGE_ALL)
const HOLD_PLAN = orderHoldOf(HOLD_READ.work!.workOrders, { leftOut: HOLD_READ.work!.workOrdersLeftOut, waitingForYes: false })
const HOLD_UNITS = HOLD_READ.work!.mtm.reduce((sum, group) => sum + group.workOrders, 0)
const NOTHING_READ = { ...CONFIRMED_READ, work: { ...HOLD_READ.work!, workOrders: [], mtm: [], workOrdersLeftOut: 0 } }
const holdOpen = (over: { readonly problem?: { key: string; params?: Record<string, string | number> } | null } = {}) => woActs('owner', { reasons: [...HOLD_REASONS, ...PRODUCTION_HOLD_REASONS], holdOrder: { number: 'SO-2026-0088', plan: HOLD_PLAN, units: HOLD_UNITS, busy: false, problem: over.problem ?? null } })
const F_OO_108: DesignCase<RecordCase>[] = [
  { id: 'f-oo-108-moves', label: 'F-OO-108 · Owner · Overview in work: Mark ready… and Hold the whole order… beside More ▾', model: base('owner', production, { tab: 'overview', production: ready(HOLD_READ), workOrderActs: woActs('owner'), liveState: 'live' }) },
  { id: 'f-oo-108-moves-sales', label: 'F-OO-108 · Sales · Hold the whole order… held — Production does this (a planner or the production manager)', model: base('sales', production, { tab: 'overview', production: ready(workActsRead(NO_RIGHTS)), workOrderActs: woActs('sales'), liveState: 'live' }) },
  { id: 'f-oo-108-nothing', label: 'F-OO-108 · Owner · a confirmed order with no work order yet: Hold the whole order… held — nothing to hold yet', model: base('owner', confirmed, { tab: 'overview', production: ready(NOTHING_READ), workOrderActs: woActs('owner'), liveState: 'live' }) },
  { id: 'f-oo-108-dialog', label: 'F-OO-108 · Owner · Hold the whole order…: the ONE Hold dialog on WO-00021, and what it leaves out — WO-00022 on hold already, WO-00019 shared, 1 not reached, 12 made-to-measure units', model: base('owner', production, { tab: 'overview', production: ready(HOLD_READ), workOrderActs: holdOpen(), liveState: 'live' }) },
  { id: 'f-oo-108-dialog-stale', label: 'F-OO-108 · Owner · the same dialog after WO-00021 changed since it was read: nothing was held, the list read again', model: base('owner', production, { tab: 'overview', production: ready(HOLD_READ), workOrderActs: holdOpen({ problem: { key: 'orders:where.hold.stale', params: { count: 1, numbers: 'WO-00021' } } }), liveState: 'live' }) },
]
// ---- end F-OO-108

// ---- F-OO-109 (order overview §1.3; N5, B-OO-006): ONE Lift for the customer's pause on N work orders — the strip's Lift the
// customer's pause… (the Owner: live; Sales: held, Production does it), the dialog with each one's pause and what stays (a quality
// hold on WO-00022, WO-00019 shared, 1 not reached), the customer told once; refused because one changed meanwhile; still reading.
const PAUSE_BLOCKERS = [
  blockerOf('BRAND_PAUSE', 'BRAND', "Paused at the customer's request", '2026-11-13T09:00:00Z', { type: 'WorkOrder', id: WORK_ORDERS[0]!.id }),
  blockerOf('BRAND_PAUSE', 'BRAND', "Paused at the customer's request", '2026-11-13T09:00:00Z', { type: 'WorkOrder', id: WORK_ORDERS[1]!.id }),
  blockerOf('BRAND_PAUSE', 'BRAND', "Paused at the customer's request", '2026-11-13T09:00:00Z', { type: 'WorkOrder', id: SHARED_WO_ID }),
  blockerOf('BRAND_PAUSE', 'BRAND', "Paused at the customer's request", '2026-11-13T09:00:00Z', null),
]
const pausedRead = (rights: WorkRights) => {
  const read = workActsRead(rights)
  return {
    ...read,
    headline: { ...read.headline!, held: true, holds: [{ kind: 'BRAND' as const, words: W105("Paused at the customer's request", 'In pausa su richiesta del cliente'), since: '2026-11-13' }], waiting: { ...read.headline!.waiting, blockers: PAUSE_BLOCKERS } },
    work: { ...read.work!, workOrders: read.work!.workOrders.map((row) => (row.sharedWithOtherCustomers ? row : { ...row, held: true, status: 'ON_HOLD' })) },
  }
}
const pauseOn = (id: string, number: string, holdId: string, quality = 0) => {
  const holds = plainHolds([{ ...CUSTOMER_PAUSE, id: holdId, workOrderId: id }], quality)
  return { ...holds, workOrder: { ...holds.workOrder, id, number } }
}
const liftOpen = (over: { readonly problem?: { key: string; params?: Record<string, string | number> } | null; readonly reading?: boolean } = {}) =>
  woActs('owner', {
    reasons: [...HOLD_REASONS, ...PRODUCTION_HOLD_REASONS],
    liftMany: {
      kind: 'BRAND',
      workOrders: [
        { id: WORK_ORDERS[0]!.id, number: 'WO-00021', holds: { value: pauseOn(WORK_ORDERS[0]!.id, 'WO-00021', '0190f0e2-5252-7000-8000-000000000021'), problem: null } },
        { id: WORK_ORDERS[1]!.id, number: 'WO-00022', holds: over.reading ? { value: null, problem: null } : { value: pauseOn(WORK_ORDERS[1]!.id, 'WO-00022', '0190f0e2-5252-7000-8000-000000000022', 1), problem: null } },
      ],
      shared: ['WO-00019'],
      notReached: 1,
      busy: false,
      problem: over.problem ?? null,
    },
  })
const F_OO_109: DesignCase<RecordCase>[] = [
  { id: 'f-oo-109-lift', label: 'F-OO-109 · Owner · the customer’s pause on WO-00021 and WO-00022 (and WO-00019 shared, 1 not reached): ONE Lift the customer’s pause…', model: base('owner', production, { tab: 'overview', production: ready(pausedRead(MANAGE_ALL)), workOrderActs: woActs('owner'), liveState: 'live' }) },
  { id: 'f-oo-109-lift-sales', label: 'F-OO-109 · Sales · the same pause: Lift the customer’s pause… held — Production does it', model: base('sales', production, { tab: 'overview', production: ready(pausedRead(NO_RIGHTS)), workOrderActs: woActs('sales'), liveState: 'live' }) },
  { id: 'f-oo-109-lift-dialog', label: 'F-OO-109 · Owner · the ONE lift: each work order’s pause, one reason, all or none; a quality hold stays on WO-00022; WO-00019 on its page; the customer told once', model: base('owner', production, { tab: 'overview', production: ready(pausedRead(MANAGE_ALL)), workOrderActs: liftOpen(), liveState: 'live' }) },
  { id: 'f-oo-109-lift-stale', label: 'F-OO-109 · Owner · the same lift refused: WO-00022 changed since it was read — nothing was lifted, the holds read again', model: base('owner', production, { tab: 'overview', production: ready(pausedRead(MANAGE_ALL)), workOrderActs: liftOpen({ problem: { key: 'orders:where.lift.stale', params: { count: 1, numbers: 'WO-00022' } } }), liveState: 'live' }) },
  { id: 'f-oo-109-lift-reading', label: 'F-OO-109 · Owner · the lift while WO-00022’s holds are still read: Lift held', model: base('owner', production, { tab: 'overview', production: ready(pausedRead(MANAGE_ALL)), workOrderActs: liftOpen({ reading: true }), liveState: 'live' }) },
]
// ---- end F-OO-109

// ---- F-OO-110 (order overview §1.4; N3, B-OO-003): cancel a waiting order — Overview's More ▾ offers Cancel order… (live for Sales)
// and its dialog says the yes asked on it is taken back. Look at 375 / 1440 / 1920, light + dark.
const WAITING_ASKED = { ...waitingOrder, openApprovals: [YES_TASK] }
const CANCEL_WAITING: CancelCheck = { ...CANCEL_CHECK, status: 'PENDING_APPROVAL', impact: { cancellable: true, blocks: [], touches: [], leavesBehind: [] }, leatherCut: [] }
const F_OO_110: DesignCase<RecordCase>[] = [
  { id: 'f-oo-110-waiting', label: 'F-OO-110 · Sales · an order waiting for a yes: More ▾ offers Cancel order… (B-OO-003)', model: base('sales', WAITING_ASKED, { tab: 'overview', production: ready(CONFIRMED_READ), liveState: 'live' }) },
  { id: 'f-oo-110-cancel', label: 'F-OO-110 · Sales · Cancel order… on a waiting order: nothing left behind, "The yes asked on it is taken back"', model: base('sales', WAITING_ASKED, { tab: 'overview', dialog: { kind: 'cancel' }, cancelCheck: { value: CANCEL_WAITING, problem: null } }) },
]
// ---- end F-OO-110

// ---- F-OO-211 (11-design §8.1, §8.2): the order's custom fields are Overview's 7 + 8 pair — beside Order facts (2 equal columns from a
// 720 px Overview, one below); with none, Order facts takes the row; Read-only: the values, no Edit; F-OO-213: someone changed the order
// first (Save again / Discard mine); a closed order holds Edit in words. Look at 375 / 1440 / 1920, dock open and closed, light + dark.
const fieldsOf = (id: string, over: Partial<CustomFieldsModel> = {}): CustomFieldsModel => ({ ...(fieldsScreen.cases.find((item) => item.id === id)!.model as CustomFieldsModel), recordLabel: production.number, ...over })
const FACTS_READ = { tab: 'overview' as const, production: ready({ ...PRODUCTION_READ, people: PEOPLE }), people: { mayAssign: false, mayNote: true, assign: null, note: null }, liveState: 'live' as const }
/** A record case with the order's custom fields beside Order facts (a new order's draft has none). */
const withFields = (item: RecordCase, customFields: CustomFieldsModel): RecordCase => (item.record ? { ...item, customFields } : item)
const F_OO_211: DesignCase<RecordCase>[] = [
  { id: 'f-oo-211-facts-fields', label: 'F-OO-211 · Sales · Overview: Order facts and Custom fields side by side (the 7 + 8 pair) — two not filled, folded; "Customer sees it" on the portal\'s fields', model: withFields(base('sales', production, FACTS_READ), fieldsOf('f-oo-212-folded')) },
  { id: 'f-oo-211-fields-read-only', label: 'F-OO-211 · Read-only · Overview: the custom fields beside Order facts, no Edit', model: withFields(readOnlyCase(base('sales', production, FACTS_READ)), fieldsOf('values', { canEdit: false, readOnly: true })) },
  { id: 'f-oo-213-order-changed', label: 'F-OO-213 · Sales · Overview: someone changed the order first — what was typed stays: Save again, Discard mine', model: withFields(base('sales', production, FACTS_READ), fieldsOf('f-oo-213-record-changed')) },
  { id: 'f-oo-213-closed', label: 'F-OO-213 · Owner · a closed order: its custom fields hold Edit — "its fields no longer change"', model: withFields(base('owner', closed, { tab: 'overview' }), fieldsOf('f-oo-213-final', { recordLabel: closed.number })) },
]
// ---- end F-OO-211

// ---- F-MS-102 (set the stage by hand, 04 §2.2–2.5): "Where it is now" with a stage set by hand — a Planner's door under the dots, the
// row (who, when, why, what the floor says, the office's note) with Change… and Clear…, 9 days old (amber, "check it"), an order no work
// order records yet (as SEED-SO-W39-02), held on a Confirmed order and during the customer's pause, none on a shipped order, held for
// Sales, the row alone for Read-only. The right is production.brand.manage (the health raise's). Look at 375 / 1440 / 1920, light + dark,
// keyboard only: the strip's link, then the door (or Change…, Clear…), then the moves.
const PLANNER_PERMISSIONS = rolePermissions('planner')
const handCan = (permissions: readonly string[]) => ({ stageHand: { can: permissions.includes('production.brand.manage') } })
/** A Planner on the order (production.brand.manage; the demo's `manager` role carries no money, as a planner). */
const plannerCase = (value: Order, over: Partial<OrderRecordModel>) => base('manager', value, { can: abilitiesOf(PLANNER_PERMISSIONS), ...handCan(PLANNER_PERMISSIONS), tab: 'overview', liveState: 'live', ...over })
const noWorkYet = order('IN_PRODUCTION', { chain: { ...production.chain, workOrders: [] } })
const F_MS_102: DesignCase<RecordCase>[] = [
  { id: 'f-ms-door', label: 'F-MS-102 · Planner · In production at Sewing: "Set the stage by hand…" beside the quiet line under the dots', model: plannerCase(production, { production: ready(HAND_FREE_READ) }) },
  { id: 'f-ms-hand', label: 'F-MS-102 · Planner · Sewing set by hand over the floor\'s Preparing: the tag, who, when, why, the floor\'s counts, the office\'s note — Change… Clear…', model: plannerCase(production, { production: ready(HAND_READ) }) },
  // F-SC-W1 (stage control B): Cutting set back below the floor's Quality check (a wrong scan) — it clears when the floor's counts come
  // back to Cutting or pass Quality check.
  { id: 'f-ms-hand-back', label: 'F-SC-W1 · Planner · Cutting set by hand below the floor\'s Quality check (a wrong scan): "it clears by itself when the floor\'s counts come back to Cutting or pass Quality check"', model: plannerCase(production, { production: ready(HAND_BACK_READ) }) },
  { id: 'f-ms-hand-old', label: 'F-MS-102 · Planner · the same, set 9 days ago: the amber rule and tag, "check it"', model: plannerCase(production, { production: ready(HAND_OLD_READ) }) },
  { id: 'f-ms-hand-nowork', label: 'F-MS-102 · Planner · Cutting set by hand on an order no work order records yet (as SEED-SO-W39-02): "it stands until you clear it or the order ships"', model: plannerCase(noWorkYet, { production: ready(HAND_NOWORK_READ) }) },
  { id: 'f-ms-confirmed', label: 'F-MS-102 · Planner · a Confirmed order: the door held — production has not started yet (R4)', model: plannerCase(confirmed, { production: ready(CONFIRMED_READ) }) },
  { id: 'f-ms-paused', label: 'F-MS-102 · Planner · the customer\'s own pause: the door held — lift the pause first (R19)', model: plannerCase(production, { production: ready(HAND_PAUSED_READ) }) },
  { id: 'f-ms-shipped', label: 'F-MS-102 · Planner · a shipped order: every stage done, no door (R5)', model: plannerCase(shipped, { production: ready() }) },
  { id: 'f-ms-sales', label: 'F-MS-102 · Sales · the row, Change… and Clear… held — production does this (a planner or the production manager)', model: base('sales', production, { tab: 'overview', production: ready(HAND_READ), liveState: 'live', ...handCan(rolePermissions('sales')) }) },
  { id: 'f-ms-read-only', label: 'F-MS-102 · Read-only · the row says it, no door', model: readOnlyCase(base('sales', production, { tab: 'overview', production: ready(HAND_READ), liveState: 'live', ...handCan(READ_ONLY_PERMISSIONS) })) },
  // F-SC-W3 (stage control B): Production now's stage bar — a Planner's steps are buttons into the same dialog; Sales reads them as words
  // with one quiet line (production does this).
  { id: 'f-sc-production-steps', label: 'F-SC-W3 · Planner · Production now: every stage but Sewing (what the customer reads) a button into the stage dialog', model: plannerCase(production, { tab: 'production', production: ready(HAND_FREE_READ) }) },
  { id: 'f-sc-production-held', label: 'F-SC-W3 · Sales · Production now: the stages as words, one quiet line — production does this (a planner or the production manager)', model: base('sales', production, { tab: 'production', production: ready(HAND_READ), liveState: 'live', ...handCan(rolePermissions('sales')) }) },
]
// ---- end F-MS-102
// ---- F-MS-103 (set the stage by hand, 04 §3; R3b, R18, R20): the ONE dialog — Set (nothing picked yet), Change… (the reason and note
// pre-filled), "Something else" without a note (Go held), a refusal said inside it (what was typed stays) — and Clear…'s confirm.
// F-SC-W2 (stage control B): a step of the stages clicked opens it with that step picked (back below the floor: told as a correction;
// Ready to ship while quality has not released every piece: the warning); Clear… up to the floor (a set back cleared): the usual notice.
// Keyboard only: Tab, the arrow keys in the radios, Esc, ⌘↵ / Ctrl↵ (no key hint text anywhere).
const F_MS_103: DesignCase<RecordCase>[] = [
  { id: 'f-ms-dialog-set', label: 'F-MS-103 · Planner · Set the stage by hand…: the floor\'s Sewing, what the customer reads (never picked); every other stage ahead or back, Ready to ship warned; the reason, the note; what the customer reads and when', model: plannerCase(production, { production: ready(HAND_FREE_READ), dialog: { kind: 'stageByHand', mode: 'set' } }) },
  { id: 'f-ms-dialog-pick', label: 'F-SC-W2 · Planner · Cutting clicked on the stages (the floor at Sewing): the dialog opens on Cutting — below what the customer reads, told as a correction; it clears when the floor\'s counts come back to Cutting or pass Sewing', model: plannerCase(production, { production: ready(HAND_FREE_READ), dialog: { kind: 'stageByHand', mode: 'set', pick: 'CUTTING' } }) },
  { id: 'f-ms-dialog-ready', label: 'F-SC-W2 · Planner · Ready to ship clicked (the floor at Quality check): "Quality has not released every piece" — a warning, never a hold', model: plannerCase(production, { production: ready(HAND_QUALITY_READ), dialog: { kind: 'stageByHand', mode: 'set', pick: 'READY' } }) },
  { id: 'f-ms-dialog-change', label: 'F-MS-103 · Planner · Change…: Sewing set by hand over the floor\'s Preparing, its reason and note pre-filled; Sewing and the floor\'s Preparing (Clear…) never picked; Cutting picked — told as a correction', model: plannerCase(production, { production: ready(HAND_READ), dialog: { kind: 'stageByHand', mode: 'change', pick: 'CUTTING' } }) },
  { id: 'f-ms-dialog-other', label: 'F-MS-103 · Planner · Change… to "Something else" without a note: Change the stage held — it needs a note', model: plannerCase(production, { production: ready(HAND_READ), dialog: { kind: 'stageByHand', mode: 'change', pick: 'CUTTING' }, draft: { reasonCode: 'OTHER', reason: '' } }) },
  { id: 'f-ms-dialog-refused', label: 'F-MS-103 · Planner · Change… refused: "The stage changed meanwhile: it was read again." — what was typed stays', model: plannerCase(production, { production: ready(HAND_READ), dialog: { kind: 'stageByHand', mode: 'change', refused: { key: 'where.manual.refused' } } }) },
  { id: 'f-ms-clear', label: 'F-MS-103 · Planner · Clear…: back to the floor\'s Preparing — the customer was told Sewing, so it is told the correction after 10 minutes', model: plannerCase(production, { production: ready(HAND_READ), dialog: { kind: 'stageClear' } }) },
  { id: 'f-ms-dialog-production', label: 'F-SC-W2 · Planner · Production tab: Quality check clicked on Production now\'s stage bar — the SAME dialog as Overview\'s, on Quality check', model: plannerCase(production, { tab: 'production', production: ready(HAND_FREE_READ), dialog: { kind: 'stageByHand', mode: 'set', pick: 'QUALITY' } }) },
  { id: 'f-ms-clear-back', label: 'F-SC-W2 · Planner · Clear… of Cutting set back below the floor\'s Quality check: back to Quality check — the customer reads it and gets the usual notice', model: plannerCase(production, { production: ready(HAND_BACK_READ), dialog: { kind: 'stageClear' } }) },
]
// ---- end F-MS-103

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-039',
  title: 'Order studio: lines, dates, production, shipments, invoices & payments with the deposit, documents',
  view: OrderDesign,
  cases: [
    { id: 'held-deposit', label: 'Owner · Lines: a new order; Make work orders held — production waits for the deposit', model: base('owner', confirmed), note: 'Held with its first blocking reason (hover or focus the button). The summary rail: money by every grain, cost too; the record chain.' },
    // B-TH-228: an order made straight from a request (no quote): the band names the request ("Made from INQ-… — Open"), the chain too.
    { id: 'th-228-made-from', label: 'TH-2 · Sales · An order made from a request: "Made from INQ-2026-0041 — Open" on the band, the request in Overview › Linked records', model: base('sales', typed, { tab: 'overview', madeFrom: { id: '0190f0e2-5151-7000-8000-000000000041', number: 'INQ-2026-0041' }, madeFromReading: false }) },
    { id: 'th-228-made-from-reading', label: 'TH-2 · Sales · While the source is read: neither "Made from" nor "Typed by the office"', model: base('sales', typed, { tab: 'overview', madeFrom: null, madeFromReading: true }) },
    // F-CP-148 (Owner O1, B-CP-011; the S2 answer reversed): seen as Sales worker the lines carry no price and no margin %.
    { id: 'sales-lines', label: 'Seen as Sales worker · Lines: no price, no margin % (Owner O1); making work orders is production’s', model: noPrice(base('sales', forRole(confirmed, 'manager'))) },
    {
      id: 'lines-cost-changed',
      label: 'Owner · Lines: cost changed since priced (B-W2b-380)',
      model: base('owner', confirmed, { lineCost: (line) => createElement(CostChangedMark, { change: line.seq === 10 ? 4.2 : line.seq === 20 ? -1.5 : 0, currency: confirmed.currency }) }),
      note: 'The mark beside a line whose revision costs more or less today than when it was priced; nothing where it did not move or without the cost grain.',
    },
    { id: 'manager-lines', label: 'Production manager · Lines: no money; read-only', model: base('manager', paidNotSent) },
    // ---- F-SA-231b ----
    { id: 'lines-artwork-viewer', label: 'F-SA-231b · Sales · Lines: "Artwork (2)" opens both files in the thread’s viewer (the read names them; ← / → walk them)', model: base('sales', withArtwork(production)) },
    { id: 'lines-mtm-rider', label: 'F-SA-231b · Sales · Lines: a made-to-measure unit names its rider (name, garment, revision) — never a measurement', model: base('sales', withUnit(production, DEMO_RIDER)) },
    { id: 'lines-mtm-no-right', label: 'F-SA-231b · Finance · Lines: without the measurements right the unit says only "Made to measure"', model: base('finance', withUnit(production, null)) },
    // ---- end F-SA-231b
    { id: 'money-new', label: 'Owner · Money: deposit asked, page not sent yet', model: base('owner', confirmed, { tab: 'money' }), note: 'The five steps: asked → bank-details page → payment → TD02 → SDI, each with what moves it on.' },
    { id: 'link-dialog', label: 'Owner · Send the bank-details page (DEPOSIT_INFO link)', model: base('owner', confirmed, { tab: 'money', dialog: { kind: 'depositLink', requestId: PAID.id }, draft: { message: 'Buongiorno, ecco i dati per il bonifico dell’acconto.' } }) },
    {
      id: 'link-sent',
      label: 'Owner · The page sent: to whom, until when',
      model: base('owner', pageSent, { tab: 'money', dialog: { kind: 'depositLink', requestId: PAID.id }, sentLink: { link: { id: '0190f0e2-1616-7000-8000-000000000001', expiresAt: SENT_LINK.expiresAt, to: SENT_LINK.to!, revokedLinkIds: [] }, emailId: '0190f0e2-1515-7000-8000-000000000001', delivery: 'sent' } }),
    },
    { id: 'money-page-sent', label: 'Finance · Page sent, waiting for the transfer', model: base('finance', pageSent, { tab: 'money' }) },
    // F-CP-148 (Owner O1): seen as Sales worker the Money tab says the deposit's state in words, the Price check one held line.
    { id: 'money-sales', label: 'Seen as Sales worker · Money: the deposit in words, no amount; Price check one line; sending and recording held', model: noPrice(base('sales', forRole(pageSent, 'manager'), { tab: 'money', ...priceCard({ state: 'held' }) })) },
    // ---- F-CP-142 (customer page plan C3; picture 21): Money › Price check, after Totals ----
    { id: 'price-check', label: 'Owner · Money › Price check: per line ours against the customer\'s, Not equal · 1 line, where it came from', model: base('owner', pageSent, { tab: 'money', ...priceCard(priceReady()) }), note: 'Customer\'s price… opens the ONE window (the Work tab\'s too); Change our price › is the order\'s Edit mode; History › the audit of this order\'s customer prices.' },
    { id: 'price-check-empty', label: 'Owner · Price check: no customer price yet, a request named them (Take them over)', model: base('owner', pageSent, { tab: 'money', ...priceCard(priceReady(EMPTY_CHECK)) }), note: '"No customer price yet" is never Equal; Customer\'s price… is the primary; the take-over is a row inside the card.' },
    { id: 'price-check-stale', label: 'Owner · Price check: changed meanwhile — "Here they are now"', model: base('owner', pageSent, { tab: 'money', ...priceCard(priceReady(PRICE_CHECK, { stale: true })) }) },
    { id: 'price-check-closed', label: 'Owner · Price check: a closed order keeps its prices (Customer\'s price… held in words)', model: base('owner', pageSent, { tab: 'money', ...priceCard(priceReady(CLOSED_CHECK), false) }), note: 'History › held: no right to read the audit log.' },
    { id: 'price-check-loading', label: 'Owner · Price check: reading', model: base('owner', pageSent, { tab: 'money', ...priceCard({ state: 'loading' }) }) },
    { id: 'price-check-error', label: 'Owner · Price check: could not be read (Try again)', model: base('owner', pageSent, { tab: 'money', ...priceCard({ state: 'failed', problem: 'problem.read.unavailable' }) }) },
    { id: 'price-check-dialog', label: 'Owner · Price check: the customer\'s-price window open', model: base('owner', pageSent, { tab: 'money', ...priceCard(priceReady()), priceCheckDialog: priceWindowOf('edit') }) },
    { id: 'price-check-held', label: 'As Production manager · Money › Price check: one line "Shown to people who see prices", no table, nothing asked', model: base('manager', pageSent, { tab: 'money', ...priceCard({ state: 'held' }) }), note: 'The money wall: as Sales worker the same (the Sales role holds no price since B-CP-011).' },
    // ---- end F-CP-142
    { id: 'payment-dialog', label: 'Finance · Record the payment: amount, day, bank reference, Issue the TD02 now', model: base('finance', pageSent, { tab: 'money', dialog: { kind: 'depositPayment', requestId: PAID.id }, draft: { reference: 'CRO-0000-ESEMPIO-88' } }) },
    { id: 'payment-dialog-over', label: 'Finance · Record the payment: more than is left (the rest stays on the payment)', model: base('finance', partPaid, { tab: 'money', dialog: { kind: 'depositPayment', requestId: PAID.id }, draft: { amount: '2000,00', reference: 'CRO-0000-ESEMPIO-89' } }) },
    { id: 'payment-refused', label: 'Finance · Record the payment: the bank reference was recorded already', model: base('finance', pageSent, { tab: 'money', dialog: { kind: 'depositPayment', requestId: PAID.id }, draft: { reference: 'CRO-0000-ESEMPIO-01' }, dialogProblem: { key: 'problem.write.reference' } }) },
    { id: 'step-up', label: 'Finance · Issuing the TD02 asks a fresh authenticator code', model: base('finance', pageSent, { tab: 'money', dialog: { kind: 'depositPayment', requestId: PAID.id }, draft: { reference: 'CRO-0000-ESEMPIO-88' }, busy: true, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.td02', problem: null } }) },
    { id: 'payment-done', label: 'Finance · Recorded: the deposit is paid and the TD02 issued', model: base('finance', paidNotSent, { tab: 'money', dialog: { kind: 'depositPayment', requestId: PAID.id }, recorded: RECORDED, sdi: CHAIN_SDI('NOT_SENT', 'SEND', true) }) },
    { id: 'td02-not-sent', label: 'Finance · Paid; TD02 issued, not sent to SDI yet: Send to SDI', model: base('finance', paidNotSent, { tab: 'money', sdi: CHAIN_SDI('NOT_SENT', 'SEND', true) }) },
    { id: 'sdi-dialog', label: 'Finance · Send the TD02 to SDI', model: base('finance', paidNotSent, { tab: 'money', sdi: CHAIN_SDI('NOT_SENT', 'SEND', true), dialog: { kind: 'sdiSend', invoiceId: TD02_ID } }) },
    { id: 'td02-at-sdi', label: 'Finance · TD02 at SDI: waiting for its answer', model: base('finance', paidNotSent, { tab: 'money', sdi: CHAIN_SDI('AT_SDI', 'WAIT'), notice: { tone: 'success', words: { key: 'notice.sdiSent' } } }) },
    { id: 'td02-delivered', label: 'Owner · TD02 delivered by SDI; production may start', model: base('owner', paidNotSent, { tab: 'money', sdi: CHAIN_SDI('DELIVERED', 'NONE') }) },
    { id: 'td02-draft', label: 'Sales · Paid; the TD02 is a draft finance issues', model: base('sales', paidDraft, { tab: 'money' }) },
    { id: 'part-paid', label: 'Finance · A part payment: what is left', model: base('finance', partPaid, { tab: 'money' }) },
    { id: 'deposit-no-td02', label: 'Finance · An EU business deposit: paid, no deposit invoice (its VAT rule)', model: base('finance', noTd02, { tab: 'money' }) },
    { id: 'no-deposit', label: 'Sales · An order that needs no deposit', model: base('sales', noDeposit, { tab: 'money' }) },
    { id: 'manager-money', label: 'Production manager · Money without money or invoices', model: base('manager', paidNotSent, { tab: 'money' }) },
    { id: 'production-gate-paid', label: 'Production manager · Production: deposit paid, Make work orders opens New work order', model: base('manager', paidNotSent, { tab: 'production', production: ready(WORK_READ) }) },
    { id: 'production-held', label: 'Sales · Production: the gate waits for the deposit; Make work orders held', model: base('sales', confirmed, { tab: 'production', production: ready(WORK_READ) }) },
    { id: 'production-progress', label: 'Sales · Production: the six sections at rest — Production now, Work orders with this order’s own pieces (where, made for this order, also makes, held, a shared work order read-only, a shared cut), 12 made-to-measure units as one row, 1 not shown; Dates & plan; Problems & holds | What we make it to; Materials', model: base('sales', production, { tab: 'production', production: ready(WORK_READ) }) },
    // ---- F-OP-113: the work-order rows — in place for a planner, held for Sales in words, a shared row read-only ----
    { id: 'wo-acts-manager', label: 'F-OP-113 · Production manager · Production: Due, Priority and Rush in place on each work order (by number), the row ⋯; WO-00019 is shared with another customer: its link only', model: base('manager', production, { tab: 'production', production: ready(workActsRead(MANAGE_ALL)), workOrderActs: woActs('manager', { toldAt: { [WORK_ORDERS_IDS[1]]: at(18, 8, 42) /* op-fx1: 18 Oct is summer time in Rome (+2): 08:42 UTC is the note's 10:42 */ } }) }), note: 'WO-00022 says "Told the floor at 10:42" after its priority was changed here.' },
    { id: 'wo-acts-saving', label: 'F-OP-113 · Production manager · Production: a priority saving (the cell marked) and a due date refused (said on the row)', model: base('manager', production, { tab: 'production', production: ready(workActsRead(MANAGE_ALL)), workOrderActs: woActs('manager', { saves: { [WORK_ORDERS_IDS[0]]: { field: 'priority', problem: null }, [WORK_ORDERS_IDS[1]]: { field: null, problem: { key: 'production:error.changed' } } } }) }) },
    // ---- F-OP-114 / F-OP-115: the row's dialogs (the DS Modal draws in a browser: the design index shows them) ----
    { id: 'wo-hold-dialog', label: 'F-OP-114 · Production manager · Hold… from a work order’s row: the reason the floor reads, what the customer reads shown before it is placed', model: base('manager', production, { tab: 'production', production: ready(workActsRead(MANAGE_ALL)), workOrderActs: woActs('manager', { reasons: [...HOLD_REASONS, ...PRODUCTION_HOLD_REASONS], dialog: woDialog('hold', productionWorkOrder('RELEASED'), { holdRight: true }) }) }) },
    { id: 'wo-release-dialog', label: 'F-OP-114 · Production manager · Release… a draft from its row: the release check in the dialog, each condition in words', model: base('manager', production, { tab: 'production', production: ready(workActsRead(MANAGE_ALL)), workOrderActs: woActs('manager', { dialog: woDialog('release', productionWorkOrder('DRAFT'), { check: { value: releaseCheck('blocked'), problem: null } }) }) }) },
    { id: 'wo-cancel-cut', label: 'F-OP-115 · Production manager · Cancel… a started work order: 8 pieces are cut — refused in the API’s words, no outcome to pick (R-16)', model: base('manager', production, { tab: 'production', production: ready(workActsRead(MANAGE_ALL)), workOrderActs: woActs('manager', { dialog: woDialog('cancel', productionWorkOrder('IN_PROGRESS'), { cancelCheck: { value: CANCEL_CUT, problem: null } }) }) }) },
    { id: 'wo-cancel-draft', label: 'F-OP-115 · Production manager · Cancel… a draft: nothing cut — the reason, then Cancel work order', model: base('manager', production, { tab: 'production', production: ready(workActsRead(MANAGE_ALL)), workOrderActs: woActs('manager', { dialog: woDialog('cancel', productionWorkOrder('DRAFT'), { cancelCheck: { value: { ...CANCEL_CUT, status: 'DRAFT', cancellable: true, refusal: null, cut: { pieces: 0, cells: [] }, issued: [], atWorkshop: [] }, problem: null } }) }) }) },
    { id: 'wo-acts-sales', label: 'F-OP-113 · Sales · Production: the rows as they are, the acts held in words — “Production does this — a planner or the production manager”', model: base('sales', production, { tab: 'production', production: ready(workActsRead(NO_RIGHTS)), workOrderActs: woActs('sales') }) },
    { id: 'production-quality', label: 'F-SA-235 · Sales · Production: a quality hold with the office’s note, a problem that needs an answer, an NCR, a final inspection waiting; the specs in force', model: base('sales', production, { tab: 'production', production: ready(QUALITY_READ), asks: { value: QUALITY_ASKS, problem: null } /* F-PT-302 */ }) },
    { id: 'production-no-right', label: 'Finance · Production: the work orders by number (no floor progress right)', model: base('finance', production, { tab: 'production', production: ready(NO_WORK_READ) }) },
    { id: 'production-error', label: 'Sales · Production: the work orders could not be read (Try again)', model: base('sales', production, { tab: 'production', production: FAILED_STATE }) },
    // ---- T.1 (order PRODUCTION tab, 15-steps T.1): the states the seed lacks, by role. The widths S / M / L are the design frame's own
    // (Phone 390, Tablet 1024, Desktop 1440, Wide 1920) — every case reads at each. ----
    // fx6: the rows with their rights, as the server sends them (workActsRead): the Owner may lift, Sales may not.
    { id: 'pt-holds-owner', label: 'PT · Owner · Production: three holds — production (the office’s note), the customer’s pause, quality — each strip with its live door', model: base('owner', production, { tab: 'production', production: ready({ ...workActsRead(MANAGE_ALL), headline: HOLDS_READ.headline }), workOrderActs: woActs('owner') }) },
    { id: 'pt-holds-sales', label: 'PT · Sales · Production: the same holds — no Lift, no Release (hidden, D2), one line says who does it', model: base('sales', production, { tab: 'production', production: ready({ ...workActsRead(NO_RIGHTS), headline: HOLDS_READ.headline }), workOrderActs: woActs('sales') }) },
    { id: 'pt-asks-open', label: 'PT · Sales · Production: an ask open — who answers and by when; Ask for an update', model: base('sales', production, { tab: 'production', production: ready(WORK_READ), asks: { value: ASKS_OPEN, problem: null }, people: PT_PEOPLE }) },
    { id: 'pt-asks-escalated', label: 'PT · Planner · Production: the ask past its day, escalated to the backup (late)', model: base('manager', production, { tab: 'production', can: abilitiesOf(rolePermissions('planner')), production: ready(WORK_READ), asks: { value: ASKS_ESCALATED, problem: null }, people: PT_PEOPLE }) },
    { id: 'pt-asks-answered', label: 'PT · Sales · Production: the supervisor’s reply answered the ask — “Latest update”, “Answered for SO-2026-0090 and 1 more” (L8)', model: base('sales', production, { tab: 'production', production: ready(WORK_READ), asks: { value: ASKS_ANSWERED_BATCH, problem: null }, people: PT_PEOPLE }) },
    { id: 'pt-customer-problem', label: 'PT · Sales · Production: a problem the customer reported — Needs an answer with Reply in the thread', model: base('sales', production, { tab: 'production', production: ready(PROBLEM_READ), asks: { value: ASKS_CUSTOMER_PROBLEM, problem: null }, people: PT_PEOPLE }) },
    { id: 'pt-promise-moves', label: 'PT · Sales · Production: the promise set, then moved twice — the whole order, then one line from its own day; “Date set” never a move', model: base('sales', promiseMovedOf(production), { tab: 'production', production: ready(WORK_READ) }) },
    { id: 'pt-gates-planner', label: 'PT · Planner · Production: a gate late, one waiting on the customer’s sample (Decide for the customer…), one started before', model: base('manager', production, { tab: 'production', can: { ...abilitiesOf(rolePermissions('planner')), decideForCustomer: true }, production: ready(GATES_READ), gateActs: GATE_ACTS }) },
    { id: 'pt-specs-replaced', label: 'PT · Sales · What we make it to: Pattern v3 replaced by v4 on 12 Nov (its change note; WO-00021 finishes on v3), the customer’s tech pack in force and newer', model: d323('sales', production, { tab: 'production', production: ready(SPEC_READ), styleSpecs: { parts: new Map([[STYLE_ID, { value: STYLE_REPLACED, problem: null }]]), more: 0 }, specCan: { versions: false, changeRequest: false } }) },
    { id: 'pt-specs-no-pack', label: 'PT · Owner · What we make it to: no inquiry — “No customer tech pack on this order.”; Versions & changes ›, Ask for a design change…', model: d323('owner', production, { tab: 'production', production: ready(WORK_READ), styleSpecs: { parts: new Map(), more: 0 }, specCan: { versions: true, changeRequest: true } }, { techPack: { value: { inquiry: null }, problem: null } }) },
    { id: 'pt-goods-missing', label: 'PT · Owner · Materials: the customer’s goods not arrived — Waits on the customer, Record what arrived…', model: d323('owner', production, { tab: 'production', production: ready(WORK_READ), receipt: { dialog: null } }, { materials: { value: GOODS_MISSING, problem: null } }) },
    { id: 'pt-goods-partly', label: 'PT · Owner · Materials: partly arrived — “4 pz still to come (2 of 6 pz arrived)”', model: d323('owner', production, { tab: 'production', production: ready(WORK_READ), receipt: { dialog: null } }) },
    { id: 'pt-goods-all-here', label: 'PT · Owner · Materials: all here — Record what the customer sent… stays for an extra delivery', model: d323('owner', production, { tab: 'production', production: ready(WORK_READ), receipt: { dialog: null } }, { materials: { value: GOODS_ALL_HERE, problem: null } }) },
    { id: 'pt-receipt', label: 'PT · Owner · Record what the customer sent: pre-filled with what is still to come; the leather by the hide said and left out', model: d323('owner', production, { tab: 'production', production: ready(WORK_READ), receipt: RECEIPT_OPEN }, { materials: { value: GOODS_WITH_LEATHER, problem: null } }) },
    { id: 'pt-buy-short', label: 'PT · Planner · Materials: a zip short — Delayed, PO-2026-0091 was due 18 Nov, Ask the buyers…', model: base('manager', production, { tab: 'production', can: abilitiesOf(rolePermissions('planner')), production: ready(WORK_READ), readiness: { value: READINESS_SHORT, problem: null }, askBuyers: ASK_BUYERS }) },
    { id: 'pt-buy-asked', label: 'PT · Planner · Materials: the buyers asked — “Asked 20/11/2026”', model: base('manager', production, { tab: 'production', can: abilitiesOf(rolePermissions('planner')), production: ready(WORK_READ), readiness: { value: READINESS_SHORT, problem: null }, askBuyers: ASKED_BUYERS }) },
    { id: 'pt-warehouse', label: 'PT · Warehouse · Production: the tab read; Record what the customer sent… (inventory.receive)', model: d323('manager', production, { tab: 'production', can: abilitiesOf(rolePermissions('warehouse')), production: ready(WORK_READ), receipt: { dialog: null } }) },
    { id: 'pt-finance', label: 'PT · Finance · Production: the holds in words, the work withheld in one line; no act', model: base('finance', production, { tab: 'production', production: ready({ ...HOLDS_READ, work: null, withheld: ['work', 'people', 'headline.notes'] }) }) },
    { id: 'pt-read-only', label: 'PT · Read-only · Production: every section read, no act button anywhere (L7)', model: base('manager', production, { tab: 'production', can: abilitiesOf(rolePermissions('read_only')), production: ready(HOLDS_READ), asks: { value: ASKS_OPEN, problem: null } }) },
    // ---- end T.1
    { id: 'dates', label: 'Sales · Production: first promise kept, two changes with who and why', model: base('sales', late, { tab: 'production', production: ready(LATE_READ) }) },
    // F-OO-142 (B-OO-009): why is a curated reason the customer reads (shown in Italian and English); the note stays the office's.
    { id: 'promise-dialog', label: 'Sales · Change promise date: the whole order — why from the list (the customer reads it, in Italian and English), the office’s own note', model: base('sales', production, { tab: 'production', production: ready(WORK_READ), dialog: { kind: 'promise' }, draft: { date: '2026-12-29', reasonCode: 'MATERIAL_LATE', reason: 'La pelle nera arriva una settimana dopo.' } }) },
    { id: 'promise-lines', label: 'Sales · Change promise date: chosen lines', model: base('sales', production, { tab: 'production', production: ready(WORK_READ), dialog: { kind: 'promise' }, draft: { scope: 'lines', lineIds: [production.lines[1]!.id], date: '2026-12-29', reasonCode: 'QUALITY', reason: 'Il rosso chiede un secondo bagno di colore.' } }) },
    { id: 'f-oo-142-promise-pick', label: 'F-OO-142 · Sales · Change promise date: no reason picked yet — Change the date held “Pick why”', model: base('sales', production, { tab: 'production', production: ready(WORK_READ), dialog: { kind: 'promise' }, draft: { date: '2026-12-29' } }) },
    // F-OO-112 (B-OO-002, Owner D1): Mark ready… opens only once quality released every piece (the catch-up before the system moves it).
    { id: 'ready-dialog', label: 'Sales · Mark ready: quality released every piece — the catch-up before the system moves it', model: base('sales', everyReleased, { dialog: { kind: 'ready' }, draft: { reason: 'Controllo finale fatto in reparto.' } }) },
    { id: 'f-oo-112-ready-held', label: 'F-OO-112 · Sales · Overview: quality released 7 of 14 — Mark ready… held with the counts (the moves row and the band ⋯)', model: base('sales', qualityHeld, { tab: 'overview', production: ready({ ...PRODUCTION_READ, people: PEOPLE }), liveState: 'live' }) },
    { id: 'shipments', label: 'Sales · Shipments: left to ship per size, two shipments', model: base('sales', shipped, { tab: 'shipments' }) },
    { id: 'shipments-empty', label: 'Sales · Shipments: nothing shipped yet', model: base('sales', production, { tab: 'shipments' }) },
    { id: 'shipped-close-settled', label: 'Sales · Shipped and settled: Close order', model: base('sales', settled, { tab: 'shipments' }) },
    { id: 'close-dialog-settled', label: 'Sales · Close a settled order', model: base('sales', settled, { dialog: { kind: 'close' } }) },
    { id: 'shipped-unsettled-sales', label: 'Sales · Shipped, not settled: Close held (the right to close unsettled orders)', model: base('sales', shipped, { tab: 'shipments' }) },
    { id: 'close-dialog-unsettled', label: 'Finance · Close an unsettled order: what is missing, a reason', model: base('finance', shipped, { dialog: { kind: 'close' }, draft: { reason: 'Il cliente salda a parte con il prossimo ordine.' } }) },
    { id: 'closed', label: 'Owner · Closed: final, nothing changes', model: base('owner', closed) },
    { id: 'cancelled', label: 'Sales · Cancelled with its reason', model: base('sales', cancelled) },
    { id: 'documents', label: 'Sales · Changes: the accepted quote and its evidence', model: base('sales', paidNotSent, { tab: 'changes' }) },
    { id: 'documents-no-right', label: 'Production manager · Changes: the quote by number only', model: base('manager', paidNotSent, { tab: 'changes' }) },
    // ---- B-TH-214: the docked thread (picture 29) ----
    {
      id: 'thread-docked',
      label: 'Sales · The thread docked beside Production & dates (40 %)',
      model: base('sales', production, { tab: 'production' }),
      note: 'The band sits in the shell’s band row; the thread is docked at 40 % (519 px at 1440, 711 px at 1920), sticky while the body scrolls, ⌘J hides it. Its "⋯" holds Activity’s tools (Add task, Ask a partner to approve, Share with a partner, Followers, Follow, Mute, Remind me). Below 1280 px the band’s Thread button opens it full width.',
    },
    { id: 'thread-lines', label: 'Sales · Lines with the thread: one third under 1600 px', model: base('sales', production), note: 'The size grids need the room: on Lines the thread takes one third below 1600 px unless the person chose a width in its width menu.' },
    // F-SA-230: no "Late N days" banner any more (Late is the band's health chip): the two notices are the customer's yes asked
    // again and the change meanwhile.
    { id: 'notices', label: 'Sales · One notice, the rest behind “N more notices”', model: base('sales', amended(late), { tab: 'production', changed: { at: at(29, 10, 42) } }), note: 'The order waits for the customer\'s yes again and changed meanwhile: the most serious notice shows, the other waits behind "1 more notice".' },
    // ---- B-TH-256: what points at the order (picture 29's 'Shipments & invoices with complaints and returns', ORD-G04, the gate block) ----
    { id: 'th-256-links', label: 'TH-6 · Sales · Shipments: the order’s complaints and returns (each opens its record)', model: base('sales', production, { tab: 'shipments', links: linksModel({ ...LINKS_FULL, rePromises: [], gates: [] }) }), note: 'Only this order’s own complaints and returns (wall W27), each by its own right; a real link to each record.' },
    { id: 'th-256-links-none', label: 'TH-6 · Sales · Shipments: no complaints or returns', model: base('sales', production, { tab: 'shipments', links: linksModel(LINKS_NONE) }) },
    { id: 'th-256-repromise', label: 'TH-6 · Sales · Planning proposes new dates: Accept / Decline in the one notice, "Tell the customer" ticked', model: base('sales', production, { tab: 'production', links: linksModel({ ...LINKS_FULL, gates: [] }, { tell: { [LINKS_FULL.rePromises[0]!.id]: true } }) }), note: 'The proposer never decides it; the customer is told only with the tick (and the right to send e-mail).' },
    // F-PT-201 (W2): on Production the proposal is Dates & plan's own; on every other tab it stays the page's one notice.
    { id: 'th-256-repromise-overview', label: 'TH-6 · Sales · Overview: Planning proposes new dates — the page’s one notice (on Production it is Dates & plan’s)', model: base('sales', production, { tab: 'overview', links: linksModel({ ...LINKS_FULL, gates: [] }, { tell: { [LINKS_FULL.rePromises[0]!.id]: true } }) }) },
    { id: 'th-256-repromise-manager', label: 'TH-6 · Production manager · The proposal read-only (held with why); the gate in words only; no complaints or returns', model: base('manager', production, { tab: 'shipments', links: linksModel(LINKS_MANAGER) }) },
    { id: 'th-256-decline', label: 'TH-6 · Sales · Decline the new dates? (the reason the planner reads)', model: base('sales', production, { tab: 'production', links: linksModel({ ...LINKS_FULL, gates: [] }, { decline: { proposalId: LINKS_FULL.rePromises[0]!.id, reason: 'Il cliente ha già promesso la consegna al negozio.', problem: null } }) }) },
    { id: 'th-256-gate', label: 'TH-6 · Sales · A compliance gate blocks a work order: the gate’s own words, Open in Compliance', model: base('sales', production, { tab: 'production', links: linksModel({ ...LINKS_FULL, rePromises: [] }) }), note: 'Same words as Compliance › Gate refusals; the link only with the compliance view right.' },
    { id: 'th-256-accepted', label: 'TH-6 · Sales · New dates accepted, the customer told', model: base('sales', production, { tab: 'production', links: linksModel(LINKS_NONE, { said: { key: 'links.done.acceptedTold', tone: 'success' } }) }) },
    { id: 'changed', label: 'Sales · Someone changed the order while a dialog was open', model: base('sales', production, { changed: { at: at(29, 10, 42) } }) },
    { id: 'notice', label: 'Sales · After a write: a notice', model: base('sales', production, { tab: 'production', notice: { tone: 'success', words: { key: 'notice.promise' } } }) },
    { id: 'loading', label: 'Loading', model: { ...base('sales', confirmed), record: { ...base('sales', confirmed).record, order: { status: 'loading' } } } },
    { id: 'error', label: 'The read failed (in words, Try again)', model: { ...base('sales', confirmed), record: { ...base('sales', confirmed).record, order: { status: 'error', problem: 'problem.read.unavailable' } } } },
    { id: 'not-found', label: 'Not found (another company, or a wrong address)', model: { ...base('sales', confirmed), record: { ...base('sales', confirmed).record, order: { status: 'not_found' } } } },
    { id: 'no-permission', label: 'No permission (orders.view over its company and customer)', model: { ...base('sales', confirmed), record: { ...base('sales', confirmed).record, order: { status: 'forbidden' } } } },
    // ---- B-W2a-50: the order every day ------------------------------------------------------------------------------------
    // ---- F-OL-05 (Order LINES lane, plan v2): the Lines tab changed in place — no edit mode (look at 375 / 1440 / 1920, light + dark) ----
    { id: 'lines-view', label: 'Lines · Owner · The tab: "14 pieces · 2 lines · Ready by …", one table per style, thin boxes, Unit price and Line total, the totals', model: base('owner', production, { linesTab: tabOf() }), note: 'Keyboard: Tab walks the boxes, Enter goes down, Esc puts a box back, ⌘Z takes the last edit back, ⌘S opens Review and save.' },
    { id: 'lines-sales', label: 'Lines · Sales · No money anywhere: no price column, no totals; one line why; boxes for sizes and notes', model: base('sales', asSales(production), { linesTab: tabOf() }) }, // B-CP-011
    { id: 'lines-sales-changing', label: 'Lines · Sales · Changing: "was 2", the bar — and still no money (the draft holds no price)', model: base('sales', asSales(confirmed), { linesTab: tabWith(threeChanges(asSales(confirmed))) }) }, // B-CP-011
    { id: 'lines-read-only', label: 'Lines · Read-only · Plain numbers, no box, no Add a style, no ⋯, no bar', model: readOnlyCase(base('sales', asSales(production), { linesTab: tabOf() })) },
    { id: 'lines-undo', label: 'Lines · Owner · One change: "1 change not saved · Undo last edit"', model: base('owner', confirmed, { linesTab: tabWith(oneMore50(confirmed)) }) },
    { id: 'lines-review', label: 'Lines · Owner · Review and save: what changes per line, the total before → after, Why (optional), the tick "Ask … to accept the new order" (the total goes up)', model: base('owner', confirmed, { linesTab: tabWith(threeChanges(confirmed), { review: reviewOf({ ...AMEND_PREVIEW, totalUp: true, amountChanges: true }) }) }) },
    // ---- F-OL-10 (Order LINES lane): the tick off, and the tab at 375 ----
    { id: 'lines-review-tick-off', label: 'Lines · Owner · Review and save with the tick taken off: "Not ticked: they are not asked." — Save changes asks the customer nothing', model: base('owner', confirmed, { linesTab: tabWith(threeChanges(confirmed), { review: reviewOf({ ...AMEND_PREVIEW, totalUp: true, amountChanges: true }, { ask: false }) }) }) },
    { id: 'lines-phone', label: 'Lines · Owner · Changing at 375 px: each colour row a card (its sizes five to a row, each named by its size, "was 2" under the box), the save bar wraps — sentence + Undo, then Discard + Review and save…', model: base('owner', confirmed, { linesTab: tabWith(threeChanges(confirmed)) }), note: 'Look at it at 375 px (and 1440 / 1920), light and dark: no sideways scroll.' },
    // ---- end F-OL-10
    { id: 'lines-review-sales', label: 'Lines · Sales · Review and save: the pieces only, "The amount changes" — never which way; the tick on', model: base('sales', asSales(confirmed), { linesTab: tabWith(threeChanges(asSales(confirmed)), { review: reviewOf(SALES_PREVIEW) }) }) }, // B-CP-011
    { id: 'lines-review-reading', label: 'Lines · Owner · Review and save: working out what changes (Save changes held)', model: base('owner', confirmed, { linesTab: tabWith(threeChanges(confirmed), { review: reviewOf(null) }) }) },
    { id: 'lines-review-problems', label: 'Lines · Owner · Review and save: refused by place, in words (Save changes held)', model: base('owner', production, { linesTab: tabWith(threeChanges(production), { review: reviewOf(AMEND_PREVIEW_PROBLEMS) }) }) },
    { id: 'lines-review-moved', label: 'Lines · Owner · Review and save: someone saved meanwhile — said at the top, the preview asked again', model: base('owner', confirmed, { linesTab: tabWith(threeChanges(confirmed), { review: reviewOf({ ...AMEND_PREVIEW, totalUp: true, amountChanges: true }, { changedMeanwhile: true }) }) }) },
    { id: 'lines-moved', label: 'Lines · Owner · Someone saved meanwhile: "Bea Esempio saved a change at 10:42: line 10 (BLK · Nero) moved. Your changes are kept." · a cell both changed: Keep mine / Take theirs', model: base('owner', confirmed, { linesTab: tabWith(oneMore50(confirmed), { moved: { by: 'Bea Esempio', at: at(29, 10, 42), lineIds: [LINE_BLK], gone: [] }, clashes: [{ lineId: LINE_BLK, field: { kind: 'size', size: '50' }, mine: '3', theirs: '4' }] }) }) },
    { id: 'lines-ask-failed', label: 'Lines · Owner · Saved, but the ask could not be sent: "Ask again" (the save stands)', model: base('owner', confirmed, { linesTab: tabOf({ askFailed: true }), notice: { tone: 'success', words: { key: 'save.done.plainAsked' } } }) },
    { id: 'lines-add-style', label: 'Lines · Owner · Add a style: our collection and this customer\'s own styles; black and red on the order already', model: base('owner', confirmed, { linesTab: tabOf({ addStyle: { query: 'DEMO', results: [{ ...STYLE_ROWS[0]!, colourways: STYLE.colourways.map((colourway) => ({ id: colourway.id, listPriced: colourway.id !== BRN.id })) }], searching: false, problem: null, row: { ...STYLE_ROWS[0]!, colourways: STYLE.colourways.map((colourway) => ({ id: colourway.id, listPriced: colourway.id !== BRN.id })) }, chosen: STYLE, picked: [BRN.id] } }) }) },
    { id: 'lines-add-style-sales', label: 'Lines · Sales · Add a style: brown has no list price for this customer — held in the dialog (someone who sees prices adds it)', model: base('sales', asSales(confirmed), { linesTab: tabOf({ addStyle: { query: 'DEMO', results: null, searching: false, problem: null, row: { ...STYLE_ROWS[0]!, colourways: STYLE.colourways.map((colourway) => ({ id: colourway.id, listPriced: colourway.id !== BRN.id })) }, chosen: STYLE, picked: [BRN.id] } }) }) }, // B-CP-011
    { id: 'lines-add-colour', label: 'Lines · Owner · + Add a colour: brown (not on the order yet), "Copy the sizes of: BLK · Nero"', model: base('owner', confirmed, { linesTab: tabOf({ addColour: { styleId: STYLE_ID } }) }) },
    { id: 'lines-figures', label: 'Lines · Owner · Changing, the preview back: each line total and the totals are the SERVER\'s figures ("was" beside them); before it answers the table shows its own estimate', model: base('owner', confirmed, { linesTab: tabWith(blackAndBrown(confirmed), { figures: serverFiguresOf(AMEND_PREVIEW, confirmed) }) }) }, // F-OL-09
    { id: 'lines-leave', label: 'Lines · Owner · An in-app link away from the order with 3 changes not saved: "Leave with 3 changes not saved?" — Stay / Leave and discard (asked on any tab; another tab of the order asks nothing)', model: base('owner', confirmed, { tab: 'overview', linesTab: tabWith(threeChanges(confirmed), { leaving: true }) }) }, // F-OL-07
    { id: 'lines-partly-shipped', label: 'Lines · Sales · Partly shipped: plain numbers and today\'s held words (changes on a partly shipped order come later)', model: base('sales', order('PARTLY_SHIPPED'), { linesTab: tabOf() }) },
    { id: 'amended-band', label: 'W2a · Sales · An amended order: “Amended · rev 2”, waiting for the customer to accept again', model: base('sales', amended(production)) },
    { id: 'close-lines-dialog', label: 'W2a · Sales · Close remaining lines: what will not be made or shipped, the reason, the reversal', model: base('sales', order('PARTLY_SHIPPED'), { dialog: { kind: 'closeLines' }, draft: { reason: 'Il cliente non vuole il resto.' } }) },
    { id: 'close-lines-done', label: 'W2a · Sales · Lines closed: what work orders still make is Production’s', model: base('sales', closedShort, { dialog: { kind: 'closeLines' }, closedLines: { order: closedShort, closed: [{ lineId: LINE_RED, seq: 20, closedShortQuantity: 2 }], reducesDone: [], stillInWorkOrders: [{ lineId: LINE_RED, pieces: 2 }], workOrders: { applied: [], waiting: [] } } }) },
    { id: 'closed-short', label: 'W2a · Sales · Lines: the red line closed short (2 pieces) with its reason', model: base('sales', closedShort) },
    { id: 'reopen-dialog', label: 'W2a · Sales · Reopen lines (the close’s reversal)', model: base('sales', closedShort, { dialog: { kind: 'reopenLines' }, draft: { reason: 'Arrivata altra pelle rossa.' } }) },
    { id: 'cancel-dialog', label: 'W2a · Sales · Cancel order in production: what it changes and leaves behind; reason; the number typed', model: base('sales', production, { dialog: { kind: 'cancel' }, cancelCheck: { value: CANCEL_CHECK, problem: null }, draft: { reason: 'Il cliente ha chiuso la stagione.', typed: 'SO-2026-0088' } }), note: 'Cancel order waits for the reason and the number typed exactly.' },
    { id: 'cancel-confirmed', label: 'W2a · Owner · Cancel a new confirmed order: its open deposit is cancelled with it', model: base('owner', confirmed, { dialog: { kind: 'cancel' }, cancelCheck: { value: CANCEL_CONFIRMED, problem: null } }) },
    { id: 'cancel-blocked', label: 'W2a · Sales · Cancel order stopped: a draft work order, a shipment being packed, an invoice issued', model: base('sales', order('READY'), { dialog: { kind: 'cancel' }, cancelCheck: { value: CANCEL_BLOCKED, problem: null } }) },
    { id: 'cancel-reading', label: 'W2a · Sales · Cancel order: reading the impact check', model: base('sales', production, { dialog: { kind: 'cancel' }, cancelCheck: { value: null, problem: null } }) },
    { id: 'cancel-failed', label: 'W2a · Sales · Cancel order: the impact check could not be read (Try again)', model: base('sales', production, { dialog: { kind: 'cancel' }, cancelCheck: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'copy-quote', label: 'W2a · Sales · Copy as new quote', model: base('sales', cancelled, { dialog: { kind: 'copyQuote' } }) },
    { id: 'copy-quote-done', label: 'W2a · Sales · Copied: the new quote and what it left out', model: base('sales', cancelled, { dialog: { kind: 'copyQuote' }, copied: COPIED }) },
    { id: 'money-schedule', label: 'W2a · Finance · Payment schedule: deposit paid, balance before shipping', model: base('finance', paidNotSent, { tab: 'money' }) },
    { id: 'money-schedule-overdue', label: 'W2a · Finance · Payment schedule: the deposit step overdue', model: base('finance', confirmed, { tab: 'money', schedule: { value: SCHEDULE_OVERDUE, problem: null } }) },
    { id: 'money-schedule-remade', label: 'W2a · Owner · Payment schedule remade by an amendment (one step replaced)', model: base('owner', amended(production), { tab: 'money', schedule: { value: SCHEDULE_REMADE, problem: null } }) },
    // B-W2a-80: the schedule card's verbs (B-W2a-F2's note).
    { id: 'w2a80-schedule-open', label: 'W2a · Finance · Schedule: Open the balance before shipping for payment; invoice the paid deposit (its TD02)', model: base('finance', paidNotSent, { tab: 'money', scheduleSteps: { can: { manageOrders: true, manageInvoices: true, waive: false }, opening: null, busy: false, problem: null } }) },
    { id: 'w2a80-schedule-day', label: 'W2a · Finance · Open for payment of a step without a day: the day its request falls due', model: base('finance', paidNotSent, { tab: 'money', schedule: { value: { ...SCHEDULE, steps: SCHEDULE.steps.map((step) => (step.kind === 'BEFORE_SHIPPING' ? { ...step, dueDate: null } : step)) }, problem: null }, scheduleSteps: { can: { manageOrders: true, manageInvoices: true, waive: false }, opening: { ...SCHEDULE.steps[1]!, dueDate: null }, busy: false, problem: null } }) },
    { id: 'w2a80-schedule-sales', label: 'W2a · Sales · Schedule verbs held (orders and invoices are managed by others)', model: base('sales', paidNotSent, { tab: 'money', scheduleSteps: { can: { manageOrders: false, manageInvoices: false, waive: false }, opening: null, busy: false, problem: null } }) },
    { id: 'money-schedule-none', label: 'W2a · Sales · No milestones: paid on invoice terms', model: base('sales', noDeposit, { tab: 'money', schedule: { value: SCHEDULE_NONE, problem: null } }) },
    // B-W2b-16: the owner waives an advance; a typed order's deposit page; the close's reason code.
    { id: 'w2b16-waive', label: 'W2b · Owner · Schedule: Waive… on the open balance before shipping (and on its deposit card)', model: base('owner', confirmed, { tab: 'money', scheduleSteps: WAIVE_STEPS }) },
    { id: 'w2b16-waive-dialog', label: 'W2b · Owner · Waive the balance before shipping: what it means, the reason; a fresh code after Waive', model: base('owner', confirmed, { tab: 'money', scheduleSteps: { ...WAIVE_STEPS, waiving: { target: { kind: 'step', id: BALANCE.id, version: BALANCE.version }, label: BALANCE.label, stepKind: 'BEFORE_SHIPPING' } } }) },
    { id: 'w2b16-waive-deposit', label: 'W2b · Owner · Waive the deposit: production may start without it', model: base('owner', confirmed, { tab: 'money', scheduleSteps: { ...WAIVE_STEPS, waiving: { target: { kind: 'step', id: SCHEDULE.steps[0]!.id, version: 1 }, label: SCHEDULE.steps[0]!.label, stepKind: 'DEPOSIT' } } }) },
    { id: 'w2b16-waive-refused', label: 'W2b · Owner · Waive refused: the step moved meanwhile (said in the dialog)', model: base('owner', confirmed, { tab: 'money', scheduleSteps: { ...WAIVE_STEPS, problem: { key: 'schedule.verbs.problem.moved' }, waiving: { target: { kind: 'step', id: BALANCE.id, version: BALANCE.version }, label: BALANCE.label, stepKind: 'BEFORE_SHIPPING' } } }) },
    { id: 'w2b16-waive-held', label: 'W2b · Finance · Waive… held: only the owner waives', model: base('finance', confirmed, { tab: 'money', scheduleSteps: { ...WAIVE_STEPS, can: { ...WAIVE_STEPS.can, waive: false } } }) },
    { id: 'w2b16-deposit-typed', label: 'W2b · Finance · A typed order’s deposit: Send the bank-details page (to the invoices contact)', model: base('finance', typed, { tab: 'money' }) },
    { id: 'w2b16-deposit-typed-dialog', label: 'W2b · Finance · Send the page of a typed order’s deposit', model: base('finance', typed, { tab: 'money', dialog: { kind: 'depositLink', requestId: typed.chain.depositRequests[0]!.id } }) },
    { id: 'w2b16-close-lines-code', label: 'W2b · Sales · Close remaining lines: the reason code from the cancel list, beside the words', model: base('sales', order('PARTLY_SHIPPED'), { dialog: { kind: 'closeLines' }, cancelReasons: CANCEL_REASONS, draft: { reason: 'Il cliente non vuole il resto.', reasonCode: 'CUSTOMER_REQUEST' } }) },
    { id: 'w2b16-close-lines-no-code', label: 'W2b · Sales · Close remaining lines held: pick a reason code', model: base('sales', order('PARTLY_SHIPPED'), { dialog: { kind: 'closeLines' }, cancelReasons: CANCEL_REASONS, draft: { reason: 'Il cliente non vuole il resto.' } }) },
    { id: 'w2b16-closed-short-code', label: 'W2b · Sales · Lines: the closed line names its reason code in words', model: base('sales', closedShort, { cancelReasons: CANCEL_REASONS }) },
    { id: 'money-schedule-manager', label: 'W2a · Production manager · Payment schedule without money', model: base('manager', paidNotSent, { tab: 'money' }) },
    { id: 'money-schedule-error', label: 'W2a · Sales · The payment schedule could not be read (Try again)', model: base('sales', confirmed, { tab: 'money', schedule: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'new-empty', label: 'W2a · Sales · New order (typed): the draft studio, no line yet — Confirm held', model: draftCase('sales'), note: 'Add a style (n), pick colours, type sizes; the rail prices it as you type.' },
    { id: 'new-priced', label: 'W2a · Owner · New order: two colour lines priced by the API (list price and a typed one), deposit and schedule', model: draftCase('owner', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'ready', value: MANUAL_PREVIEW, problem: null } }) }, // B-CP-011
    { id: 'new-owner', label: 'W2a · Owner · New order priced: cost too (cost grain)', model: draftCase('owner', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'ready', value: MANUAL_PREVIEW, problem: null } }) },
    { id: 'new-pricing', label: 'W2a · Owner · New order: pricing while typing', model: draftCase('owner', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'reading', value: MANUAL_PREVIEW, problem: null } }) }, // B-CP-011
    { id: 'new-problems', label: 'W2a · Sales · New order: the API’s problems by place, in words — Confirm held', model: draftCase('sales', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'ready', value: MANUAL_PROBLEMS, problem: null } }) },
    { id: 'new-refused', label: 'W2a · Sales · New order: Confirm refused (said above the lines; the lines stay)', model: draftCase('sales', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'ready', value: MANUAL_PREVIEW, problem: null }, problem: { key: 'problem.write.unavailable' } }) },
    { id: 'new-composer', label: 'W2a · Sales · New order: Add a style — colours picked', model: draftCase('sales', { composer: { ...COMPOSER_EMPTY, query: 'DEMO', results: STYLE_ROWS, chosen: STYLE, picked: [BRN.id] } }) },
    { id: 'new-reading', label: 'W2a · New order: reading the customer', model: draftCase('sales', { party: { status: 'loading' }, number: undefined }) },
    { id: 'new-missing', label: 'W2a · New order: an address without a customer (start again from the list)', model: draftCase('sales', { header: null, party: { status: 'missing' } }) },
    // ---- B-TH-231: the fold "Customer files" — held in the page, attached right after Confirm (O-SAL-ORD-NEW.form-F08)
    { id: 'th-231-files', label: 'TH-2 · Sales · New order: Customer files held until Confirm (a ticked measurement sheet, a photo, a refused SVG)', model: draftCase('sales', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'ready', value: MANUAL_PREVIEW, problem: null }, files: { held: HELD, canUpload: true, leftOut: 0, made: null, busy: false } }), note: '"Added to the order when you confirm, for the office only": nothing exists before the order.' },
    { id: 'th-231-files-failed', label: 'TH-2 · Sales · Order made; 2 files did not attach — Retry', model: draftCase('sales', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'ready', value: MANUAL_PREVIEW, problem: null }, files: { held: HELD.map((file, index): HeldFile => (file.problem ? file : { ...file, state: index === 0 ? 'attached' : 'failed' })), canUpload: true, leftOut: 0, made: { number: 'SO-2026-0089', href: `${PREFIX}/sales/orders/x` }, busy: false } }), note: 'The order stays made (Confirm is held: never twice); Retry sends only what did not attach.' },
    { id: 'th-231-files-no-right', label: 'TH-2 · Sales · New order: no right to upload files (said; the order is made without them)', model: draftCase('sales', { files: { held: [], canUpload: false, leftOut: 0, made: null, busy: false } }) },
    // ---- end B-TH-231
    { id: 'new-error', label: 'W2a · New order: the customer could not be read (Try again)', model: draftCase('sales', { party: { status: 'error', problem: 'problem.read.unavailable' } }) },
    { id: 'new-no-manage', label: 'W2a · Finance · New order held: taking orders is the sales right', model: draftCase('finance', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'ready', value: MANUAL_PREVIEW, problem: null } }) },
    // ---- B-W2a-72: the Margin tab (margin grain only; Owner answer S2: sales see %, never cost amounts) ----
    { id: 'w2a-margin', label: 'W2a · Finance · Money › Margin: quoted → now → so far, where the margin went, by line', model: base('finance', production, { tab: 'money', margin: marginAs('finance', MARGIN) }), note: 'Quoted 5,160.00 (43.0 %) → material −200.00 → subcontract −60.00 → overhead −80.00 → now 4,820.00 (40.2 %): −340.00.' },
    // B-CP-011: "margin % only" was Sales under S2; O1 reverses it — Sales reads no margin (the Margin section is not drawn).
    { id: 'w2a-margin-sales', label: 'W2a · Seen as Sales (no margin grain since B-CP-011, Owner O1): Money › no Margin section — no %, no amount', model: base('sales', production, { tab: 'money', margin: marginAs('sales', MARGIN) }) },
    { id: 'w2a-margin-no-grain', label: 'W2a · Production manager · Money: no margin grain, no Margin section', model: base('manager', production, { tab: 'money', margin: marginAs('manager', null) }) },
    { id: 'w2a-margin-loading', label: 'W2a · Margin reading', model: base('finance', production, { tab: 'money', margin: marginAs('finance', { value: null, problem: null }) }) },
    { id: 'w2a-margin-error', label: "W2a · Margin couldn't load: Try again (the rest of the order stays usable)", model: base('finance', production, { tab: 'money', margin: marginAs('finance', { value: null, problem: 'problem.unavailable' }) }) },
    // ---- F-SA-237: Files, every file of the order by where it comes from (the same body as the thread's Files window) ----
    { id: 'files', label: 'F-SA-237 · Sales · Files: by source — the order and its conversation, the lines’ artwork (also on SO-2026-0151), production photos; shared or office only; 3 you cannot open', model: base('sales', production, { tab: 'files', files: { read: ORDER_FILES, problem: null, selected: [], canShare: true } }) },
    { id: 'files-chosen', label: 'F-SA-237 · Sales · Files: two chosen — Download 2 · Share 1 own with the customer', model: base('sales', production, { tab: 'files', files: { read: ORDER_FILES, problem: null, selected: ['0190f0e2-8181-7000-8000-000000000001', '0190f0e2-8181-7000-8000-000000000002'], canShare: true } }) },
    { id: 'files-empty', label: 'F-SA-237 · Files: none yet', model: base('sales', production, { tab: 'files', files: { read: { ...ORDER_FILES, groups: ORDER_FILES.groups.map((group) => ({ ...group, files: [], leftOut: 0, measurementsLeftOut: 0 })), total: 0 }, problem: null, selected: [], canShare: true } }) },
    { id: 'files-failed', label: "F-SA-237 · Files couldn't be read (Try again)", model: base('sales', production, { tab: 'files', files: { read: null, problem: 'read', selected: [], canShare: true } }) },
    // ---- F-CP-148 (the money wall; B-CP-023): the order's files with two priced documents — named for a price holder, counted for anyone else
    { id: 'cp-148-files-owner', label: 'F-CP-148 · Seen as Owner · Files: the order confirmation and the customer\'s PO named and opened (a price holder)', model: base('owner', production, { tab: 'files', files: { read: PRICED_FILES, problem: null, selected: [], canShare: true } }) },
    { id: 'cp-148-files-sales', label: 'F-CP-148 · Seen as Sales worker · Files: "2 priced documents — you cannot open them" counted, never named, no tile, no preview', model: noPrice(base('sales', forRole(production, 'manager'), { tab: 'files', files: { read: PRICED_LOCKED, problem: null, selected: [], canShare: true } })) },
    { id: 'cp-148-files-manager', label: 'F-CP-148 · Seen as Production manager · Files: the same counted lock line; the artwork and the photos open', model: base('manager', production, { tab: 'files', files: { read: PRICED_LOCKED, problem: null, selected: [], canShare: false } }) },
    // ---- end F-CP-148
    // ---- F-SA-232: Overview, the first tab ("where is it now", progress by line — the order's own pieces) ----
    // F-OO-133 (W05 follow-up): with the people part read (PEOPLE) and Sales' People rights (Ask; no supervisor right) — the real card,
    // never the withheld sentence of a part not read.
    { id: 'overview', label: 'F-SA-232 · Sales · Overview: In production · Sewing (F-OO-101: status · stage); at risk and Urgent (customer) in the band, waiting on us in Requests & changes (F-OO-103); the lines’ own pieces (Rosso: sewing not counted here)', model: base('sales', production, { tab: 'overview', production: ready({ ...PRODUCTION_READ, people: PEOPLE }), people: { mayAssign: false, mayNote: true, assign: null, note: null }, liveState: 'live' }) },
    { id: 'overview-confirmed', label: 'F-SA-232 · Sales · Overview before any work order: Confirmed · Preparing (F-OO-101); the deposit it waits for is the deposit strip’s (F-OO-105)', model: base('sales', confirmed, { tab: 'overview', production: ready(CONFIRMED_READ), liveState: 'live' }) },
    { id: 'overview-sizes', label: 'F-SA-232 · Sales · Overview: line 10’s sizes in the centred window (PiecesGrid, shipped, the finish forecast)', model: base('sales', production, { tab: 'overview', production: ready(), overviewLine: LINE_BLK, liveState: 'live' }) },
    { id: 'overview-loading', label: 'F-SA-232 · Overview reading (skeletons, never a 0)', model: base('sales', production, { tab: 'overview', production: LOADING_STATE, liveState: 'connecting' }) },
    { id: 'overview-failed', label: "F-SA-232 · Overview: the production couldn't be read (this part only, Try again)", model: base('sales', production, { tab: 'overview', production: FAILED_STATE, liveState: 'offline' }) },
    ...F_OO_102, // F-OO-102: the headline and the dots before, after and without production
    ...F_OO_105, // F-OO-105: the strips with their real doors (holds, the deposit, the credit; Owner, Sales, Read-only)
    ...F_OO_106, // F-OO-106: the order's own credit hold — Check credit again, Ask for a yes…, the last no, who checks it
    ...F_OO_108, // F-OO-108: Hold the whole order… — the move, held for Sales and with nothing yet, the ONE Hold dialog on the plan
    ...F_OO_109, // F-OO-109: ONE Lift for the customer's pause on N work orders — the door, held for Sales, the dialog
    ...F_OO_110, // F-OO-110: cancel a waiting order — Cancel order… under More ▾, the yes taken back
    ...F_OO_211, // F-OO-211 / F-OO-213: the custom fields beside Order facts — read-only, the order changed first, a closed order
    ...F_MS_102, // F-MS-102: the stage set by hand — the door under the dots, the row with Change… and Clear…, held, none
    ...F_MS_103, // F-MS-103: the stage set by hand — the ONE dialog (Set, Change…, held, refused) and Clear…'s confirm
    // ---- F-SA-243: the order page's doors to the ONE review window, Still to do ----
    ...F_SA_243,
    ...F_OP_301, // F-OP-301 (walk #1, #2, #3)
    ...F_OO_204, // F-OO-204: the request rows and their doors (Changes)
    ...F_OO_205, // F-OO-205: the Requests & changes card
    // ---- B-W2b-323: orders in depth (priority, season, the yes, what is frozen, priced changes, materials, confirmation, tech pack, forecast, milestones) ----
    ...W2B_323,
    // ---- F-OP-217: the dock's scopes, each inside the one card (look at them at 1440 with the dock a third and 40 %, and at 375) ----
    { id: 'f-op-217-dock-order', label: 'F-OP-217 · Sales · Dock: the pick band inside the card on This order (2 new), the whose-line', model: { ...base('sales', production, { tab: 'overview' }), dock: 'order' } },
    { id: 'f-op-217-dock-general', label: 'F-OP-217 · Sales · Dock: Moto Demo (general) — the customer’s general thread, the pick band in its card', model: { ...base('sales', production, { tab: 'overview' }), dock: 'general' } },
    { id: 'f-op-217-dock-work-order', label: 'F-OP-217 · Sales · Dock: a work order’s notes — office only, the whose-line in the office tone, no mail', model: { ...base('sales', production, { tab: 'production' }), dock: 'wo' } },
    { id: 'f-op-217-dock-all', label: 'F-OP-217 · Sales · Dock: All of Moto Demo — read only: its Head, compact lines (the customer’s, ours, an office note, General, another order with files), the foot “Read only. Write in:”', model: { ...base('sales', production, { tab: 'lines' }), dock: 'all' } },
    // ---- F-OP-129: the order page at the end — the edit strip per reader and under cut, the Shipments rows (tracking, shared, made elsewhere) ----
    ...F_OP_129,
  ],
})
