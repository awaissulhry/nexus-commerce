import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { PasteAnswer } from './api'
import { PASTE_SAMPLE } from './model'
import { PasteLines, type PasteLinesModel } from './view/PasteLines'

/**
 * SCR-416 — Paste lines (design pop:quotes.pasteLines, SAL-160; B-W2b-316 on B-W2b-302's paste), made-up data only: cells of
 * the invented DEMO-JKT-01 copied from a sheet. Each case is one state: empty, the columns read, the review (a change, a new
 * line, a row and cells left out in words), a first row that cannot be read, the write done, the check failing.
 */

const TEXT = 'Style\tColourway\tPrice\t50\t52\t54\t58\nDEMO-JKT-01\tBLK\t\t2\t6\t2\t\nDEMO-JKT-01\tRED\t440\t1\t3\t2\t1\nDEMO-JKT-99\tBLK\t\t1\t1\t\t'
const PREVIEW: PasteAnswer = {
  preview: true,
  rows: [
    { row: 2, style: 'DEMO-JKT-01', colourway: 'BLK', action: 'CHANGE', lineId: '0190f0e2-8888-7000-8000-000000000001', sizes: { '50': 2, '52': 6, '54': 2 }, before: { '50': 2, '52': 4, '54': 2 }, after: { '50': 2, '52': 6, '54': 2 }, priceFrom: 'KEPT', leftOut: [] },
    { row: 3, style: 'DEMO-JKT-01', colourway: 'RED', action: 'ADD', lineId: null, sizes: { '50': 1, '52': 3, '54': 2 }, before: null, after: { '50': 1, '52': 3, '54': 2 }, priceFrom: 'TYPED', leftOut: [{ size: '58', message: 'Row 3: 58 is not a size of DEMO-JKT-01 (48, 50, 52, 54, 56).' }] },
    { row: 4, style: 'DEMO-JKT-99', colourway: 'BLK', action: 'SKIP', lineId: null, sizes: {}, before: null, after: null, priceFrom: null, leftOut: [{ size: null, message: 'Row 4: DEMO-JKT-99 is not a style this company sells.' }] },
  ],
  counts: { rows: 3, added: 1, changed: 1, skipped: 1, cellsLanded: 6, cellsLeftOut: 1 },
}
const model = (extra: Partial<PasteLinesModel> = {}): PasteLinesModel => ({ text: TEXT, preview: PREVIEW, state: { phase: 'ready' }, ...extra })

export const designScreen = defineDesignScreen<PasteLinesModel>({
  screen: 'SCR-416',
  title: 'Paste lines (quote): paste area, columns, review, what could not land',
  view: PasteLines,
  cases: [
    { id: 'empty', label: 'Nothing pasted yet', model: model({ text: '', preview: null }), note: 'The placeholder shows the shape: Style, Colourway, the sizes.' },
    { id: 'review', label: 'A paste read: 1 change, 1 new line, a row and a cell left out', model: model(), note: 'Each row that lands old → new; what could not land counted and said in words; a price lands on a new line only.' },
    { id: 'reading', label: 'Checking the paste', model: model({ preview: null, state: { phase: 'reading' } }) },
    { id: 'bad-head', label: 'A first row that cannot be read', model: model({ text: 'Codice\t50\t52\nDEMO-JKT-01\t1\t2', preview: null }) },
    { id: 'sample', label: 'The sample shape pasted', model: model({ text: PASTE_SAMPLE, preview: { ...PREVIEW, rows: [PREVIEW.rows[0]!], counts: { rows: 1, added: 0, changed: 1, skipped: 0, cellsLanded: 3, cellsLeftOut: 0 } } }) },
    { id: 'done', label: 'Written: 1 added, 1 changed', model: model({ state: { phase: 'done', results: { '2': { ok: true, words: { key: 'review.result.saved' } }, '3': { ok: true, words: { key: 'review.result.added' } } } } }) },
    // B-W2b-374 (XF3:01): an Options column — a new line takes the values it names; what cannot be read is said.
    {
      id: 'w2b-374-options',
      label: 'An Options column: a new line takes its options, an unknown one and a line already there said',
      model: model({
        text: 'Style\tColourway\tOptions\t50\t52\nDEMO-JKT-01\tBLK\tLINER:YES\t2\t6\nDEMO-JKT-01\tRED\tLINER:YES, NAME:NAME=ROSSI, HUMP:XL\t1\t3',
        preview: {
          ...PREVIEW,
          rows: [
            { ...PREVIEW.rows[0]!, sizes: { '50': 2, '52': 6 }, after: { '50': 2, '52': 6, '54': 2 }, leftOut: [{ size: null, message: "Row 2: the options are not written on a line already on the quote: change them in the line's Options." }] },
            { ...PREVIEW.rows[1]!, sizes: { '50': 1, '52': 3 }, after: { '50': 1, '52': 3 }, priceFrom: 'LIST', options: 2, leftOut: [{ size: null, message: 'Row 3: option HUMP:XL is not one the style offers.' }] },
          ],
          counts: { rows: 2, added: 1, changed: 1, skipped: 0, cellsLanded: 4, cellsLeftOut: 0 },
        },
      }),
    },
    { id: 'failed', label: 'The check failed', model: model({ preview: null, state: { phase: 'failed', problem: { ns: 'sales', key: 'problem.write.unavailable' } } }) },
  ],
})
