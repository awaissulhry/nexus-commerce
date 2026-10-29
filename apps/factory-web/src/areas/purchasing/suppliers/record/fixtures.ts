import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, inShell, panels, PURCHASE_ORDERS, RECORD_CAN, recordModel, SUPPLIERS, withoutMoney } from '../../../parties/_shared/fixtures'
import { failed, loaded, loading, partyDraftOf, type PartyRecordModel } from '../../../parties/_shared/model'
import type { Party } from '../../../parties/_shared/api'
import { SupplierRecordView } from './view/SupplierRecordView'

/**
 * SCR-057 Supplier record — made-up suppliers only. Each case is one state the Owner reviews: the Overview form (⌘S),
 * a change waiting with a problem (Save held with its reason), a prospect waiting for approval, EU tanneries with VIES,
 * blocked, read-only rights, no cost grain, contacts (who receives POs), orders, activity, dialogs, loading and errors.
 */

const by = (code: string): Party => SUPPLIERS.find((item) => item.code === code)!
const record = (code: string, over: Partial<PartyRecordModel> = {}) => recordModel('suppliers', by(code), over)

function SupplierDesign({ model }: { model: PartyRecordModel }) {
  const party = model.party
  return inShell(`/purchasing/suppliers/${party?.id ?? 'x'}`, createElement(SupplierRecordView, { model, panels: party ? panels(party) : null }))
}

export const designScreen = defineDesignScreen<PartyRecordModel>({
  screen: 'SCR-057',
  title: 'Supplier record',
  view: SupplierDesign,
  cases: [
    { id: 'overview', label: 'Overview: the supplier, its tax identity and addresses', model: record('CONCERIA-DEMO'), note: 'Change a field and the bar appears (⌘S saves, Discard puts it back).' },
    {
      id: 'overview-editing',
      label: 'Overview: unsaved changes with a problem',
      model: record('CONCERIA-DEMO', { draft: { ...partyDraftOf(by('CONCERIA-DEMO')), legalName: '', paymentTerms: 'RiBa 90 gg f.m.' } }),
      note: 'Save is held until the legal name is back.',
    },
    { id: 'overview-saved', label: 'Overview: saved', model: record('CONCERIA-DEMO', { notice: { key: 'done.saved', tone: 'success' } }) },
    { id: 'prospect', label: 'A prospect: approve it before POs', model: record('PROTEZIONI-PROVA', { purchaseOrders: loaded([]) }) },
    { id: 'eu-valid', label: 'EU tannery: VIES valid', model: record('DE-LEDER', { purchaseOrders: loaded([]) }) },
    { id: 'eu-unchecked', label: 'EU tannery: never checked', model: record('PT-EXEMPLO', { purchaseOrders: loaded([]) }) },
    { id: 'subcontractor', label: 'A subcontractor (a person’s workshop)', model: record('TERZISTA-DEMO', { purchaseOrders: loaded([]) }) },
    { id: 'both-sides', label: 'Also a customer: one party record', model: record('PELLETTERIA-DOPPIA', { purchaseOrders: loaded([]) }) },
    { id: 'blocked', label: 'Blocked, with its reason', model: record('FORN-BLOCCATO') },
    { id: 'read-only', label: 'Read-only rights: fields as text', model: record('CONCERIA-DEMO', { can: { ...RECORD_CAN, manage: false, block: false, vies: false } }) },
    {
      id: 'no-cost',
      label: 'A role without the cost grain',
      model: record('CONCERIA-DEMO', { can: { ...RECORD_CAN, cost: false }, purchaseOrders: loaded(withoutMoney(PURCHASE_ORDERS)) }),
      note: 'No values drawn, not even as —.',
    },
    { id: 'contacts', label: 'Contacts: who receives POs', model: record('CONCERIA-DEMO', { tab: 'contacts' }), note: 'The Receives POs box saves at once.' },
    { id: 'contacts-nobody', label: 'Contacts: nobody receives POs yet', model: record('TESSITURA-ESEMPIO', { tab: 'contacts' }) },
    { id: 'contacts-empty', label: 'Contacts: none yet', model: record('PROTEZIONI-PROVA', { tab: 'contacts' }) },
    { id: 'contact-new', label: 'Add a contact', model: record('CONCERIA-DEMO', { tab: 'contacts', dialog: { kind: 'contact' } }) },
    { id: 'orders', label: 'Orders', model: record('CONCERIA-DEMO', { tab: 'orders' }) },
    {
      id: 'orders-no-cost',
      label: 'Orders without the cost grain',
      model: record('CONCERIA-DEMO', { tab: 'orders', can: { ...RECORD_CAN, cost: false }, purchaseOrders: loaded(withoutMoney(PURCHASE_ORDERS)) }),
    },
    { id: 'orders-empty', label: 'Orders: none yet', model: record('PROTEZIONI-PROVA', { tab: 'orders', purchaseOrders: loaded([]) }) },
    { id: 'orders-error', label: "Orders: couldn't load", model: record('CONCERIA-DEMO', { tab: 'orders', purchaseOrders: failed('problem.unavailable') }) },
    { id: 'activity', label: 'Activity', model: record('CONCERIA-DEMO', { tab: 'activity' }) },
    { id: 'dock', label: 'Thread beside Overview (≥ 1280 px, ⌘J)', model: record('CONCERIA-DEMO', { dockOpen: true }) },
    { id: 'address-new', label: 'Add a pick-up address', model: record('CONCERIA-DEMO', { dialog: { kind: 'address' } }) },
    { id: 'identity-new', label: 'New tax identity from a date', model: record('CONCERIA-DEMO', { dialog: { kind: 'identity', mode: 'new' } }) },
    { id: 'block', label: 'Block supplier', model: record('CONCERIA-DEMO', { dialog: { kind: 'block' } }) },
    { id: 'changed', label: 'Changed by someone else while editing', model: record('CONCERIA-DEMO', { changedAt: at(29, 9, 40) }) },
    { id: 'loading', label: 'Loading', model: record('CONCERIA-DEMO', { party: null, asOf: null, live: 'connecting', purchaseOrders: loading() }) },
    { id: 'not-found', label: 'Not found', model: record('CONCERIA-DEMO', { party: null, problem: 'problem.notFound' }) },
    { id: 'no-access', label: 'No permission', model: record('CONCERIA-DEMO', { can: { ...RECORD_CAN, view: false } }) },
    { id: 'shortcuts', label: 'Keyboard shortcuts (?)', model: record('CONCERIA-DEMO', { dialog: { kind: 'shortcuts' } }) },
  ],
})
