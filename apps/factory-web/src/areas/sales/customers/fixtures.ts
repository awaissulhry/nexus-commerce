import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { CUSTOMERS, inShell, listModel, rowOf, SUPPLIERS, useDesignList } from '../../parties/_shared/fixtures'
import { blankNewParty, failed, loaded, loading, SIDES, type PartiesListModel } from '../../parties/_shared/model'
import { CustomersView } from './view/CustomersView'

/**
 * SCR-032 Customers — made-up customers only ("Demo", "Esempio", "Beispiel" names, example.com mail, VAT numbers of
 * zeros and ones). Each case is one state the Owner reviews: the list with its tiles, each tile pressed, search,
 * nothing yet, nothing matching, loading, a failed read, no access, read-only rights (held actions with their reason),
 * a selection with its reach, live updates waiting, offline, more pages, and every dialog.
 */

const rows = CUSTOMERS.map(rowOf)
const list = (over: Partial<PartiesListModel> = {}) => listModel('customers', over)
const pick = (...codes: string[]) => rows.filter((row) => codes.includes(row.code)).map((row) => row.id)

function CustomersDesign({ model }: { model: PartiesListModel }) {
  return inShell('/sales/customers', createElement(CustomersView, useDesignList(model)))
}

const euDraft = () => {
  const draft = blankNewParty(SIDES.customers)
  return {
    ...draft,
    party: { ...draft.party, country: 'DE', language: 'de', legalName: 'Beispiel Neu GmbH', code: 'BEISPIEL-NEU' },
    identity: { ...draft.identity, country: 'DE', taxMode: 'EU_B2B' as const, vatNumber: 'DE222222222' },
    codeTouched: false,
  }
}

