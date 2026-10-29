import type { Issue } from '../../core/errors'
import { fitsDecimal, fromMinorUnits, toMinorUnits, UNIT_PRICE, type MinorUnits } from '../../core/money'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { COST_ROUND } from '../../costing/sheet'
import type { PartyTaxMode } from '../../parties/tax'
import { decimalText, roundTo } from '../../product/units/units'
import { defineMachine } from '../../state/machine'
import { Dec, HUNDRED, parseDecimal, sum, ZERO, type Decimal } from '../../tax/decimal'
import { computeVat, vatOn, type AmountLine, type PriceBasis } from '../../tax/vat-summary'
import type { VatTreatment } from '../../tax/vat-treatment'
import type { QuoteRules } from './rules'

/**
 * Quotes (B-W1-21; plan A1 §2.4 C, §2.5 "Quote", §2.6; SAL-143, SAL-172, SAL-184, SAL-203, SAL-268, GAP-001, FIN-023),
 * pure: the states, a line's size grid and price, the money of a version (net per line rounded at line level, VAT by
 * the party's treatment through tax/vat-summary computeVat — the same arithmetic as the invoice, so the total the
 * customer accepts is the total it is invoiced —, gross, deposit), the cost of a line from the style's cost sheet
 * (costing), the margin against the floor, the approval rules and the issues that stop a quote, in words.
 *
 * A quote is a header and its versions (factory-db sales.prisma); this step edits the current DRAFT version and moves it
 * DRAFT → PENDING_APPROVAL → APPROVED (or back to DRAFT), or CANCELLED. Sending (→ SENT, the frozen version, its PDF and
 * accept link) is B-W1-24; it asks `sendBlockers` here.
 *
 * Price basis: a quote to a consumer (IT_B2C, EU_B2C) is priced VAT included (GROSS: the consumer's price, Codice del
 * Consumo art. 49), any other NET; the version has no column for it, so it is always `priceBasisOf(taxMode)`, here, for
 * the quote, the order made from it and its invoice alike. Unit prices are on that basis; `netAmount` is always without
 * VAT, so cost and margin compare like with like.
 *
 * Margin = net − cost, in minor units; margin % = margin ÷ net × 100 (4 places). The floor rule (SAL-184, FIN-023) breaks
 * when the version's margin OR a line's margin is under the floor (a line sold under the floor is what FIN-023 names);
 * the discount rule when a line's discount off its list price is over the limit. Either asks for an approval. A margin is
 * known only when every line has its cost: an incomplete cost is listed in words and stops the approval request and the
 * send (never counted as 0).
 */

export const QUOTE_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'] as const
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]
export const QUOTE_VERSION_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED'] as const
export type QuoteVersionStatus = (typeof QUOTE_VERSION_STATUSES)[number]
export const SALES_LINE_KINDS = ['SIZE_GRID', 'MADE_TO_MEASURE'] as const
export type SalesLineKind = (typeof SALES_LINE_KINDS)[number]
export const DEPOSIT_KINDS = ['ACCONTO', 'CAPARRA'] as const
export type DepositKind = (typeof DEPOSIT_KINDS)[number]
export const APPROVAL_REASONS = ['MARGIN_FLOOR', 'DISCOUNT_LIMIT', 'AMOUNT_LIMIT', 'SPECIAL_ITEM'] as const
export type ApprovalReason = (typeof APPROVAL_REASONS)[number]
export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

/**
 * The moves of a version, as the …_sales_guards trigger allows them. This step makes DRAFT → PENDING_APPROVAL (ask),
 * PENDING_APPROVAL → APPROVED (approve) | DRAFT (reject, withdraw), APPROVED → DRAFT (reopen), and any of the three →
 * CANCELLED; B-W1-24 makes the sends and the party's decisions.
 */
export const quoteVersionMachine = defineMachine<QuoteVersionStatus>({
  name: 'quote',
  states: QUOTE_VERSION_STATUSES,
  transitions: {
    DRAFT: ['PENDING_APPROVAL', 'SENT', 'CANCELLED'],
    PENDING_APPROVAL: ['APPROVED', 'DRAFT', 'CANCELLED'],
    APPROVED: ['SENT', 'DRAFT', 'CANCELLED'],
    SENT: ['ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED'],
  },
})

