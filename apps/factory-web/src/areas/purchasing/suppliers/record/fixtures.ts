import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, inShell, panels, PURCHASE_ORDERS, RECORD_CAN, recordModel, SUPPLIERS, withoutMoney } from '../../../parties/_shared/fixtures'
import { failed, loaded, loading, partyDraftOf, type PartyRecordModel } from '../../../parties/_shared/model'
import type { Party } from '../../../parties/_shared/api'
import { SupplierRecordView } from './view/SupplierRecordView'
import { ACTIVE_SOURCES, addDraft, CAN, changed, DesignSources, KANGAROO, MATERIAL, MATERIAL_OPTIONS, SOURCES, sourcesModel, withoutCost } from '../sources/demo/fixtures'
import { say, type ApprovedSourcesModel } from '../sources/model'

/**
 * SCR-057 Supplier record — made-up suppliers only. Each case is one state the Owner reviews: the Overview form (⌘S),
 * a change waiting with a problem (Save held with its reason), a prospect waiting for approval, EU tanneries with VIES,
 * blocked, read-only rights, no cost grain, contacts (who receives POs), orders, activity, dialogs, loading and errors.
 * B-W2a-69: Items & prices (`items-*`): the approved sources typed in place (saving, saved, refused), a primary that
 * demotes another, Add a source (search, picked, refused as a duplicate), archived, bulk Archive / Restore, empty,
 * loading, error, read-only, no cost grain, no purchasing.view, the keys.
 */

/** A record case with the Items & prices tab's own model (the slot Purchasing draws). */
type SupplierCase = PartyRecordModel & { sources?: ApprovedSourcesModel }

const by = (code: string): Party => SUPPLIERS.find((item) => item.code === code)!
const record = (code: string, over: Partial<PartyRecordModel> = {}): SupplierCase => recordModel('suppliers', by(code), over)
const items = (sources: Partial<ApprovedSourcesModel> = {}, over: Partial<PartyRecordModel> = {}): SupplierCase => ({ ...record('CONCERIA-DEMO', { tab: 'items', ...over }), sources: sourcesModel(sources) })
const ROW = ACTIVE_SOURCES[0]!

function SupplierDesign({ model }: { model: SupplierCase }) {
  const party = model.party
  const { sources, ...record } = model
  return inShell(
    `/purchasing/suppliers/${party?.id ?? 'x'}`,
    createElement(SupplierRecordView, { model: record, panels: party ? panels(party) : null, items: createElement(DesignSources, { model: sources ?? sourcesModel() }) }),
  )
}

export const designScreen = defineDesignScreen<SupplierCase>({
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
    { id: 'items', label: 'Items & prices: approved sources', model: items(), note: 'Type in a cell and leave it: one field saved with the row\u2019s version. A colour\u2019s own primary, every colour of every company, an unusable unit.' },
    { id: 'items-saving', label: 'Items & prices: a price saving', model: items({ cells: { [`${ROW.id}:unitPrice`]: { state: 'saving' } } }) },
    { id: 'items-saved', label: 'Items & prices: the minimum saved', model: items({ cells: { [`${ROW.id}:minOrderQty`]: { state: 'saved' } } }) },
    {
      id: 'items-refused',
      label: 'Items & prices: cells refused',
      model: items({ cells: { [`${ROW.id}:leadTimeDays`]: { state: 'refused', words: say('cell.badDays', { max: 366 }) }, [`${ACTIVE_SOURCES[2]!.id}:unitPrice`]: { state: 'refused', words: say('cell.changed') } }, notice: { tone: 'warning', words: changed } }),
      note: 'A typed value the rules refuse says why in the cell; a 409 reads the row again and says so.',
    },
    { id: 'items-demoted', label: 'Items & prices: a new primary demotes another', model: items({ notice: { tone: 'info', words: say('notice.demoted', { supplier: 'Conceria Esempio Due', material: MATERIAL.leather.code }) } }) },
    { id: 'items-add', label: 'Add a source: find the material', model: items({ dialog: addDraft({ materialQuery: 'demo', materials: MATERIAL_OPTIONS }) }) },
    { id: 'items-add-picked', label: 'Add a source: material picked, as primary', model: items({ dialog: addDraft({ material: KANGAROO, itemColourId: KANGAROO.colours[0]!.id, purchaseUom: 'HIDE', unitPrice: '98,50', minOrderQty: '10', leadTimeDays: '18', preference: 'PRIMARY', supplierArticleCode: 'CD-CNG10' }) }) },
    { id: 'items-add-duplicate', label: 'Add a source: refused, a duplicate', model: items({ dialog: addDraft({ material: KANGAROO, unitPrice: '98.5', problem: say('add.refused.duplicate') }) }) },
    { id: 'items-add-every', label: 'Add a source: every company, refused by the role', model: items({ dialog: addDraft({ material: KANGAROO, scope: 'every', problem: say('add.refused.everyCompany') }) }) },
    { id: 'items-archived', label: 'Items & prices: archived sources', model: items({ view: 'archived', read: { status: 'ready', rows: SOURCES.filter((row) => row.status === 'ARCHIVED'), more: false } }), note: 'An archived row reads as text: restore it to change it.' },
    { id: 'items-all', label: 'Items & prices: all, a pick across states', model: items({ view: 'all', read: { status: 'ready', rows: SOURCES, more: false }, selected: [SOURCES[1]!.id, SOURCES[4]!.id] }), note: 'Archive 1 and Restore 1: each verb reaches the rows of its state.' },
    { id: 'items-archive', label: 'Archive 2 sources', model: items({ selected: [ACTIVE_SOURCES[1]!.id, ACTIVE_SOURCES[3]!.id], dialog: { kind: 'archive', ids: [ACTIVE_SOURCES[1]!.id, ACTIVE_SOURCES[3]!.id], reason: 'Not bought from them any more.', busy: false } }) },
    {
      id: 'items-bulk-done',
      label: 'Archive: one done, one refused',
      model: items({ bulk: { verb: 'archive', done: 1, refused: [{ label: `${MATERIAL.lining.code} · NERO`, words: say('cell.changed') }] } }),
    },
    { id: 'items-empty', label: 'Items & prices: none yet', model: items({ read: { status: 'ready', rows: [], more: false } }) },
    { id: 'items-loading', label: 'Items & prices: loading', model: items({ read: { status: 'loading' } }) },
    { id: 'items-error', label: "Items & prices: couldn't load", model: items({ read: { status: 'error', problem: 'problem.offline' } }) },
    { id: 'items-read-only', label: 'Items & prices: read only (no purchasing.sources.manage)', model: items({ can: { ...CAN, manage: false } }), note: 'Cells as text with the reason; Add held with it.' },
    { id: 'items-no-cost', label: 'Items & prices: no cost grain', model: items({ can: { ...CAN, cost: false }, read: { status: 'ready', rows: withoutCost(ACTIVE_SOURCES), more: false } }), note: 'No price column, not even as —; no last purchase price.' },
    { id: 'items-no-access', label: 'Items & prices: no purchasing.view', model: items({ can: { ...CAN, view: false } }, { can: { ...RECORD_CAN, purchaseOrders: false } }) },
    { id: 'items-keys', label: 'Items & prices: keyboard shortcuts', model: items({ dialog: { kind: 'keys' } }) },
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
