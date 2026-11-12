import { createElement, useEffect, useState } from 'react'
import { RecordPanelsView } from '../../../record-panels/view/RecordPanelsView'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import {
  ASSIGNEES,
  canFor,
  COMPANY_ID,
  CONTACTS,
  CUSTOMERS,
  DECLINED_VIEW,
  inShell,
  JACKET_DETAIL,
  listOf,
  MAIL_DRAFT,
  MAIL_TAKEN,
  ME,
  NOW,
  PANTS_DETAIL,
  panelsOf,
  PREFIX,
  PROSPECT_VIEW,
  QUOTED_VIEW,
  ROWS,
  STYLE_OPTIONS,
  VIEW,
  type RoleCase,
} from './demo/fixtures'
import { draftFromMail, emptyDecline, emptyLine, emptyNewDraft, HOME_ADDRESS, requestDraftOf, type InquiryTile, type ListAddress, type RecordTab } from './model'
import type { InquiryView } from './api'
import type { InquiryRecordModel, RecordDialog } from './record-model'
import { InquiriesView, type BulkDialog, type InquiriesModel } from './view/InquiriesView'
import type { NewInquiryModel } from './view/NewInquiryDialog'

/**
 * SCR-105 — Sales › Inquiries (design sales.inquiries, an inbox), made-up data only: the tiles (each a saved filter), the notices
 * (one at a time, the rest behind "N more notices"), the list in the shared frame (rows selected: Assign to… and Decline N with
 * the closed ones left out), the inquiry in its DetailModal (Request — editable, changed with the EditModeBar, a prospect to
 * match —, Files & specs with the tech pack in force, Quote not yet / made, Activity), New inquiry (typed, a prospect, held,
 * refused, from a mail, a mail already made into one), Assign, Decline (Other without words held; a selection), Mark as lost,
 * Make quote (what goes over, what is left out; a prospect held), the receipts, empty, filtered, loading, failed, offline, the
 * keys, and the role cases (sales, a reader without changes or prices, the warehouse without access).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: InquiriesModel
  /** The record panels the open inquiry's tabs mount (their own made-up cases). */
  readonly panels?: 'conversation' | 'files'
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
    customers: view?.prospect ? { items: CUSTOMERS, problem: null } : null,
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
      limit: 200,
      newInquiry: null,
      bulk: null,
      detail: null,
      ...over,
    },
  }
}

const open = (view: InquiryView, tab: RecordTab = 'request', over: Partial<InquiryRecordModel> = {}, role: RoleCase = 'owner'): DesignModel => ({
  ...page({ address: at({ open: view.id, tab }), detail: record(view, { tab, ...over }, role) }, role),
  panels: tab === 'activity' ? 'conversation' : tab === 'files' ? 'files' : undefined,
})
const dialog = (view: InquiryView, value: RecordDialog, tab: RecordTab = 'request'): DesignModel => open(view, tab, { dialog: value })
const tile = (id: InquiryTile, rows: typeof ROWS): Partial<InquiriesModel> => ({ address: at({ tile: id }), list: listOf(rows) })

const NEW: NewInquiryModel = {
  draft: { ...emptyNewDraft(), source: 'PHONE', partyId: CUSTOMERS[1]!.id, request: 'Called: 60 rain trousers for the spring, S to XL, about 38 EUR.', targetPrice: '38', wantedDate: '2027-02-15', lines: [{ ...emptyLine('demo-1'), styleId: STYLE_OPTIONS[1]!.id, styleLabel: `${STYLE_OPTIONS[1]!.code} · ${STYLE_OPTIONS[1]!.name}`, sizes: { S: 10, M: 20, L: 20, XL: 10 } }], assignToMe: true },
  mail: null,
  customers: { items: CUSTOMERS, problem: null },
  contacts: { items: CONTACTS, problem: null },
  styles: { items: STYLE_OPTIONS, problem: null },
  details: { [PANTS_DETAIL.id]: { status: 'ready', value: PANTS_DETAIL } },
  files: [{ key: 'f1', name: 'rain-trousers-photo.jpg', size: 412_000, problem: null }],
  busy: false,
  notice: null,
  offline: false,
}
const NEW_PROSPECT: NewInquiryModel = { ...NEW, draft: { ...emptyNewDraft(), source: 'FAIR', who: 'prospect', prospect: { name: 'Gianni Esempio', company: 'Demo Moto Club', email: 'president@motoclub-demo.example.com', phone: '' }, request: 'Club jackets with an embroidered logo, about 40.', lines: [{ ...emptyLine('demo-2'), description: 'Club jacket with a logo on the back', quantity: '40' }] }, files: [] }
const FROM_MAIL: NewInquiryModel = { ...NEW, draft: { ...draftFromMail(MAIL_DRAFT), techPackFileIds: [MAIL_DRAFT.attachments[0]!.id] }, mail: { id: MAIL_DRAFT.mail.id, draft: { status: 'ready', value: MAIL_DRAFT } }, files: [] }

