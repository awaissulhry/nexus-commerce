import { createElement, useMemo, useRef, useState, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { beforeOrderGroupsOf, openQuotesOf, waitsOnUsOf } from '@nexus/factory-domain/sales/before-order/groups'
import type { BeforeOrderCountsAnswer } from '@nexus/factory-domain/sales/before-order/contracts'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { ApiClient } from '../../../../../lib/api/client'
import { ListToolsContext } from '../../../../../list-frame/tools/transport'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useT } from '../../../../../lib/i18n/provider'
import type { ReadPictures } from '../../../../../lib/record-picture/cache'
import { memoryStore, memoryTransport, type MemoryToolsModel } from '../../../../_shared/list-tools/memory'
import { manyActModelOf, type ManyActModel } from '../../../_shared/many-acts/use-many-act'
import type { ManyAct, ManyRecord, ManyResult } from '../../../_shared/many-acts/model'
import type { QuoteListRow } from '../../../quotes/api'
import { abilitiesOf, grainsOf, NO_FILTERS } from '../../../quotes/model'
import { quoteActOf } from '../../../quotes/list/acts'
import { quoteRecordOf, quoteRightsOf, type QuoteRecord } from '../../../quotes/list/bar'
import { CHIP_ROWS, quotesListModel } from '../../../quotes/list/fixtures'
import type { QuotesListViewModel } from '../../../quotes/list/list-model'
import { QuotesListView } from '../../../quotes/list/view/QuotesListView'
import { quote as quoteDetail, pending as pendingQuote } from '../../../quotes/record/fixtures'
import type { QuoteDialog } from '../../../quotes/record/record-model'
import type { QuoteDetail } from '../../../quotes/api'
import type { CatalogueRecord, IncomingRow, InquiryView } from '../../../inquiries/api'
import { incomingActOf } from '../../../inquiries/acts'
import type { IncomingRecord } from '../../../inquiries/bar'
import { acceptDraftOf } from '../../../inquiries/catalogue-model'
import { CATALOGUE_RECORD, CATALOGUE_ROW, INCOMING_ROWS, listOf, ROWS as REQUEST_ROWS, VIEW } from '../../../inquiries/demo/fixtures'
import { BULK_ASSIGN, BULK_DECLINE, catalogueModel, incomingPage, incomingRecord } from '../../../inquiries/fixtures'
import { emptyDecline, HOME_ADDRESS, type ListAddress } from '../../../inquiries/model'
import { InquiriesView, type InquiriesModel } from '../../../inquiries/view/InquiriesView'
import { replyRowOf } from '../../../inquiries/bar' // F-CQ-304
import { replyComposerContext, replyTargetsOf, todoStart, type ReplyManyModel, type ReplyRecordType, type ReplyRow } from '../../../orders/list/reply-many' // F-CQ-304
import { startDraft } from '../../../../../lib/record-thread/composer/model' // F-CQ-304
import type { DraftRow } from '../drafts/api'
import { CustomerDraftsList, type CustomerDraftsListModel } from '../drafts/view/CustomerDraftsList'
import { bandOf, doorAddress, DOORS, emptyTab, TAB_KINDS, tabRightsOf, termsOfDoor, type Door, type TabFacts } from './band'
import { BEFORE_ORDER_NS } from './view/BeforeOrderBand'
import { DraftsFrame, QuotesTabFrame, TabSection } from './view/QuotesTabParts'

/**
 * cq T (customer page › Quotes & incoming, 15-steps T.1; 10-design §1–§8): the tab's gallery — the REAL parts (the band, the sections,
 * the two lists' own views, the drafts' own list, each window at a step) over made-up data: a busy customer, drafts only, nothing at
 * all, everything closed; opened from a door; each role (its rights from the role's own template); rows ticked on each bar; every
 * window; More ▾, a row ⋯, Sort ▾, Customise; a phone; the tab's rooms. Nothing is sent from the gallery. Data is made up: Seed
 * Customer One, SEED-QT-…, SEED-INQ-…, SEED-RQ-…, SEED-SO-0150.
 */

// ---- the customer, the roles ------------------------------------------------------------------------------------------------------

const PREFIX = '/w/DEMO'
const PARTY = { id: '0190f0e2-c1c1-7000-8000-0000000000c1', code: 'SEED-C1', name: 'Seed Customer One' } as const
const BASE = `${PREFIX}/sales/customers/${PARTY.id}`

export type TabRole = 'owner' | 'sales' | 'finance' | 'viewer' | 'production'
/** A role's permissions as a session holds them (its template's permissions and a `money.<grain>` per grain). */
const template = (key: string): string[] => {
  const role = templateOf(key)
  return [...(role?.permissions ?? []), ...(role?.grains ?? []).map((grain) => `money.${grain}`), 'home.view']
}
const OWNER_EXTRA = ['quotes.view', 'quotes.manage', 'quotes.approve', 'quotes.send', 'sales.inquiries.view', 'sales.inquiries.manage', 'orders.view', 'orders.manage', 'tasks.manage', 'threads.read', 'sales.samples.view', 'money.price', 'money.cost', 'money.margin']
const PERMISSIONS: Readonly<Record<TabRole, readonly string[]>> = {
  owner: [...template('sales'), ...OWNER_EXTRA],
  sales: template('sales'),
  finance: template('finance'),
  viewer: template('read_only'),
  production: template('production_manager'),
}
/** The Incoming list's own role cases (its rights and its bar from the same templates). */
const INCOMING_ROLE = { owner: 'owner', sales: 'sales', finance: 'reader', viewer: 'reader', production: 'production' } as const

