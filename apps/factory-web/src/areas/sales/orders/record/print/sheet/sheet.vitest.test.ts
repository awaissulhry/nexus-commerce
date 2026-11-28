import { describe, expect, it } from 'vitest'
import type { PrintSheetAnswer, SheetCard } from '../api'
import { A4, CARD_MM, CARDS_PER_SHEET, cardSheetsOf, codePlaceOf, CODE_MIN_MM, isPdf, printMarkOf, qrTextsOf, sheetPagesOf, sheetTitleOf, stepDepartmentOf } from './model'

/**
 * owb-ss4 step 4.2 (design plan § 4.1, § 5f, § 5zj B; settles L6, L8) — the ONE print sheet, pure: the page list (the work order number
 * as QR, the code at its place or top right 20 mm, kept on the page and never under 20 mm), the card sheets of 2 × 4 (105 × 74.25 mm),
 * "Print N · date" only from 2, the steps as departments, the customer CODE only. Made-up data only.
 */

const card = (n: number, over: Partial<SheetCard> = {}): SheetCard => ({
  bundleId: `bn-${n}`,
  code: `BN-0000${n}`,
  basketNo: `B-04${String(n).padStart(2, '0')}`,
  pieces: 1,
  styleCode: 'DEMO-SUIT-01',
  label: 'Race suit',
  pictureFileId: 'pic-1',
  customerCode: 'C-ALPHA',
  dueDate: '2026-12-15',
  printNo: 1,
  steps: [{ departmentNumber: 1, shortName: 'Pattern', name: 'Pattern making', nameUr: 'پیٹرن', tone: 'purple', icon: 'ruler' }],
  ...over,
})

const ANSWER: PrintSheetAnswer = {
  printId: 'print-2',
  kind: 'AGAIN',
  printedAt: '2026-11-28T09:00:00.000Z',
  order: { number: 'SO-2026-0101', customerCode: 'C-ALPHA', dueDate: '2026-12-15' },
  pages: [
    { salesOrderLineId: 'line-1', label: 'Race suit', styleCode: 'DEMO-SUIT-01', fileId: 'file-1', page: 1, contentType: 'application/pdf', qr: 'WO-2026-0041', workOrderNumber: 'WO-2026-0041', placement: null, printNo: 1 },
    { salesOrderLineId: 'line-1', label: 'Race suit', styleCode: 'DEMO-SUIT-01', fileId: 'file-1', page: 2, contentType: 'application/pdf; charset=binary', qr: 'WO-2026-0041', workOrderNumber: 'WO-2026-0041', placement: { xMm: 10, yMm: 250, sizeMm: 30 }, printNo: 2 },
    { salesOrderLineId: 'line-2', label: 'Gloves', styleCode: 'DEMO-GLV-02', fileId: 'file-2', page: 1, contentType: 'image/png', qr: 'WO-2026-0042', workOrderNumber: 'WO-2026-0042', placement: { xMm: 200, yMm: -5, sizeMm: 12 }, printNo: 3 },
  ],
  cards: Array.from({ length: 10 }, (_, index) => card(index + 1, index === 9 ? { printNo: 2 } : {})),
}

describe('the design pages', () => {
  it('one page each, in order, the work order number as QR; a PDF page is drawn by pdf.js, an image as it is', () => {
    const pages = sheetPagesOf(ANSWER)
    expect(pages.map((page) => [page.page, page.qr, page.pdf])).toEqual([[1, 'WO-2026-0041', true], [2, 'WO-2026-0041', true], [1, 'WO-2026-0042', false]])
    expect(isPdf('application/pdf')).toBe(true)
    expect(isPdf('image/jpeg')).toBe(false)
  })

  it('the code: none placed → top right, 20 mm; a placement is kept on the page and never under 20 mm', () => {
    expect(codePlaceOf(null)).toEqual({ xMm: A4.widthMm - CODE_MIN_MM - 8, yMm: 8, sizeMm: 20 })
    expect(codePlaceOf({ xMm: 10, yMm: 250, sizeMm: 30 })).toEqual({ xMm: 10, yMm: 250, sizeMm: 30 })
    expect(codePlaceOf({ xMm: 200, yMm: -5, sizeMm: 12 })).toEqual({ xMm: 190, yMm: 0, sizeMm: 20 })
    expect(codePlaceOf({ xMm: 0, yMm: 290, sizeMm: 40 })).toEqual({ xMm: 0, yMm: 257, sizeMm: 40 })
  })

  it('"Print N · date" only from the second print on', () => {
    const marks = sheetPagesOf(ANSWER).map((page) => page.mark)
    expect(marks).toEqual([null, { printNo: 2, at: ANSWER.printedAt }, { printNo: 3, at: ANSWER.printedAt }])
    expect(printMarkOf(1, ANSWER.printedAt)).toBeNull()
  })
})

describe('the basket cards', () => {
  it('2 × 4 on an A4 sheet (105 × 74.25 mm each): 10 cards make two sheets of 8 and 2', () => {
    expect(CARDS_PER_SHEET).toBe(8)
    expect(CARD_MM).toEqual({ widthMm: 105, heightMm: 74.25 })
    const sheets = cardSheetsOf(ANSWER)
    expect(sheets.map((sheet) => sheet.length)).toEqual([8, 2])
    expect(sheets[1]![1]!.mark).toEqual({ printNo: 2, at: ANSWER.printedAt })
    expect(sheets[0]![0]!.mark).toBeNull()
  })

  it('the card: the BN code, the basket number, the customer CODE (never a name), the due date, the steps as departments with Urdu', () => {
    const first = cardSheetsOf(ANSWER)[0]![0]!
    expect(first).toMatchObject({ code: 'BN-00001', basketNo: 'B-0401', customerCode: 'C-ALPHA', dueDate: '2026-12-15' })
    expect(Object.keys(first)).not.toContain('customerName')
    expect(stepDepartmentOf(card(1).steps[0]!)).toEqual({ no: 1, tone: 'purple', icon: 'ruler', name: 'Pattern making', shortName: 'Pattern', nameUr: 'پیٹرن' })
    expect(stepDepartmentOf({ departmentNumber: 9, shortName: 'Pack', name: 'Packing', nameUr: null, tone: 'not-a-tone', icon: '' })).toEqual({ no: 9, tone: 'slate', icon: '', name: 'Packing', shortName: 'Pack' })
  })

  it('every QR text once; the title says which print', () => {
    expect(qrTextsOf(ANSWER)).toHaveLength(2 + 10)
    expect(sheetTitleOf(ANSWER)).toEqual({ key: 'sheet.titleAgain', params: { number: 'SO-2026-0101' } })
    expect(sheetTitleOf({ ...ANSWER, kind: 'FIRST' }).key).toBe('sheet.titleFirst')
  })
})
