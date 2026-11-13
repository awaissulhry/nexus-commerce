import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'
import { parseDecimal } from '../../tax/decimal'
import { SALES_FEE_KINDS, type SalesFeeKind } from '../quotes/quotes'
import { deliveryTermsProblems, type StoredAcceptanceMode } from '../quote-terms/rules'

/**
 * Quote templates (B-W2b-294; SAL-144 "Templates speed daily quoting", SAL-252 "Company-scoped templates"; design
 * sales.settings ssettings.templates "Saved starts with lines, sections, notes, validity, terms, acceptance mode"), pure:
 * a template of one company or of every company of the tenant, its terms (language, validity, firm offer, acceptance mode,
 * deposit, payment terms, the T&C text and version, Incoterm and place, ship complete) and its lines (a style in a colourway
 * or one chosen at use, pieces per size or typed at use, a section heading, a description, a note; a fee line of a fee kind
 * with its price). apps/factory-api's modules/sales/quote-templates keeps them and starts a quote from one; the database
 * (QuoteTemplate_guard, QuoteTemplateLine_guard) checks the same shapes last.
 */

export const TEMPLATE_LIMITS = Object.freeze({ name: 120, description: 2000, termsText: 20_000, termsVersion: 40, section: 120, lineDescription: 500, lineNote: 1000, lines: 200, sizes: 100, pieces: 100_000, validityDays: 365 })

export const TEMPLATE_LINE_KINDS = ['SIZE_GRID', 'FEE'] as const
export type TemplateLineKind = (typeof TEMPLATE_LINE_KINDS)[number]

export const TEMPLATE_CHANGES = ['MADE', 'CHANGED', 'LINES', 'ARCHIVED', 'RESTORED'] as const
export type TemplateChange = (typeof TEMPLATE_CHANGES)[number]

const ONE_LINE = /^[^\x00-\x1f\x7f]+$/
const SIZE_CODE = /^[^\s]{1,40}$/

export interface TemplateHeader {
  readonly name: string
  readonly description: string | null
  readonly language: string
  readonly currency: string
  readonly validityDays: number | null
  readonly firmOffer: boolean
  readonly acceptanceMode: StoredAcceptanceMode
  readonly depositPct: string | null
  readonly depositKind: string | null
  readonly termsText: string | null
  readonly termsVersion: string | null
  readonly incoterm: string | null
  readonly incotermPlace: string | null
  readonly shipComplete: boolean
}

/** What is wrong with a template's header, in words (the database's QuoteTemplate_guard, said first). */
export function templateHeaderProblems(header: TemplateHeader, at = 'body'): Issue[] {
  const issues: Issue[] = []
  const name = header.name.trim()
  if (name === '' || name.length > TEMPLATE_LIMITS.name || !ONE_LINE.test(name)) issues.push({ path: `${at}/name`, message: `A name of one line, 1 to ${TEMPLATE_LIMITS.name} characters ("Season order").` })
  if (header.description !== null && header.description.length > TEMPLATE_LIMITS.description) issues.push({ path: `${at}/description`, message: `A description of at most ${TEMPLATE_LIMITS.description} characters.` })
  if (header.language !== 'it' && header.language !== 'en') issues.push({ path: `${at}/language`, message: 'The document language is it or en.' })
  if (!/^[A-Z]{3}$/.test(header.currency)) issues.push({ path: `${at}/currency`, message: 'A currency of three capitals (EUR).' })
  if (header.validityDays !== null && (!Number.isInteger(header.validityDays) || header.validityDays < 1 || header.validityDays > TEMPLATE_LIMITS.validityDays)) issues.push({ path: `${at}/validityDays`, message: `A quote stands 1 to ${TEMPLATE_LIMITS.validityDays} days, or the sales settings' days (none).` })
  if (header.depositPct !== null) {
    const pct = parseDecimal(header.depositPct)
    if (pct === null || !fitsDecimal(header.depositPct, 7, 4) || pct.lte(0) || pct.gt(100)) issues.push({ path: `${at}/depositPct`, message: 'A deposit above 0 and at most 100 percent of the gross total, or none.' })
  }
  if ((header.depositPct === null) !== (header.depositKind === null)) issues.push({ path: `${at}/depositKind`, message: 'A deposit has its kind (acconto or caparra), and a kind its deposit.' })
  if (header.termsText !== null && header.termsText.length > TEMPLATE_LIMITS.termsText) issues.push({ path: `${at}/termsText`, message: `The terms and conditions take at most ${TEMPLATE_LIMITS.termsText} characters.` })
  if (header.termsVersion !== null && header.termsVersion.length > TEMPLATE_LIMITS.termsVersion) issues.push({ path: `${at}/termsVersion`, message: `The terms' version reference takes at most ${TEMPLATE_LIMITS.termsVersion} characters.` })
  issues.push(...deliveryTermsProblems({ incoterm: header.incoterm, incotermPlace: header.incotermPlace, shipComplete: header.shipComplete, acceptanceMode: header.acceptanceMode, depositPct: header.depositPct }, at))
  return issues
}