// ---- the counts (one read; the server's own sums, per role: a kind the role does not read is null, never 0) -----------------------

interface Kinds {
  readonly quotes: { PREPARING: number; APPROVAL: number; WAITING_CUSTOMER: number; ORDER_WAITS: number; WON: number; LOST: number }
  readonly requests: { TO_ANSWER: number; WAITING_CUSTOMER: number; WON: number; MOVED: number; LOST: number }
  readonly portalOrders: { TO_ANSWER: number; WON: number; MOVED: number; LOST: number }
  readonly drafts: number
  readonly sampleRounds: number
}
const NONE: Kinds = {
  quotes: { PREPARING: 0, APPROVAL: 0, WAITING_CUSTOMER: 0, ORDER_WAITS: 0, WON: 0, LOST: 0 },
  requests: { TO_ANSWER: 0, WAITING_CUSTOMER: 0, WON: 0, MOVED: 0, LOST: 0 },
  portalOrders: { TO_ANSWER: 0, WON: 0, MOVED: 0, LOST: 0 },
  drafts: 0,
  sampleRounds: 0,
}
/** The busy customer: every group (the rows below are exactly these). */
const BUSY: Kinds = {
  quotes: { PREPARING: 2, APPROVAL: 1, WAITING_CUSTOMER: 1, ORDER_WAITS: 1, WON: 1, LOST: 2 },
  requests: { TO_ANSWER: 2, WAITING_CUSTOMER: 1, WON: 0, MOVED: 1, LOST: 1 },
  portalOrders: { TO_ANSWER: 1, WON: 0, MOVED: 1, LOST: 0 },
  drafts: 2,
  sampleRounds: 1,
}
const CLOSED_ONLY: Kinds = { ...NONE, quotes: { ...NONE.quotes, WON: 1, LOST: 2 }, requests: { ...NONE.requests, MOVED: 1, LOST: 1 }, portalOrders: { ...NONE.portalOrders, MOVED: 1 } }

function countsOf(kinds: Kinds, role: TabRole): BeforeOrderCountsAnswer {
  const rights = tabRightsOf(PERMISSIONS[role])
  const byKind = { quotes: rights.quotes ? kinds.quotes : null, requests: rights.requests ? kinds.requests : null, portalOrders: rights.requests && rights.drafts ? kinds.portalOrders : null, drafts: rights.drafts ? kinds.drafts : null }
  const groups = beforeOrderGroupsOf(byKind)
  return { partyId: PARTY.id, groups, openQuotes: openQuotesOf(byKind.quotes), waitsOnUs: waitsOnUsOf(groups), byKind, sampleRounds: rights.samples ? kinds.sampleRounds : null, asOf: '2026-10-29T10:00:00.000Z' } as BeforeOrderCountsAnswer
}

// ---- the customer's rows (the lists' own made-up rows, made this customer's) ------------------------------------------------------

const quoteOf = (row: QuoteListRow, n: string, patch: Partial<QuoteListRow> = {}): QuoteListRow => ({ ...row, partyId: PARTY.id, partyName: PARTY.name, number: `SEED-QT-${n}`, ...patch })
const chip = (n: number) => CHIP_ROWS.find((row) => row.number.endsWith(String(n)))!
const ORDER_WAITS_QUOTE = quoteOf(chip(58), '0015')
/** r2 while the customer holds r1 (the portal shows r1 until r2 is sent). */
const REVISED_QUOTE = quoteOf(chip(51), '0012')
/** A portal order accepted as a quote: the draft it became, "Customer sees" its words. */
const FROM_PORTAL_QUOTE = quoteOf(chip(50), '0016', { approval: null, marginFloorBreached: false, madeFrom: { inquiryId: '0190f0e2-5151-7000-8000-000000000086', number: 'SEED-RQ-0086', status: 'QUOTED' } })
const APPROVAL_QUOTE = quoteOf(chip(52), '0013')
const SENT_QUOTE = quoteOf(chip(54), '0014')
const LIVE_QUOTES: QuoteListRow[] = [ORDER_WAITS_QUOTE, REVISED_QUOTE, FROM_PORTAL_QUOTE, APPROVAL_QUOTE, SENT_QUOTE]
const WON_QUOTE = quoteOf(chip(57), '0010', { order: { ...chip(57).order!, number: 'SEED-SO-0150' } })
const LOST_QUOTES: QuoteListRow[] = [quoteOf(chip(60), '0009'), quoteOf(chip(61), '0011')]
const EXPIRED_QUOTE = LOST_QUOTES[1]!

