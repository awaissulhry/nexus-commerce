import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../../lib/design/design-screen'
import { inShell } from '../../../../shared/fixtures'
import { IMPORT_CHECK, IMPORT_MORE, IMPORT_RESULT, PREFIX } from '../../demo'
import { ImportDuplicatesPanel, type ImportDuplicatesModel } from '../../view/ImportDuplicatesPanel'

/**
 * SCR-622 — Possible duplicates in the import wizard (B-W2b-427; design admin.import wizard step 3 "possible duplicates"):
 * in the check (nothing written yet: fix the sheet or apply) and in the result (Merge… per new record), every state. The
 * panel sits under the check's changes and under the result (SCR-017's wizard). Made-up rows.
 */

const model = (extra: Partial<ImportDuplicatesModel> = {}): ImportDuplicatesModel => ({ state: 'ready', answer: IMPORT_CHECK, phase: 'check', prefix: PREFIX, canMerge: true, ...extra })

function CheckDesign({ model: given }: { model: ImportDuplicatesModel }) {
  return inShell('/admin/import', createElement('div', { className: 'fw-dup-section' }, createElement(ImportDuplicatesPanel, { model: given })))
}

export const designScreen = defineDesignScreen<ImportDuplicatesModel>({
  screen: 'SCR-622',
  title: 'Possible duplicates in an import',
  view: CheckDesign,
  cases: [
    { id: 'check', label: 'In the check: new rows that look like records already there', model: model(), note: 'Row 4 has the same name and mail domain as C-0001, row 9 a similar name; row 17 looks like row 12 of the same sheet. Each record opens in a new tab; nothing is written yet.' },
    { id: 'result', label: 'After the apply: Merge… per new record', model: model({ answer: IMPORT_RESULT, phase: 'result' }), note: 'Merge… opens SCR-621 with the record already there kept.' },
    { id: 'result-no-right', label: 'After the apply: may not merge', model: model({ answer: IMPORT_RESULT, phase: 'result', canMerge: false }) },
    { id: 'more', label: 'Only the first 500 new rows checked', model: model({ answer: IMPORT_MORE }) },
    { id: 'loading', label: 'Loading', model: model({ state: 'loading', answer: null }) },
    { id: 'error', label: 'Could not be read', model: model({ state: 'error', answer: null }) },
    { id: 'none', label: 'Nothing looks alike (the panel is absent)', model: model({ answer: { ...IMPORT_CHECK, rows: [] } }) },
  ],
})