/** The states this step's office commands leave a version in (cancel reaches CANCELLED from each). */
export const OPEN_BEFORE_SEND: readonly QuoteVersionStatus[] = Object.freeze(['DRAFT', 'PENDING_APPROVAL', 'APPROVED'])

/** The states in words, for messages. */
export const STATUS_WORDS: Readonly<Record<QuoteVersionStatus, string>> = Object.freeze({
  DRAFT: 'a draft',
  PENDING_APPROVAL: 'waiting for approval',
  APPROVED: 'approved',
  SENT: 'sent',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  EXPIRED: 'expired',
  SUPERSEDED: 'replaced by a newer version',
  CANCELLED: 'cancelled',
})

/** At most this many lines on one version, and pieces in one size of a line. */
export const MAX_QUOTE_LINES = 200
export const MAX_SIZE_QUANTITY = 99_999
export const MAX_TEXT = { description: 1000, note: 2000, paymentTerms: 500, termsText: 20_000, termsVersion: 50, customerRef: 100, internalNote: 4000, changeNote: 1000, reason: 1000 } as const

/** Consumers see and accept VAT-inclusive prices (Codice del Consumo art. 49): their quotes are priced GROSS. */
export function priceBasisOf(taxMode: PartyTaxMode): PriceBasis {
  return taxMode === 'IT_B2C' || taxMode === 'EU_B2C' ? 'GROSS' : 'NET'
}

/**
 * The VAT treatment of the sale as the version stores it (QuoteVersion.taxMode): the party's tax mode, or IT_B2B for an
 * EU business without a valid VIES check (DL 331/1993 art. 41: Italian VAT until VIES proves the number).
 */
export function versionTaxModeOf(identityTaxMode: PartyTaxMode, viesValid: boolean): PartyTaxMode {
  return identityTaxMode === 'EU_B2B' && !viesValid ? 'IT_B2B' : identityTaxMode
}

