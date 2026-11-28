import { defineDesignScreen } from '../../../../../../lib/design/design-screen'
import { cardSheetsOf, sheetPagesOf, sheetTitleOf } from './model'
import type { PrintSheetAnswer } from '../api'
import { PrintSheetView, type PrintSheetViewModel } from './view/PrintSheetView'

/**
 * owb-ss4 step 4.2 — the print sheet in the design index (`/design/SCR-owb-print-sheet`): a first print (one design page, 10 cards on two
 * A4 sheets) and a print again ("Print 2 · date" on the page and the card), with no picture drawn (the index reads no file). Made-up
 * data only (example numbers, the customer CODE only).
 */

const ANSWER: PrintSheetAnswer = {
  printId: 'print-1',
  kind: 'FIRST',
  printedAt: '2026-11-28T09:00:00.000Z',
  order: { number: 'SO-2026-0101', customerCode: 'C-ALPHA', dueDate: '2026-12-15' },
  pages: [{ salesOrderLineId: 'line-1', label: 'Race suit', styleCode: 'DEMO-SUIT-01', fileId: 'file-1', page: 1, contentType: 'application/pdf', qr: 'WO-2026-0041', workOrderNumber: 'WO-2026-0041', placement: null, printNo: 1 }],
  cards: Array.from({ length: 10 }, (_, index) => ({
    bundleId: `bn-${index + 1}`,
    code: `BN-0000${index + 1}`,
    basketNo: `B-04${String(index + 1).padStart(2, '0')}`,
    pieces: 1,
    styleCode: 'DEMO-SUIT-01',
    label: 'Race suit',
    pictureFileId: null,
    customerCode: 'C-ALPHA',
    dueDate: '2026-12-15',
    printNo: 1,
    steps: [
      { departmentNumber: 1, shortName: 'Pattern', name: 'Pattern making', nameUr: 'پیٹرن', tone: 'purple', icon: 'ruler' },
      { departmentNumber: 2, shortName: 'Cutting', name: 'Cutting', nameUr: 'کٹنگ', tone: 'emerald', icon: 'scissors' },
      { departmentNumber: 4, shortName: 'Stitching', name: 'Stitching', nameUr: 'سلائی', tone: 'orange', icon: 'shirt' },
      { departmentNumber: 6, shortName: 'Packing', name: 'Packing', nameUr: 'پیکنگ', tone: 'cyan', icon: 'package' },
    ],
  })),
}
const viewOf = (answer: PrintSheetAnswer): PrintSheetViewModel => ({
  state: 'ready',
  problem: null,
  title: sheetTitleOf(answer),
  pages: sheetPagesOf(answer).map((page) => ({ ...page, src: null, failed: true, qrSrc: null })),
  cardSheets: cardSheetsOf(answer).map((sheet) => sheet.map((card) => ({ ...card, pictureSrc: null, qrSrc: null }))),
  drawing: false,
})
const AGAIN: PrintSheetAnswer = { ...ANSWER, kind: 'AGAIN', printId: 'print-2', pages: ANSWER.pages.map((page) => ({ ...page, printNo: 2 })), cards: ANSWER.cards.slice(0, 1).map((card) => ({ ...card, printNo: 2 })) }

export const designScreen = defineDesignScreen<PrintSheetViewModel>({
  screen: 'SCR-owb-print-sheet',
  title: 'The print sheet — design pages with the code, basket cards 2 × 4 (owb-ss4)',
  view: PrintSheetView,
  cases: [
    { id: 'first', label: 'The first print: 1 page, 10 cards', model: viewOf(ANSWER), note: 'Cards 2 × 4 per A4; no customer name, no price.' },
    { id: 'again', label: 'Print again: "Print 2 · date"', model: viewOf(AGAIN) },
    { id: 'reading', label: 'Reading', model: { ...viewOf(ANSWER), state: 'reading', title: null, pages: [], cardSheets: [] } },
  ],
})
