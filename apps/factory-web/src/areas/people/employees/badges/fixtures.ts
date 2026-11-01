import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { EMPLOYEE_LIST, ORIGIN, PREFIX } from '../../_shared/fixtures'
import { BadgeSheetView, type BadgeSheetModel } from './view/BadgeSheetView'

/** SCR-085-badges — the badge sheet (a new tab), made-up people only: the sheet, one not found, empty, loading, failed. */
const sheet = (over: Partial<BadgeSheetModel> = {}): BadgeSheetModel => ({
  person: 'Anna Esempio',
  at: '2026-11-02T09:42:00.000Z',
  asked: 6,
  people: { value: EMPLOYEE_LIST.slice(0, 6), problem: null },
  origin: ORIGIN,
  prefix: PREFIX,
  companyName: 'Officina Demo',
  ...over,
})

export const designScreen = defineDesignScreen<BadgeSheetModel>({
  screen: 'SCR-085-badges',
  title: 'Badge sheet (print)',
  view: BadgeSheetView,
  cases: [
    { id: 'sheet', label: 'Six badges for paper', model: sheet() },
    { id: 'missing', label: 'One person not found', model: sheet({ asked: 3, people: { value: EMPLOYEE_LIST.slice(0, 2), problem: null } }) },
    { id: 'empty', label: 'Nobody chosen', model: sheet({ asked: 0, people: { value: [], problem: null } }) },
    { id: 'loading', label: 'Loading', model: sheet({ people: { value: null, problem: null } }) },
    { id: 'error', label: "The people couldn't be read", model: sheet({ people: { value: null, problem: 'problem.unavailable' } }) },
  ],
})
