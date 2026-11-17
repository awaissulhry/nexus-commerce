import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../../../../shell/design-data'
import { canFor, COMPANY_ID, CONTACTS, CUSTOMERS, DECLINED_VIEW, DEMO_PICTURES, demoThreadElement, inShell, JACKET_DETAIL, listOf, ME, NOW, PANTS_DETAIL, PREFIX, PROSPECT_VIEW, QUOTED_VIEW, ROWS, STYLE_OPTIONS, threadModel, VIEW, type RoleCase } from '../../demo/fixtures'
// B-TH-228: Make order, Make style draft.
import { ORDERABLE_VIEW, ORDERED_VIEW } from '../../demo/fixtures'
import { orderDraftOf, styleDraftOf } from '../../model'
import type { CustomerCheck, InquiryView } from '../../api'
import { HOME_ADDRESS } from '../../model'
import type { InquiryRecordModel } from '../../record-model'
import { InquiriesView, type InquiriesModel } from '../InquiriesView'

/**
 * SCR-105-pane — Incoming's reading pane (B-TH-217, B-TH-218; threads plan TH-1b, pictures 13–15 drawn to the approved look: the
 * list ~35 %, the request ~65 %; at 1920 Details has its own 320 px column, at 1440 it folds under row 2). Made-up data only.
 * Row 1 (picture · customer — subject · state with waiting · owner · 2 of 3 · ⋯ · ×), row 2 (ONE main button that follows the
 * request, Make quote, Ask for info, Decline, Details ▾), the customer's own words first, the thread, Details.
 */

// ---- B-TH-234: the customer check's three answers (made-up customers; only those the person may make requests for) ----
const CHECK_BASE: CustomerCheck = {
  prospect: { name: 'Demo Track Club', company: 'Demo Track Club', email: 'club@track-demo.example.com', phone: '+39 02 0000 0000', lawfulBasis: 'CONTRACT', erased: false },
  candidates: [],
  ambiguous: false,
  suggestion: { code: 'DEMO-TRACK', legalName: 'Demo Track Club', kind: 'ORGANISATION' },
  make: { allowed: true, refusal: null },
  match: { allowed: true, refusal: null },
}
const CHECK_CONTACT: CustomerCheck = { ...CHECK_BASE, candidates: [{ party: { id: CUSTOMERS[0]!.id, code: CUSTOMERS[0]!.code, name: CUSTOMERS[0]!.tradeName ?? CUSTOMERS[0]!.legalName }, contact: { id: CONTACTS[0]!.id, name: CONTACTS[0]!.name }, matchedBy: 'CONTACT' }] }
const CHECK_DOMAIN: CustomerCheck = { ...CHECK_BASE, candidates: [{ party: { id: CUSTOMERS[1]!.id, code: CUSTOMERS[1]!.code, name: CUSTOMERS[1]!.legalName }, contact: null, matchedBy: 'DOMAIN' }] }
const CHECK_NONE: CustomerCheck = CHECK_BASE
// ---- end B-TH-234

interface PaneCase {
  readonly role: RoleCase
  readonly model: InquiriesModel
  /** The box asked for info (the reply to the customer with the question). */
  readonly asking?: boolean
}

function record(view: InquiryView, role: RoleCase, over: Partial<InquiryRecordModel> = {}): InquiryRecordModel {
  return {
    prefix: PREFIX,
    me: ME,
    can: canFor(role),
    live: 'live',
    loaded: { status: 'ready', value: view },
    tab: 'request',
    draft: null,
    saving: false,
    busy: false,
    contacts: view.party ? { items: CONTACTS, problem: null } : null,
    styles: { items: STYLE_OPTIONS, problem: null },
    details: { [JACKET_DETAIL.id]: { status: 'ready', value: JACKET_DETAIL }, [PANTS_DETAIL.id]: { status: 'ready', value: PANTS_DETAIL } },
    stale: null,
    notice: null,
    dialog: null,
    pictures: false,
    ...over,
  }
}

