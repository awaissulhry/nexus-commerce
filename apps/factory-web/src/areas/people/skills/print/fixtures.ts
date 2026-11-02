import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { MATRIX, ROWS } from '../fixtures'
import { skillsAddressOf } from '../model'
import { MatrixPrintView, type MatrixPrintModel } from './view/MatrixPrintView'

/** SCR-160-print — the matrix on one A3 sheet with its filters on top, made-up people only. */
const sheet = (over: Partial<MatrixPrintModel> = {}, terms = ''): MatrixPrintModel => ({
  person: 'Anna Esempio',
  at: '2026-11-02T09:42:00.000Z',
  company: 'Officina Demo',
  site: 'Stabilimento Nord',
  address: skillsAddressOf(new URLSearchParams(terms)),
  picked: 0,
  matrix: { value: MATRIX, problem: null },
  ...over,
})

export const designScreen = defineDesignScreen<MatrixPrintModel>({
  screen: 'SCR-160-print',
  title: 'Skills matrix (A3 print)',
  view: MatrixPrintView,
  cases: [
    { id: 'sheet', label: 'One site, grouped line › team', model: sheet() },
    { id: 'filtered', label: 'A tile and a search written on top', model: sheet({ matrix: { value: { ...MATRIX, rows: ROWS.slice(1, 3) }, problem: null } }, 'tile=TRAINEES&q=Prova') },
    { id: 'picked', label: 'Two people chosen, by name', model: sheet({ site: null, picked: 2, matrix: { value: { ...MATRIX, rows: ROWS.slice(0, 2) }, problem: null } }, 'sort=NAME') },
    { id: 'empty', label: 'Nobody in this view', model: sheet({ matrix: { value: { ...MATRIX, rows: [] }, problem: null } }) },
    { id: 'loading', label: 'Loading', model: sheet({ matrix: { value: null, problem: null } }) },
    { id: 'error', label: "Couldn't be read", model: sheet({ matrix: { value: null, problem: 'problem.unavailable' } }) },
  ],
})