const REF = { id: PARTY.id, code: PARTY.code, name: PARTY.name }
const incomingOf = (row: IncomingRow, number: string): IncomingRow => ({
  ...row,
  number,
  party: REF,
  fromWords: PARTY.name,
  prospect: false,
  ...(row.request ? { request: { ...row.request, number, party: REF, fromWords: PARTY.name, prospect: false } } : {}),
})
const requestRow = (index: number) => INCOMING_ROWS.find((row) => row.kind === 'REQUEST' && row.id === REQUEST_ROWS[index]!.id)!
/** Overdue: a request waiting on us longer than a working day. */
const OVERDUE = incomingOf(requestRow(0), 'SEED-INQ-0007')
const ASSIGNED = incomingOf(requestRow(1), 'SEED-INQ-0008')
const NEED_INFO = incomingOf(requestRow(2), 'SEED-INQ-0009')
const PORTAL = incomingOf(CATALOGUE_ROW, 'SEED-RQ-0087')
const LIVE_INCOMING: IncomingRow[] = [OVERDUE, PORTAL, ASSIGNED, NEED_INFO]
const ENDED_INCOMING: IncomingRow[] = [incomingOf(requestRow(5), 'SEED-INQ-0004')]

const file = (id: string) => ({ id, lineId: null, originalName: `${id}.pdf`, kind: 'ATTACHMENT', sizeBytes: 120000, status: 'READY', locked: false })
const DRAFTS: DraftRow[] = [
  { id: 'd0000000-0000-4000-8000-0000000007c1', number: null, status: 'DRAFT', party: REF, customerRef: null, requestedDate: '2026-12-15', lines: 3, pieces: 140, netShown: '18400.00', currency: 'EUR', version: 6, draft: { startedBy: 'Seed Buyer One', startedAt: '2026-10-22T09:00:00.000Z', lastEditedBy: 'Seed Buyer One', lastEditedAt: '2026-10-28T10:42:00.000Z', title: 'SEED-STY-01 Touring jacket', people: 12, readiness: { parts: [], done: 5, of: 7, problems: 1 }, later: ['PEOPLE'], thread: { messages: 4, lastAt: '2026-10-28T10:40:00.000Z', designerAsked: true }, files: { logos: [file('l1')], references: [], sheets: [] } } },
  { id: 'd0000000-0000-4000-8000-0000000007c2', number: null, status: 'DRAFT', party: REF, customerRef: null, requestedDate: null, lines: 0, pieces: 0, netShown: null, currency: 'EUR', version: 1, draft: { startedBy: 'Seed Buyer Two', startedAt: '2026-10-27T15:10:00.000Z', lastEditedBy: 'Seed Buyer Two', lastEditedAt: '2026-10-27T15:20:00.000Z', title: null, people: 0, readiness: { parts: [], done: 1, of: 7, problems: 0 }, later: [], thread: null, files: { logos: [], references: [], sheets: [] } } },
]

// ---- the lists as the tab mounts them (the host's columns by the tab's room, Most urgent first, the customer's one name) -----------

/** Each door's address on the customer's page (the open door's: everything again). */
const hrefsUnder = (base: string, open: Door | null): Record<Door, string> => {
  const hrefs = Object.fromEntries(DOORS.map((door) => [door, doorAddress(base, new URLSearchParams('tab=quotes'), door)])) as Record<Door, string>
  return open ? { ...hrefs, [open]: doorAddress(base, new URLSearchParams('tab=quotes'), null) } : hrefs
}

function quotesOf(role: TabRole, room: number, rows: readonly QuoteListRow[], over: Partial<QuotesListViewModel> = {}): QuotesListViewModel {
  const permissions = PERMISSIONS[role]
  const can = abilitiesOf(permissions)
  const grains = grainsOf(permissions)
  return quotesListModel({
    grains,
    can,
    rows: { items: [...rows], more: false, problem: null },
    filters: { ...NO_FILTERS, party: PARTY.id, group: 'LIVE', sort: 'urgent' },
    embedded: true,
    columns: 'host',
    room,
    customerName: PARTY.name,
    readsOrders: permissions.includes('orders.view'),
    readsRequests: permissions.includes('sales.inquiries.view'),
    unread: null,
    barRights: quoteRightsOf(permissions, can, grains),
    cardDoor: null,
    ...over,
  })
}

function incomingOfRole(role: TabRole, room: number, rows: readonly IncomingRow[], over: Partial<InquiriesModel> = {}): InquiriesModel {
  const address: ListAddress = { ...HOME_ADDRESS, party: PARTY.id }
  return incomingPage(
    { address, list: listOf(rows), embedded: true, paneMode: 'host', locked: true, kinds: TAB_KINDS, homeTile: 'OPEN', rank: 'urgent', rankHeld: null, columns: 'host', room, customerName: PARTY.name, ...over },
    INCOMING_ROLE[role],
  ).model
}

const draftsOf = (room: number, rows: readonly DraftRow[] = DRAFTS): CustomerDraftsListModel => ({ customer: PARTY.name, read: { status: 'ready', rows: [...rows] }, updates: 0, activeId: null, wide: room >= 1100 })

// ---- a case ----------------------------------------------------------------------------------------------------------------------

