import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import { listBandOf } from './band'
import { noticesRead, PREFIX, ROWS, shellOf, words } from './design-data'
import { DeliveriesCase, type DeliveriesCaseBuilder } from './view/DeliveriesCase'
import type { DeliveriesListViewModel } from './view/DeliveriesListView'
import type { CancelModel } from './view/Dialogs'

/**
 * SCR-227 › Ship notices (design portal.supplier.asn: sec:asn-grid "Deliveries you announced", pop:cancel-asn; B-W2b-186),
 * MADE-UP data only: every notice and how it was received, one state's chip, selected rows with Export N, the cancel pop-up
 * of a sent notice and of a draft, nothing yet, nothing matching, loading, an error, a list cut at 500, live changes waiting,
 * an office preview, a colleague who may only read, and a person without the page.
 */

function listModel(over: Partial<DeliveriesListViewModel> = {}): DeliveriesListViewModel {
  return { state: 'ready', read: noticesRead(), chip: null, q: '', prefix: PREFIX, selected: [], facts: { preview: false, offline: false }, busy: false, dialog: null, updates: 0, ...over }
}

function listCase(build: (locale: Locale) => { model?: Partial<DeliveriesListViewModel>; preview?: boolean; held?: string | null }): DeliveriesCaseBuilder {
  return (locale) => {
    const t = words(locale)
    const { model = {}, preview = false, held = null } = build(locale)
    const list = listModel(model)
    return {
      shell: shellOf(locale, { preview, band: listBandOf({ t, locale, asOf: list.read?.asOf ?? null, prefix: PREFIX, announceHeld: held ? t(held) : null }) }),
      body: { kind: 'list', model: list },
    }
  }
}

const cancelOf = (row: (typeof ROWS)[number], over: Partial<CancelModel> = {}): CancelModel => ({
  target: { id: row.id, number: row.number, status: row.status, version: row.version, orderNumber: row.purchaseOrder.number },
  reason: '',
  busy: false,
  heldReason: row.status === 'SENT' ? 'cancel.held.reason' : null,
  problem: null,
  ...over,
})

export const designScreen = defineDesignScreen<DeliveriesCaseBuilder>({
  screen: 'SCR-227',
  title: 'Supplier Ship notices (portal.supplier.asn)',
  view: DeliveriesCase,
  cases: [
    { id: 'normal', label: 'Deliveries you announced', model: listCase(() => ({})), note: 'Every notice and how it was received: their reference first, ours second; ships / arrives; carrier and tracking; your DDT; lines and hides; Announced, In transit, Received, Received with differences (the lines that differ), Cancelled, Draft. Row → the notice (a draft at its steps); ⋯ Change, Cancel…, the order. Band: Announce delivery; ⋯ the packing list template, Ask a question. No price anywhere.' },
    { id: 'chip', label: 'One state: received with differences', model: listCase(() => ({ model: { chip: 'RECEIVED_WITH_DIFFERENCES', read: noticesRead(ROWS.filter((row) => row.state === 'RECEIVED_WITH_DIFFERENCES')) } })) },
    { id: 'selected', label: 'Two notices selected', model: listCase(() => ({ model: { selected: [ROWS[1]!.id, ROWS[3]!.id] } })), note: 'Export 2 takes the search’s place (the CSV is made in the browser, never a price).' },
    { id: 'cancel', label: 'Pop-up: cancel a sent notice', model: listCase(() => ({ model: { dialog: cancelOf(ROWS[1]!) } })), note: '“The lines become open again.” A sent notice says why: Cancel ship notice is held until the reason is typed.' },
    { id: 'cancel-typed', label: 'Pop-up: the reason typed', model: listCase(() => ({ model: { dialog: cancelOf(ROWS[1]!, { reason: 'Il camion è stato annullato dal vettore.', heldReason: null }) } })) },
    { id: 'cancel-draft', label: 'Pop-up: discard a draft', model: listCase(() => ({ model: { dialog: cancelOf(ROWS[0]!) } })) },
    { id: 'cancel-refused', label: 'Pop-up: the cancel refused', model: listCase(() => ({ model: { dialog: cancelOf(ROWS[1]!, { reason: 'Camion annullato.', heldReason: null, problem: 'changed' }) } })), note: 'Received by our warehouse meanwhile: the refusal in our words, nothing hidden.' },
    { id: 'empty', label: 'No deliveries announced', model: listCase(() => ({ model: { read: { ...noticesRead([]), counts: {} } } })), note: '“No deliveries announced.” + Announce delivery.' },
    { id: 'no-match', label: 'Nothing matches the search', model: listCase(() => ({ model: { q: 'SP-9999', read: noticesRead([]) } })) },
    { id: 'loading', label: 'Loading', model: listCase(() => ({ model: { state: 'loading', read: null } })) },
    { id: 'error', label: 'The list could not be read', model: listCase(() => ({ model: { state: 'error', read: null } })), note: 'A failed read is never drawn as an empty list.' },
    { id: 'capped', label: 'Only the latest 500', model: listCase(() => ({ model: { read: noticesRead(ROWS, { more: true }) } })) },
    { id: 'updates', label: 'A receipt posted meanwhile', model: listCase(() => ({ model: { updates: 1 } })), note: 'Live: “1 update · Show” (rows never move under the cursor).' },
    { id: 'preview', label: 'An office preview', model: listCase(() => ({ preview: true, held: 'held.preview', model: { facts: { preview: true, offline: false }, read: noticesRead(ROWS, { mayWrite: false }) } })), note: 'Announce delivery, Change and Cancel are held with the reason.' },
    { id: 'viewer', label: 'A colleague who may only read', model: listCase(() => ({ held: 'held.mayWrite', model: { read: noticesRead(ROWS, { mayWrite: false }) } })), note: '“Ask your admin for the right to upload.”' },
    {
      id: 'no-access',
      label: 'Not part of the person’s access',
      model: (locale) => ({ shell: shellOf(locale, { band: { title: words(locale)('list.title') } }), body: { kind: 'noAccess', admins: ['Anna Esempio'] } }),
      note: 'A typed or old address: who to ask, and Home. Not in the navigation (fails closed).',
    },
  ],
})
