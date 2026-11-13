import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { demoWorksheetPdf, PREFIX, PROFILE_ID, WORKSHEETS } from '../demo/fixtures'
import { WorksheetView, type WorksheetModel } from './view/WorksheetView'

/**
 * SCR-431 — the made-to-measure worksheet and order form PDF in a new tab (design sales.mtm tab:mtm.worksheet, SAL-303; B-W2b-358's
 * worksheet) with made-up data only: the newest version with Print, an earlier version picked, the same contents shown again (no
 * new version), none kept yet (Make), none without the right to make one, reading, a failed read, the PDF that would not open, a
 * refused keep, no right.
 */

const base = (over: Partial<WorksheetModel> = {}): WorksheetModel => ({
  prefix: PREFIX,
  profileId: PROFILE_ID,
  allowed: true,
  mayMake: true,
  title: { rider: 'Demo Rider Due', garment: 'JACKET', revision: 3 },
  versions: { status: 'ready', items: WORKSHEETS },
  shown: WORKSHEETS[0]!.id,
  pdf: demoWorksheetPdf('JACKET r3 v2 - Demo Rider Due'),
  pdfProblem: null,
  busy: false,
  problem: null,
  sameAsNewest: false,
  ...over,
})

function WorksheetDesign({ model }: { model: WorksheetModel }) {
  return createElement(WorksheetView, { model })
}

export const designScreen = defineDesignScreen<WorksheetModel>({
  screen: 'SCR-431',
  title: 'Made-to-measure worksheet and order form (a new tab)',
  view: WorksheetDesign,
  cases: [
    { id: 'newest', label: 'Sales: version 2 of revision 3 with Print; versions to pick', model: base() },
    { id: 'earlier', label: 'An earlier version picked (revision 1)', model: base({ shown: WORKSHEETS[1]!.id, pdf: demoWorksheetPdf('JACKET r1 v1 - Demo Rider Due') }) },
    { id: 'same', label: 'Nothing changed since the newest: shown again (no new version)', model: base({ sameAsNewest: true }) },
    { id: 'none', label: 'None kept yet: Make the worksheet', model: base({ versions: { status: 'ready', items: [] }, shown: null, pdf: null }) },
    { id: 'none-no-right', label: 'Production manager: none kept, someone who records measurements makes it', model: base({ versions: { status: 'ready', items: [] }, shown: null, pdf: null, mayMake: false }) },
    { id: 'read-only', label: 'Production manager: reads the newest; Make again held with why', model: base({ mayMake: false }) },
    { id: 'refused', label: 'The keep refused (said above the PDF)', model: base({ problem: { key: 'problem.conflict' } }) },
    { id: 'opening', label: 'Opening the PDF', model: base({ pdf: null }) },
    { id: 'loading', label: 'Reading', model: base({ versions: { status: 'loading' }, pdf: null, shown: null }) },
    { id: 'error', label: 'The read failed (in words, Try again)', model: base({ versions: { status: 'error', problem: 'problem.unavailable' }, pdf: null }) },
    { id: 'pdf-failed', label: 'The PDF could not be opened (Try again)', model: base({ pdf: null, pdfProblem: 'problem.unavailable' }) },
    { id: 'no-permission', label: 'No right to see rider measurements', model: base({ allowed: false, versions: { status: 'loading' }, pdf: null }) },
  ],
})