export interface QuotesTabCase {
  readonly role: TabRole
  readonly counts: BeforeOrderCountsAnswer | null
  readonly failed?: boolean
  readonly door: Door | null
  /** The tab's own room in px (the frame draws the tab at this width). */
  readonly room: number
  readonly quotes: QuotesListViewModel
  readonly incoming: InquiriesModel
  readonly drafts: CustomerDraftsListModel
  /** Views ▾ / Export ▾ / Customise of the Quotes list, in memory. */
  readonly tools?: MemoryToolsModel
  // ---- cq W3 (T part 2): the customer page's own gallery mounts this tab for ITS customer, with a draft open in its window
  /** The page's customer (absent: Seed Customer One). */
  readonly party?: { readonly id: string; readonly name: string }
  /** A draft's read-only window (the page's gallery builds it). */
  readonly window?: ReactNode
}

const ROOM = 1240
function tabCase(over: Partial<QuotesTabCase> & { kinds?: Kinds; quoteRows?: readonly QuoteListRow[]; incomingRows?: readonly IncomingRow[] } = {}): QuotesTabCase {
  const role = over.role ?? 'owner'
  const room = over.room ?? ROOM
  const { kinds = BUSY, quoteRows = LIVE_QUOTES, incomingRows = LIVE_INCOMING, ...rest } = over
  return { role, counts: countsOf(kinds, role), door: null, room, quotes: quotesOf(role, room, quoteRows), incoming: incomingOfRole(role, room, incomingRows), drafts: draftsOf(room), ...rest }
}

/** The tab under a door: the band's chip, each list on exactly that door's rows, the others folded. */
function doorCase(door: Door, quoteRows: readonly QuoteListRow[], incomingRows: readonly IncomingRow[], role: TabRole = 'owner'): QuotesTabCase {
  const terms = termsOfDoor(door)
  const base = tabCase({ role, quoteRows, incomingRows })
  return {
    ...base,
    door,
    quotes: { ...base.quotes, filters: { ...base.quotes.filters, group: terms.quotes ?? 'LIVE' } },
    incoming: { ...base.incoming, address: { ...base.incoming.address, tile: terms.incoming ?? 'OPEN' } },
  }
}

// ---- the windows at a step (the real acts: their plan, their "Not on (why)", their receipt) ---------------------------------------

/** The gallery never runs an act: a client that is never called. */
const NO_API = {} as ApiClient
const day = (date: string) => date.split('-').reverse().join('/')
const recordsOf = (rows: readonly QuoteListRow[]): QuoteRecord[] => rows.map((row) => quoteRecordOf(row, PREFIX))
const requestsOf = (rows: readonly IncomingRow[]): IncomingRecord[] => rows.map((row) => ({ ...row, label: row.number, href: null }))
function windowOf<R extends ManyRecord>(act: ManyAct<R>, records: readonly R[], step: { typed?: string; fields?: Record<string, string>; results?: ManyResult[] } = {}): ManyActModel {
  const results = step.results ?? []
  return manyActModelOf({ act, records, typed: step.typed ?? '', fields: step.fields ?? {}, phase: results.length > 0 ? 'receipt' : 'plan', progress: { done: results.length, count: results.length }, results })
}
const quoteWindow = (kind: 'cancel' | 'askApproval' | 'makeOrders' | 'newLink', rows: readonly QuoteListRow[], step: Parameters<typeof windowOf>[2] = {}) => windowOf(quoteActOf(kind, NO_API, recordsOf(rows), day), recordsOf(rows), step)
const incomingWindow = (kind: 'lost' | 'askInfo', rows: readonly IncomingRow[], step: Parameters<typeof windowOf>[2] = {}) => windowOf(incomingActOf(kind, NO_API, requestsOf(rows)), requestsOf(rows), step)

/** F-CQ-304: the Reply-to-N window at its first step (nothing typed, the customer reads Italian in its portal). */
function replyOf(rows: readonly ReplyRow[], recordType: ReplyRecordType | ((row: ReplyRow) => ReplyRecordType), asked: boolean): ReplyManyModel {
  const targets = replyTargetsOf(rows.map((row, index) => ({ ...row, partyId: PARTY.id, partyName: PARTY.name, customerSeq: index + 3 })), recordType)
  const today = '2026-10-29'
  const kinds = new Set(targets.map((target) => target.recordType))
  return { customer: { id: PARTY.id, name: PARTY.name }, targets, batchId: 'seed-batch-1', draft: startDraft(replyComposerContext(PARTY.name)), notes: [], language: 'it', portal: 'on', sending: false, progress: null, results: {}, done: false, todo: todoStart(asked, today), asked, today, recordType: kinds.size === 1 ? targets[0]!.recordType! : 'Inquiry' }
}