export interface TemplateLineInput {
  readonly seq: number
  readonly section: string | null
  readonly kind: TemplateLineKind
  readonly feeKind: SalesFeeKind | null
  readonly styleId: string
  readonly colourwayId: string | null
  /** SIZE_GRID: pieces per size, or null (typed at use). */
  readonly sizes: Readonly<Record<string, number>> | null
  /** A unit price it starts with (decimal string, the template's currency); null: the price list's at use. */
  readonly unitPrice: string | null
  readonly description: string | null
  readonly note: string | null
}

/** What is wrong with a template's lines (the whole list), in words (the database's QuoteTemplateLine_guard, said first). */
export function templateLineProblems(lines: readonly TemplateLineInput[], at = 'body/lines'): Issue[] {
  const issues: Issue[] = []
  if (lines.length > TEMPLATE_LIMITS.lines) issues.push({ path: at, message: `A template holds at most ${TEMPLATE_LIMITS.lines} lines.` })
  const seqs = new Set<number>()
  lines.forEach((line, index) => {
    const path = `${at}/${index}`
    if (!Number.isInteger(line.seq) || line.seq < 1) issues.push({ path: `${path}/seq`, message: 'A line has its place: a whole number from 1.' })
    else if (seqs.has(line.seq)) issues.push({ path: `${path}/seq`, message: `Line ${line.seq} is named twice.` })
    seqs.add(line.seq)
    if (line.section !== null && (line.section.trim() === '' || line.section.length > TEMPLATE_LIMITS.section || !ONE_LINE.test(line.section))) issues.push({ path: `${path}/section`, message: `A section heading of one line, at most ${TEMPLATE_LIMITS.section} characters ("Jackets").` })
    if (line.kind === 'FEE') {
      if (line.feeKind === null || !(SALES_FEE_KINDS as readonly string[]).includes(line.feeKind)) issues.push({ path: `${path}/feeKind`, message: `A fee line says what it charges for: ${SALES_FEE_KINDS.join(', ')}.` })
      if (line.sizes !== null) issues.push({ path: `${path}/sizes`, message: 'A fee line has no sizes.' })
      if (line.unitPrice === null) issues.push({ path: `${path}/unitPrice`, message: 'A fee line has its price.' })
    } else if (line.feeKind !== null) issues.push({ path: `${path}/feeKind`, message: 'Only a fee line has a fee kind.' })
    if (line.sizes !== null) {
      const entries = Object.entries(line.sizes)
      if (entries.length === 0 || entries.length > TEMPLATE_LIMITS.sizes) issues.push({ path: `${path}/sizes`, message: `Pieces for 1 to ${TEMPLATE_LIMITS.sizes} sizes, or none (typed when the quote is made).` })
      for (const [size, pieces] of entries) {
        if (!SIZE_CODE.test(size)) issues.push({ path: `${path}/sizes/${size}`, message: 'A size code of at most 40 characters, no space.' })
        if (!Number.isInteger(pieces) || pieces < 1 || pieces > TEMPLATE_LIMITS.pieces) issues.push({ path: `${path}/sizes/${size}`, message: `Size ${size}: whole pieces from 1 to ${TEMPLATE_LIMITS.pieces}.` })
      }
    }
    if (line.unitPrice !== null) {
      const price = parseDecimal(line.unitPrice)
      if (price === null || !fitsDecimal(line.unitPrice, 18, 6) || price.lte(0)) issues.push({ path: `${path}/unitPrice`, message: 'A unit price above 0 (a decimal of at most 6 places), or none: the price list prices it.' })
    }
    if (line.description !== null && line.description.length > TEMPLATE_LIMITS.lineDescription) issues.push({ path: `${path}/description`, message: `A line's text of at most ${TEMPLATE_LIMITS.lineDescription} characters.` })
    if (line.note !== null && line.note.length > TEMPLATE_LIMITS.lineNote) issues.push({ path: `${path}/note`, message: `A note of at most ${TEMPLATE_LIMITS.lineNote} characters.` })
  })
  return issues
}

