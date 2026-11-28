import { defineDesignScreen } from '../../../../../../lib/design/design-screen'
import type { SheetCard } from '../api'
import { againFormOf, againHeldOf, againPagesOf, type AgainForm } from '../model'
import { PrintAgainView, type PrintAgainViewModel } from './PrintAgainView'

/**
 * owb-ss4 step 4.3 — the window "Print again" in the design index (`/design/SCR-owb-print-again`): all ticked from the order (no reason
 * yet), a small change with its words, lost (one card), the cards not known. Made-up data only (example numbers).
 */

const card = (n: number, printNo = 1): SheetCard => ({ bundleId: `bn-${n}`, code: `BN-0000${n}`, basketNo: `B-04${String(n).padStart(2, '0')}`, pieces: 1, styleCode: 'DEMO-SUIT-01', label: n > 4 ? 'Gloves' : 'Race suit', pictureFileId: null, customerCode: 'C-ALPHA', dueDate: '2026-12-15', printNo, steps: [] })
const PAGES = againPagesOf([
  { salesOrderLineId: 'line-1', label: 'Race suit', fileId: 'file-1', pageCount: 2, placed: true },
  { salesOrderLineId: 'line-2', label: 'Gloves', fileId: 'file-2', pageCount: 1, placed: false },
])
const CARDS = [card(1), card(2), card(3, 2), card(4), card(5)]
const model = (form: AgainForm, over: Partial<PrintAgainViewModel> = {}): PrintAgainViewModel => ({ open: true, state: 'ready', readProblem: null, pages: PAGES, cards: CARDS, cardsMissing: false, form, held: againHeldOf({ may: true, form, busy: false }), busy: false, writeProblem: null, ...over })
const ALL = againFormOf(PAGES, CARDS)

export const designScreen = defineDesignScreen<PrintAgainViewModel>({
  screen: 'SCR-owb-print-again',
  title: 'Print again — the same codes, ticked pages and cards, a reason in one tap (owb-ss4)',
  view: PrintAgainView,
  cases: [
    { id: 'from-order', label: 'From the order: all ticked, no reason yet', model: model(ALL), note: 'The act waits: "Choose why".' },
    { id: 'small-change', label: 'A small change, with its words', model: model({ ...ALL, reason: 'SMALL_CHANGE', note: 'The chest logo is 2 cm bigger' }), note: 'The baskets of this piece show “The design changed” on the floor.' },
    { id: 'small-change-empty', label: 'A small change without words', model: model({ ...ALL, reason: 'SMALL_CHANGE', note: '' }) },
    { id: 'lost-one-card', label: 'Lost: one card', model: model({ ...ALL, pages: new Set(), cards: new Set(['bn-3']), reason: 'LOST' }) },
    { id: 'cards-missing', label: 'The cards could not be read', model: model({ ...ALL, cards: new Set() }, { cards: [], cardsMissing: true }) },
  ],
})