const PEOPLE = [
  { id: '0190f0e2-7777-7000-8000-0000000000a1', name: 'Seed Person One', me: true },
  { id: '0190f0e2-7777-7000-8000-0000000000a2', name: 'Seed Person Two', me: false },
]
const ticked = (base: QuotesTabCase, quotes: readonly QuoteListRow[], incoming: readonly IncomingRow[] = []): QuotesTabCase => ({
  ...base,
  quotes: { ...base.quotes, selected: quotes.map((row) => row.id) },
  incoming: { ...base.incoming, selected: incoming.map((row) => row.key) },
})
const withQuotes = (base: QuotesTabCase, over: Partial<QuotesListViewModel>): QuotesTabCase => ({ ...base, quotes: { ...base.quotes, ...over } })
const withIncoming = (base: QuotesTabCase, over: Partial<InquiriesModel>): QuotesTabCase => ({ ...base, incoming: { ...base.incoming, ...over } })
/** The quote a row's window opens on (the page's customer: its code and name). */
const detailOf = (number: string, status: QuoteDetail['status'] = 'DRAFT'): QuoteDetail => quoteDetail({ number, partyId: PARTY.id, party: { code: PARTY.code, legalName: PARTY.name, status: 'ACTIVE' }, status, current: { status } })
const quoteDialogOn = (dialog: QuoteDialog, detail = detailOf('SEED-QT-0011')) => ({ quote: detail, model: { dialog, me: PEOPLE[0]!.id, can: abilitiesOf(PERMISSIONS.owner), grains: grainsOf(PERMISSIONS.owner), busy: false } })
const VERB_VIEW: InquiryView = { ...VIEW, number: 'SEED-INQ-0008', party: REF, fromWords: PARTY.name, prospect: false }
const PORTAL_RECORD: CatalogueRecord = { ...CATALOGUE_RECORD, request: { ...CATALOGUE_RECORD.request, number: 'SEED-RQ-0087', party: REF } }
const PENDING_QUOTE: QuoteDetail = { ...pendingQuote(), number: APPROVAL_QUOTE.number, partyId: PARTY.id, party: { code: PARTY.code, legalName: PARTY.name, status: 'ACTIVE' } }

// ---- the gallery's frame ---------------------------------------------------------------------------------------------------------

/** The tab as the customer page mounts it (its words, its room), the lists' own views inside its sections. */
export function QuotesTabDesign({ model }: { model: QuotesTabCase }) {
  const party = model.party ?? PARTY
  const base = model.party ? `${PREFIX}/sales/customers/${party.id}` : BASE
  const tab: TabFacts = { counts: model.counts, failed: model.failed ?? false, door: model.door, terms: termsOfDoor(model.door), rights: tabRightsOf(PERMISSIONS[model.role]), room: model.room, hrefs: hrefsUnder(base, model.door), everything: doorAddress(base, new URLSearchParams('tab=quotes'), null), prefix: PREFIX }
  const band = bandOf(tab.counts, tab.rights, tab.door)
  const hidden = emptyTab(band, tab.door)
  const quotesList = createElement(QuotesListView, { model: { ...model.quotes, customerName: party.name } })
  const incoming = hidden ? null : createElement(TabSection, { kind: 'incoming', customer: party.name, tab }, createElement(InquiriesView, { model: { ...model.incoming, customerName: party.name } }))
  const quotes = hidden ? null : createElement(TabSection, { kind: 'quotes', customer: party.name, tab }, model.tools ? createElement(MemoryTools, { tools: model.tools }, quotesList) : quotesList)
  const picture = useT(BEFORE_ORDER_NS)('drafts.picture')
  const drafts = hidden ? null : createElement(DraftsFrame, { customer: party.name, tab, window: model.window ?? null }, createElement(CustomerDraftsList, { model: { ...model.drafts, customer: party.name, pictures: { read: NO_PICTURES, header: picture } } }))
  const frame = createElement(QuotesTabFrame, { model: { partyId: party.id, customer: party.name, tab, band }, incoming, quotes, drafts })
  return createElement('div', { style: { maxWidth: model.room, margin: '0 auto' } }, createElement(WithMessages, { namespaces: ['parties', BEFORE_ORDER_NS] }, frame))
}

/** The drafts' garments are read by the host in one batch: the gallery reads none (each cell shows its placeholder). */
const NO_PICTURES: ReadPictures = async () => []

/** Views ▾, Export ▾ and Customise in memory (the Office's list tools, made up). */
function MemoryTools({ tools, children }: { tools: MemoryToolsModel; children?: ReactNode }) {
  const [query, setQuery] = useState('')
  const store = useRef(memoryStore(tools))
  const transport = useMemo(() => memoryTransport(tools, store.current, query, setQuery), [tools, query])
  return createElement(ListToolsContext.Provider, { value: transport }, children)
}

const TOOLS: MemoryToolsModel = { pageKey: null, locale: 'en', answer: { views: [], roleDefaultId: null, personalDefaultId: null, roles: [], allRoles: [], can: { save: true, manage: false, export: true }, exports: { formats: ['XLSX', 'CSV'] } }, jobs: [] }

// ---- cq W3 (T part 2): the builders the customer page's gallery mounts this tab with ----------------------------------------------

