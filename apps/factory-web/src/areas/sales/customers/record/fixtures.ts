import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { ARCHIVED_CUSTOMER, at, CUSTOMERS, inShell, NOW, ORDERS, panels, QUOTES, RECORD_CAN, recordModel, withoutMoney } from '../../../parties/_shared/fixtures'
import { failed, loaded, loading, type PartyRecordModel } from '../../../parties/_shared/model'
import type { Party } from '../../../parties/_shared/api'
import { CustomerRecordView } from './view/CustomerRecordView'

/**
 * SCR-033 Customer record — made-up customers only. Each case is one state the Owner reviews: an Italian business that
 * can be invoiced, one that cannot yet (and why, with the step that fixes it), EU businesses with each VIES answer, a
 * person, a customer outside the EU, blocked, archived, read-only rights, no price grain, every tab, every dialog, a
 * change by someone else, loading, not found, a failed read and no access.
 */

const by = (code: string): Party => [...CUSTOMERS, ARCHIVED_CUSTOMER].find((item) => item.code === code)!
const record = (code: string, over: Partial<PartyRecordModel> = {}) => recordModel('customers', by(code), over)

function CustomerDesign({ model }: { model: PartyRecordModel }) {
  const party = model.party
  const id = party?.id ?? 'x'
  return inShell(`/sales/customers/${id}`, createElement(CustomerRecordView, { model, panels: party ? panels(party) : null, documents: party ? panels(party, 'files') : null }))
}