function paneCase(view: InquiryView, role: RoleCase = 'owner', over: Partial<InquiryRecordModel> = {}, page: Partial<InquiriesModel> = {}, asking = false): PaneCase {
  return {
    role,
    asking,
    model: {
      prefix: PREFIX,
      me: ME,
      companyId: COMPANY_ID,
      can: canFor(role),
      address: { ...HOME_ADDRESS, tile: 'ALL', open: view.id },
      list: listOf(ROWS),
      problem: null,
      customers: CUSTOMERS,
      asOf: NOW,
      live: 'live',
      updates: 0,
      notice: null,
      dismissed: [],
      newRequest: null,
      bulk: null,
      detail: record(view, role, over),
      pane: { handled: null, closing: null, rights: { erase: role === 'owner', closeThread: role === 'owner' } },
      companies: DEMO_COMPANIES.slice(0, 1).map((entry) => ({ id: entry.id, name: entry.name })),
      noticeFacts: {},
      demoPictures: DEMO_PICTURES,
      ...page,
    },
  }
}

function PaneDesign({ model }: { model: PaneCase }) {
  const [state, setState] = useState(model.model)
  useEffect(() => setState(model.model), [model])
  const view = createElement(InquiriesView, {
    model: state,
    slots: { thread: demoThreadElement(model.asking ? threadModel('reply', '') : threadModel('note', '', !!state.detail && state.detail.loaded.status === 'ready' && state.detail.loaded.value.prospect)) },
    actions: {
      onOpen: (id) => setState((now) => ({ ...now, address: { ...now.address, open: id }, detail: id === null ? null : record([VIEW, PROSPECT_VIEW, QUOTED_VIEW, DECLINED_VIEW].find((one) => one.id === id) ?? { ...VIEW, ...ROWS.find((one) => one.id === id)!, fileCounts: undefined } as InquiryView, model.role) })),
      onAddress: (patch) => setState((now) => ({ ...now, address: { ...now.address, ...patch } })),
    },
  })
  return inShell('/sales/incoming', view, model.role)
}

