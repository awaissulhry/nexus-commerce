import { departmentToneOf, type Department } from '../../../../../../lib/department/model'
import type { PrintSheetAnswer, SheetCard, SheetPage } from '../api'
import { clampPlace, MIN_CODE_MM, usualPlaceOf, type PageMm, type Place } from '../place/model'

/**
 * owb-ss4 step 4.2 (design plan § 4.1 the card, § 5f the code on every page, § 5zj B "Print 2 · date"; settles L6, L8) — the ONE print
 * sheet, pure: the design pages (one A4 page each: the mockup page drawn whole, the QR of the line's WORK ORDER NUMBER at its placement —
 * none: the usual place, top right, 20 mm — and from the second print on "Print N · date" in its foot), then the basket cards, 2 × 4 on
 * an A4 sheet (105 × 74.25 mm each): the QR of the basket's BN code, the basket number big, the picture, the customer CODE, the due date,
 * the steps as department chips (number, English, Urdu) with a box for a pen tick. Never a customer name, never a price.
 */

/** An A4 sheet, portrait (mm). */
export const A4 = Object.freeze({ widthMm: 210, heightMm: 297 })
/** A scan code is never smaller than this (a phone reads it): § 5f — the domain's number. */
export const CODE_MIN_MM = MIN_CODE_MM
/** Basket cards on one A4 sheet: 2 columns × 4 rows. */
export const CARD_COLUMNS = 2
export const CARD_ROWS = 4
export const CARDS_PER_SHEET = CARD_COLUMNS * CARD_ROWS
/** One card (mm): the sheet split 2 × 4 — measured, not guessed. */
export const CARD_MM = Object.freeze({ widthMm: A4.widthMm / CARD_COLUMNS, heightMm: A4.heightMm / CARD_ROWS })

export type CodePlace = Place

/**
 * owb-ss4b: the code's place ON THE DESIGN PAGE, in the page's own millimetres (a PDF page's size, an image's by its shape — the SAME
 * rule as "Place the scan code"): the saved placement kept on the page and never under 20 mm; none: the usual place, top right, 20 mm,
 * 10 mm from the edges (the domain's).
 */
export function codePlaceOf(placement: SheetPage['placement'], page: PageMm = A4): CodePlace {
  return placement ? clampPlace(placement, page) : usualPlaceOf(page)
}

/** A box in per cent of its parent. */
export interface PercentBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** The design page drawn whole and centred on the A4 paper (its own shape kept): its box in per cent of the paper. */
export function frameOf(page: PageMm): PercentBox {
  const paper = A4.widthMm / A4.heightMm
  const ratio = page.widthMm / Math.max(0.0001, page.heightMm)
  if (ratio >= paper) {
    const height = (((A4.widthMm / ratio) / A4.heightMm) * 100)
    return { left: 0, top: (100 - height) / 2, width: 100, height }
  }
  const width = (((A4.heightMm * ratio) / A4.widthMm) * 100)
  return { left: (100 - width) / 2, top: 0, width, height: 100 }
}

/** The code's square in per cent of the design page's box. */
export const codeBoxOf = (place: CodePlace, page: PageMm): PercentBox => ({
  left: (place.xMm / page.widthMm) * 100,
  top: (place.yMm / page.heightMm) * 100,
  width: (place.sizeMm / page.widthMm) * 100,
  height: (place.sizeMm / page.heightMm) * 100,
})

/** "Print N · date" only from the second print on (the first print carries no mark). */
export const printMarkOf = (printNo: number, printedAt: string): { readonly printNo: number; readonly at: string } | null => (printNo >= 2 ? { printNo, at: printedAt } : null)

export interface SheetPageModel {
  readonly key: string
  readonly fileId: string
  readonly page: number
  /** A PDF page is drawn with pdf.js; an image file as it is. */
  readonly pdf: boolean
  readonly label: string
  readonly styleCode: string
  /** The QR's text: the work order number. */
  readonly qr: string
  readonly workOrderNumber: string
  /** The saved placement (null: the usual place); placed on the page once its size is known (codePlaceOf). */
  readonly placement: SheetPage['placement']
  readonly mark: { readonly printNo: number; readonly at: string } | null
}

export const isPdf = (contentType: string): boolean => contentType.toLowerCase().split(';')[0]!.trim() === 'application/pdf'

/** The design pages, in the answer's order. */
export function sheetPagesOf(answer: Pick<PrintSheetAnswer, 'pages' | 'printedAt'>): SheetPageModel[] {
  return answer.pages.map((page) => ({
    key: `${page.salesOrderLineId}:${page.fileId}:${page.page}`,
    fileId: page.fileId,
    page: page.page,
    pdf: isPdf(page.contentType),
    label: page.label,
    styleCode: page.styleCode,
    qr: page.qr,
    workOrderNumber: page.workOrderNumber,
    placement: page.placement,
    mark: printMarkOf(page.printNo, answer.printedAt),
  }))
}

export interface SheetCardModel {
  readonly bundleId: string
  /** The QR's text: the basket's BN code. */
  readonly code: string
  readonly basketNo: string
  readonly pieces: number
  readonly label: string
  readonly styleCode: string
  readonly pictureFileId: string | null
  /** The customer's CODE (never its name). */
  readonly customerCode: string
  readonly dueDate: string | null
  readonly steps: readonly Department[]
  readonly mark: { readonly printNo: number; readonly at: string } | null
}

/** A step of the card as a department (the DS department chip draws it: number, tone, icon, English; the Urdu beside it). */
export const stepDepartmentOf = (step: SheetCard['steps'][number]): Department => ({
  no: step.departmentNumber,
  tone: departmentToneOf(step.tone),
  icon: step.icon,
  name: step.name,
  shortName: step.shortName,
  ...(step.nameUr ? { nameUr: step.nameUr } : {}),
})

export function sheetCardOf(card: SheetCard, printedAt: string): SheetCardModel {
  return {
    bundleId: card.bundleId,
    code: card.code,
    basketNo: card.basketNo,
    pieces: card.pieces,
    label: card.label,
    styleCode: card.styleCode,
    pictureFileId: card.pictureFileId,
    customerCode: card.customerCode,
    dueDate: card.dueDate,
    steps: card.steps.map(stepDepartmentOf),
    mark: printMarkOf(card.printNo, printedAt),
  }
}

/** The cards in A4 sheets of 2 × 4 (the last sheet may hold fewer). */
export function cardSheetsOf(answer: Pick<PrintSheetAnswer, 'cards' | 'printedAt'>): SheetCardModel[][] {
  const sheets: SheetCardModel[][] = []
  answer.cards.forEach((card, index) => {
    if (index % CARDS_PER_SHEET === 0) sheets.push([])
    sheets[sheets.length - 1]!.push(sheetCardOf(card, answer.printedAt))
  })
  return sheets
}

/** Every QR text the sheet needs once (the work order numbers of its pages, the BN codes of its cards). */
export const qrTextsOf = (answer: Pick<PrintSheetAnswer, 'pages' | 'cards'>): string[] => [...new Set([...answer.pages.map((page) => page.qr), ...answer.cards.map((card) => card.code)])]

/** The sheet's head line: which print of which order (the view adds how many pages and cards). */
export function sheetTitleOf(answer: Pick<PrintSheetAnswer, 'kind' | 'order'>): { readonly key: string; readonly params: Readonly<Record<string, string>> } {
  return { key: answer.kind === 'FIRST' ? 'sheet.titleFirst' : 'sheet.titleAgain', params: { number: answer.order.number } }
}