/** A template of one company is that company's; of every company (null) the tenant's, read by every company. */
export const templateServes = (template: { readonly companyId: string | null }, companyId: string): boolean => template.companyId === null || template.companyId === companyId

// ---- starting a quote ---------------------------------------------------------------------------------------------------

/** What the person picks for a template line when the quote is made (a colourway left open, sizes typed at use). */
export interface LinePick {
  readonly templateLineId: string
  readonly colourwayId?: string | null | undefined
  readonly sizes?: Readonly<Record<string, number>> | null | undefined
  /** Leave this line out of the quote. */
  readonly skip?: boolean | undefined
}

export interface PlannedLine {
  readonly templateLineId: string
  readonly seq: number
  readonly section: string | null
  readonly styleId: string
  readonly colourwayId: string
  readonly sizes: Readonly<Record<string, number>>
  readonly unitPrice: string | null
  readonly description: string | null
  readonly note: string | null
}

/** A template line that does not become a quote line, and why (in words). */
export interface LeftOut {
  readonly seq: number
  readonly size: string | null
  readonly reason: string
}

/**
 * Which template lines become lines of the new quote: a size grid line in its colourway (the template's, or the one picked)
 * with its pieces (the template's, or the ones typed); a line without either is left out and said, as is a fee line (a quote
 * line of a fee is priced with the waterfall's fees, which come later) and a line the person leaves out.
 */
export function planStart(lines: readonly (TemplateLineInput & { readonly id: string })[], picks: readonly LinePick[]): { readonly lines: PlannedLine[]; readonly leftOut: LeftOut[] } {
  const byLine = new Map(picks.map((pick) => [pick.templateLineId, pick]))
  const planned: PlannedLine[] = []
  const leftOut: LeftOut[] = []
  for (const line of [...lines].sort((a, b) => a.seq - b.seq)) {
    const pick = byLine.get(line.id)
    if (pick?.skip) {
      leftOut.push({ seq: line.seq, size: null, reason: 'Left out when the quote was made.' })
      continue
    }
    if (line.kind === 'FEE') {
      leftOut.push({ seq: line.seq, size: null, reason: 'A fee line is not added to a quote yet: add the fee by hand once fees are priced on quotes.' })
      continue
    }
    const colourwayId = pick?.colourwayId ?? line.colourwayId
    if (!colourwayId) {
      leftOut.push({ seq: line.seq, size: null, reason: 'Its colourway is chosen when the quote is made: pick one, or add the line on the quote.' })
      continue
    }
    const sizes = pick?.sizes ?? line.sizes
    if (!sizes || Object.keys(sizes).length === 0) {
      leftOut.push({ seq: line.seq, size: null, reason: 'Its pieces per size are typed when the quote is made: type them, or add the line on the quote.' })
      continue
    }
    planned.push({ templateLineId: line.id, seq: line.seq, section: line.section, styleId: line.styleId, colourwayId, sizes, unitPrice: line.unitPrice, description: line.description, note: line.note })
  }
  return { lines: planned, leftOut }
}
