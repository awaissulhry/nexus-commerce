import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { inShell, listModel, rowOf, SUPPLIERS, useDesignList } from '../../parties/_shared/fixtures'
import { blankNewParty, failed, loaded, loading, SIDES, type PartiesListModel } from '../../parties/_shared/model'
import { SuppliersView } from './view/SuppliersView'

/**
 * SCR-056 Suppliers — made-up suppliers only (a "Conceria Demo", a "Tessitura Esempio", a subcontractor, a carrier, two
 * EU tanneries; example.com mail, VAT numbers of zeros and ones). Each case is one state the Owner reviews.
 */

const rows = SUPPLIERS.map(rowOf)
const list = (over: Partial<PartiesListModel> = {}) => listModel('suppliers', over)
const pick = (...codes: string[]) => rows.filter((row) => codes.includes(row.code)).map((row) => row.id)

function SuppliersDesign({ model }: { model: PartiesListModel }) {
  return inShell('/purchasing/suppliers', createElement(SuppliersView, useDesignList(model)))
}

const euDraft = () => {
  const draft = blankNewParty(SIDES.suppliers)
  return {
    ...draft,
    party: { ...draft.party, country: 'PT', language: 'pt', legalName: 'Couros Exemplo Lda', code: 'COUROS-EXEMPLO' },
    identity: { ...draft.identity, country: 'PT', taxMode: 'EU_B2B' as const, vatNumber: 'PT111111111' },
  }
}

export const designScreen = defineDesignScreen<PartiesListModel>({
  screen: 'SCR-056',
  title: 'Suppliers',
  view: SuppliersDesign,
  cases: [
    { id: 'list', label: 'The list: roles, VAT number with its VIES mark', model: list(), note: 'Pelletteria Doppia is also a customer: one party record, both lists.' },
    { id: 'view-subcontractors', label: 'Rows ▾ Subcontractors', model: list({ view: 'subcontractors', rows: loaded(rows.filter((row) => row.roles.includes('SUBCONTRACTOR'))), total: 1 }) },
    { id: 'tile-prospects', label: 'Tile pressed: prospects (no POs until approved)', model: list({ view: 'prospects', rows: loaded(rows.filter((row) => row.status === 'PROSPECT')), total: 1 }) },
    { id: 'search', label: 'Search', model: list({ query: 'conceria', rows: loaded(rows.filter((row) => /conceria/i.test(row.legalName))), total: 1 }) },
    { id: 'filtered-empty', label: 'No rows match these filters', model: list({ query: 'zzz', rows: loaded([]), total: 0 }) },
    { id: 'empty', label: 'First day: no supplier yet', model: list({ rows: loaded([]), total: 0, tiles: { active: 0, prospects: 0, blocked: 0 } }) },
    { id: 'loading', label: 'Loading', model: list({ rows: loading(), total: null, tiles: {}, asOf: null, live: 'connecting' }) },
    {
      id: 'error',
      label: "The API didn't answer",
      model: list({ rows: failed('problem.unavailable'), total: null, tiles: { active: null, prospects: null, blocked: null }, asOf: null, live: 'offline' }),
    },
    { id: 'no-access', label: 'No permission', model: list({ can: { view: false, manage: false, block: false, vies: false } }) },
    { id: 'read-only', label: 'Read-only rights: actions held with their reason', model: list({ can: { view: true, manage: false, block: false, vies: false }, selected: pick('DE-LEDER') }) },
    { id: 'selection', label: 'Selection: reach said before the click', model: list({ selected: pick('DE-LEDER', 'PT-EXEMPLO', 'CONCERIA-DEMO', 'FORN-BLOCCATO') }) },
    { id: 'live-updates', label: 'Live: 2 updates waiting', model: list({ updates: 2 }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows', model: list({ focusRow: 1 }) },
    { id: 'new', label: 'New supplier (opens as a prospect)', model: list({ dialog: { kind: 'new' } }) },
    { id: 'new-eu', label: 'New supplier: an EU tannery', model: list({ dialog: { kind: 'new' }, newDraft: euDraft() }) },
    {
      id: 'new-duplicate',
      label: 'New supplier: already a customer',
      model: list({ dialog: { kind: 'new' }, dialogProblem: 'new.conflictNumber', duplicates: [rowOf(SUPPLIERS.find((item) => item.code === 'PELLETTERIA-DOPPIA')!)] }),
    },
    { id: 'block', label: 'Block a supplier', model: list({ dialog: { kind: 'block', partyIds: pick('TESSITURA-ESEMPIO') } }) },
    { id: 'all-selected', label: 'Every loaded row selected (header box)', model: list({ selected: rows.map((row) => row.id) }) },
    { id: 'archive', label: 'Archive a supplier', model: list({ dialog: { kind: 'archive', partyIds: pick('PROTEZIONI-PROVA') } }) },
    { id: 'shortcuts', label: 'Keyboard shortcuts (?)', model: list({ dialog: { kind: 'shortcuts' } }) },
  ],
})