const assignDialog = (people: Extract<RecordDialog, { kind: 'assign' }>['people'] = { status: 'ready', value: ASSIGNEES }): RecordDialog => ({ kind: 'assign', people, busy: false, notice: null })
const BULK_ASSIGN: BulkDialog = { kind: 'assign', ids: [ROWS[0]!.id, ROWS[3]!.id], model: { subject: { key: 'bulk.subject', params: { count: 2 } }, current: null, people: { status: 'ready', value: ASSIGNEES }, busy: false, notice: null, offline: false } }
const BULK_DECLINE: BulkDialog = { kind: 'decline', ids: [ROWS[0]!.id, ROWS[3]!.id], model: { subject: { key: 'bulk.subject', params: { count: 2 } }, draft: { ...emptyDecline, reason: 'CAPACITY' }, message: { to: null, held: { key: 'decline.message.many' } }, busy: false, notice: null, offline: false } }

function ListDesign({ model }: { model: DesignModel }) {
  const [state, setState] = useState(model.model)
  useEffect(() => setState(model.model), [model])
  const panels = model.panels && state.detail?.loaded.status === 'ready' ? createElement(RecordPanelsView, { model: panelsOf(state.detail.loaded.value, model.panels) }) : null
  const view = createElement(InquiriesView, {
    model: state,
    slots: model.panels === 'conversation' ? { activity: panels } : model.panels === 'files' ? { files: panels } : undefined,
    actions: {
      onAddress: (patch) => setState((now) => ({ ...now, address: { ...now.address, ...patch } })),
      onClearFilters: () => setState((now) => ({ ...now, address: HOME_ADDRESS })),
      onOpen: (id) => setState((now) => ({ ...now, address: { ...now.address, open: id }, detail: id === null ? null : record([VIEW, PROSPECT_VIEW, QUOTED_VIEW, DECLINED_VIEW].find((one) => one.id === id) ?? { ...VIEW, ...ROWS.find((one) => one.id === id)! }) })),
      onNew: () => setState((now) => ({ ...now, newInquiry: { ...NEW, draft: emptyNewDraft(), files: [] } })),
      newInquiry: {
        onDraft: (patch) => setState((now) => (now.newInquiry ? { ...now, newInquiry: { ...now.newInquiry, draft: { ...now.newInquiry.draft, ...patch } } } : now)),
        onCustomer: (partyId) => setState((now) => (now.newInquiry ? { ...now, newInquiry: { ...now.newInquiry, draft: { ...now.newInquiry.draft, partyId } } } : now)),
        onClose: () => setState((now) => ({ ...now, newInquiry: null })),
        onSubmit: () => setState((now) => ({ ...now, newInquiry: null, notice: { key: 'new.done', params: { number: 'INQ-DEMO-0007' }, tone: 'success' } })),
      },
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
  return inShell('/sales/inquiries', view, model.role)
}

const OPEN_ROWS = ROWS.filter((one) => ['NEW', 'ASSIGNED', 'NEED_INFO'].includes(one.status))
const CHANGED = { ...requestDraftOf(VIEW), wantedDate: '2027-01-27', targetPrice: '142', lines: [...requestDraftOf(VIEW).lines, { ...emptyLine('demo-3'), description: 'Kidney belt in black', quantity: '20' }] }

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-105',
  title: 'Inquiries',
  view: ListDesign,
  holdsPage: true,
  cases: [
    { id: 'inbox', label: 'The queue: open inquiries, the oldest waiting first; tiles, waiting in working time, "You" / "A colleague"', model: page(), note: 'Enter opens the inquiry in its DetailModal; x / Space select; ⋯ and right-click the verbs. Keys only in the footer icon.' },
    { id: 'tile-new', label: 'Tile: New (its chip in the filter row)', model: page(tile('NEW', OPEN_ROWS.filter((one) => one.status === 'NEW'))) },
    { id: 'tile-waiting-us', label: 'Tile: Waiting for us over 1 working day', model: page(tile('WAITING_US', OPEN_ROWS.filter((one) => one.waiting.overdue))) },
    { id: 'tile-waiting-customer', label: 'Tile: Waiting for the customer', model: page(tile('WAITING_CUSTOMER', OPEN_ROWS.filter((one) => one.status === 'NEED_INFO'))) },
    { id: 'tile-quoted-week', label: 'Tile: Quoted this week', model: page(tile('QUOTED_THIS_WEEK', [ROWS[4]!])) },
    { id: 'all-rows', label: 'Rows ▾ All: closed ones with their quote or the decline reason', model: page({ address: at({ tile: 'ALL' }), list: listOf(ROWS) }) },
    { id: 'filtered', label: 'Filters as chips: source Phone, a search (Clear all)', model: page({ address: at({ source: 'PHONE', q: 'trousers' }), list: listOf([ROWS[0]!]) }) },
    { id: 'selected', label: 'Two rows selected: Assign 2, Decline 2, Export 2', model: page({ selected: [ROWS[0]!.id, ROWS[3]!.id] }) },
    { id: 'selected-closed', label: 'A selection with closed rows: they are left out of Assign and Decline (said before the click)', model: page({ address: at({ tile: 'ALL' }), list: listOf(ROWS), selected: [ROWS[0]!.id, ROWS[4]!.id, ROWS[5]!.id] }) },
    { id: 'notices', label: 'Notices: the count is partial (one shown, "1 more notice")', model: page({ list: listOf(OPEN_ROWS, false) }) },
    { id: 'notices-open', label: 'Every notice listed (partial count, prospects to match), each dismissed by its value', model: page({ list: listOf(OPEN_ROWS, false), noticesOpen: true }) },
    { id: 'detail', label: 'The inquiry (DetailModal): Request — who asks, what, the lines with sizes, the target, the mail as sent', model: open(VIEW), note: 'Q make quote, A assign, D decline, J / K the next and previous inquiry, Esc closes; Open full page is a new tab.' },
    { id: 'detail-changed', label: 'Request changed: the date, the target and a new line — the EditModeBar (⌘S applies)', model: open(VIEW, 'request', { draft: CHANGED }) },
    { id: 'detail-prospect', label: 'A prospect: "Unknown sender — match to a customer"; Make quote held until matched', model: open(PROSPECT_VIEW) },
    { id: 'detail-files', label: 'Files & specs: the tech pack (a newer version in force), the mail’s attachments, the files panel', model: open(VIEW, 'files') },
    { id: 'detail-quote-none', label: 'Quote: not quoted yet (what Make quote will copy)', model: open(VIEW, 'quote') },
    { id: 'detail-quote-made', label: 'Quote: the quote it became (link, status, value)', model: open(QUOTED_VIEW, 'quote') },
    { id: 'detail-activity', label: 'Activity: the thread (internal notes and mail to the customer), files and history', model: open(VIEW, 'activity') },
    { id: 'detail-closed', label: 'A declined inquiry: read-only but for its note, the reason and who', model: open(DECLINED_VIEW) },
    { id: 'detail-stale', label: 'Changed by someone while typing: Reload (the typing is kept until then)', model: open(VIEW, 'request', { draft: CHANGED, stale: '10:41' }) },
    { id: 'detail-refused', label: 'Apply refused: our words, the field named', model: open(VIEW, 'request', { draft: CHANGED, notice: { key: 'problem.invalid', tone: 'danger', lines: [{ key: 'field.lineAt', params: { n: 5 } }] } }) },
    { id: 'detail-loading', label: 'The inquiry being read', model: { ...page({ address: at({ open: VIEW.id }), detail: record(null) }) } },
    { id: 'detail-error', label: "Couldn't load the inquiry (Try again)", model: { ...page({ address: at({ open: VIEW.id }), detail: record(null, { loaded: { status: 'error', problem: 'problem.unavailable' } }) }) } },
    { id: 'assign', label: 'Assign: people who keep inquiries here, by name (me first), Nobody; ↑ ↓ Enter', model: dialog(VIEW, assignDialog()) },
    { id: 'assign-loading', label: 'Assign: the people being read', model: dialog(VIEW, assignDialog({ status: 'loading' })) },
    { id: 'assign-bulk', label: 'Assign to… over a selection (all or none)', model: page({ selected: [ROWS[0]!.id, ROWS[3]!.id], bulk: BULK_ASSIGN }) },
    { id: 'decline', label: 'Decline: the reason and an optional message to the customer, previewed', model: dialog(VIEW, { kind: 'decline', draft: { reason: 'LEAD_TIME', note: 'Earliest slot is March.', message: 'Dear Bea, thank you for the request: we cannot deliver by 20 January. We could from March.' }, busy: false, notice: null }) },
    { id: 'decline-other', label: 'Decline held: Other without words', model: dialog(VIEW, { kind: 'decline', draft: { reason: 'OTHER', note: '', message: '' }, busy: false, notice: null }) },
    { id: 'decline-prospect', label: "Decline a prospect's inquiry: the message is held (no customer conversation yet)", model: dialog(PROSPECT_VIEW, { kind: 'decline', draft: { ...emptyDecline, reason: 'CAPACITY' }, busy: false, notice: null }) },
    { id: 'decline-bulk', label: 'Decline 2 over a selection (no message: one customer at a time)', model: page({ selected: [ROWS[0]!.id, ROWS[3]!.id], bulk: BULK_DECLINE }) },
    { id: 'lost', label: 'Mark as lost: why, in words', model: dialog(VIEW, { kind: 'lost', note: 'They placed it elsewhere.', busy: false, notice: null }) },
    { id: 'quote', label: 'Make quote: customer, contact, promise date, the lines that go over and the ones left out', model: dialog(VIEW, { kind: 'quote', customerRef: 'SS27-RFQ-14', busy: false, notice: null }, 'quote') },
    { id: 'quote-prospect', label: 'Make quote held: a prospect (match it first)', model: dialog(PROSPECT_VIEW, { kind: 'quote', customerRef: '', busy: false, notice: null }, 'quote') },
    { id: 'quoted', label: 'The receipt after Make quote: Open QT-…, what was left out', model: page({ notice: { key: 'done.quote', params: { quote: 'QT-DEMO-00013', number: VIEW.number }, tone: 'warning', link: { href: '#', label: { key: 'done.openQuote', params: { quote: 'QT-DEMO-00013' } } }, lines: [{ key: 'leftOut.noStyle', params: { n: 4 } }] } }) },
    { id: 'new', label: 'New inquiry: a phone call from a customer, a style with its sizes, a target, a file, give it to me', model: page({ newInquiry: NEW }) },
    { id: 'new-prospect', label: 'New inquiry: a new prospect from a fair, a product in words', model: page({ newInquiry: NEW_PROSPECT }) },
    { id: 'new-held', label: 'New inquiry held: no customer and no request yet', model: page({ newInquiry: { ...NEW, draft: emptyNewDraft(), files: [] } }) },
    { id: 'new-refused', label: 'New inquiry refused: our words, the field named', model: page({ newInquiry: { ...NEW, notice: { key: 'problem.invalid', tone: 'danger', lines: [{ key: 'field.prospect' }] } } }) },
    { id: 'new-from-mail', label: 'Make an inquiry from a mail: the sender is a contact of the brand, its attachment as the tech pack', model: page({ newInquiry: FROM_MAIL }) },
    { id: 'new-mail-taken', label: 'A mail already made into an inquiry (Open it)', model: page({ newInquiry: { ...FROM_MAIL, mail: { id: MAIL_TAKEN.mail.id, draft: { status: 'ready', value: MAIL_TAKEN } } } }) },
    { id: 'updates', label: '3 changes waiting (Show)', model: page({ updates: 3 }) },
    { id: 'capped', label: 'The first 200 rows only (narrow the filters)', model: page({ limit: 3, list: listOf(OPEN_ROWS) }) },
    { id: 'filtered-empty', label: 'No rows match these filters (Clear filters)', model: page({ address: at({ source: 'FAIR', q: 'zzz' }), list: listOf([]) }) },
    { id: 'empty', label: 'No inquiries yet (New inquiry)', model: page({ list: { rows: [], counts: { NEW: 0, WAITING_US: 0, WAITING_CUSTOMER: 0, QUOTED_THIS_WEEK: 0, MINE: 0, OPEN: 0, QUOTED: 0, DECLINED: 0, LOST: 0, ALL: 0 }, complete: true } }) },
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