export const designScreen = defineDesignScreen<PartiesListModel>({
  screen: 'SCR-032',
  title: 'Customers',
  view: CustomersDesign,
  cases: [
    { id: 'list', label: 'The list: tiles, roles, VIES and SDI columns', model: list(), note: 'Press a VIES mark for the result; a tile is a saved filter (its chip shows in the filter row).' },
    {
      id: 'tile-vies',
      label: 'Tile pressed: EU businesses without a valid VIES check',
      model: list({ view: 'vies', rows: loaded(rows.filter((row) => row.attention.includes('VIES_NOT_PROVEN'))), total: 3 }),
    },
    { id: 'tile-invoice', label: "Tile pressed: can't be invoiced yet", model: list({ view: 'invoice', rows: loaded(rows.filter((row) => row.invoiceBlocked)), total: 2 }) },
    {
      id: 'view-brands',
      label: 'Rows ▾ Brands, with a kind filter',
      model: list({ view: 'brands', filters: { kind: 'ORGANISATION' }, rows: loaded(rows.filter((row) => row.roles.includes('BRAND'))), total: 2 }),
    },
    { id: 'search', label: 'Search by name or VAT number', model: list({ query: 'demo', rows: loaded(rows.filter((row) => /demo/i.test(`${row.code} ${row.legalName}`))), total: 6 }) },
    { id: 'filtered-empty', label: 'No rows match these filters', model: list({ query: 'zzz', rows: loaded([]), total: 0 }) },
    { id: 'empty', label: 'First day: no customer yet', model: list({ rows: loaded([]), total: 0, tiles: { active: 0, prospects: 0, vies: 0, invoice: 0, blocked: 0 } }) },
    { id: 'loading', label: 'Loading', model: list({ rows: loading(), total: null, tiles: {}, asOf: null, live: 'connecting' }) },
    {
      id: 'error',
      label: "The API didn't answer",
      model: list({ rows: failed('problem.unavailable'), total: null, tiles: { active: null, prospects: null, vies: null, invoice: null, blocked: null }, asOf: null, live: 'offline' }),
      note: 'Never drawn as an empty list; the tiles say they could not count.',
    },
    { id: 'no-access', label: 'No permission: what is needed and who has it', model: list({ can: { view: false, manage: false, block: false, vies: false } }) },
    {
      id: 'read-only',
      label: 'Read-only rights: actions held with their reason',
      model: list({ can: { view: true, manage: false, block: false, vies: false }, selected: pick('DE-BEISPIEL', 'MODA-DEMO') }),
      note: 'New customer, Check VIES and Archive stay focusable and say which right is missing.',
    },
    {
      id: 'selection',
      label: 'Selection: reach said before the click',
      model: list({ selected: pick('DE-BEISPIEL', 'FR-EXEMPLE', 'AT-MUSTER', 'MODA-DEMO', 'BLOCCATO-DEMO') }),
      note: '5 selected: VIES reaches the 3 EU businesses; Archive the 4 not blocked.',
    },
    { id: 'selection-held', label: 'Selection: nothing VIES can check (held)', model: list({ selected: pick('MODA-DEMO', 'PILOTA-DEMO') }) },
    { id: 'live-updates', label: 'Live: 3 updates waiting behind Show', model: list({ updates: 3 }), note: 'Rows never move under the cursor.' },
    { id: 'offline', label: 'Offline: rows stay readable with their time', model: list({ live: 'offline' }) },
    { id: 'more', label: 'More than one page (Show more)', model: list({ more: true, total: 132 }) },
    { id: 'notice', label: 'A receipt after blocking', model: list({ notice: { key: 'done.block', tone: 'success', params: { name: 'Bloccato Demo S.p.A.' } } }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows, x selects, the keys in the footer icon', model: list({ focusRow: 2, selected: pick('FR-EXEMPLE') }) },
    { id: 'new', label: 'New customer (VAT number first)', model: list({ dialog: { kind: 'new' } }), note: '⌘↵ creates; the code follows the name until it is typed.' },
    { id: 'new-eu', label: 'New customer: an EU business (VIES asked on create)', model: list({ dialog: { kind: 'new' }, newDraft: euDraft() }) },
    {
      id: 'new-duplicate',
      label: 'New customer: the VAT number already belongs to a party',
      model: list({ dialog: { kind: 'new' }, dialogProblem: 'new.conflictNumber', duplicates: [rowOf(SUPPLIERS.find((item) => item.code === 'PELLETTERIA-DOPPIA')!)] }),
      note: 'One record per business partner: open it and give it the Customer role.',
    },
    { id: 'new-refused', label: 'New customer: a value refused by the API', model: list({ dialog: { kind: 'new' }, newDraft: euDraft(), dialogProblem: 'problem.invalid', refused: ['vatNumber'] }) },
    {
      id: 'new-companies',
      label: 'New customer: a person working in two companies chooses where it belongs',
      model: list({
        dialog: { kind: 'new' },
        companies: [
          { id: 'c1', name: 'Officina Demo S.r.l.' },
          { id: 'c2', name: 'Pelletteria Esempio S.p.A.' },
        ],
      }),
    },
    { id: 'block', label: 'Block a customer (reason required)', model: list({ dialog: { kind: 'block', partyIds: pick('MODA-DEMO') } }) },
    {
      id: 'block-many',
      label: 'Block 3 customers with one reason',
      model: list({ selected: pick('MODA-DEMO', 'MARCHIO-ESEMPIO', 'DE-BEISPIEL', 'NUOVO-PROVA'), dialog: { kind: 'block', partyIds: pick('MODA-DEMO', 'MARCHIO-ESEMPIO', 'DE-BEISPIEL') } }),
      note: 'Block N reaches the active ones only (the prospect is left out).',
    },
    { id: 'archive', label: 'Archive a customer', model: list({ dialog: { kind: 'archive', partyIds: pick('NUOVO-PROVA') } }) },
    {
      id: 'archive-many',
      label: 'Archive 3 customers',
      model: list({ selected: pick('NUOVO-PROVA', 'ES-PRUEBA', 'CH-DEMO', 'BLOCCATO-DEMO'), dialog: { kind: 'archive', partyIds: pick('NUOVO-PROVA', 'ES-PRUEBA', 'CH-DEMO') } }),
    },
    {
      id: 'bulk-running',
      label: 'Check VIES for 3: running',
      model: list({
        dialog: { kind: 'bulk' },
        bulk: { kind: 'vies', total: 3, done: false, results: [{ id: 'a', code: 'DE-BEISPIEL', name: 'Beispiel Motorrad GmbH', outcome: 'vies.result.VALID', tone: 'success' }] },
      }),
    },
    {
      id: 'bulk-done',
      label: 'Check VIES for 3: done, one with no answer',
      model: list({
        dialog: { kind: 'bulk' },
        bulk: {
          kind: 'vies',
          total: 3,
          done: true,
          results: [
            { id: 'a', code: 'DE-BEISPIEL', name: 'Beispiel Motorrad GmbH', outcome: 'vies.result.VALID', tone: 'success' },
            { id: 'b', code: 'FR-EXEMPLE', name: 'Exemple Moto SARL', outcome: 'vies.result.INVALID', tone: 'danger' },
            { id: 'c', code: 'AT-MUSTER', name: 'Muster Leder GmbH', outcome: 'vies.result.ERROR', tone: 'warning' },
          ],
        },
      }),
    },
    { id: 'shortcuts', label: 'Keyboard shortcuts (?)', model: list({ dialog: { kind: 'shortcuts' } }) },
  ],
})
