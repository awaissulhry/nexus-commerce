import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { RecordPanelsView } from '../../../../record-panels/view/RecordPanelsView'
import { canFor, CONTACTS, CUSTOMERS, DECLINED_VIEW, inShell, JACKET_DETAIL, ME, NOW, PANTS_DETAIL, panelsOf, PREFIX, PROSPECT_VIEW, QUOTED_VIEW, STYLE_OPTIONS, VIEW, type RoleCase } from '../demo/fixtures'
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
  const panels = view && (model.record.tab === 'activity' || model.record.tab === 'files') ? createElement(RecordPanelsView, { model: panelsOf(view, model.record.tab === 'files' ? 'files' : 'conversation') }) : null
  const page = createElement(InquiryPageView, { model: model.record, asOf: NOW, slots: model.record.tab === 'activity' ? { activity: panels } : model.record.tab === 'files' ? { files: panels } : undefined })
  return inShell('/sales/inquiries', page, model.role)
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-105-full',
  title: 'Inquiry full page',
  view: RecordDesign,
  holdsPage: true,
  cases: [
    { id: 'request', label: 'Request: who asks, what, the lines with sizes, the target, the mail as sent', model: recordCase(VIEW), note: 'The same tabs and dialogs as the DetailModal; the tabs are real links.' },
    { id: 'files', label: 'Files & specs: the tech pack in force, the mail’s attachments, the files panel', model: recordCase(VIEW, 'files') },
    { id: 'quote', label: 'Quote: not quoted yet', model: recordCase(VIEW, 'quote') },
    { id: 'activity', label: 'Activity: the thread, files and history', model: recordCase(VIEW, 'activity') },
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