export const designScreen = defineDesignScreen<PaneCase>({
  screen: 'SCR-105-pane',
  title: 'Incoming reading pane',
  view: PaneDesign,
  holdsPage: true,
  cases: [
    { id: 'pane', label: 'TH-1b · A customer\'s request by e-mail, in progress with me: Make quote is the main button; the customer\'s words first; Details folded at 1440, a column at 1920', model: paneCase(VIEW), note: 'J / K walk the requests outside the feed; Esc closes; ⋯ Open full page, Print, Edit the request, Start an erasure request (privacy), Close thread (threads.manage).' },
    { id: 'pane-prospect', label: 'TH-1b · A prospect (marked new): replies wait for "Make the customer first"; the prospect block with its lawful basis', model: paneCase(PROSPECT_VIEW) },
    { id: 'pane-quoted', label: 'TH-1b · Quoted: no actions, the outcome line; Made from it shows the quote with its own status', model: paneCase(QUOTED_VIEW) },
    { id: 'pane-declined', label: 'TH-1b · Declined: read-only, the reason and who', model: paneCase(DECLINED_VIEW) },
    { id: 'pane-handled', label: 'TH-1b · Someone else changed it meanwhile: the line with Reload and Next', model: { ...paneCase(VIEW), model: { ...paneCase(VIEW).model, pane: { handled: '10:42', closing: null, rights: { erase: true, closeThread: true } } } } },
    { id: 'pane-production', label: 'TH-1b · The production manager: every sales action held "Needs the sales permission"; no target price; office notes allowed', model: paneCase(VIEW, 'production') },
    { id: 'pane-ask', label: 'TH-1b · Ask for info: the box is the reply to the customer; Send asks (the request then waits for the customer)', model: paneCase(VIEW, 'owner', {}, {}, true) },
    { id: 'pane-quote', label: 'TH-1b · Make quote (a DRAFT): what goes over and what is left out; the customer is not told yet', model: paneCase(VIEW, 'owner', { dialog: { kind: 'quote', customerRef: '', busy: false, notice: null } }) },
    { id: 'pane-decline', label: 'TH-1b · Decline: the reason, an optional message (off by default)', model: paneCase(VIEW, 'owner', { dialog: { kind: 'decline', draft: { reason: 'LEAD_TIME', note: '', message: '' }, busy: false, notice: null } }) },
    { id: 'pane-loading', label: 'TH-1b · The request being read', model: paneCase(VIEW, 'owner', { loaded: { status: 'loading' } }) },
    // ---- B-TH-228 (TH-2): Make order and Make style draft
    { id: 'th-228-order-held', label: 'TH-2 · Make order held: a line asked in words — "make the style draft first" (the API’s words on hover)', model: paneCase(VIEW), note: 'Make quote stays the main button (something to quote); Make order is beside it, held with the API’s reason: line 30 has no colourway, line 40 no style yet.' },
    { id: 'th-228-style-main', label: 'TH-2 · Only a line in words: Make style draft is the main button', model: paneCase({ ...VIEW, lines: VIEW.lines.slice(3) }), note: 'Nothing can go on a quote; the glove asked in words needs its style first.' },
    { id: 'th-228-order', label: 'TH-2 · Make order: lines, the price the customer was shown, the date, their PO, the files going with it', model: paneCase(ORDERABLE_VIEW, 'owner', { dialog: { kind: 'order', draft: orderDraftOf(ORDERABLE_VIEW, canFor('owner')), busy: false, notice: null } }), note: 'The order goes through the normal checks and comes out Confirmed or Waiting for approval — the receipt says which. ⌘↵ makes it.' },
    { id: 'th-228-order-waits', label: 'TH-2 · The receipt: made, waiting for approval (credit) — never “confirmed”; a file that did not go with it', model: paneCase(ORDERED_VIEW, 'owner', { notice: { key: 'done.orderCredit', params: { order: 'SO-2026-0142', number: ORDERED_VIEW.number }, tone: 'warning', link: { href: `${PREFIX}/sales/orders/x`, label: { key: 'done.openOrder', params: { order: 'SO-2026-0142' } } }, lines: [{ key: 'done.filesCarried', params: { count: 2 } }, { key: 'done.fileNotCarried', params: { name: 'size chart.xlsx', reason: 'The file is still being checked.' } }] } }), note: 'The request is Ordered and names the order with ITS own state.' },
    { id: 'th-228-style-draft', label: 'TH-2 · Make style draft: code, name, type, scale, which files go — for the request’s own customer’s label', model: paneCase(VIEW, 'owner', { dialog: { kind: 'styleDraft', draft: { ...styleDraftOf(VIEW), code: 'GL-SS27', productType: 'GLOVES', sizeScaleId: 'sc-1' }, scales: { status: 'ready', value: [{ id: 'sc-1', code: 'EU-GLOVE', name: 'Gloves S–XXL' }, { id: 'sc-2', code: 'EU-46-60', name: 'Jackets 46–60' }] }, busy: false, notice: null } }), note: 'The brand is the request’s customer (shown, never chosen). A style needs a released version and a colourway before an order takes it.' },
    { id: 'th-228-style-production', label: 'TH-2 · The production manager may make a style draft (every sales action held)', model: paneCase({ ...VIEW, lines: VIEW.lines.slice(3) }, 'production', { dialog: { kind: 'styleDraft', draft: styleDraftOf(VIEW), scales: { status: 'loading' }, busy: false, notice: null } }) },
    { id: 'th-228-made-from', label: 'TH-2 · Made from it: the style draft with its own state (opens in a new tab)', model: paneCase(ORDERABLE_VIEW), note: 'Details › Made from it lists the style draft TJ-SS27 (Draft); Make order may go (every line ready).' },
    // ---- end B-TH-228
    // B-TH-230: New messages beside the reading pane (the e-mail-like list keeps the count under the request's words).
    // ---- B-TH-234 (TH-3): answer a new customer, decline in words, hand the customer a task
    { id: 'th3-234-customer', label: 'TH-3 · Make or match the customer: the check found one customer by a contact\'s own address — picked, goes alone; the prospect\'s lawful basis travels', model: paneCase(PROSPECT_VIEW, 'owner', { dialog: { kind: 'customer', check: { status: 'ready', value: CHECK_CONTACT }, choice: { mode: 'match', partyId: CHECK_CONTACT.candidates[0]!.party.id, contactId: CHECK_CONTACT.candidates[0]!.contact!.id, addContact: false }, confirmed: false, busy: false, notice: null } }), note: 'Only customers this person may make a request for are listed (never another customer by name). After it: the "new" mark goes, replies open, the mail joins the conversation shared with that customer only.' },
    { id: 'th3-234-customer-domain', label: 'TH-3 · Found only by the company domain: nothing is picked for you; once picked it asks first ("I checked: … is from …")', model: paneCase(PROSPECT_VIEW, 'owner', { dialog: { kind: 'customer', check: { status: 'ready', value: CHECK_DOMAIN }, choice: { mode: 'match', partyId: CHECK_DOMAIN.candidates[0]!.party.id, contactId: null, addContact: true }, confirmed: false, busy: false, notice: null } }) },
    { id: 'th3-234-customer-make', label: 'TH-3 · Nobody found: a new customer from the prospect (code proposed, Prospect until confirmed)', model: paneCase(PROSPECT_VIEW, 'owner', { dialog: { kind: 'customer', check: { status: 'ready', value: CHECK_NONE }, choice: { mode: 'make', code: CHECK_NONE.suggestion.code, legalName: CHECK_NONE.suggestion.legalName, kind: 'ORGANISATION', status: 'PROSPECT' }, confirmed: false, busy: false, notice: null } }) },
    { id: 'th3-234-customer-reading', label: 'TH-3 · The check being read', model: paneCase(PROSPECT_VIEW, 'owner', { dialog: { kind: 'customer', check: { status: 'loading' }, choice: null, confirmed: false, busy: false, notice: null } }) },
    { id: 'th3-234-decline-portal', label: 'TH-3 · Decline with one message: "Send to the customer" ticked — the customer reads it in its portal, with the decline (one step)', model: paneCase({ ...VIEW, source: 'PORTAL', messageTo: { via: 'PORTAL', to: [], language: 'en', refusal: null } }, 'owner', { dialog: { kind: 'decline', draft: { reason: 'LEAD_TIME', note: 'Earliest slot is March.', message: 'Thank you for the request: we cannot deliver by 20 January. We could from March.', send: true }, busy: false, notice: null } }) },
    { id: 'th3-234-decline-mail', label: 'TH-3 · Decline with one message by mail: to the request\'s contact, written in Italian (the customer\'s language)', model: paneCase({ ...VIEW, messageTo: { via: 'MAIL', to: ['buyer@brand-demo.example.com'], language: 'it', refusal: null } }, 'owner', { dialog: { kind: 'decline', draft: { reason: 'CAPACITY', note: '', message: 'Grazie per la richiesta: non possiamo produrla entro gennaio.', send: true }, busy: false, notice: null } }) },
    { id: 'th3-234-not-an-order', label: 'TH-3 · ⋯ Not an order: closed without counting as declined — nothing is sent, the customer reads "Closed"', model: paneCase(VIEW, 'owner', { dialog: { kind: 'decline', draft: { reason: 'NOT_AN_ORDER', note: 'A supplier\'s newsletter.', message: '', send: false }, busy: false, notice: null } }) },
    { id: 'th3-234-decline-prospect', label: 'TH-3 · Decline a prospect\'s request: no message possible (make the customer first)', model: paneCase({ ...PROSPECT_VIEW, messageTo: { via: null, to: [], language: null, refusal: { code: 'NEEDS_CUSTOMER', message: 'x' } } }, 'owner', { dialog: { kind: 'decline', draft: { reason: 'CAPACITY', note: '', message: '', send: false }, busy: false, notice: null } }) },
    { id: 'th3-234-task', label: 'TH-3 · Ask Demo Moto Brand for… a document, an answer or measurements, by a date (a task in its portal)', model: paneCase(VIEW, 'owner', { can: { ...canFor('owner'), tasks: true }, dialog: { kind: 'task', draft: { kind: 'SEND_MEASUREMENTS', due: '2026-11-20' }, busy: false, notice: null } }) },
    { id: 'th3-234-task-refused', label: 'TH-3 · The task refused in words: the request was closed meanwhile', model: paneCase(VIEW, 'owner', { can: { ...canFor('owner'), tasks: true }, dialog: { kind: 'task', draft: { kind: 'UPLOAD_DOCUMENT', due: null }, busy: false, notice: { key: 'task.refusal.REQUEST_CLOSED', tone: 'danger' } } }) },
    // ---- end B-TH-234
    { id: 'th-230-pane-new', label: 'TH-2 · New messages beside the pane: "● 2 new" under the request; amber waiting by the one rule', model: paneCase(VIEW, 'owner', {}, { unread: { [ROWS[0]!.id]: { newCount: 2, lastAt: '2026-11-17T09:42:00.000Z' }, [ROWS[2]!.id]: { newCount: 3, lastAt: '2026-11-16T15:10:00.000Z' } } }) },
  ],
})
