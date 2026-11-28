import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { PrintPreview } from './api'
import { startHeldOf } from './model'
import { PrintStartView, type PrintStartViewModel } from './view/PrintStartView'

/**
 * owb-ss4 step 4.1 — the window "Print and start the work" in the design index (`/design/SCR-owb-print-start`): ready (1 of 3 placed),
 * a material warning that asks for a reason, refused (the deposit), the switch off at this site, printed already, reading. Made-up data
 * only (example numbers, style codes).
 */

const PREVIEW: PrintPreview = {
  orderId: 'so-1',
  version: 7,
  state: 'READY',
  printedAt: null,
  basketsAtPrint: true,
  workOrders: [
    { workOrderId: null, number: null, styleCode: 'DEMO-SUIT-01', pieces: 12, status: null },
    { workOrderId: 'wo-2', number: 'WO-2026-0042', styleCode: 'DEMO-GLV-02', pieces: 4, status: 'DRAFT' },
  ],
  problems: [],
  refused: false,
  needsMaterialReason: false,
  baskets: { count: 13, lines: [{ salesOrderLineId: 'line-1', label: 'Race suit', baskets: 12 }, { salesOrderLineId: 'line-2', label: 'Gloves', baskets: 1 }] },
  pages: [
    { salesOrderLineId: 'line-1', label: 'Race suit', fileId: 'file-1', pageCount: 2, placed: true },
    { salesOrderLineId: 'line-2', label: 'Gloves', fileId: 'file-2', pageCount: 1, placed: false },
  ],
  placed: { done: 1, of: 3 },
}
const model = (preview: PrintPreview, reason = ''): PrintStartViewModel => ({ open: true, state: 'ready', readProblem: null, orderNumber: 'SO-2026-0101', preview, reason, held: startHeldOf({ may: true, preview, reason, busy: false }), busy: false, writeProblem: null })
const MATERIAL = { code: 'MATERIAL', class: 'WARN' as const, workOrderNumber: 'WO-2026-0042', words: 'Not enough leather in stock for WO-2026-0042.' }
const DEPOSIT = { code: 'DEPOSIT', class: 'MONEY' as const, workOrderNumber: null, words: 'The deposit of this order is not paid yet.' }

export const designScreen = defineDesignScreen<PrintStartViewModel>({
  screen: 'SCR-owb-print-start',
  title: 'Print and start the work — what prints, the problems in words, the ONE act (owb-ss4)',
  view: PrintStartView,
  cases: [
    { id: 'ready', label: 'Ready, 1 of 3 placed', model: model(PREVIEW), note: 'Never a stop: the other codes go to the usual place.' },
    { id: 'warn', label: 'A material warning asks for a reason', model: model({ ...PREVIEW, problems: [MATERIAL], needsMaterialReason: true }), note: 'The act waits until 3 characters are typed.' },
    { id: 'refused', label: 'Refused: must be fixed first', model: model({ ...PREVIEW, problems: [DEPOSIT, MATERIAL], refused: true }), note: 'Must be fixed first · Warnings, in words.' },
    { id: 'at-cutting', label: 'Basket cards print at cutting on this site', model: model({ ...PREVIEW, basketsAtPrint: false, baskets: { count: 0, lines: [] } }) },
    { id: 'printed', label: 'Printed already', model: model({ ...PREVIEW, state: 'PRINTED', printedAt: '2026-11-27T09:00:00.000Z' }) },
    { id: 'reading', label: 'Reading', model: { ...model(PREVIEW), state: 'reading', preview: null } },
  ],
})
