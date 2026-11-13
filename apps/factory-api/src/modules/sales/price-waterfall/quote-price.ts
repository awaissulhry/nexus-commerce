import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { buildWaterfall, explainWaterfall, FEE_CREDIT_AGAINST_BULK, stepPrice, stepsProblem, suggestedPriceOf, type OptionCharge, type StartKind, type WaterfallStep } from '@nexus/factory-domain/sales/price-waterfall/rules'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { isGoodsLine, type SalesFeeKind } from '@nexus/factory-domain/sales/quotes/quotes'
import { Dec, HUNDRED } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { reasonFor, reasonWords } from '../../../platform/reasons/service'
import { linePricesOf } from '../pricing-depth/quote-pricing'
import { refreshVersion } from '../quotes/pricing'
import { assertDraft, detailInCommand, onQuote } from '../quotes/quotes'
import { quoteRulesFor } from '../quotes/rules'
import { decimal, officeQuote, readCurrentVersion, readLineRecords, type LineRecord, type QuoteRow, type Reader, type VersionRow } from '../quotes/store'
import { readFacts, type QuoteDetail } from '../quotes/views'
import { personFloor, versionPersonOf } from './floors'

/**
 * The price of a quote line (B-W2b-330; SAL-173, SAL-174, SAL-175, SAL-189; design quote › Price & margin "Pricing by
 * line", the line drawer's "Cost breakdown and Waterfall"):
 *
 *   GET  /sales/quotes/:quoteId/pricing            every line of the current version: its waterfall as stored, in words
 *                                                  ("why this price?"), what its list would give now, the price its cost
 *                                                  suggests, its margin against the floor the version is held to
 *   PUT  /sales/quotes/:quoteId/lines/:lineId/price  a DRAFT goods line priced by its waterfall, in ONE update of the line
 *                                                  (unitPrice, listUnitPrice, priceSteps, the reason, its sizes' own
 *                                                  prices): start LIST | SUGGESTED | MANUAL, the list's break, the options
 *                                                  chosen on the line, a discount, a manual net with its reason code
 *                                                  (an ACTIVE code of PRICE_ADJUSTMENT; one that needs words, a note);
 *                                                  then the version's money and rules (W1 refreshVersion)
 *
 * Every figure is the price grain; the suggested price's margin and the line's margin the margin grain; the cost behind
 * the suggestion is never answered (only which revision's sheet and when it was priced). A writer that changes the price
 * without the steps (W1's line edit, W2a's amendment) has them dropped by the database: the waterfall is never stale.
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** A step list as stored (QuoteLine.priceSteps), or null when there is none. */
export const storedSteps = (value: Prisma.JsonValue | null): WaterfallStep[] | null => (Array.isArray(value) ? (value as unknown as WaterfallStep[]) : null)

/** The words of the PRICE_ADJUSTMENT reasons (English label; the screen reads the list itself for its language). */
export async function priceReasonLabels(db: Reader): Promise<(code: string) => string | null> {
  const words = await reasonWords(db as Prisma.TransactionClient, 'PRICE_ADJUSTMENT')
  return (code) => words.get(code)?.labelEn ?? null
}

/** A waterfall as answered: the steps (price grain), the words, and whether it still adds up. */
export function waterfallView(steps: WaterfallStep[] | null, unitPrice: string | null, listUnitPrice: string | null, currency: string, label: (code: string) => string | null) {
  if (steps === null) return { steps: asMoney('price', null), why: asMoney('price', null), problem: null }
  const problem = stepsProblem(steps, unitPrice, listUnitPrice)
  const why = explainWaterfall(steps, currency, label)
  return { steps: asMoney('price', steps.map((step) => ({ ...step }))), why: asMoney('price', { rows: why.rows.map((row): Record<string, unknown> => ({ ...row })), sentence: why.sentence }), problem }
}

/** The basis back to the net (a consumer's quote is priced VAT included at `rate`). */
const toNetOf = (rate: string | null, basis: 'NET' | 'GROSS') => (price: string) => (basis === 'NET' || rate === null ? stepPrice(price) : stepPrice(new Dec(price).times(HUNDRED).dividedBy(HUNDRED.plus(new Dec(rate)))))

