import { createElement, useEffect, useState } from 'react'
import { DEMO_COMPANIES } from '../../../shell/design-data'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import {
  ASSIGNEES,
  // B-TH-233: every kind of row, the catalogue order beside the list, Customer replies.
  CATALOGUE_RECORD,
  CATALOGUE_ROW,
  CHANGE_ROW,
  INCOMING_ROWS,
  repliesOf,
  canFor,
  COMPANY_ID,
  CONTACTS,
  CUSTOMERS,
  DECLINED_VIEW,
  DEMO_PICTURES,
  demoThreadElement,
  inShell,
  JACKET_DETAIL,
  listOf,
  ME,
  NOW,
  PANTS_DETAIL,
  PREFIX,
  PROSPECT_VIEW,
  QUOTED_VIEW,
  ROWS,
  STYLE_OPTIONS,
  VIEW,
  type RoleCase,
} from './demo/fixtures'
import { emptyDecline, emptyLine, HOME_ADDRESS, requestDraftOf, type InquiryTile, type ListAddress, type RecordTab } from './model'
import { acceptDraftOf, type CatalogueModel } from './catalogue-model'
import type { AddressesModel } from './addresses/model' // B-TH-285
import type { InquiryView } from './api'
import type { InquiryRecordModel, RecordDialog } from './record-model'
import { InquiriesView, type BulkDialog, type InquiriesModel } from './view/InquiriesView'

