import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, CONTACTS, CUSTOMERS, DECLINED_VIEW, demoThreadElement, inShell, JACKET_DETAIL, ME, NOW, PANTS_DETAIL, PREFIX, PROSPECT_VIEW, QUOTED_VIEW, ROWS, STYLE_OPTIONS, VIEW, type RoleCase } from '../demo/fixtures'
import type { InquiryView } from '../api'
import type { RecordTab } from '../model'
import type { InquiryRecordModel } from '../record-model'
import { InquiryPageView } from '../view/InquiryPageView'

/**
 * SCR-105-full — the inquiry's full page (design tab:inquiries.full: "Open full page" from the DetailModal, a new tab, for long
 * requests with many files), made-up data only: each tab, a prospect to match, a quoted and a declined inquiry, offline,
 * loading, not found, failed, a reader, no access.
 */

interface RecordCase {
  readonly role: RoleCase
  readonly record: InquiryRecordModel
  /** B-TH-219: opened from the list ("2 of 3"); the phone's details sheet open. */
  readonly nav?: boolean
  readonly sheet?: boolean
}

function recordCase(view: InquiryView | null, tab: RecordTab = 'request', over: Partial<InquiryRecordModel> = {}, role: RoleCase = 'owner'): RecordCase {
  return {
    role,
    record: {
      prefix: PREFIX,
      me: ME,
      can: canFor(role),
      live: 'live',
      loaded: view ? { status: 'ready', value: view } : { status: 'loading' },
      tab,
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
    },
  }
}

function RecordDesign({ model }: { model: RecordCase }) {
  const view = model.record.loaded.status === 'ready' ? model.record.loaded.value : null
  // B-TH-219: the request's thread as the main column (made-up messages; nothing is sent).
  const page = createElement(InquiryPageView, {
    model: model.record,
    asOf: NOW,
    thread: view ? demoThreadElement() : null,
    backHref: `${PREFIX}/sales/incoming${view ? `?open=${view.id}` : ''}`,
    nav: model.nav && view ? { ids: [ROWS[0]!.id, view.id, ROWS[3]!.id], onGo: () => undefined } : null,
    rights: { erase: model.role === 'owner', closeThread: model.role === 'owner' },
    sheetOpen: model.sheet,
  })
  return inShell('/sales/incoming', page, model.role)
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-105-full',
  title: 'Request full page',
  view: RecordDesign,
  holdsPage: true,
  cases: [
    { id: 'request', label: 'TH-1b · The request\'s full page: row 1, the actions, the customer\'s words, the thread about two thirds, Details about one third', model: recordCase(VIEW), note: 'The reading pane\'s parts on a page of their own (a new tab, a deep link, a phone).' },
    { id: 'th-219-nav', label: 'TH-1b · Opened from the list: "2 of 3" walks the list\'s order; Back to Incoming keeps its filters', model: { ...recordCase(VIEW), nav: true } },
    { id: 'th-219-sheet', label: 'TH-1b · On a phone: the details behind "i" as a bottom sheet; the main action stays on top', model: { ...recordCase(VIEW), sheet: true }, note: 'Look at it at 375.' },
    { id: 'prospect', label: 'A prospect to match to a customer', model: recordCase(PROSPECT_VIEW) },
    { id: 'quoted', label: 'Quoted: the quote with its value', model: recordCase(QUOTED_VIEW, 'quote') },
    { id: 'declined', label: 'Declined: read-only but for its note', model: recordCase(DECLINED_VIEW) },
    { id: 'make-quote', label: 'Make quote from the band', model: recordCase(VIEW, 'request', { dialog: { kind: 'quote', customerRef: '', busy: false, notice: null } }) },
    { id: 'saved', label: 'The receipt after Apply', model: recordCase(VIEW, 'request', { notice: { key: 'request.saved', params: { number: VIEW.number }, tone: 'success' } }) },
    { id: 'offline', label: 'Offline: Apply and every verb held', model: recordCase(VIEW, 'request', { live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: recordCase(null) },
    { id: 'not-found', label: 'Not found (or another company)', model: recordCase(null, 'request', { loaded: { status: 'notFound' } }) },
    { id: 'error', label: "Couldn't load the inquiry (Try again)", model: recordCase(null, 'request', { loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'reader', label: 'A reader: view only, no price', model: recordCase(VIEW, 'request', {}, 'reader') },
    { id: 'no-permission', label: 'Warehouse: no access', model: recordCase(VIEW, 'request', {}, 'warehouse') },
  ],
})