/** The day `days` after a calendar day. */
export function addDays(day: BusinessDate, days: number): BusinessDate {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

// ---- a line's price and size grid -------------------------------------------------------------------------------

/** One size of a size-grid line: its pieces and, when it differs from the line's, its own unit price. */
export interface SizeRow {
  readonly size: string
  readonly quantity: number
  readonly unitPrice: string | null
}

const PRICE_ROUND = { scale: UNIT_PRICE.scale, rounding: 'HALF_UP' } as const
const fitsPrice = (value: string): boolean => fitsDecimal(value, UNIT_PRICE.precision, UNIT_PRICE.scale) && !value.startsWith('-')

/** A price as stored and shown: 6 places at most, no trailing zeros. */
export const priceText = (value: Decimal | string): string => decimalText(roundTo(value, PRICE_ROUND))

export interface PriceInput {
  readonly unitPrice?: string | null | undefined
  readonly listUnitPrice?: string | null | undefined
  readonly discountPct?: string | null | undefined
}

/**
 * A line's unit price and list price from what the office typed: a unit price (the discount is then read off the list
 * price, if any), or a list price and a discount (the unit price = list × (1 − discount ÷ 100), 6 places half up).
 * `current` is the line as stored (an edit that sends only a discount keeps the list price). The schema has no discount
 * column: the discount is always list vs unit.
 */
export function resolvePrice(input: PriceInput, current: { readonly unitPrice: string; readonly listUnitPrice: string | null } | null, at: string): { unitPrice: string; listUnitPrice: string | null } | Issue[] {
  const issues: Issue[] = []
  const list = input.listUnitPrice === undefined ? (current?.listUnitPrice ?? null) : input.listUnitPrice
  if (list !== null && !fitsPrice(list)) issues.push({ path: `${at}/listUnitPrice`, message: 'A list price of 0 or more with at most 6 decimals.' })
  if (input.discountPct !== undefined && input.discountPct !== null) {
    if (input.unitPrice !== undefined && input.unitPrice !== null) issues.push({ path: `${at}/discountPct`, message: 'Send a unit price or a discount off the list price, not both.' })
    const discount = parseDecimal(input.discountPct)
    if (discount === null || !fitsDecimal(input.discountPct, 7, 4) || discount.lt(0) || discount.gte(100)) issues.push({ path: `${at}/discountPct`, message: 'A discount from 0 to below 100 percent.' })
    if (list === null) issues.push({ path: `${at}/listUnitPrice`, message: 'A discount is taken off the list price: send the list price too.' })
    if (issues.length > 0) return issues
    const unit = new Dec(list!).times(HUNDRED.minus(discount!)).dividedBy(HUNDRED)
    return { unitPrice: priceText(unit), listUnitPrice: priceText(list!) }
  }
  const unit = input.unitPrice === undefined || input.unitPrice === null ? (current?.unitPrice ?? '0') : input.unitPrice
  if (!fitsPrice(unit)) issues.push({ path: `${at}/unitPrice`, message: 'A unit price of 0 or more with at most 6 decimals.' })
  if (issues.length > 0) return issues
  return { unitPrice: priceText(unit), listUnitPrice: list === null ? null : priceText(list) }
}

/** What a style offers a colourway in: its range, and which sizes are ACTIVE SKUs of the colourway. */
export interface GridFacts {
  readonly range: readonly string[]
  readonly offered: ReadonlySet<string>
}

export interface SizeInput {
  readonly size: string
  readonly quantity: number
  readonly unitPrice?: string | null | undefined
}

/**
 * A size grid as typed (SAL-268): a size of the style's range, offered in the colourway (an ACTIVE SKU), once; whole
 * pieces from 0 to MAX_SIZE_QUANTITY (0 leaves the size out); a size's own price, when it has one, 0 or more. At least
 * one piece. Returns the rows in the range's order, or the problems.
 */
export function sizeGrid(sizes: readonly SizeInput[], facts: GridFacts, at: string): SizeRow[] | Issue[] {
  const issues: Issue[] = []
  const seen = new Set<string>()
  sizes.forEach((row, index) => {
    const path = `${at}/${index}`
    if (seen.has(row.size)) issues.push({ path: `${path}/size`, message: `Size ${row.size} is in the grid twice.` })
    seen.add(row.size)
    if (!facts.range.includes(row.size)) issues.push({ path: `${path}/size`, message: `Not a size of this style's range (${facts.range.join(', ')}).` })
    else if (!facts.offered.has(row.size)) issues.push({ path: `${path}/size`, message: `Size ${row.size} is not offered in this colourway (no active SKU).` })
    if (!Number.isInteger(row.quantity) || row.quantity < 0 || row.quantity > MAX_SIZE_QUANTITY) issues.push({ path: `${path}/quantity`, message: `Whole pieces from 0 to ${MAX_SIZE_QUANTITY}.` })
    if (row.unitPrice !== undefined && row.unitPrice !== null && !fitsPrice(row.unitPrice)) issues.push({ path: `${path}/unitPrice`, message: 'A unit price of 0 or more with at most 6 decimals.' })
  })
  if (issues.length > 0) return issues
  const rows = sizes
    .filter((row) => row.quantity > 0)
    .map((row) => ({ size: row.size, quantity: row.quantity, unitPrice: row.unitPrice === undefined || row.unitPrice === null ? null : priceText(row.unitPrice) }))
    .sort((a, b) => facts.range.indexOf(a.size) - facts.range.indexOf(b.size))
  if (rows.length === 0) return [{ path: at, message: 'A size grid line has at least one piece.' }]
  return rows
}

export const isIssueList = <T>(value: T | Issue[]): value is Issue[] => Array.isArray(value) && (value.length === 0 || 'path' in (value[0] as object))

/** Pieces of a grid. */
export const piecesOf = (sizes: readonly Pick<SizeRow, 'quantity'>[]): number => sizes.reduce((total, row) => total + row.quantity, 0)

/** The prices a line sells at: its own, and each size's own. */
const effectivePrices = (unitPrice: string, sizes: readonly SizeRow[]): Decimal[] => sizes.map((row) => new Dec(row.unitPrice ?? unitPrice))

/**
 * A line's discount off its list price, percent (4 places): the largest over the prices it sells at (a size cheaper
 * than the line is a discount too). Null without a list price above 0, or when nothing sells under it.
 */
export function discountOf(line: { readonly unitPrice: string; readonly listUnitPrice: string | null; readonly sizes: readonly SizeRow[] }): string | null {
  if (line.listUnitPrice === null) return null
  const list = new Dec(line.listUnitPrice)
  if (list.lte(ZERO)) return null
  const prices = effectivePrices(line.unitPrice, line.sizes)
  const lowest = prices.length === 0 ? new Dec(line.unitPrice) : Dec.min(...prices)
  if (lowest.gte(list)) return null
  return decimalText(list.minus(lowest).times(HUNDRED).dividedBy(list).toDecimalPlaces(4, Dec.ROUND_HALF_UP))
}

/** A line is priced when every piece sells above 0. */
export const isPriced = (line: { readonly unitPrice: string; readonly sizes: readonly SizeRow[] }): boolean => effectivePrices(line.unitPrice, line.sizes).every((price) => price.gt(ZERO))

// ---- a line's cost (costing's cost sheet, B-W1-16) ----------------------------------------------------------------

/** One size of a line as the cost sheet costs it: complete or not, and the cost per garment of its known inputs. */
export interface CostedSize {
  readonly quantity: number
  readonly complete: boolean
  readonly knownTotal: Decimal
}

export interface LineCost {
  readonly complete: boolean
  /** The line's cost ÷ its pieces, 6 places (sizes cost differently, so an average); null unless complete. */
  readonly unitCost: string | null
  /** Σ cost per garment × pieces, exact, rounded once to minor units; null unless complete. */
  readonly amount: MinorUnits | null
}

/** A line's cost from its sizes' cells (exactCell of the sheet): exact to the end, one rounding per figure. */
export function lineCostOf(sizes: readonly CostedSize[], currency: string): LineCost {
  const pieces = sizes.reduce((total, row) => total + row.quantity, 0)
  if (sizes.length === 0 || pieces === 0 || sizes.some((row) => !row.complete)) return { complete: false, unitCost: null, amount: null }
  const exact = sum(sizes.map((row) => row.knownTotal.times(row.quantity)))
  return { complete: true, unitCost: decimalText(roundTo(exact.dividedBy(pieces), COST_ROUND)), amount: toMinorUnits(exact, currency) }
}

// ---- the money of a version ---------------------------------------------------------------------------------------

/** A line as the version's money is computed from it. */
export interface MoneyLine {
  readonly seq: number
  readonly unitPrice: string
  readonly listUnitPrice: string | null
  readonly sizes: readonly SizeRow[]
  /** The line's cost (LineCost.amount); null: incomplete. */
  readonly costAmount: MinorUnits | null
}

export interface PricedLine {
  readonly seq: number
  readonly quantity: number
  /** Without VAT, rounded at line level (each price of the line once). */
  readonly netAmount: MinorUnits
  /** The line's own VAT (NET: its net's VAT; GROSS: its gross − net). The version's VAT is per treatment. */
  readonly vatAmount: MinorUnits
  readonly discountPct: string | null
  readonly costAmount: MinorUnits | null
  readonly marginAmount: MinorUnits | null
  readonly marginPct: string | null
  /** Its margin is under the floor (false while the cost is not known). */
  readonly belowFloor: boolean
}

/** One VAT treatment of the version: what the invoice's DatiRiepilogo will say. */
export interface VatBreakdown {
  readonly rate: string | null
  readonly nature: string | null
  readonly taxable: MinorUnits
  readonly vat: MinorUnits
  readonly rounding: MinorUnits
}

export interface RuleCheck {
  readonly reason: Extract<ApprovalReason, 'MARGIN_FLOOR' | 'DISCOUNT_LIMIT'>
  /** The rule could be checked (MARGIN_FLOOR: every line has its cost). */
  readonly known: boolean
  readonly broken: boolean
  /** In words, without a cost or margin figure: people without the margin grain read it too. */
  readonly message: string
  /** The lines that break it, by seq. */
  readonly lines: readonly number[]
}

export interface PricedVersion {
  readonly basis: PriceBasis
  readonly currency: string
  readonly lines: readonly PricedLine[]
  readonly netAmount: MinorUnits
  readonly vatAmount: MinorUnits
  readonly grossAmount: MinorUnits
  readonly vat: readonly VatBreakdown[]
  readonly depositAmount: MinorUnits | null
  /** Every line has its cost (and there is a line). */
  readonly costComplete: boolean
  readonly costAmount: MinorUnits | null
  readonly marginAmount: MinorUnits | null
  readonly marginPct: string | null
  readonly marginFloorPct: string
  readonly discountLimitPct: string
  /** The floor rule breaks (the version's or a line's margin under the floor). */
  readonly marginFloorBreached: boolean
  readonly rules: readonly RuleCheck[]
  /** A rule breaks: the version needs an approval before it is sent. */
  readonly approvalNeeded: boolean
}

export interface VersionMoneyInput {
  readonly basis: PriceBasis
  readonly currency: string
  /** The party's treatment (every line of a version is taxed alike: one party, garments). */
  readonly treatment: VatTreatment
  readonly lines: readonly MoneyLine[]
  readonly depositPct: string | null
  readonly rules: Pick<QuoteRules, 'marginFloorPct' | 'discountLimitPct'>
}

/** Margin % (4 places), or null when the net is 0 or the figure passes Decimal(9,4). */
function marginPercent(margin: MinorUnits, net: MinorUnits): string | null {
  if (net === 0) return null
  const pct = new Dec(margin).times(HUNDRED).dividedBy(net).toDecimalPlaces(4, Dec.ROUND_HALF_UP)
  return pct.abs().gte(100_000) ? null : decimalText(pct)
}

/** Under the floor, exactly (never on a rounded %): margin × 100 < floor × net; a net of 0 is under it when it costs. */
const underFloor = (margin: MinorUnits, net: MinorUnits, floor: Decimal): boolean => (net === 0 ? margin < 0 : new Dec(margin).times(HUNDRED).lt(floor.times(net)))

const seqList = (lines: readonly number[]): string => (lines.length === 1 ? `Line ${lines[0]}` : `Lines ${lines.join(', ')}`)

/**
 * The money of a version from its lines: each line's net (computeVat: each price of the line × its pieces, rounded to
 * the cent), the VAT per treatment, the gross, the deposit (gross × % ÷ 100, rounded once), the cost and margin of each
 * line and of the version, and the approval rules. Deterministic: the read computes the VAT breakdown again with it.
 */
export function priceVersion(input: VersionMoneyInput): PricedVersion {
  const { basis, currency, treatment } = input
  const amounts: AmountLine[] = []
  const owners: number[] = []
  input.lines.forEach((line, index) => {
    const groups = new Map<string, number>()
    for (const row of line.sizes) {
      const price = priceText(row.unitPrice ?? line.unitPrice)
      groups.set(price, (groups.get(price) ?? 0) + row.quantity)
    }
    for (const [price, quantity] of groups) {
      amounts.push({ treatment, quantity: new Dec(quantity), unitPrice: new Dec(price) })
      owners.push(index)
    }
  })
  const vat = computeVat(amounts, basis)
  const minor = (value: Decimal): MinorUnits => toMinorUnits(value, currency)
  const floor = new Dec(input.rules.marginFloorPct)
  const limit = new Dec(input.rules.discountLimitPct)

  const lines: PricedLine[] = input.lines.map((line, index) => {
    const parts = vat.lines.filter((_, at) => owners[at] === index)
    const net = minor(sum(parts.map((part) => part.net)))
    const lineVat = basis === 'NET' ? minor(vatOn(sum(parts.map((part) => part.net)), treatment)) : minor(sum(parts.map((part) => (part.gross ?? part.net).minus(part.net))))
    const margin = line.costAmount === null ? null : net - line.costAmount
    return {
      seq: line.seq,
      quantity: piecesOf(line.sizes),
      netAmount: net,
      vatAmount: lineVat,
      discountPct: discountOf(line),
      costAmount: line.costAmount,
      marginAmount: margin,
      marginPct: margin === null ? null : marginPercent(margin, net),
      belowFloor: margin !== null && underFloor(margin, net, floor),
    }
  })

  const netAmount = minor(vat.taxable)
  const grossAmount = minor(vat.total)
  const costComplete = lines.length > 0 && lines.every((line) => line.costAmount !== null)
  const costAmount = costComplete ? lines.reduce((total, line) => total + line.costAmount!, 0) : null
  const marginAmount = costAmount === null ? null : netAmount - costAmount
  const versionUnder = marginAmount !== null && underFloor(marginAmount, netAmount, floor)
  const linesUnder = costComplete ? lines.filter((line) => line.belowFloor).map((line) => line.seq) : []
  const marginFloorBreached = costComplete && (versionUnder || linesUnder.length > 0)
  const overLimit = lines.filter((line) => line.discountPct !== null && new Dec(line.discountPct).gt(limit)).map((line) => line.seq)

  const marginRule: RuleCheck = !costComplete
    ? { reason: 'MARGIN_FLOOR', known: false, broken: false, lines: [], message: lines.length === 0 ? 'The margin is known once the quote has lines.' : 'The margin is not known until every line has its cost.' }
    : marginFloorBreached
      ? {
          reason: 'MARGIN_FLOOR',
          known: true,
          broken: true,
          lines: linesUnder,
          message: versionUnder ? "The quote's margin is under the floor: an approver decides." : `${seqList(linesUnder)} ${linesUnder.length === 1 ? 'is' : 'are'} under the margin floor: an approver decides.`,
        }
      : { reason: 'MARGIN_FLOOR', known: true, broken: false, lines: [], message: 'The margin is at or above the floor.' }
  const discountRule: RuleCheck =
    overLimit.length > 0
      ? {
          reason: 'DISCOUNT_LIMIT',
          known: true,
          broken: true,
          lines: overLimit,
          message: `${seqList(overLimit)} ${overLimit.length === 1 ? 'has a discount' : 'have discounts'} off the list price over the ${decimalText(limit)} % limit: an approver decides.`,
        }
      : { reason: 'DISCOUNT_LIMIT', known: true, broken: false, lines: [], message: `No discount is over the ${decimalText(limit)} % limit.` }
  const rules = [marginRule, discountRule]

  return {
    basis,
    currency,
    lines,
    netAmount,
    vatAmount: minor(vat.vat),
    grossAmount,
    vat: vat.summary.map((row) => ({
      rate: row.treatment.kind === 'TAXABLE' ? new Dec(row.treatment.rate).toFixed(2) : null,
      nature: row.treatment.kind === 'NON_TAXABLE' ? row.treatment.natura : null,
      taxable: minor(row.taxable),
      vat: minor(row.vat),
      rounding: minor(row.rounding),
    })),
    depositAmount: input.depositPct === null ? null : toMinorUnits(fromMinorUnits(grossAmount, currency).times(new Dec(input.depositPct)).dividedBy(HUNDRED), currency),
    costComplete,
    costAmount,
    marginAmount,
    marginPct: marginAmount === null ? null : marginPercent(marginAmount, netAmount),
    marginFloorPct: decimalText(floor),
    discountLimitPct: decimalText(limit),
    marginFloorBreached,
    rules,
    approvalNeeded: rules.some((rule) => rule.broken),
  }
}

/** The approval reasons of the rules that break. */
export const brokenReasons = (rules: readonly RuleCheck[]): ApprovalReason[] => rules.filter((rule) => rule.broken).map((rule) => rule.reason)

// ---- the approval -------------------------------------------------------------------------------------------------

export interface ApprovalLine {
  readonly seq: number
  readonly description: string | null
  readonly quantity: number
  readonly unitPrice: string
  readonly listUnitPrice: string | null
}

/**
 * QuoteApproval.details (a margin-grain column): the numbers behind each broken rule and exactly what was asked to be
 * approved (prices, discounts, the margin %, never a cost or margin amount), with the fingerprint of the priced content
 * the API takes; an approval is decided only while the version is still that content.
 */
export function approvalDetails(priced: PricedVersion, lines: readonly ApprovalLine[], fingerprint: string) {
  const bySeq = new Map(priced.lines.map((line) => [line.seq, line]))
  return {
    fingerprint,
    rules: priced.rules
      .filter((rule) => rule.broken)
      .map((rule) =>
        rule.reason === 'MARGIN_FLOOR'
          ? { reason: rule.reason, marginPct: priced.marginPct, marginFloorPct: priced.marginFloorPct, lines: rule.lines.map((seq) => ({ seq, marginPct: bySeq.get(seq)?.marginPct ?? null })) }
          : { reason: rule.reason, discountLimitPct: priced.discountLimitPct, lines: rule.lines.map((seq) => ({ seq, discountPct: bySeq.get(seq)?.discountPct ?? null })) },
      ),
    asked: {
      basis: priced.basis,
      currency: priced.currency,
      netAmount: priced.netAmount,
      vatAmount: priced.vatAmount,
      grossAmount: priced.grossAmount,
      marginPct: priced.marginPct,
      marginFloorPct: priced.marginFloorPct,
      lines: lines.map((line) => ({ ...line, netAmount: bySeq.get(line.seq)?.netAmount ?? 0, discountPct: bySeq.get(line.seq)?.discountPct ?? null, marginPct: bySeq.get(line.seq)?.marginPct ?? null })),
    },
  }
}
export type ApprovalDetails = ReturnType<typeof approvalDetails>

// ---- what stops a quote -------------------------------------------------------------------------------------------

/**
 * BLOCKS: stops the approval request and the send. BLOCKS_SEND: stops only the send (B-W1-24's checks). WARNING: said
 * before sending, never stops it. INFO: worth knowing.
 */
export const ISSUE_SEVERITIES = ['BLOCKS', 'BLOCKS_SEND', 'WARNING', 'INFO'] as const
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number]