/**
 * SCR-105 — Sales › Inquiries (design sales.inquiries, an inbox), made-up data only: the tiles (each a saved filter), the notices
 * (one at a time, the rest behind "N more notices"), the list in the shared frame (rows selected: Assign to… and Decline N with
 * the closed ones left out), the inquiry in its DetailModal (Request — editable, changed with the EditModeBar, a prospect to
 * match —, Files & specs with the tech pack in force, Quote not yet / made, Activity), Assign, Decline (Other without words held; a selection), Mark as lost,
 * Make quote (what goes over, what is left out; a prospect held), the receipts, empty, filtered, loading, failed, offline, the
 * keys, and the role cases (sales, a reader without changes or prices, the warehouse without access).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: InquiriesModel
}

const at = (over: Partial<ListAddress>): ListAddress => ({ ...HOME_ADDRESS, ...over })

function record(view: InquiryView | null, over: Partial<InquiryRecordModel> = {}, role: RoleCase = 'owner'): InquiryRecordModel {
  return {
    prefix: PREFIX,
    me: ME,
    can: canFor(role),
    live: 'live',
    loaded: view ? { status: 'ready', value: view } : { status: 'loading' },
    tab: 'request',
    draft: null,
    saving: false,
    busy: false,
    contacts: view?.party ? { items: CONTACTS, problem: null } : null,
    styles: { items: STYLE_OPTIONS, problem: null },
    details: { [JACKET_DETAIL.id]: { status: 'ready', value: JACKET_DETAIL }, [PANTS_DETAIL.id]: { status: 'ready', value: PANTS_DETAIL } },
    stale: null,
    notice: null,
    dialog: null,
    pictures: false,
    ...over,
  }
}

function page(over: Partial<InquiriesModel> = {}, role: RoleCase = 'owner'): DesignModel {
  return {
    role,
    model: {
      prefix: PREFIX,
      me: ME,
      companyId: COMPANY_ID,
      can: canFor(role),
      address: HOME_ADDRESS,
      list: listOf(),
      problem: null,
      customers: CUSTOMERS,
      asOf: NOW,
      live: 'live',
      updates: 0,
      notice: null,
      dismissed: [],
      newRequest: null,
      bulk: null,
      detail: null,
      // B-TH-216: one company (no Company column), the rows' small previews.
      companies: DEMO_COMPANIES.slice(0, 1).map((entry) => ({ id: entry.id, name: entry.name, code: entry.code })),
      // B-TH-233: the built pages a Customer replies row opens (its record's own page, else its panels).
      built: ['/sales/orders/[id]', '/sales/quotes/[id]', '/sales/incoming'],
      noticeFacts: {},
      demoPictures: DEMO_PICTURES,
      ...over,
    },
  }
}

const open = (view: InquiryView, tab: RecordTab = 'request', over: Partial<InquiryRecordModel> = {}, role: RoleCase = 'owner'): DesignModel => ({
  ...page({ address: at({ open: view.id, tab }), detail: record(view, { tab, ...over }, role) }, role),
})
const dialog = (view: InquiryView, value: RecordDialog, tab: RecordTab = 'request'): DesignModel => open(view, tab, { dialog: value })
// ── B-TH-233: a row's key in the grid and the selection; the catalogue order beside the list ──
const keyOf = (row: { id: string }): string => `REQUEST:${row.id}`
function catalogueModel(over: Partial<CatalogueModel> = {}, role: RoleCase = 'owner'): CatalogueModel {
  return { prefix: PREFIX, can: canFor(role), offline: false, loaded: { status: 'ready', value: CATALOGUE_RECORD }, notice: null, dialog: null, handled: null, ...over }
}
const catalogueOpen = (over: Partial<CatalogueModel> = {}, role: RoleCase = 'owner', list = listOf()): DesignModel => page({ address: at({ catalogue: CATALOGUE_ROW.id }), list, catalogue: catalogueModel(over, role) }, role)
const ACCEPTED_RECORD = { ...CATALOGUE_RECORD, request: { ...CATALOGUE_RECORD.request, status: 'ACCEPTED' as const, words: { it: 'Confermata', en: 'Confirmed' }, decidedAt: NOW, decidedBy: 'Marco Demo', salesOrder: { id: '0190f0e2-5502-7000-8000-000000000009', number: 'SO-DEMO-00009' } }, may: { order: false, quote: false, refuse: false } }
const tile = (id: InquiryTile, rows: typeof ROWS): Partial<InquiriesModel> => ({ address: at({ tile: id }), list: listOf(rows) })

const assignDialog = (people: Extract<RecordDialog, { kind: 'assign' }>['people'] = { status: 'ready', value: ASSIGNEES }): RecordDialog => ({ kind: 'assign', people, busy: false, notice: null })
// ── end B-TH-233 ──
// ── B-TH-285: the inquiry addresses (made-up, at the demo company's receiving domain) ──
const ADDRESSES: AddressesModel = { loaded: { status: 'ready', value: { companyId: COMPANY_ID, answer: { addresses: ['orders@demo.example.com', 'rfq@demo.example.com'], source: 'COMPANY', version: 2, hasOwnSettings: true, mayManage: true } } }, draft: ['orders@demo.example.com', 'rfq@demo.example.com'], adding: '', domains: ['demo.example.com'], live: false, busy: false, problem: null, saved: false, offline: false }
const DOOR = { key: 'addresses.door.notLive', params: { count: 2 } }
// ── end B-TH-285 ──
const BULK_ASSIGN: BulkDialog = { kind: 'assign', ids: [ROWS[0]!.id, ROWS[3]!.id], model: { subject: { key: 'bulk.subject', params: { count: 2 } }, current: null, people: { status: 'ready', value: ASSIGNEES }, busy: false, notice: null, offline: false } }
const BULK_DECLINE: BulkDialog = { kind: 'decline', ids: [ROWS[0]!.id, ROWS[3]!.id], model: { subject: { key: 'bulk.subject', params: { count: 2 } }, draft: { ...emptyDecline, reason: 'CAPACITY' }, message: { to: null, held: { key: 'decline.message.many' } }, busy: false, notice: null, offline: false } }

function ListDesign({ model }: { model: DesignModel }) {
  const [state, setState] = useState(model.model)
  useEffect(() => setState(model.model), [model])
  // B-TH-217: the open request's thread in the reading pane (made-up messages; nothing is sent).
  const view = createElement(InquiriesView, {
    model: state,
    slots: state.detail ? { thread: demoThreadElement() } : state.catalogue ? { catalogueThread: demoThreadElement() } : undefined,
    actions: {
      onAddress: (patch) => setState((now) => ({ ...now, address: { ...now.address, ...patch } })),
      onClearFilters: () => setState((now) => ({ ...now, address: HOME_ADDRESS })),
      // B-TH-233: a catalogue order opens its own pane; a request the request's.
      onOpen: (id) =>
        setState((now) =>
          id === CATALOGUE_ROW.id
            ? { ...now, address: { ...now.address, open: null, catalogue: id }, detail: null, catalogue: catalogueModel() }
            : { ...now, address: { ...now.address, open: id, catalogue: null }, catalogue: null, detail: id === null ? null : record([VIEW, PROSPECT_VIEW, QUOTED_VIEW, DECLINED_VIEW].find((one) => one.id === id) ?? { ...VIEW, ...ROWS.find((one) => one.id === id)! }) },
        ),
      onOpenRow: (row) => setState((now) => (row.kind === 'CATALOGUE_ORDER' ? { ...now, address: { ...now.address, open: null, catalogue: row.id }, detail: null, catalogue: catalogueModel() } : row.kind === 'REQUEST' ? { ...now, address: { ...now.address, open: row.id, catalogue: null }, catalogue: null, detail: record([VIEW, PROSPECT_VIEW, QUOTED_VIEW, DECLINED_VIEW].find((one) => one.id === row.id) ?? { ...VIEW, ...ROWS.find((one) => one.id === row.id)! }) } : now)),
      catalogue: {
        onAccept: (as) => setState((now) => (now.catalogue ? { ...now, catalogue: { ...now.catalogue, dialog: { kind: 'accept', draft: acceptDraftOf(CATALOGUE_RECORD, as, now.can), busy: false, notice: null } } } : now)),
        onRefuse: () => setState((now) => (now.catalogue ? { ...now, catalogue: { ...now.catalogue, dialog: { kind: 'refuse', reason: '', busy: false, notice: null } } } : now)),
        onReason: (reason) => setState((now) => (now.catalogue?.dialog?.kind === 'refuse' ? { ...now, catalogue: { ...now.catalogue, dialog: { ...now.catalogue.dialog, reason } } } : now)),
        onCloseDialog: () => setState((now) => (now.catalogue ? { ...now, catalogue: { ...now.catalogue, dialog: null } } : now)),
        onSubmit: () => setState((now) => (now.catalogue ? { ...now, catalogue: { ...now.catalogue, dialog: null } } : now)),
      },
      // B-TH-221: New request has its own design screen, SCR-105-new.
      onBulk: (kind) => setState((now) => ({ ...now, bulk: kind === 'assign' ? BULK_ASSIGN : BULK_DECLINE })),
      bulk: { onClose: () => setState((now) => ({ ...now, bulk: null })), onSubmit: () => setState((now) => ({ ...now, bulk: null })), onAssign: () => setState((now) => ({ ...now, bulk: null })) },
      record: {
        onTab: (tab) => setState((now) => (now.detail ? { ...now, detail: { ...now.detail, tab } } : now)),
        onDraft: (patch) => setState((now) => (now.detail && now.detail.loaded.status === 'ready' ? { ...now, detail: { ...now.detail, draft: { ...(now.detail.draft ?? requestDraftOf(now.detail.loaded.value)), ...patch } } } : now)),
        onLines: (lines) => setState((now) => (now.detail && now.detail.loaded.status === 'ready' ? { ...now, detail: { ...now.detail, draft: { ...(now.detail.draft ?? requestDraftOf(now.detail.loaded.value)), lines } } } : now)),
        onDiscard: () => setState((now) => (now.detail ? { ...now, detail: { ...now.detail, draft: null } } : now)),
        onVerb: (verb) =>
          setState((now) =>
            now.detail
              ? { ...now, detail: { ...now.detail, dialog: verb === 'assign' ? assignDialog() : verb === 'decline' ? { kind: 'decline', draft: emptyDecline, busy: false, notice: null } : verb === 'lost' ? { kind: 'lost', note: '', busy: false, notice: null } : verb === 'quote' ? { kind: 'quote', customerRef: '', busy: false, notice: null } : null } }
              : now,
          ),
        dialog: {
          onClose: () => setState((now) => (now.detail ? { ...now, detail: { ...now.detail, dialog: null } } : now)),
          onDecline: (patch) => setState((now) => (now.detail?.dialog?.kind === 'decline' ? { ...now, detail: { ...now.detail, dialog: { ...now.detail.dialog, draft: { ...now.detail.dialog.draft, ...patch } } } } : now)),
          onSubmit: () => setState((now) => (now.detail ? { ...now, detail: { ...now.detail, dialog: null } } : now)),
        },
        onDismissNotice: () => setState((now) => (now.detail ? { ...now, detail: { ...now.detail, notice: null } } : now)),
      },
      onDismissNotice: () => setState((now) => ({ ...now, notice: null })),
      onDismissPageNotice: (key) => setState((now) => ({ ...now, dismissed: [...now.dismissed, key] })),
    },
  })
  return inShell('/sales/incoming', view, model.role)
}

const OPEN_ROWS = ROWS.filter((one) => ['NEW', 'ASSIGNED', 'NEED_INFO'].includes(one.status))
// B-TH-230: the reader's own new messages on two requests (made-up times).
const UNREAD = { [ROWS[0]!.id]: { newCount: 2, lastAt: '2026-11-17T09:42:00.000Z' }, [ROWS[2]!.id]: { newCount: 120, lastAt: '2026-11-16T15:10:00.000Z' } }
const CHANGED = { ...requestDraftOf(VIEW), wantedDate: '2027-01-27', targetPrice: '142', lines: [...requestDraftOf(VIEW).lines, { ...emptyLine('demo-3'), description: 'Kidney belt in black', quantity: '20' }] }

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-105',
  title: 'Incoming',
  view: ListDesign,
  holdsPage: true,
  cases: [
    // ── B-TH-216 (threads plan TH-1b): Sales › Incoming — every request of every customer on one page, every cell a door ──
    { id: 'th-216-incoming', label: 'TH-1b · Incoming: the band (Incoming · 3 open · as of), five tiles, Picture, Customer (a prospect marked new), Subject, Files, Quantity, Wanted, Received, Waiting, Owner by name, State, Source, Number', model: page(), note: 'Every cell is a door: Customer → the customer (peek on rest), Subject / Number → the request, Picture → the picture large, Files → its files, State / Source narrow the list. The rest of a row opens the request (⌘: a new tab). Keys only in the footer icon.' },
    { id: 'th-216-all', label: 'TH-1b · Rows ▾ All: closed requests with their quote (a door) or the decline reason', model: page({ address: at({ tile: 'ALL' }), list: listOf(ROWS) }) },
    { id: 'th-216-state', label: 'TH-1b · The State cell narrowed the list to "In progress" (its chip)', model: page({ address: at({ tile: 'ALL', status: 'ASSIGNED' }), list: listOf(ROWS.filter((one) => one.status === 'ASSIGNED')) }) },
    { id: 'th-216-picture', label: 'TH-1b · The picture large (the small preview, Open style, the request names 2 styles)', model: page({ viewer: ROWS[1]!.id }) },
    { id: 'th-216-numbering', label: 'TH-1b · One notice: requests by portal and mail are off for a company (no request numbering), 2 more behind', model: page({ list: listOf(OPEN_ROWS, false), noticeFacts: { numberingMissing: [DEMO_COMPANIES[0].name], mailToSort: { count: 4, more: false } } }) },
    { id: 'th-216-mail', label: 'TH-1b · One notice: 4 mails wait in Mail to sort (Open)', model: page({ noticeFacts: { mailToSort: { count: 4, more: false } } }) },
    { id: 'th-216-companies', label: 'TH-1b · Two companies: the Company column (a funnel) and its chip', model: page({ companies: DEMO_COMPANIES.map((entry) => ({ id: entry.id, name: entry.name })), address: at({ company: DEMO_COMPANIES[0].id }) }) },
    { id: 'th-216-production', label: 'TH-1b · The production manager: reads every request, no target price, every sales action held "Needs the sales permission"', model: page({ selected: [keyOf(ROWS[0]!)] }, 'production') },
    // ── end B-TH-216 ──
    // ── B-TH-230 (TH-2): New messages (the reader's own) and the Waiting column amber by the one rule ──
    { id: 'th-230-new-messages', label: 'TH-2 · New messages: "● 2 new · 10:42" on the requests the customer answered; the Waiting column amber past 1 working day', model: page({ unread: UNREAD }), note: 'One read for the page (POST /threads/unread, ≤ 200 rows); a count only on rows you may open; the cell opens the request beside the list with its thread at the first new message. Waiting on us past 1 working day is amber (the one rule: the thread head and Today say the same); waiting on the customer is never amber.' },
    // ── end B-TH-230 ──
    // ── B-TH-233 (TH-3): Incoming over every door — requests, catalogue orders and change requests in one list; Customer replies ──
    { id: 'th3-233-kinds', label: 'TH-3 · Every door in one list: requests, a catalogue order (opens beside the list) and a change request (opens Home › Approvals), each with its kind mark; the tiles count every kind', model: page({ address: at({ tile: 'ALL' }), list: listOf(INCOMING_ROWS) }), note: 'A row is listed only to a reader who may open it (its kind\'s own view right): the production manager reads requests; a reader without orders.view never sees a catalogue order or a change request (the API leaves them out and does not count them).' },
    { id: 'th3-233-kind-chip', label: 'TH-3 · The Kind filter narrowed the list to catalogue orders (its chip)', model: page({ address: at({ tile: 'ALL', kind: 'CATALOGUE_ORDER' }), list: listOf([CATALOGUE_ROW]) }) },
    { id: 'th3-233-catalogue', label: 'TH-3 · A catalogue order beside the list: Accept as order (main), Accept as quote, Refuse; their PO, the date asked, the ship-to waiting for its check, the lines (a size no longer offered named), the thread', model: catalogueOpen() },
    { id: 'th3-233-catalogue-accept', label: 'TH-3 · Accept as order: the promise date, a price per line (the price the customer was shown filled in)', model: catalogueOpen({ dialog: { kind: 'accept', draft: acceptDraftOf(CATALOGUE_RECORD, 'ORDER', canFor('owner')), busy: false, notice: null } }) },
    { id: 'th3-233-catalogue-refuse', label: 'TH-3 · Refuse: the words the customer reads, previewed', model: catalogueOpen({ dialog: { kind: 'refuse', reason: 'We cannot make the sand jackets before March: we will send a quote for March.', busy: false, notice: null } }) },
    { id: 'th3-233-catalogue-decided', label: 'TH-3 · A catalogue order accepted as SO-…: the outcome line, no actions; the receipt opens the order', model: catalogueOpen({ loaded: { status: 'ready', value: ACCEPTED_RECORD }, notice: { key: 'catalogue.done.order', params: { made: 'SO-DEMO-00009', number: CATALOGUE_ROW.number }, tone: 'success', link: { href: '#', label: { key: 'catalogue.done.open', params: { made: 'SO-DEMO-00009' } } } } }) },
    { id: 'th3-233-catalogue-production', label: 'TH-3 · The production manager opens a catalogue order: every action held "Only sales can accept or refuse a catalogue order", no prices', model: catalogueOpen({}, 'production') },
    { id: 'th3-233-catalogue-gone', label: 'TH-3 · A catalogue order this reader may not open: "not found" — never that it exists', model: catalogueOpen({ loaded: { status: 'notFound' } }) },
    { id: 'th3-233-selected-mixed', label: 'TH-3 · A selection over every kind: Assign and Decline reach the requests only, the other kinds left out and said', model: page({ address: at({ tile: 'ALL' }), list: listOf(INCOMING_ROWS), selected: [keyOf(ROWS[0]!), CATALOGUE_ROW.key, CHANGE_ROW.key] }) },
    { id: 'th3-233-companies', label: 'TH-3 · Two companies: every number carries its company\'s code (list-F12), the Company column', model: page({ companies: DEMO_COMPANIES.map((entry) => ({ id: entry.id, name: entry.name, code: entry.code })), wide: true, address: at({ tile: 'ALL' }), list: listOf(INCOMING_ROWS) }) },
    { id: 'th3-233-replies', label: 'TH-3 · Customer replies: the conversations on orders, quotes and returns whose last shared message is the customer\'s; each opens its record at that message; amber past the rule\'s days', model: page({ address: at({ tile: 'CUSTOMER_REPLIES' }), list: listOf([]), replies: repliesOf() }), note: 'One office inbox (no new page): each row is listed only when the reader may open its record (threads.read and the record\'s own view right, checked by the API row by row). Our reply takes the row off.' },
    { id: 'th3-233-replies-empty', label: 'TH-3 · Customer replies: nothing waits on us', model: page({ address: at({ tile: 'CUSTOMER_REPLIES' }), list: listOf([]), replies: repliesOf([]) }) },
    { id: 'th3-233-replies-partial', label: 'TH-3 · Customer replies: more than one read keeps (the count says so), Show more', model: page({ address: at({ tile: 'CUSTOMER_REPLIES' }), list: listOf([]), replies: repliesOf(undefined, false, 'next-page'), more: { next: true, busy: false, problem: null, page: 100 } }) },
    { id: 'th3-233-replies-noright', label: 'TH-3 · Customer replies without threads.read: said, nothing listed', model: page({ address: at({ tile: 'CUSTOMER_REPLIES' }), list: listOf([]), replies: null, can: { ...canFor('owner'), thread: false } }) },
    // ── end B-TH-233 ──
    // ── B-TH-285 (TH-8): inquiry addresses in Incoming's ⋯, the band while the orders@ door is not open ──
    { id: 'th3-285-door', label: 'TH-8 · The band says the mail door is not open yet: 2 inquiry addresses wait for live mail receiving (a go-live step)', model: page({ addresses: { open: false, model: ADDRESSES, door: DOOR } }) },
    { id: 'th3-285-addresses', label: 'TH-8 · ⋯ Inquiry addresses: mail to them becomes a request by itself (unknown senders as prospects); at most 20, at the company\'s receiving domain', model: page({ addresses: { open: true, model: ADDRESSES, door: DOOR } }) },
    { id: 'th3-285-addresses-problems', label: 'TH-8 · Problems in words before Save (another domain, twice); a refused save names its rows (another company\'s address)', model: page({ addresses: { open: true, model: { ...ADDRESSES, draft: ['orders@demo.example.com', 'sales@elsewhere.example.org', 'ORDERS@demo.example.com'], problem: { phrase: { key: 'addresses.problem.rows' }, rows: { 0: { key: 'addresses.problem.taken' } } } }, door: DOOR } }) },
    { id: 'th3-285-addresses-read', label: 'TH-8 · A reader without the sales settings right: the addresses read-only, the shared list said', model: page({ addresses: { open: true, model: { ...ADDRESSES, loaded: { status: 'ready', value: { companyId: null, answer: { addresses: ['orders@demo.example.com'], source: 'TENANT', version: 4, hasOwnSettings: true, mayManage: false } } }, draft: ['orders@demo.example.com'] }, door: null } }, 'sales') },
    { id: 'th3-285-addresses-clash', label: 'TH-8 · Someone changed the addresses meanwhile: read again, said', model: page({ addresses: { open: true, model: { ...ADDRESSES, problem: { phrase: { key: 'addresses.problem.stale' }, rows: {} } }, door: DOOR } }) },
    // ── end B-TH-285 ──
    { id: 'inbox', label: 'The queue: open inquiries, the oldest waiting first; tiles, waiting in working time, "You" / "A colleague"', model: page(), note: 'Enter opens the inquiry in its DetailModal; x / Space select; ⋯ and right-click the verbs. Keys only in the footer icon.' },
    { id: 'tile-new', label: 'Tile: New (its chip in the filter row)', model: page(tile('NEW', OPEN_ROWS.filter((one) => one.status === 'NEW'))) },
    { id: 'tile-waiting-us', label: 'Tile: Waiting for us over 1 working day', model: page(tile('WAITING_US', OPEN_ROWS.filter((one) => one.waiting.overdue))) },
    { id: 'tile-waiting-customer', label: 'Tile: Waiting for the customer', model: page(tile('WAITING_CUSTOMER', OPEN_ROWS.filter((one) => one.status === 'NEED_INFO'))) },
    { id: 'tile-quoted-week', label: 'Tile: Quoted this week', model: page(tile('QUOTED_THIS_WEEK', [ROWS[4]!])) },
    { id: 'all-rows', label: 'Rows ▾ All: closed ones with their quote or the decline reason', model: page({ address: at({ tile: 'ALL' }), list: listOf(ROWS) }) },
    { id: 'filtered', label: 'Filters as chips: source Phone, a search (Clear all)', model: page({ address: at({ source: 'PHONE', q: 'trousers' }), list: listOf([ROWS[0]!]) }) },
    { id: 'selected', label: 'Two rows selected: Assign 2, Decline 2, Export 2', model: page({ selected: [keyOf(ROWS[0]!), keyOf(ROWS[3]!)] }) },
    { id: 'selected-closed', label: 'A selection with closed rows: they are left out of Assign and Decline (said before the click)', model: page({ address: at({ tile: 'ALL' }), list: listOf(ROWS), selected: [keyOf(ROWS[0]!), keyOf(ROWS[4]!), keyOf(ROWS[5]!)] }) },
    { id: 'notices', label: 'Notices: the count is partial (one shown, "1 more notice")', model: page({ list: listOf(OPEN_ROWS, false) }) },
    { id: 'notices-open', label: 'Every notice listed (partial count, prospects to match), each dismissed by its value', model: page({ list: listOf(OPEN_ROWS, false), noticesOpen: true }) },
    { id: 'detail', label: 'TH-1b · The reading pane: row 1 (picture · customer — subject · state · owner · 2 of 3 · ⋯ · ×), the actions, the customer\'s words first, the thread, Details', model: open(VIEW), note: 'Q make quote, A assign, D decline, J / K the next and previous request (outside the feed), Esc closes; ⋯ Open full page is a new tab.' },
    { id: 'detail-changed', label: 'TH-1b · The pane while the request is being edited (Edit the request holds the EditModeBar)', model: open(VIEW, 'request', { draft: CHANGED }) },
    { id: 'detail-prospect', label: 'TH-1b · A prospect marked new: the prospect block with its lawful basis; replies wait for "Make the customer first"', model: open(PROSPECT_VIEW) },
    { id: 'detail-quote-made', label: 'TH-1b · Made from it: the quote with its own status and value; the closed line', model: open(QUOTED_VIEW) },
    { id: 'detail-closed', label: 'A declined inquiry: read-only but for its note, the reason and who', model: open(DECLINED_VIEW) },
    { id: 'detail-stale', label: 'Changed by someone while typing: Reload (the typing is kept until then)', model: open(VIEW, 'request', { draft: CHANGED, stale: '10:41' }) },
    { id: 'detail-refused', label: 'Apply refused: our words, the field named', model: open(VIEW, 'request', { draft: CHANGED, notice: { key: 'problem.invalid', tone: 'danger', lines: [{ key: 'field.lineAt', params: { n: 5 } }] } }) },
    { id: 'detail-loading', label: 'The inquiry being read', model: { ...page({ address: at({ open: VIEW.id }), detail: record(null) }) } },
    { id: 'detail-error', label: "Couldn't load the inquiry (Try again)", model: { ...page({ address: at({ open: VIEW.id }), detail: record(null, { loaded: { status: 'error', problem: 'problem.unavailable' } }) }) } },
    { id: 'assign', label: 'Assign: people who keep inquiries here, by name (me first), Nobody; ↑ ↓ Enter', model: dialog(VIEW, assignDialog()) },
    { id: 'assign-loading', label: 'Assign: the people being read', model: dialog(VIEW, assignDialog({ status: 'loading' })) },
    { id: 'assign-bulk', label: 'Assign to… over a selection (all or none)', model: page({ selected: [keyOf(ROWS[0]!), keyOf(ROWS[3]!)], bulk: BULK_ASSIGN }) },
    { id: 'decline', label: 'Decline: the reason and an optional message to the customer, previewed', model: dialog(VIEW, { kind: 'decline', draft: { reason: 'LEAD_TIME', note: 'Earliest slot is March.', message: 'Dear Bea, thank you for the request: we cannot deliver by 20 January. We could from March.' }, busy: false, notice: null }) },
    { id: 'decline-other', label: 'Decline held: Other without words', model: dialog(VIEW, { kind: 'decline', draft: { reason: 'OTHER', note: '', message: '' }, busy: false, notice: null }) },
    { id: 'decline-prospect', label: "Decline a prospect's inquiry: the message is held (no customer conversation yet)", model: dialog(PROSPECT_VIEW, { kind: 'decline', draft: { ...emptyDecline, reason: 'CAPACITY' }, busy: false, notice: null }) },
    { id: 'decline-bulk', label: 'Decline 2 over a selection (no message: one customer at a time)', model: page({ selected: [keyOf(ROWS[0]!), keyOf(ROWS[3]!)], bulk: BULK_DECLINE }) },
    { id: 'lost', label: 'Mark as lost: why, in words', model: dialog(VIEW, { kind: 'lost', note: 'They placed it elsewhere.', busy: false, notice: null }) },
    { id: 'quote', label: 'Make quote: customer, contact, promise date, the lines that go over and the ones left out', model: dialog(VIEW, { kind: 'quote', customerRef: 'SS27-RFQ-14', busy: false, notice: null }, 'quote') },
    { id: 'quote-prospect', label: 'Make quote held: a prospect (match it first)', model: dialog(PROSPECT_VIEW, { kind: 'quote', customerRef: '', busy: false, notice: null }, 'quote') },
    { id: 'quoted', label: 'The receipt after Make quote: Open QT-…, what was left out', model: page({ notice: { key: 'done.quote', params: { quote: 'QT-DEMO-00013', number: VIEW.number }, tone: 'warning', link: { href: '#', label: { key: 'done.openQuote', params: { quote: 'QT-DEMO-00013' } } }, lines: [{ key: 'leftOut.noStyle', params: { n: 4 } }] } }) },
    { id: 'updates', label: '3 changes waiting (Show)', model: page({ updates: 3 }) },
    { id: 'capped', label: 'B-TH-233 · More rows than one page: "Show 200 more" reads the next page (no "first 200 rows" any more)', model: page({ list: listOf(undefined, true, 'next-page'), more: { next: true, busy: false, problem: null, page: 200 } }) },
    { id: 'filtered-empty', label: 'No rows match these filters (Clear filters)', model: page({ address: at({ source: 'FAIR', q: 'zzz' }), list: listOf([]) }) },
    { id: 'empty', label: 'No inquiries yet (New inquiry)', model: page({ list: { rows: [], counts: { NEW: 0, WAITING_US: 0, WAITING_CUSTOMER: 0, QUOTED_THIS_WEEK: 0, MINE: 0, OPEN: 0, QUOTED: 0, ORDERED: 0, DECLINED: 0, NOT_AN_ORDER: 0, LOST: 0, ALL: 0, CUSTOMER_REPLIES: 0 }, kinds: { REQUEST: 0, CATALOGUE_ORDER: 0, CHANGE_REQUEST: 0 }, next: null, complete: true } }) },
    { id: 'loading', label: 'Loading (tiles "—")', model: page({ list: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "Couldn't load inquiries (Try again; tiles \"—\", Couldn't count)", model: page({ list: null, problem: 'problem.unavailable' }) },
    { id: 'offline', label: 'Offline: the rows as last read; every verb held', model: page({ live: 'offline' }) },
    { id: 'keys', label: 'The keys in the footer icon', model: page({ keysOpen: true }) },
    { id: 'sales', label: 'Sales: answers, assigns, quotes (prices shown)', model: page({}, 'sales') },
    { id: 'reader', label: 'A reader: sees the queue, changes nothing (held with the reason), no target price', model: page({}, 'reader') },
    { id: 'reader-detail', label: 'A reader opens an inquiry: "You can view, not change", no price', model: open(VIEW, 'request', {}, 'reader') },
    { id: 'no-permission', label: "Warehouse: no access (the page is not in the overlay)", model: page({}, 'warehouse') },
  ],
})