/** The revision and day the line's cost was priced from (its cost snapshot), never a figure. */
function costBasisOf(line: LineRecord) {
  const snapshot = (line.costSnapshot ?? null) as { revisionId?: unknown; revision?: unknown; revisionStatus?: unknown; on?: unknown; computedAt?: unknown } | null
  if (!snapshot || typeof snapshot !== 'object') return null
  return {
    revisionId: typeof snapshot.revisionId === 'string' ? snapshot.revisionId : line.styleRevisionId,
    revision: typeof snapshot.revision === 'number' ? snapshot.revision : null,
    revisionStatus: typeof snapshot.revisionStatus === 'string' ? snapshot.revisionStatus : null,
    on: typeof snapshot.on === 'string' ? snapshot.on : null,
    computedAt: typeof snapshot.computedAt === 'string' ? snapshot.computedAt : null,
  }
}

/** The options chosen on the lines, as the waterfall's OPTION steps take them (frozen surcharge, net). */
async function optionChargesOf(db: Reader, lineIds: readonly string[]): Promise<Map<string, OptionCharge[]>> {
  if (lineIds.length === 0) return new Map()
  const rows = await db.quoteLineOption.findMany({
    where: { lineId: { in: [...lineIds] } },
    select: { id: true, lineId: true, freeText: true, surchargeAmount: true, surchargePct: true, value: { select: { name: true } }, group: { select: { name: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const byLine = new Map<string, OptionCharge[]>()
  for (const row of rows) {
    const label = `${row.value?.name ?? row.group?.name ?? 'Option'}${row.freeText ? ` "${row.freeText}"` : ''}`
    byLine.set(row.lineId, [...(byLine.get(row.lineId) ?? []), { optionId: row.id, label, amount: decimal(row.surchargeAmount), pct: row.surchargePct === null ? null : row.surchargePct.toString() }])
  }
  return byLine
}

/** The extra columns of the version's lines this module reads (W1's line record leaves them out). */
async function lineExtrasOf(db: Reader, versionId: string) {
  const rows = await db.quoteLine.findMany({ where: { versionId }, select: { id: true, feeKind: true, priceSteps: true, adjustmentReason: true, styleRevisionId: true } })
  return new Map(rows.map((row) => [row.id, row]))
}

/** The floor the version is held to: its maker's (role or company). */
async function floorOfVersion(db: Reader, quote: QuoteRow, version: VersionRow, now: Date) {
  const rules = await quoteRulesFor(db, quote.companyId)
  return personFloor(db, quote, versionPersonOf(quote, version), rules.marginFloorPct, now)
}

/** GET /sales/quotes/:quoteId/pricing (quotes.view): see the module comment. */
export async function quotePricing(caller: CommandCaller, quoteId: string) {
  const quote = await officeQuote(caller, quoteId)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const version = await readCurrentVersion(client, quote)
    const facts = await readFacts(client, quote, now, { certificates: false })
    const lines = facts.lines
    const extras = await lineExtrasOf(client, version.id)
    const listed = await linePricesOf(client, quote, version, now)
    const options = await optionChargesOf(client, lines.map((line) => line.id))
    const label = await priceReasonLabels(client)
    const floor = await floorOfVersion(client, quote, version, now)
    const pricedBySeq = new Map(facts.priced.lines.map((line) => [line.seq, line]))
    const toNet = toNetOf(listed.rate, listed.basis)
    return {
      quoteId: quote.id,
      versionId: version.id,
      revision: version.revision,
      status: version.status,
      currency: version.currency,
      priceBasis: listed.basis,
      floor: { marginFloorPct: asMoney('margin', floor.marginFloorPct), source: floor.source, roleKey: floor.roleKey, personId: floor.personId },
      lines: lines.map((line) => {
        const extra = extras.get(line.id)
        const unitPrice = decimal(line.unitPrice)!
        const listUnitPrice = decimal(line.listUnitPrice)
        const stored = waterfallView(storedSteps(extra?.priceSteps ?? null), unitPrice, listUnitPrice, version.currency, label)
        const fromList = listed.lines.find((row) => row.line.id === line.id)
        const money = pricedBySeq.get(line.seq)
        const goods = isGoodsLine(line)
        const proposal =
          goods && fromList?.priced.listPrice
            ? buildWaterfall({
                start: { kind: 'LIST', unitPrice: fromList.priced.listPrice, source: { type: 'PriceListEntry', id: fromList.entry!.id }, label: fromList.priced.steps[0]?.label ?? 'List price' },
                breakStep: breakOf(fromList.priced.steps),
                options: options.get(line.id) ?? [],
                sizeCharges: fromList.priced.sizeSurcharges.map((row) => ({ surchargeId: row.surchargeId, size: row.size, added: row.onBasis })),
                onBasis: listed.onBasis,
                toNet,
                currency: version.currency,
              })
            : null
        const suggested = goods ? suggestedPriceOf({ unitCost: line.costAmount === null ? null : decimal(line.unitCost), marginPct: floor.marginFloorPct, currency: version.currency, onBasis: listed.onBasis }) : null
        return {
          lineId: line.id,
          seq: line.seq,
          kind: line.kind,
          feeKind: (extra?.feeKind ?? null) as SalesFeeKind | null,
          styleId: line.styleId,
          colourwayId: line.colourwayId,
          quantity: line.quantity,
          unitPrice: asMoney('price', unitPrice),
          listUnitPrice: asMoney('price', listUnitPrice),
          adjustmentReason: extra?.adjustmentReason ?? null,
          steps: stored.steps,
          why: stored.why,
          stepsProblem: stored.problem,
          fromList: asMoney('price', proposal === null || Array.isArray(proposal) ? null : proposal.steps.map((step) => ({ ...step }))),
          suggested:
            suggested === null
              ? null
              : 'problem' in suggested
                ? { unitPrice: asMoney('price', null), marginPct: asMoney('margin', null), basedOn: costBasisOf(line), problem: suggested.problem }
                : { unitPrice: asMoney('price', suggested.unitPrice), marginPct: asMoney('margin', suggested.marginPct), basedOn: costBasisOf(line), problem: null },
          marginPct: asMoney('margin', money?.marginPct ?? null),
          belowFloor: asMoney('margin', money?.belowFloor ?? false),
          fee: line.kind === 'FEE' ? { creditAgainstBulk: { enabled: FEE_CREDIT_AGAINST_BULK.enabled, words: FEE_CREDIT_AGAINST_BULK.words } } : null,
        }
      }),
    }
  })
}

/** The BREAK step of a list's first steps (B-W2b-325 linePriceOf), as the builder takes it. */
function breakOf(steps: readonly { readonly kind: string; readonly delta?: string; readonly pct?: string; readonly source?: { readonly type: string; readonly id: string }; readonly label?: string }[]) {
  const step = steps.find((entry) => entry.kind === 'BREAK')
  return step && step.delta && step.source ? { delta: step.delta, ...(step.pct ? { pct: step.pct } : {}), source: step.source, ...(step.label ? { label: step.label } : {}) } : null
}

export interface PriceLineInput {
  readonly version: number
  readonly start: StartKind
  /** MANUAL: the starting price typed, on the version's basis, and its reason. */
  readonly startPrice?: string | null | undefined
  readonly startReasonCode?: string | null | undefined
  readonly startNote?: string | null | undefined
  /** SUGGESTED: the margin to earn (percent of the net); default the floor the version is held to. */
  readonly marginPct?: string | null | undefined
  /** The options chosen on the line as OPTION steps (default true). */
  readonly options?: boolean | undefined
  /** The money fields of the body are optional in the contract's type (the grain filter may drop them): checked here. */
  readonly discount?: { readonly pct?: string | undefined; readonly reasonCode?: string | null | undefined; readonly note?: string | null | undefined } | null | undefined
  readonly net?: { readonly unitPrice?: string | undefined; readonly reasonCode: string; readonly note?: string | null | undefined } | null | undefined
}

/** A PRICE_ADJUSTMENT code checked: ACTIVE, and one that needs detail with its words (400 in words). */
// B-W2b-302: takes a reader (goal-seek's preview checks the reason outside a command).
async function assertReason(db: Reader, code: string | null | undefined, note: string | null, at: string): Promise<void> {
  if (code === undefined || code === null) return
  const reason = await reasonFor(db as Prisma.TransactionClient, 'PRICE_ADJUSTMENT', code)
  if (!reason || !reason.active) throw new ValidationError(`"${code}" is not an active reason for a price change: choose one of the price adjustment reasons (Sales settings › Reasons).`, [{ path: `${at}/reasonCode`, message: 'Not an active PRICE_ADJUSTMENT reason.' }])
  if (reason.needsDetail && note === null) throw new ValidationError(`The reason "${reason.labelEn}" needs a few words: add a note.`, [{ path: `${at}/note`, message: 'This reason needs a note.' }])
}

const sizeAudit = (sizes: readonly { size: string; unitPrice: string | null }[]) => sizes.map((row) => ({ size: row.size, unitPrice: row.unitPrice }))

// ---- B-W2b-302: the price of a line in two parts, plan (no write) and write, so that goal-seek (SAL-150) shows a waterfall
// before it writes it and writes many lines in one command with the same rules: PUT …/price stays the one price writer. ----

/** B-W2b-302: the reads a line's price is planned from, once per version (goal-seek plans many lines with the same). */
export interface PriceContext {
  readonly listed: Awaited<ReturnType<typeof linePricesOf>>
  readonly floor: Awaited<ReturnType<typeof floorOfVersion>>
  readonly extras: Awaited<ReturnType<typeof lineExtrasOf>>
  readonly options: Map<string, OptionCharge[]>
}

/** B-W2b-302: see PriceContext. */
export async function priceContextOf(db: Reader, current: QuoteRow, version: VersionRow, lines: readonly LineRecord[], now: Date): Promise<PriceContext> {
  return {
    listed: await linePricesOf(db, current, version, now),
    floor: await floorOfVersion(db, current, version, now),
    extras: await lineExtrasOf(db, version.id),
    options: await optionChargesOf(db, lines.map((line) => line.id)),
  }
}

/** B-W2b-302: a line's planned price: the waterfall, the net, the list price kept, each size's own price after. */
export interface LinePricePlan {
  readonly steps: WaterfallStep[]
  readonly unitPrice: string
  readonly listUnitPrice: string | null
  readonly adjustmentReason: string | null
  readonly sizesAfter: { size: string; unitPrice: string | null }[]
}

/**
 * B-W2b-302: the waterfall PUT …/price would write for a DRAFT goods line (no write), refused in words as the route refuses it:
 * a fee, a made-to-measure line, a missing price or reason, an inactive reason, no list for a LIST start, no cost for SUGGESTED.
 */
export async function planLinePrice(db: Reader, ctx: PriceContext, version: VersionRow, line: LineRecord, body: PriceLineInput): Promise<LinePricePlan> {
  if (!isGoodsLine(line)) throw new DomainError('conflict', 'A fee is priced on its own: change it with PATCH …/fees/:lineId.', [{ path: 'lineId', message: 'A FEE line has no waterfall.' }])
  if (line.kind !== 'SIZE_GRID') throw new DomainError('conflict', 'Made-to-measure comes later: only a size-grid line is priced here.', [{ path: 'lineId', message: 'Not a size-grid line.' }])

  const startNote = blankToNull(body.startNote)
  const discountNote = blankToNull(body.discount?.note)
  const netNote = blankToNull(body.net?.note)
  if (body.discount && !body.discount.pct) throw new ValidationError('A discount says its percent.', [{ path: 'body/discount/pct', message: 'Send the percent.' }])
  if (body.net && !body.net.unitPrice) throw new ValidationError('A manual net says the net unit price.', [{ path: 'body/net/unitPrice', message: 'Send the net unit price.' }])
  if (body.start === 'MANUAL') {
    if (!body.startPrice) throw new ValidationError('A typed starting price is sent with it.', [{ path: 'body/startPrice', message: 'Send the starting price.' }])
    if (!body.startReasonCode) throw new ValidationError('A typed starting price names its reason (SAL-175).', [{ path: 'body/startReasonCode', message: 'Send the reason code.' }])
  }
  await assertReason(db, body.start === 'MANUAL' ? body.startReasonCode : null, startNote, 'body/start')
  await assertReason(db, body.discount?.reasonCode, discountNote, 'body/discount')
  await assertReason(db, body.net?.reasonCode, netNote, 'body/net')

  const { listed, floor } = ctx
  const fromList = listed.lines.find((row) => row.line.id === line.id)
  const listPrice = fromList?.priced.listPrice ?? null

  let start: Parameters<typeof buildWaterfall>[0]['start']
  if (body.start === 'LIST') {
    if (listPrice === null || !fromList?.entry) throw new DomainError('conflict', "No price list prices this style and colourway on the quote's day: start from the price its cost suggests, or type one with its reason.", [{ path: 'body/start', message: 'No list price.' }])
    start = { kind: 'LIST', unitPrice: listPrice, source: { type: 'PriceListEntry', id: fromList.entry.id }, label: fromList.priced.steps[0]?.label || 'List price' }
  } else if (body.start === 'SUGGESTED') {
    if (line.styleRevisionId === null) throw new DomainError('conflict', 'The style has no revision to cost the line from: no price can be suggested.', [{ path: 'body/start', message: 'No revision.' }])
    const suggested = suggestedPriceOf({ unitCost: line.costAmount === null ? null : decimal(line.unitCost), marginPct: body.marginPct ?? floor.marginFloorPct, currency: version.currency, onBasis: listed.onBasis })
    if ('problem' in suggested) throw new DomainError('conflict', suggested.problem, [{ path: body.marginPct ? 'body/marginPct' : 'body/start', message: suggested.problem }])
    start = { kind: 'SUGGESTED', unitPrice: suggested.unitPrice, source: { type: 'StyleRevision', id: line.styleRevisionId }, label: 'From the cost and the margin to earn' }
  } else {
    start = { kind: 'MANUAL', unitPrice: body.startPrice!, reasonCode: body.startReasonCode!, ...(startNote ? { note: startNote } : {}) }
  }
  const built = buildWaterfall({
    start,
    breakStep: body.start === 'LIST' && fromList ? breakOf(fromList.priced.steps) : null,
    options: body.options === false ? [] : (ctx.options.get(line.id) ?? []),
    discount: body.discount ? { pct: body.discount.pct!, reasonCode: body.discount.reasonCode ?? null } : null,
    net: body.net ? { unitPrice: body.net.unitPrice!, reasonCode: body.net.reasonCode, note: netNote } : null,
    // The list's size surcharges belong to a list price (a price from the cost or typed carries its own).
    sizeCharges: body.start === 'LIST' && fromList ? fromList.priced.sizeSurcharges.map((row) => ({ surchargeId: row.surchargeId, size: row.size, added: row.onBasis })) : [],
    onBasis: listed.onBasis,
    toNet: toNetOf(listed.rate, listed.basis),
    currency: version.currency,
  })
  if (Array.isArray(built)) throw new ValidationError(built.length === 1 ? built[0]!.message : 'The price cannot be built.', built as Issue[])
  // A note on the discount goes on its step.
  const steps = discountNote ? built.steps.map((step) => (step.kind === 'DISCOUNT' ? { ...step, note: discountNote.slice(0, 500) } : step)) : built.steps
  return {
    steps: steps as WaterfallStep[],
    unitPrice: built.unitPrice,
    listUnitPrice: listPrice ?? decimal(line.listUnitPrice),
    adjustmentReason: built.adjustmentReason,
    sizesAfter: line.sizes.map((row) => ({ size: row.size, unitPrice: built.sizePrices[row.size] ?? null })),
  }
}

/**
 * B-W2b-302: a planned price written: ONE update of the line (the price, the list price, the waterfall and the reason
 * together: the database checks the steps add up to the price; a LIST start is the list price), then each size's own price,
 * audited (quotes.priceLine) and emitted. The caller refreshes the version's money once (W1 refreshVersion).
 */
export async function writeLinePrice(tools: CommandTools, current: QuoteRow, version: VersionRow, ctx: PriceContext, line: LineRecord, plan: LinePricePlan, start: StartKind): Promise<void> {
  const { tx } = tools
  const extras = ctx.extras.get(line.id)
  await tx.quoteLine.update({
    where: { id: line.id },
    data: { unitPrice: plan.unitPrice, listUnitPrice: plan.listUnitPrice, priceSteps: plan.steps as unknown as Prisma.InputJsonValue, adjustmentReason: plan.adjustmentReason, version: { increment: 1 } },
    select: { id: true },
  })
  for (const row of plan.sizesAfter) {
    const was = line.sizes.find((entry) => entry.size === row.size)?.unitPrice ?? null
    if ((was === null ? null : stepPrice(was)) === row.unitPrice) continue
    await tx.quoteLineSize.updateMany({ where: { lineId: line.id, size: row.size }, data: { unitPrice: row.unitPrice, version: { increment: 1 } } })
  }
  tools.audit({
    action: 'quotes.priceLine',
    recordType: 'Quote',
    recordId: current.id,
    companyId: current.companyId,
    before: { lineId: line.id, unitPrice: markMoney('price', decimal(line.unitPrice)), listUnitPrice: markMoney('price', decimal(line.listUnitPrice)), priceSteps: markMoney('price', extras?.priceSteps ?? null), adjustmentReason: extras?.adjustmentReason ?? null, sizes: markMoney('price', sizeAudit(line.sizes)) },
    after: { lineId: line.id, start, unitPrice: markMoney('price', plan.unitPrice), listUnitPrice: markMoney('price', plan.listUnitPrice), priceSteps: markMoney('price', plan.steps), adjustmentReason: plan.adjustmentReason, sizes: markMoney('price', plan.sizesAfter) },
  })
  tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'changed', lineId: line.id } })
}