export const QUOTE_ISSUE_CODES = [
  'PARTY_NOT_QUOTABLE',
  'NO_LINES',
  'NOT_PRICED',
  'COST_INCOMPLETE',
  'NO_COST_REVISION',
  'COST_ESTIMATE',
  'CERTIFICATE',
  'VIES_NOT_PROVEN',
  'APPROVAL_NEEDED',
  'NO_VALIDITY',
  'VALIDITY_PAST',
  'NO_BILL_TO',
  'NO_SHIP_TO',
  'NO_CONTACT_EMAIL',
  'NO_PROMISE_DATE',
] as const
export type QuoteIssueCode = (typeof QUOTE_ISSUE_CODES)[number]

export interface QuoteIssue {
  readonly code: QuoteIssueCode
  readonly severity: IssueSeverity
  readonly path: string
  /** In words, without a cost or margin figure. */
  readonly message: string
  readonly lineId: string | null
  readonly size: string | null
}

export interface IssueFacts {
  readonly today: BusinessDate
  readonly party: {
    readonly status: string
    readonly legalName: string
    /** The identity's tax mode (EU_B2B here even when the version is taxed as IT_B2B for want of a VIES proof). */
    readonly taxMode: PartyTaxMode | null
    readonly viesValid: boolean
    readonly viesMessage: string | null
  }
  readonly version: {
    readonly validUntil: string | null
    readonly billToAddressId: string | null
    readonly shipToAddressId: string | null
    readonly promiseDate: string | null
    readonly contactEmail: string | null
  }
  readonly lines: readonly {
    readonly id: string
    readonly seq: number
    readonly label: string
    readonly priced: boolean
    /** The cost sheet's missing inputs that touch the line, in words; empty when complete. */
    readonly costMissing: readonly string[]
    /** The revision the cost came from: RELEASED, DRAFT (an estimate), or null (the style has none). */
    readonly costRevision: 'RELEASED' | 'DRAFT' | 'OBSOLETE' | null
    /** Per size: the certificate gate's reasons (empty: covered or not required). */
    readonly certificates: readonly { readonly size: string; readonly reasons: readonly string[] }[]
  }[]
  readonly rules: readonly RuleCheck[]
}