export const designScreen = defineDesignScreen<PartyRecordModel>({
  screen: 'SCR-033',
  title: 'Customer record',
  view: CustomerDesign,
  cases: [
    {
      id: 'overview',
      label: 'Overview: an Italian business ready to invoice',
      model: record('MODA-DEMO'),
      note: 'Key numbers and Now come from its quotes and orders; the side panel says nothing waits.',
    },
    {
      id: 'overview-missing',
      label: "Overview: a prospect that can't be invoiced yet",
      model: record('NUOVO-PROVA', { quotes: loaded([]), orders: loaded([]) }),
      note: 'Each next step has the button that fixes it; Activate is the primary action.',
    },
    { id: 'overview-fiscal-drawer', label: 'Overview: a brand without SDI code or PEC', model: record('MARCHIO-ESEMPIO') },
    { id: 'overview-eu-valid', label: 'Overview: EU business, VIES valid', model: record('DE-BEISPIEL') },
    { id: 'overview-person', label: 'Overview: a private person (rider)', model: record('PILOTA-DEMO', { quotes: loaded([]), orders: loaded([]) }) },
    { id: 'overview-extra-eu', label: 'Overview: a customer outside the EU (CHF)', model: record('CH-DEMO', { quotes: loaded([]), orders: loaded([]) }) },
    {
      id: 'overview-no-price',
      label: 'Overview: a role without the price grain',
      model: record('MODA-DEMO', { can: { ...RECORD_CAN, price: false }, quotes: loaded(withoutMoney(QUOTES)), orders: loaded(withoutMoney(ORDERS)) }),
      note: 'Counts only: amounts are not sent and not drawn.',
    },
    { id: 'blocked', label: 'Blocked, with its reason', model: record('BLOCCATO-DEMO') },
    { id: 'archived', label: 'Archived: read only until reactivated', model: record('ARCHIVIATO-DEMO', { quotes: loaded([]), orders: loaded([]) }) },
    { id: 'read-only', label: 'Read-only rights: you can view, not change', model: record('MODA-DEMO', { can: { ...RECORD_CAN, manage: false, block: false, vies: false } }) },
    { id: 'addresses', label: 'Addresses & contacts', model: record('MODA-DEMO', { tab: 'addresses' }), note: 'The default switches save at once; Edit opens the address.' },
    { id: 'addresses-saving', label: 'Addresses: a default being saved', model: record('MODA-DEMO', { tab: 'addresses', saving: `shipTo:${by('MODA-DEMO').addresses[1]!.id}` }) },
    { id: 'addresses-empty', label: 'Addresses & contacts: none yet', model: record('NUOVO-PROVA', { tab: 'addresses' }) },
    { id: 'address-new', label: 'Add an address', model: record('MODA-DEMO', { tab: 'addresses', dialog: { kind: 'address' } }) },
    {
      id: 'address-edit',
      label: 'Edit an address (sent documents keep their copy)',
      model: record('MODA-DEMO', { tab: 'addresses', dialog: { kind: 'address', addressId: by('MODA-DEMO').addresses[1]!.id } }),
    },
    {
      id: 'address-refused',
      label: 'An address refused by the API',
      model: record('MODA-DEMO', { tab: 'addresses', dialog: { kind: 'address', addressId: by('MODA-DEMO').addresses[0]!.id }, dialogProblem: 'problem.invalid', refused: ['postalCode'] }),
    },
    { id: 'contact-new', label: 'Add a contact', model: record('MODA-DEMO', { tab: 'addresses', dialog: { kind: 'contact' } }) },
    { id: 'tax', label: 'Tax & terms: an Italian identity', model: record('MODA-DEMO', { tab: 'tax' }) },
    { id: 'tax-eu-valid', label: 'Tax & terms: VIES valid, with its proof', model: record('DE-BEISPIEL', { tab: 'tax' }) },
    { id: 'tax-eu-invalid', label: 'Tax & terms: VIES answered not valid', model: record('FR-EXEMPLE', { tab: 'tax' }) },
    { id: 'tax-eu-held', label: "Tax & terms: VIES didn't answer (held, not a refusal)", model: record('AT-MUSTER', { tab: 'tax' }) },
    { id: 'tax-eu-unchecked', label: 'Tax & terms: never checked', model: record('ES-PRUEBA', { tab: 'tax', history: loaded([]) }) },
    {
      id: 'tax-checking',
      label: 'Tax & terms: a check running',
      model: record('ES-PRUEBA', { tab: 'tax', viesRunning: true, notice: { key: 'vies.checkingOne', tone: 'info', params: { name: 'Prueba Motos S.L.' } } }),
    },
    { id: 'identity-new', label: 'New tax identity from a date', model: record('MODA-DEMO', { tab: 'tax', dialog: { kind: 'identity', mode: 'new' } }) },
    { id: 'identity-correct', label: 'Correct the identity in force (add the SDI code)', model: record('MARCHIO-ESEMPIO', { tab: 'tax', dialog: { kind: 'identity', mode: 'correct' } }) },
    { id: 'identity-first', label: 'A first tax identity', model: record('NUOVO-PROVA', { tab: 'tax', dialog: { kind: 'identity', mode: 'new' } }) },
    { id: 'quotes-orders', label: 'Quotes & orders: open', model: record('MODA-DEMO', { tab: 'orders' }) },
    { id: 'quotes-orders-all', label: 'Quotes & orders: all', model: record('MODA-DEMO', { tab: 'orders', deals: 'all' }) },
    {
      id: 'quotes-orders-no-price',
      label: 'Quotes & orders: without the price grain',
      model: record('MODA-DEMO', { tab: 'orders', deals: 'all', can: { ...RECORD_CAN, price: false }, quotes: loaded(withoutMoney(QUOTES)), orders: loaded(withoutMoney(ORDERS)) }),
    },
    { id: 'quotes-orders-empty', label: 'Quotes & orders: none yet', model: record('NUOVO-PROVA', { tab: 'orders', quotes: loaded([]), orders: loaded([]) }) },
    { id: 'quotes-orders-error', label: "Quotes & orders: couldn't load", model: record('MODA-DEMO', { tab: 'orders', quotes: failed('problem.unavailable') }) },
    { id: 'documents', label: 'Documents (files of the record)', model: record('MODA-DEMO', { tab: 'documents' }) },
    { id: 'activity', label: 'Activity (thread, files, history)', model: record('MODA-DEMO', { tab: 'activity' }) },
    { id: 'dock', label: 'Thread beside Overview (≥ 1280 px, ⌘J)', model: record('MODA-DEMO', { dockOpen: true }), note: 'Owner O1: wide screens only; narrower, the button opens Activity.' },
    { id: 'edit', label: 'Edit the identity (explicit save)', model: record('MODA-DEMO', { dialog: { kind: 'edit' } }) },
    { id: 'block', label: 'Block customer', model: record('MODA-DEMO', { dialog: { kind: 'block' } }) },
    { id: 'archive', label: 'Archive customer', model: record('NUOVO-PROVA', { dialog: { kind: 'archive' } }) },
    { id: 'changed', label: 'Changed by someone else while editing', model: record('MODA-DEMO', { changedAt: at(29, 9, 40) }), note: 'Our unsaved work is kept until Reload.' },
    { id: 'conflict', label: 'A save refused: changed meanwhile', model: record('MODA-DEMO', { notice: { key: 'problem.conflict', tone: 'warning' } }) },
    { id: 'offline', label: 'Offline', model: record('MODA-DEMO', { live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: record('MODA-DEMO', { party: null, asOf: null, live: 'connecting', quotes: loading(), orders: loading() }) },
    { id: 'not-found', label: 'Not found', model: record('MODA-DEMO', { party: null, problem: 'problem.notFound' }) },
    { id: 'error', label: "The API didn't answer", model: record('MODA-DEMO', { party: null, problem: 'problem.unavailable' }) },
    { id: 'no-access', label: 'No permission', model: record('MODA-DEMO', { can: { ...RECORD_CAN, view: false } }) },
    { id: 'shortcuts', label: 'Keyboard shortcuts (?)', model: record('MODA-DEMO', { dialog: { kind: 'shortcuts' }, asOf: NOW }) },
  ],
})