/** PUT /sales/quotes/:quoteId/lines/:lineId/price (quotes.manage): see the module comment. */
export async function priceLine(caller: CommandCaller, quoteId: string, lineId: string, body: PriceLineInput, idempotencyKey?: string): Promise<{ quote: QuoteDetail; line: ReturnType<typeof lineAnswer> }> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  return onQuote(caller, quote, { name: 'quotes.priceLine', idempotencyKey, input: { quoteId, lineId, ...body }, version: body.version }, async (tools, current, version) => {
    const { tx, now } = tools
    assertDraft(version)
    const lines = await readLineRecords(tx, version.id)
    const line = lines.find((entry) => entry.id === lineId)
    if (!line) throw new NotFoundError('Quote line not found.')
    // B-W2b-302: planned, then written (the same two parts goal-seek uses).
    const ctx = await priceContextOf(tx, current, version, [line], now)
    const plan = await planLinePrice(tx, ctx, version, line, body)
    await writeLinePrice(tools, current, version, ctx, line, plan, body.start)
    await refreshVersion(tools, current, version, new Set())
    const label = await priceReasonLabels(tx)
    return { ...(await detailInCommand(tools, current.id)), line: lineAnswer(line.id, plan.unitPrice, plan.listUnitPrice, plan.steps, plan.adjustmentReason, version.currency, label) }
  })
}

function lineAnswer(lineId: string, unitPrice: string, listUnitPrice: string | null, steps: WaterfallStep[], adjustmentReason: string | null, currency: string, label: (code: string) => string | null) {
  const view = waterfallView(steps, unitPrice, listUnitPrice, currency, label)
  return { lineId, unitPrice: asMoney('price', unitPrice), listUnitPrice: asMoney('price', listUnitPrice), adjustmentReason, steps: view.steps, why: view.why }
}