/** Everything that stops or concerns a version, in the order a person fixes them. */
export function quoteIssues(facts: IssueFacts): QuoteIssue[] {
  const issues: QuoteIssue[] = []
  const add = (code: QuoteIssueCode, severity: IssueSeverity, path: string, message: string, lineId: string | null = null, size: string | null = null) => issues.push({ code, severity, path, message, lineId, size })
  const { party, version } = facts
  if (party.status === 'BLOCKED' || party.status === 'ARCHIVED') add('PARTY_NOT_QUOTABLE', 'BLOCKS', 'party', `${party.legalName} is ${party.status.toLowerCase()}: no quote goes to it until it is active again.`)
  if (facts.lines.length === 0) add('NO_LINES', 'BLOCKS', 'lines', 'The quote has no lines yet: add a style and its size grid.')
  facts.lines.forEach((line, index) => {
    const at = `lines/${index}`
    if (!line.priced) add('NOT_PRICED', 'BLOCKS', `${at}/unitPrice`, `Line ${line.seq} (${line.label}) has no price: every piece sells above 0.`, line.id)
    if (line.costRevision === null) add('NO_COST_REVISION', 'BLOCKS', `${at}/styleRevisionId`, `Line ${line.seq} (${line.label}): the style has no revision to cost it from.`, line.id)
    else if (line.costMissing.length > 0) add('COST_INCOMPLETE', 'BLOCKS', `${at}/cost`, `Line ${line.seq} (${line.label}): the cost is incomplete — ${line.costMissing.join('; ')}`, line.id)
    else if (line.costRevision === 'DRAFT') add('COST_ESTIMATE', 'INFO', `${at}/styleRevisionId`, `Line ${line.seq} (${line.label}) is costed from a draft revision: an estimate until the style is released.`, line.id)
    for (const certificate of line.certificates) {
      if (certificate.reasons.length > 0) add('CERTIFICATE', 'WARNING', `${at}/sizes/${certificate.size}`, `Line ${line.seq} (${line.label}), size ${certificate.size}: not covered by a valid certificate — ${certificate.reasons.join('; ')}`, line.id, certificate.size)
    }
  })
  if (party.taxMode === 'EU_B2B' && !party.viesValid) add('VIES_NOT_PROVEN', 'WARNING', 'party/vies', `VAT is charged at 22 % until VIES confirms the VAT number. ${party.viesMessage ?? ''}`.trim())
  const broken = facts.rules.filter((rule) => rule.broken)
  if (broken.length > 0) add('APPROVAL_NEEDED', 'INFO', 'approval', `Needs approval: ${broken.map((rule) => rule.message).join(' ')}`)
  if (version.validUntil === null) add('NO_VALIDITY', 'BLOCKS_SEND', 'validUntil', 'Set the last day the offer can be accepted.')
  else if (version.validUntil < facts.today) add('VALIDITY_PAST', 'BLOCKS_SEND', 'validUntil', 'The offer ends before today: set a later day.')
  if (version.billToAddressId === null) add('NO_BILL_TO', 'BLOCKS_SEND', 'billToAddressId', 'Choose the invoice address.')
  if (version.shipToAddressId === null) add('NO_SHIP_TO', 'BLOCKS_SEND', 'shipToAddressId', 'Choose the delivery address.')
  if (version.contactEmail === null) add('NO_CONTACT_EMAIL', 'BLOCKS_SEND', 'contactId', 'Choose a contact with an email: the quote and its accept link go to them.')
  if ((party.taxMode === 'IT_B2C' || party.taxMode === 'EU_B2C') && version.promiseDate === null) add('NO_PROMISE_DATE', 'BLOCKS_SEND', 'promiseDate', 'A consumer is told the delivery date before accepting (Codice del Consumo art. 49): set the promise date.')
  return issues
}

