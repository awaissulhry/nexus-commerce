import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../../../../shell/design-data'
import { canFor, COMPANY_ID, CONTACTS, CUSTOMERS, DECLINED_VIEW, DEMO_PICTURES, demoThreadElement, inShell, JACKET_DETAIL, listOf, ME, NOW, PANTS_DETAIL, PREFIX, PROSPECT_VIEW, QUOTED_VIEW, ROWS, STYLE_OPTIONS, threadModel, VIEW, type RoleCase } from '../../demo/fixtures'
import type { InquiryView } from '../../api'
import { HOME_ADDRESS } from '../../model'
import type { InquiryRecordModel } from '../../record-model'
import { InquiriesView, type InquiriesModel } from '../InquiriesView'

/**
 * SCR-105-pane — Incoming's reading pane (B-TH-217, B-TH-218; threads plan TH-1b, pictures 13–15 drawn to the approved look: the
 * list ~35 %, the request ~65 %; at 1920 Details has its own 320 px column, at 1440 it folds under row 2). Made-up data only.
 * Row 1 (picture · customer — subject · state with waiting · owner · 2 of 3 · ⋯ · ×), row 2 (ONE main button that follows the
 * request, Make quote, Ask for info, Decline, Details ▾), the customer's own words first, the thread, Details.
 */

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
    customers: view.prospect ? { items: CUSTOMERS, problem: null } : null,
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
      limit: 200,
      newInquiry: null,
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
  ],
})
