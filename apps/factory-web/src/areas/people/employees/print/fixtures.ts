import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { EMPLOYEE_LIST, PEOPLE } from '../../_shared/fixtures'
import { StaffPrintView, type StaffPrintModel } from './view/StaffPrintView'

/** SCR-084-print — the staff list on paper with its filters written on top, made-up people only. */
const print = (over: Partial<StaffPrintModel> = {}): StaffPrintModel => ({
  person: 'Anna Esempio',
  at: '2026-11-02T09:42:00.000Z',
  company: 'Officina Demo',
  site: 'Stabilimento Nord',
  address: { tile: null, rows: 'ACTIVE', q: '', view: 'people', isNew: false, isImport: false, lineId: null },
  rows: { value: EMPLOYEE_LIST, problem: null, cut: false },
  ...over,
})

export const designScreen = defineDesignScreen<StaffPrintModel>({
  screen: 'SCR-084-print',
  title: 'Staff list (print)',
  view: StaffPrintView,
  cases: [
    { id: 'list', label: 'Everyone active at one site', model: print() },
    { id: 'filtered', label: 'All sites, the agency tile and a search written on top', model: print({ site: null, address: { tile: 'AGENCY_ENDING', rows: 'ACTIVE', q: 'Campione', view: 'people', isNew: false, isImport: false, lineId: null }, rows: { value: [PEOPLE.ion], problem: null, cut: false } }) },
    { id: 'empty', label: 'Nobody in this view', model: print({ rows: { value: [], problem: null, cut: false } }) },
    { id: 'loading', label: 'Loading', model: print({ rows: { value: null, problem: null, cut: false } }) },
    { id: 'error', label: "The list couldn't be read", model: print({ rows: { value: null, problem: 'problem.unavailable', cut: false } }) },
  ],
})