/** What stops an approval request: the BLOCKS issues. */
export const submitBlockers = (issues: readonly QuoteIssue[]): QuoteIssue[] => issues.filter((issue) => issue.severity === 'BLOCKS')

/**
 * What stops the send (B-W1-24): every BLOCKS and BLOCKS_SEND issue, and an approval the rules need and the version does
 * not have (a DRAFT that breaks a rule; PENDING_APPROVAL waits for the decision).
 */
export function sendBlockers(issues: readonly QuoteIssue[], status: QuoteVersionStatus, approvalNeeded: boolean): QuoteIssue[] {
  const blockers = issues.filter((issue) => issue.severity === 'BLOCKS' || issue.severity === 'BLOCKS_SEND')
  if (status === 'PENDING_APPROVAL') blockers.push({ code: 'APPROVAL_NEEDED', severity: 'BLOCKS_SEND', path: 'approval', message: 'The approval request is waiting for a decision.', lineId: null, size: null })
  else if (status === 'DRAFT' && approvalNeeded) blockers.push({ code: 'APPROVAL_NEEDED', severity: 'BLOCKS_SEND', path: 'approval', message: 'A rule is broken: ask for an approval first.', lineId: null, size: null })
  else if (status !== 'DRAFT' && status !== 'APPROVED') blockers.push({ code: 'APPROVAL_NEEDED', severity: 'BLOCKS_SEND', path: 'status', message: `The quote is ${STATUS_WORDS[status]}.`, lineId: null, size: null })
  return blockers
}

/** A validity day as typed: a calendar day, from tomorrow on (an offer of less than a day is held: the design). */
export function validityProblem(day: string, today: BusinessDate): string | null {
  if (!isBusinessDate(day)) return 'Expected a calendar day written YYYY-MM-DD.'
  return day <= today ? 'The offer stands at least until tomorrow.' : null
}
