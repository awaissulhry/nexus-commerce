import { describe, expect, it } from 'vitest'
import type { PrintPreview, SheetCard } from './api'
import {
  againBodyOf,
  againCardsOf,
  againFormOf,
  againHeldOf,
  againPagesOf,
  mayPrintOf,
  NOTE_MAX,
  pageKey,
  placedLineOf,
  printsLineOf,
  problemGroupsOf,
  reasonShown,
  startBodyOf,
  startHeldOf,
  startStateOf,
  toggledIn,
} from './model'

/**
 * owb-ss4 steps 4.1 + 4.3 (design plan § 1 row 1, § 4.1, § 5f, § 5zj B; settles L1, L6, L7) — the two print windows, pure: refused /
 * warn / ready, the reason field only on the material warning, "0 of 3 placed — the code goes to the usual place" never a stop, the
 * cards or "at cutting on this site"; Print again's ticks, the reason in one tap, the words a small change needs, the body. Made-up data.
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
    { salesOrderLineId: 'line-2', label: 'Gloves', fileId: 'file-2', pageCount: null, placed: false },
    { salesOrderLineId: 'line-3', label: 'Patch', fileId: null, pageCount: null, placed: false },
  ],
  placed: { done: 1, of: 3 },
}
const DEPOSIT = { code: 'DEPOSIT', class: 'MONEY' as const, workOrderNumber: null, words: 'The deposit is not paid.' }
const MATERIAL = { code: 'MATERIAL', class: 'WARN' as const, workOrderNumber: 'WO-2026-0042', words: 'Not enough leather in stock.' }

describe('Print and start the work: refused / warn / ready', () => {
  it('a refusal holds the act with the count of what must be fixed; the warnings go on', () => {
    const refused = { ...PREVIEW, problems: [DEPOSIT, MATERIAL], refused: true }
    expect(startStateOf(refused)).toBe('refused')
    expect(problemGroupsOf(refused.problems)).toEqual({ mustFix: [DEPOSIT], warnings: [MATERIAL] })
    expect(startHeldOf({ may: true, preview: refused, reason: '', busy: false })).toEqual({ key: 'held.refused', params: { count: 1 } })
    expect(reasonShown(refused)).toBe(false)
  })

  it('a material warning asks for a reason (3 to 500 characters), then goes on with it in the body', () => {
    const warn = { ...PREVIEW, problems: [MATERIAL], needsMaterialReason: true }
    expect(startStateOf(warn)).toBe('warn')
    expect(reasonShown(warn)).toBe(true)
    expect(startHeldOf({ may: true, preview: warn, reason: ' ok', busy: false })).toEqual({ key: 'held.reason', params: { min: 3 } })
    expect(startHeldOf({ may: true, preview: warn, reason: 'x'.repeat(501), busy: false })).toEqual({ key: 'held.reasonLong', params: { max: 500 } })
    expect(startHeldOf({ may: true, preview: warn, reason: 'Leather comes on Monday', busy: false })).toBeNull()
    expect(startBodyOf(warn, '  Leather comes on Monday ')).toEqual({ version: 7, materialReason: 'Leather comes on Monday' })
  })

  it('ready: no reason field, the body is the version only; printed and not confirmed say why; the right first', () => {
    expect(startStateOf(PREVIEW)).toBe('ready')
    expect(reasonShown(PREVIEW)).toBe(false)
    expect(startHeldOf({ may: true, preview: PREVIEW, reason: '', busy: false })).toBeNull()
    expect(startBodyOf(PREVIEW, 'ignored')).toEqual({ version: 7 })
    expect(startHeldOf({ may: true, preview: { ...PREVIEW, state: 'PRINTED', printedAt: '2026-11-27T09:00:00.000Z' }, reason: '', busy: false })).toEqual({ key: 'held.printed' })
    expect(startHeldOf({ may: true, preview: { ...PREVIEW, state: 'NOT_CONFIRMED' }, reason: '', busy: false })).toEqual({ key: 'held.notConfirmed' })
    expect(startHeldOf({ may: false, preview: PREVIEW, reason: '', busy: false })).toEqual({ key: 'held.noRight' })
    expect(startHeldOf({ may: true, preview: null, reason: '', busy: false })).toEqual({ key: 'held.reading' })
    expect(startHeldOf({ may: true, preview: PREVIEW, reason: '', busy: true })).toEqual({ key: 'held.busy' })
    expect(mayPrintOf(['orders.view', 'production.print.start'])).toBe(true)
    expect(mayPrintOf(['orders.view'])).toBe(false)
  })

  it('what prints: the pages of the pieces with a mockup, and the cards — or "at cutting on this site" where the switch is off', () => {
    expect(printsLineOf(PREVIEW)).toEqual({ pages: 3, cards: { key: 'start.cards', params: { count: 13 } } })
    expect(printsLineOf({ ...PREVIEW, basketsAtPrint: false, baskets: { count: 0, lines: [] } }).cards).toEqual({ key: 'start.cardsAtCutting' })
  })

  it('the placed line is never a stop: "0 of 3 placed — the code goes to the usual place"', () => {
    expect(placedLineOf({ done: 0, of: 3 })).toEqual({ key: 'start.placed.some', params: { done: 0, of: 3 } })
    expect(placedLineOf({ done: 3, of: 3 })).toEqual({ key: 'start.placed.all', params: { of: 3 } })
    expect(placedLineOf({ done: 0, of: 0 })).toEqual({ key: 'start.placed.none' })
    expect(startHeldOf({ may: true, preview: { ...PREVIEW, placed: { done: 0, of: 3 } }, reason: '', busy: false })).toBeNull()
  })
})

const card = (bundleId: string, over: Partial<SheetCard> = {}): SheetCard => ({ bundleId, code: `BN-${bundleId}`, basketNo: `B-${bundleId}`, pieces: 1, styleCode: 'DEMO-SUIT-01', label: 'Race suit', pictureFileId: null, customerCode: 'C-ALPHA', dueDate: null, printNo: 1, steps: [], ...over })

describe('Print again: ticks, one-tap reason, the words of a small change, the body', () => {
  const pages = againPagesOf(PREVIEW.pages)
  const cards = againCardsOf([card('1'), card('2', { shipped: true }), card('3', { printNo: 2 })])

  it('every page of each piece with a mockup; a shipped basket\'s card is not offered; from the order all are ticked', () => {
    expect(pages.map((page) => page.key)).toEqual([pageKey('line-1', 1), pageKey('line-1', 2), pageKey('line-2', 1)])
    expect(cards.map((entry) => entry.bundleId)).toEqual(['1', '3'])
    const form = againFormOf(pages, cards)
    expect([...form.pages]).toEqual(['line-1:1', 'line-1:2', 'line-2:1'])
    expect([...form.cards]).toEqual(['1', '3'])
    expect(form.reason).toBeNull()
    expect([...toggledIn(form.cards, '1')]).toEqual(['3'])
  })

  it('waits: nothing ticked · no reason · a small change with no words or more than 140 · the right', () => {
    const form = againFormOf(pages, cards)
    expect(againHeldOf({ may: true, form: { ...form, pages: new Set(), cards: new Set() }, busy: false })).toEqual({ key: 'again.held.tick' })
    expect(againHeldOf({ may: true, form, busy: false })).toEqual({ key: 'again.held.why' })
    expect(againHeldOf({ may: true, form: { ...form, reason: 'SMALL_CHANGE', note: '  ' }, busy: false })).toEqual({ key: 'again.held.note' })
    expect(againHeldOf({ may: true, form: { ...form, reason: 'SMALL_CHANGE', note: 'x'.repeat(NOTE_MAX + 1) }, busy: false })).toEqual({ key: 'again.held.noteLong', params: { max: 140 } })
    expect(againHeldOf({ may: true, form: { ...form, reason: 'SMALL_CHANGE', note: 'The chest logo is 2 cm bigger' }, busy: false })).toBeNull()
    expect(againHeldOf({ may: true, form: { ...form, reason: 'LOST' }, busy: false })).toBeNull()
    expect(againHeldOf({ may: false, form: { ...form, reason: 'LOST' }, busy: false })).toEqual({ key: 'held.noRight' })
  })

  it('the body: the reason, the words only on a small change, the ticked pages and cards in order', () => {
    const form = { ...againFormOf(pages, cards), pages: new Set(['line-1:2']), cards: new Set(['3']) }
    expect(againBodyOf({ ...form, reason: 'DAMAGED', note: 'not sent' }, pages, cards)).toEqual({ reason: 'DAMAGED', pages: [{ salesOrderLineId: 'line-1', page: 2 }], cards: [{ bundleId: '3' }] })
    expect(againBodyOf({ ...form, reason: 'SMALL_CHANGE', note: ' The chest logo is 2 cm bigger ' }, pages, cards)).toEqual({ reason: 'SMALL_CHANGE', note: 'The chest logo is 2 cm bigger', pages: [{ salesOrderLineId: 'line-1', page: 2 }], cards: [{ bundleId: '3' }] })
    expect(againBodyOf({ ...form, reason: null }, pages, cards)).toBeNull()
  })
})
