import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PEOPLE_ROLES, PREFIX } from '../../_shared/fixtures'
import { CLOSE_MONTH, LUL_OPENED } from '../demo/fixtures'
import { attendanceCan } from '../model'
import { LulView, type LulModel } from './view/LulView'

/** The smallest PDF a viewer opens: a blank page, made-up, no person on it. */
const BLANK = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 842 595]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')

/** SCR-157-lul — the LUL calendar tab, made-up document only. */
const lul = (over: Partial<LulModel> = {}): LulModel => ({ allowed: true, closeId: CLOSE_MONTH.closeId, can: attendanceCan(PEOPLE_ROLES.hr), prefix: PREFIX, gateShut: false, opened: LUL_OPENED, src: BLANK, month: CLOSE_MONTH, problem: null, ...over })

export const designScreen = defineDesignScreen<LulModel>({
  screen: 'SCR-157-lul',
  title: 'LUL calendar (PDF)',
  view: ({ model }) => inShell('/people/attendance', createElement(LulView, { model })),
  cases: [
    { id: 'open', label: 'The sealed calendar, the seal, what the consultant confirms', model: lul() },
    { id: 'loading', label: 'Opening', model: lul({ opened: null, src: null }) },
    { id: 'error', label: "Couldn't open", model: lul({ opened: null, src: null, problem: 'problem.unavailable' }) },
    { id: 'gate-off', label: 'Gate shut', model: lul({ opened: null, src: null, gateShut: true }) },
    { id: 'none', label: 'No calendar in the address', model: lul({ closeId: '', opened: null, src: null }) },
    { id: 'no-permission', label: 'No LUL right', model: lul({ allowed: false, opened: null, src: null }) },
  ],
})