/** The tab as the page's busy case shows it, for the page's customer. */
export const quotesTabFor = (party: { readonly id: string; readonly name: string }, role: TabRole = 'owner'): QuotesTabCase => ({ ...tabCase({ role }), party })
/** "Customer is writing" (the WRITING door) for the page's customer: its drafts (the page's own made-up rows), one open in its window. */
export function writingTabFor(party: { readonly id: string; readonly name: string }, drafts: CustomerDraftsListModel, role: TabRole, window: ReactNode = null): QuotesTabCase {
  const count = drafts.read.status === 'ready' ? drafts.read.rows.length : 0
  return { ...doorCase('WRITING', [], [], role), counts: countsOf({ ...BUSY, drafts: count }, role), drafts, party, ...(window ? { window } : {}) }
}

// ---- the cases -------------------------------------------------------------------------------------------------------------------

const busy = tabCase()
const salesCase = tabCase({ role: 'sales' })
const financeCase = tabCase({ role: 'finance' })
const viewerCase = tabCase({ role: 'viewer' })
const productionCase = tabCase({ role: 'production' })

export const designScreen = defineDesignScreen<QuotesTabCase>({
  screen: 'SCR-033-quotes',
  title: 'Customer page › Quotes & incoming: the band, the sections, the acts',
  view: QuotesTabDesign,
  cases: [
    // ---- the data
    { id: 'busy', label: 'Owner · a busy customer: every group, Requests & portal orders then Quotes, then Customer is writing', model: busy, note: 'The band: 2 writing › 3 to answer (amber) › 2 preparing › 1 approval › 2 with the customer › 1 order waits (amber), the closed three apart. SEED-INQ-0007 overdue first; SEED-QT-0015 accepted, its order waits for the PO number; SEED-QT-0012 r2 while the customer holds r1; SEED-QT-0016 from the portal order SEED-RQ-0086 (accepted as a quote: Moved to a quote 1); SEED-INQ-0009 needs info.' },
    { id: 'drafts-only', label: 'Drafts only: the customer writes two portal drafts, nothing else yet', model: tabCase({ kinds: { ...NONE, drafts: 2 }, quoteRows: [], incomingRows: [] }), note: 'Each list says the customer has none (one quiet line each); the drafts list stays.' },
    { id: 'nothing', label: 'Nothing at all: ONE card with New request / New quote for the customer', model: tabCase({ kinds: NONE, quoteRows: [], incomingRows: [] }), note: 'The New buttons move into the card (never twice): the band\'s head has none.' },
    { id: 'all-closed', label: 'Everything closed: each list says so, the closed groups as doors', model: tabCase({ kinds: CLOSED_ONLY, quoteRows: [], incomingRows: [] }), note: 'Won 1 · Moved to a quote 2 · Lost 3 — each a door that opens exactly those rows.' },
    { id: 'counts-failed', label: 'The counts could not be read: the band says so, the lists still draw', model: { ...busy, counts: null, failed: true } },
    // ---- opened from a door
    { id: 'door-to-answer', label: 'Opened from the door To answer (the Work line, the shell badge): the requests and portal orders that wait on us', model: doorCase('TO_ANSWER', [], [OVERDUE, PORTAL, ASSIGNED]), note: 'The chip: To answer · 3, why it holds them, ✕ and Show everything; Quotes folds to one line.' },
    { id: 'door-lost', label: 'Opened from the door Lost: the lost quotes and the ended requests', model: doorCase('LOST', LOST_QUOTES, ENDED_INCOMING) },
    { id: 'door-writing', label: 'Opened from the door Customer is writing: the drafts; both lists fold', model: doorCase('WRITING', [], []) },
    { id: 'door-order-waits', label: 'Opened from the door Order waits: the accepted quote whose order waits, with why', model: doorCase('ORDER_WAITS', [ORDER_WAITS_QUOTE], []) },
    // ---- each role
    { id: 'role-sales', label: 'Sales (no money): every list, no amount anywhere; Preview PDF and New link not drawn', model: salesCase },
    { id: 'role-finance', label: 'Finance: Quotes and the drafts; no Requests section (one quiet line)', model: financeCase },
    { id: 'role-viewer', label: 'Read-only: both lists, no New button, no act', model: viewerCase },
    { id: 'role-production', label: 'Production manager: Requests & portal orders only (no target price); Quotes is one quiet line', model: productionCase },
    // ---- rows ticked on each bar (3 + More ▾; never an act for a missing right; held with words by the rows' state)
    { id: 'bar-owner-quotes', label: 'Bar, Owner, Quotes: Ask Seed Customer One about 3… · Add task to 3… · Cancel 2 quotes…, More ▾ (Ask for approval on 1… · Make the orders for 1… · Send a new link to 1…)', note: 'The accepted quote is ticked too: Cancel counts only the open ones; its window says why the other is not on.', model: ticked(busy, [ORDER_WAITS_QUOTE, REVISED_QUOTE, SENT_QUOTE]) },
    { id: 'bar-owner-incoming', label: 'Bar, Owner, Incoming: Assign 2… · Ask Seed Customer One about 2… · Decline 2…, More ▾ (Mark 2 lost… · Reply to Seed Customer One on 3… · Add task to 3…); a portal order ticked: one line', model: ticked(busy, [], [OVERDUE, ASSIGNED, PORTAL]) },
    { id: 'bar-sales', label: 'Bar, Sales: Ask … about 2… · Add task · Cancel; More ▾ without Send a new link (no prices)', model: ticked(salesCase, [REVISED_QUOTE, SENT_QUOTE], [OVERDUE]) },
    { id: 'bar-finance', label: 'Bar, Finance: Reply to … on 2… (no to-do: it does not make the customer\'s to-dos) · Add task to 2…', model: ticked(financeCase, [REVISED_QUOTE, APPROVAL_QUOTE]) },
    { id: 'bar-viewer', label: 'Bar, Read-only: no act — one line says the role changes none (Export N stays)', model: ticked(viewerCase, [REVISED_QUOTE], [OVERDUE]) },
    { id: 'bar-production', label: 'Bar, Production manager: Reply and Add task only on Incoming (no request act)', model: ticked(productionCase, [], [OVERDUE, NEED_INFO]) },
    { id: 'bar-held', label: 'Bar, held by the state: an accepted quote ticked alone — Cancel and Ask for approval held, in words', model: ticked(busy, [WON_QUOTE]) },
    // ---- every window
    { id: 'win-cancel', label: 'Cancel 3 quotes: Runs on 2 · Not on 1 (closed), a reason for the sent one', model: withQuotes(busy, { many: quoteWindow('cancel', [REVISED_QUOTE, SENT_QUOTE, WON_QUOTE]) }) },
    { id: 'win-ask-approval', label: 'Ask for approval on 2: drafts only (one waits already, why beside it)', model: withQuotes(busy, { many: quoteWindow('askApproval', [REVISED_QUOTE, FROM_PORTAL_QUOTE, APPROVAL_QUOTE]) }) },
    { id: 'win-make-orders', label: 'Make the orders for 2: the PO number typed where the terms need one; the account on hold and the one with its order Not on', model: withQuotes(busy, { many: quoteWindow('makeOrders', [ORDER_WAITS_QUOTE, quoteOf(chip(58), '0017', { id: '0190f0e2-9999-7000-8000-0000000001c7', versionId: '0190f0e2-9999-7000-8000-0000000001d7', order: { ...chip(58).order!, reason: 'NOT_MADE' } }), quoteOf(chip(59), '0018'), WON_QUOTE], { fields: { [ORDER_WAITS_QUOTE.id]: 'PO-SEED-7' } }) }) },
    { id: 'win-new-link', label: 'Send a new link to 1: sent quotes only (prices: the Owner)', model: withQuotes(busy, { many: quoteWindow('newLink', [SENT_QUOTE, REVISED_QUOTE]) }) },
    { id: 'win-mark-lost', label: 'Mark 2 lost: one note on each; the portal order is answered on its own', model: withIncoming(busy, { many: incomingWindow('lost', [OVERDUE, ASSIGNED, PORTAL], { typed: 'They chose another maker' }) }) },
    { id: 'win-ask-about', label: 'Ask Seed Customer One about 2 requests: one question; one asked already', model: withIncoming(busy, { many: incomingWindow('askInfo', [OVERDUE, ASSIGNED, NEED_INFO], { typed: 'Which sizes for the second colour?' }) }) },
    {
      id: 'win-receipt',
      label: 'The receipt: 1 done · 1 not done (changed meanwhile), each record named; Run the rest again (1)',
      model: withQuotes(busy, {
        many: quoteWindow('cancel', [REVISED_QUOTE, SENT_QUOTE], {
          typed: 'The customer moved the season',
          results: [
            { id: REVISED_QUOTE.id, label: REVISED_QUOTE.number, href: null, done: true, words: { ns: 'before-order', key: 'acts.done.cancelled' } },
            { id: SENT_QUOTE.id, label: SENT_QUOTE.number, href: null, done: false, words: { ns: 'orders-sheet', key: 'commands.many.stale', params: { number: SENT_QUOTE.number } } },
          ],
        }),
      }),
    },
    { id: 'win-assign', label: 'Assign 2: the plan (Runs on 2 · 1 of another kind left out) and a refusal that names the request', model: withIncoming(busy, { bulk: { ...BULK_ASSIGN, model: { ...BULK_ASSIGN.model, notice: { key: 'refusal.other', tone: 'danger', lines: [{ key: 'bulk.refusedOne', params: { number: ASSIGNED.number } }] } } } as InquiriesModel['bulk'] }) },
    { id: 'win-decline', label: 'Decline 2: the reason; the true words (no message goes; each portal request tells its customer)', model: withIncoming(busy, { bulk: BULK_DECLINE }) },
    // ---- F-CQ-304: the Orders sheet's Reply-to-N window given the quotes / the requests (their own conversations and words)
    { id: 'win-ask-quotes', label: 'Ask Seed Customer One about 3 quotes: one message, each quote\'s own conversation, the to-do tick ON ("Your quote 3 …")', model: withQuotes(busy, { reply: replyOf([ORDER_WAITS_QUOTE, REVISED_QUOTE, SENT_QUOTE], 'Quote', true) }) },
    { id: 'win-reply-requests', label: 'Reply to Seed Customer One on 3: two requests and a portal order, each its own conversation (no to-do from here)', model: withIncoming(busy, { reply: replyOf([OVERDUE, ASSIGNED, PORTAL].map(replyRowOf), (row) => (row.id === PORTAL.id ? 'PortalOrderRequest' : 'Inquiry'), false) }) },
    { id: 'win-add-task', label: 'Add task to 3 quotes: Assign to starts on "Me", each name a door', model: withQuotes(busy, { tasks: { records: [ORDER_WAITS_QUOTE, REVISED_QUOTE, SENT_QUOTE].map((row) => ({ type: 'Quote', id: row.id, label: row.number, supervisor: null })), people: { status: 'ready', data: PEOPLE } } }) },
    { id: 'win-make-quote', label: 'Make quote… on a request row: the request\'s own window, here (no page hop)', model: withIncoming(busy, { verb: incomingRecord(VERB_VIEW, { dialog: { kind: 'quote', customerRef: '', busy: false, notice: null } }) }) },
    { id: 'win-decline-one', label: 'Decline… on a request row: its own window, here', model: withIncoming(busy, { verb: incomingRecord(VERB_VIEW, { dialog: { kind: 'decline', draft: emptyDecline, busy: false, notice: null } }) }) },
    { id: 'win-accept-order', label: 'Accept as order… on a portal order row: its own window, here', model: withIncoming(busy, { catalogueVerb: catalogueModel({ loaded: { status: 'ready', value: PORTAL_RECORD }, dialog: { kind: 'accept', draft: acceptDraftOf(PORTAL_RECORD, 'ORDER', { price: true }), busy: false, notice: null } }) }) },
    { id: 'win-accept-quote', label: 'Accept as quote… on a portal order row: a draft quote at today\'s list prices', model: withIncoming(busy, { catalogueVerb: catalogueModel({ loaded: { status: 'ready', value: PORTAL_RECORD }, dialog: { kind: 'accept', draft: acceptDraftOf(PORTAL_RECORD, 'QUOTE', { price: true }), busy: false, notice: null } }) }) },
    { id: 'win-refuse', label: 'Refuse… on a portal order row: why, the customer reads it', model: withIncoming(busy, { catalogueVerb: catalogueModel({ loaded: { status: 'ready', value: PORTAL_RECORD }, dialog: { kind: 'refuse', reason: '', busy: false, notice: null } }) }) },
    { id: 'win-revise-expired', label: 'Make revision 2… from an expired quote (the quote page\'s own window, on its row)', model: withQuotes(busy, { quoteDialog: quoteDialogOn('revise', detailOf(EXPIRED_QUOTE.number, 'EXPIRED')) }) },
    { id: 'win-approve', label: 'Approve… on a row waiting for approval (the asker never decides: said inside)', model: withQuotes(busy, { quoteDialog: quoteDialogOn('approve', PENDING_QUOTE) }) },
    { id: 'win-reject', label: 'Reject… on a row waiting for approval: a reason', model: withQuotes(busy, { quoteDialog: quoteDialogOn('reject', PENDING_QUOTE) }) },
    // ---- the menus (open them in the frame)
    { id: 'more-quotes', label: 'More ▾ on the Quotes bar (open it): Ask for approval on 1… · Make the orders for 1… · Send a new link to 1…', model: ticked(busy, [ORDER_WAITS_QUOTE, REVISED_QUOTE, SENT_QUOTE]), note: 'Open More ▾ in the bar.' },
    { id: 'more-incoming', label: 'More ▾ on the Incoming bar (open it): Mark 2 lost… · Reply to Seed Customer One on 3… · Add task to 3…', model: ticked(busy, [], [OVERDUE, ASSIGNED, PORTAL]), note: 'Open More ▾ in the bar.' },
    { id: 'row-menu', label: 'Row ⋯ by kind (open one): a draft quote, one waiting for approval, a sent one, an accepted one whose order waits; a request; a portal order', model: busy, note: 'Each next step only with its right, held by the row\'s state; Cancel quote… last (danger); a portal order: Accept as order… / Accept as quote… / Refuse….' },
    { id: 'sort', label: 'Sort ▾ (open it): Most urgent first, Newest first, Valid until soonest', model: busy, note: 'Open Sort ▾ on either list: its title says the rule.' },
    { id: 'customise', label: 'Customise the Quotes list\'s columns (this tab keeps its own layout)', model: { ...busy, tools: { ...TOOLS, design: { dialog: 'customise' } } } },
    // ---- widths
    { id: 'phone', label: 'On a phone (open at Phone 375): ONE card per row, a door to its thread', model: tabCase({ room: 375 }), note: 'Open this case at Phone 375: the band\'s doors in a 2-column grid, the short New words, each row one card.' },
    { id: 'room-779', label: 'The tab\'s room 779 px (a dock open beside it): the base row, the date folds under the chips', model: tabCase({ room: 779 }) },
    { id: 'room-863', label: 'The tab\'s room 863 px: + Valid until', model: tabCase({ room: 863 }) },
    { id: 'room-1067', label: 'The tab\'s room 1067 px: + Updated, Pieces', model: tabCase({ room: 1067 }) },
    { id: 'dark', label: 'Dark (open with the dark theme): the band\'s amber doors, the chips, the closed doors', model: busy, note: 'Open this case with the dark theme.' },
  ],
})
