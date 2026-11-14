import type { Prisma } from '@nexus/factory-db'
import { DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import type { CheckLineView, LineConfiguratorView, SaveOrderOptionsBody, SaveQuoteOptionsBody } from '@nexus/factory-domain/sales/configurator/contracts'
import {
  frozenSurcharges,
  marginPctOf,
  netOfBasis,
  optionsPriced,
  optionSourceIds,
  orderChangeHeld,
  orderOptionsRefusal,
  orderSurcharges,
  picksProblems,
  surchargeChange,
  surchargeTotal,
  manualChangeOf,
  type Frozen,
  type LinePick,
  type RepriceHeld,
} from '@nexus/factory-domain/sales/configurator/rules'
import type { ChosenValue } from '@nexus/factory-domain/product/options/rules'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { priceBasisOf } from '@nexus/factory-domain/sales/quotes/quotes'
import type { WaterfallStep } from '@nexus/factory-domain/sales/price-waterfall/rules'
import { can } from '@nexus/factory-domain/core/permissions'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { checkStyleOptions } from '../../product/options/check'
import { valueNames } from '../../product/options/store'
import { priceContextOf, storedSteps, writeLinePrice, type PriceContext } from '../price-waterfall/quote-price'
import { refreshVersion } from '../quotes/pricing'
import { assertDraft, detailInCommand, onQuote } from '../quotes/quotes'
import { decimal, officeContextOf, officeQuote, readCurrentVersion, readLineRecords, readQuote, type LineRecord, type QuoteRow, type Reader, type VersionRow } from '../quotes/store'
import { officeOrder } from '../orders/moves'
import { lockOrder, type OrderRow } from '../orders/store'
import { artworkOf } from './artwork'
import { baseOf, chargesOf, listPriceOf, plannedPrice, restartOf, storedOf, type Restart } from './reprice'
import { styleConfiguratorOf, valuePrices } from './style'
// B-W2b-374: what a group takes; who may show an order line's artwork in the portal.
import { assertPicksTake } from '../../product/options/takes'
import { mayShareArtwork } from '../portal-ordering/artwork'

/**
 * The configurator on a quote or order line (B-W2b-340; SAL-133, SAL-136, SAL-139, SAL-140; CF1:01-03; design
 * pop:quotes.lineDrawer, the order's Lines). Office only.
 *
 *   GET  /sales/quotes/:quoteId/lines/:lineId/configurator          quotes.view   the line's configurator (below)
 *   POST /sales/quotes/:quoteId/lines/:lineId/configurator/check    quotes.view   a choice checked, its surcharges and the
 *                                                                                 price it would make (no write)
 *   PUT  /sales/quotes/:quoteId/lines/:lineId/options               quotes.manage the choice written: checked by B-W2b-229's
 *                                                                                 checkStyleOptions in the command (a refused
 *                                                                                 combination answers in the rule's words), each
 *                                                                                 value's surcharge frozen, the line priced
 *                                                                                 again through B-W2b-330's waterfall
 *   GET / POST …check / PUT …options of /sales/orders/:orderId/lines/:lineId   orders.view | orders.manage   the same on an order
 *                                                                                 line: copied from its quote line; changed while
 *                                                                                 the order is open and no work order makes the
 *                                                                                 line; the accepted price kept (a change of what
 *                                                                                 the options add is held until `keepPrice`)
 *
 * The configurator: the style's groups, values with their surcharges and rules, the panel colours and leathers
 * (./style.ts), the line's chosen values (QuoteLineOption / SalesOrderLineOption: the value, its text, by default, a colour
 * or a material and its colour, the frozen surcharge), THE check of the choice now, whether the price holds the options,
 * the line's prices, cost and margin by grain, the main picture of its colourway and its artwork (./artwork.ts).
 */

const ORDER_CLOSED = new Set(['CANCELLED', 'CLOSED'])

/** An option row of a line, as the configurator reads it. */
interface OptionRow {
  readonly id: string
  readonly groupId: string
  readonly valueId: string
  readonly freeText: string | null
  readonly byDefault: boolean
  readonly colourId: string | null
  readonly itemId: string | null
  readonly itemColourId: string | null
  readonly surchargeAmount: string | null
  readonly surchargePct: string | null
}

const OPTION_COLUMNS = { id: true, groupId: true, valueId: true, freeText: true, byDefault: true, colourId: true, itemId: true, itemColourId: true, surchargeAmount: true, surchargePct: true } as const

const rowOf = (row: { id: string; groupId: string; valueId: string; freeText: string | null; byDefault: boolean; colourId: string | null; itemId: string | null; itemColourId: string | null; surchargeAmount: Prisma.Decimal | null; surchargePct: Prisma.Decimal | null }): OptionRow => ({
  ...row,
  surchargeAmount: decimal(row.surchargeAmount),
  surchargePct: row.surchargePct === null ? null : decimalText(row.surchargePct.toString()),
})

async function quoteOptions(db: Reader, lineId: string): Promise<OptionRow[]> {
  return (await db.quoteLineOption.findMany({ where: { lineId }, select: OPTION_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(rowOf)
}

async function orderOptions(db: Reader, lineId: string): Promise<OptionRow[]> {
  return (await db.salesOrderLineOption.findMany({ where: { lineId }, select: OPTION_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(rowOf)
}

const picksOfRows = (rows: readonly OptionRow[]) => rows.map((row) => ({ valueId: row.valueId, text: row.freeText }))

const chosenOfRows = (rows: readonly OptionRow[]) =>
  rows.map((row) => ({ id: row.id, groupId: row.groupId, valueId: row.valueId, text: row.freeText, byDefault: row.byDefault, colourId: row.colourId, itemId: row.itemId, itemColourId: row.itemColourId, surchargeAmount: asMoney('price', row.surchargeAmount), surchargePct: asMoney('price', row.surchargePct) }))

const checkPartOf = (check: Awaited<ReturnType<typeof checkStyleOptions>>) => ({
  ok: check.check.ok,
  blocks: check.check.blocks.map((finding) => ({ ...finding, message: { ...finding.message } })),
  warnings: check.check.warnings.map((finding) => ({ ...finding, message: { ...finding.message } })),
  outsideCertificate: check.summary.outsideCertificate,
  certificateNotes: check.summary.certificateNotes.map((entry) => ({ ...entry })),
})

/** The option rows a waterfall's OPTION steps name (any version or order: a reading), by id. */
async function stepSources(db: Reader, steps: readonly WaterfallStep[] | null): Promise<Map<string, { valueId: string; amount: string | null }>> {
  const ids = optionSourceIds(steps).filter(isUuid)
  if (ids.length === 0) return new Map()
  const quoteRows = await db.quoteLineOption.findMany({ where: { id: { in: ids } }, select: { id: true, valueId: true, surchargeAmount: true } })
  const orderRows = await db.salesOrderLineOption.findMany({ where: { id: { in: ids } }, select: { id: true, valueId: true, surchargeAmount: true } })
  return new Map([...quoteRows, ...orderRows].map((row) => [row.id, { valueId: row.valueId, amount: row.surchargeAmount === null ? null : decimal(row.surchargeAmount) }]))
}

/** The library colour, material and its colour a choice names: active, of the line's company or every company (B-W2b-374: also a typed order line's, at `at`). */
export async function extrasProblems(db: Reader, companyId: string, picks: readonly LinePick[], at = 'body/picks'): Promise<Issue[]> {
  const issues: Issue[] = []
  for (const [index, pick] of picks.entries()) {
    if (pick.colourId) {
      const colour = await db.colour.findUnique({ where: { id: pick.colourId }, select: { status: true, companyId: true } })
      if (!colour || colour.status !== 'ACTIVE' || (colour.companyId !== null && colour.companyId !== companyId)) issues.push({ path: `${at}/${index}/colourId`, message: 'Not an active colour of the library for this company.' })
    }
    if (pick.itemId) {
      const item = await db.item.findUnique({ where: { id: pick.itemId }, select: { status: true, companyId: true } })
      if (!item || item.status !== 'ACTIVE' || (item.companyId !== null && item.companyId !== companyId)) issues.push({ path: `${at}/${index}/itemId`, message: 'Not an active material for this company.' })
      else if (pick.itemColourId) {
        const colour = await db.itemColour.findFirst({ where: { id: pick.itemColourId, itemId: pick.itemId }, select: { status: true } })
        if (!colour || colour.status !== 'ACTIVE') issues.push({ path: `${at}/${index}/itemColourId`, message: 'Not an active colour of this material.' })
      }
    }
  }
  return issues
}

async function assertExtras(db: Reader, companyId: string, picks: readonly LinePick[]): Promise<void> {
  const issues = await extrasProblems(db, companyId, picks)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
}

/** A refused combination, in the rule's words (CF1:01). */
function refusedIn(check: Awaited<ReturnType<typeof checkStyleOptions>>): DomainError {
  const blocks = check.check.blocks
  return new DomainError('conflict', blocks[0]!.message.en, blocks.map((finding) => ({ path: `body/${finding.path}`, message: finding.message.en })))
}

function invalidPicks(picks: readonly LinePick[]): void {
  const issues = picksProblems(picks)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
}

/** What the chosen values would be written as: the check's values, each with its pick's colour or material and its surcharge (B-W2b-374: also a typed order line's). */
export function rowsToWrite(chosen: readonly ChosenValue[], picks: readonly LinePick[], surcharges: ReadonlyMap<string, Frozen>) {
  return chosen.map((entry) => {
    const pick = picks.find((candidate) => candidate.valueId === entry.valueId)
    const frozen = surcharges.get(entry.valueId) ?? { amount: null, pct: null }
    return {
      groupId: entry.groupId,
      valueId: entry.valueId,
      freeText: entry.text,
      byDefault: entry.byDefault,
      colourId: pick?.colourId ?? null,
      itemId: pick?.itemId ?? null,
      itemColourId: pick?.itemId ? (pick.itemColourId ?? null) : null,
      surchargeAmount: frozen.amount,
      surchargePct: frozen.pct,
    }
  })
}

async function valueNameMap(db: Reader, valueIds: readonly string[]): Promise<Map<string, string>> {
  return new Map([...(await valueNames(db, valueIds)).entries()].map(([id, facts]) => [id, facts.name]))
}

const audited = (rows: readonly { valueId: string; freeText: string | null; byDefault: boolean; colourId: string | null; itemId: string | null; itemColourId: string | null; surchargeAmount: string | null; surchargePct: string | null }[]) =>
  rows.map((row) => ({ valueId: row.valueId, freeText: row.freeText, byDefault: row.byDefault, colourId: row.colourId, itemId: row.itemId, itemColourId: row.itemColourId, surcharge: markMoney('price', { amount: row.surchargeAmount, pct: row.surchargePct }) }))

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

// ---- the quote line -----------------------------------------------------------------------------------------------------

async function quoteLineOf(db: Reader, version: VersionRow, lineId: string): Promise<LineRecord> {
  const line = isUuid(lineId) ? (await readLineRecords(db, version.id)).find((entry) => entry.id === lineId) : undefined
  if (!line) throw new NotFoundError('Quote line not found.')
  return line
}

const basisOf = (version: VersionRow): 'NET' | 'GROSS' => priceBasisOf(version.taxMode)
const rateOf = (line: Pick<LineRecord, 'vatRatePct'>): string | null => (line.vatRatePct === null ? null : line.vatRatePct.toString())

/** Why the person may not change a quote line's options now, in words (null: they may). */
function quoteHeld(context: OfficeContext, quote: QuoteRow, version: VersionRow, line: LineRecord) {
  if (!can(actorOf(context), QUOTES_MANAGE, { companyId: quote.companyId, partyId: quote.partyId })) return { it: 'Le opzioni si leggono: cambiarle spetta a chi gestisce i preventivi.', en: 'You may read the options: changing them is for people who manage quotes.' }
  if (version.status !== 'DRAFT') return { it: 'Il preventivo non è una bozza: le opzioni cambiano solo in bozza (fai una nuova versione).', en: 'The quote is not a draft: options change only while it is a draft (make a new version).' }
  if (line.kind === 'FEE') return { it: 'Una spesa non ha opzioni.', en: 'A fee takes no options.' }
  return null
}

async function quoteLineView(db: Reader, context: OfficeContext, quote: QuoteRow, version: VersionRow, line: LineRecord, ctx: PriceContext): Promise<LineConfiguratorView> {
  const style = await db.style.findUniqueOrThrow({ where: { id: line.styleId }, select: { id: true, code: true, name: true, companyId: true, status: true } })
  const colourway = await db.colourway.findUniqueOrThrow({ where: { id: line.colourwayId }, select: { id: true, code: true, name: true } })
  const configurator = await styleConfiguratorOf(db, style, colourway, quote.companyId)
  const rows = await quoteOptions(db, line.id)
  const check = await checkStyleOptions(db, line.styleId, picksOfRows(rows), { useDefaults: rows.length === 0 })
  const steps = storedOf(ctx, line.id)
  const restart = restartOf(line, steps, listPriceOf(ctx, line.id))
  const held = quoteHeld(context, quote, version, line)
  const basis = basisOf(version)
  const unitPrice = decimal(line.unitPrice) ?? '0'
  return {
    document: { kind: 'QUOTE', id: quote.id, number: quote.number, version: quote.version, status: version.status, revision: version.revision, currency: version.currency, priceBasis: basis },
    line: {
      id: line.id,
      seq: line.seq,
      kind: line.kind,
      quantity: line.quantity,
      unitPrice: asMoney('price', unitPrice),
      listUnitPrice: asMoney('price', decimal(line.listUnitPrice)),
      unitCost: asMoney('cost', decimal(line.unitCost)),
      marginPct: asMoney('margin', marginPctOf(netOfBasis(unitPrice, basis, rateOf(line)), decimal(line.unitCost))),
      optionsTotal: asMoney('price', surchargeTotal(rows.map((row) => ({ amount: row.surchargeAmount })))),
    },
    ...configurator,
    // A line nothing was chosen on yet shows what it would take (the style's defaults), not written.
    chosen: rows.length > 0 ? chosenOfRows(rows) : check.check.chosen.map((entry) => ({ id: null, groupId: entry.groupId, valueId: entry.valueId, text: entry.text, byDefault: entry.byDefault, colourId: null, itemId: null, itemColourId: null, surchargeAmount: asMoney('price', null), surchargePct: asMoney('price', null) })),
    check: checkPartOf(check),
    pricing: {
      holdsOptions: optionsPriced(steps, await stepSources(db, steps), rows.map((row) => ({ valueId: row.valueId, amount: row.surchargeAmount }))),
      held: restart.kind === 'HELD' ? restart.held : null,
      manualKept: manualChangeOf(steps) !== null,
    },
    artwork: await artworkOf(db, { kind: 'QUOTE', quoteId: quote.id, line: { id: line.id, seq: line.seq, styleId: line.styleId } }),
    // B-W2b-374: a quote line's artwork is shown in the portal from the order line (share: false here).
    may: { configure: held === null, held, artwork: held === null && can(actorOf(context), FILES_UPLOAD, { companyId: quote.companyId }), share: false },
  }
}

/** GET /sales/quotes/:quoteId/lines/:lineId/configurator (quotes.view). */
export async function quoteLineConfigurator(caller: CommandCaller, quoteId: string, lineId: string): Promise<LineConfiguratorView> {
  const quote = await officeQuote(caller, quoteId)
  const context = officeContextOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const version = await readCurrentVersion(db, quote)
    const line = await quoteLineOf(db, version, lineId)
    return quoteLineView(db, context, quote, version, line, await priceContextOf(db, quote, version, [line], now))
  })
}

/** The surcharges a choice freezes on a quote line, and the restart it is priced from. */
async function quoteSurcharges(db: Reader, version: VersionRow, line: LineRecord, ctx: PriceContext, chosen: readonly ChosenValue[]) {
  const restart: Restart = restartOf(line, storedOf(ctx, line.id), listPriceOf(ctx, line.id))
  const base = baseOf(restart, line, listPriceOf(ctx, line.id), basisOf(version), rateOf(line))
  const prices = await valuePrices(db, chosen.map((entry) => entry.valueId))
  return { restart, frozen: frozenSurcharges(chosen.map((entry) => entry.valueId), prices, base, version.currency) }
}

/** POST /sales/quotes/:quoteId/lines/:lineId/configurator/check (quotes.view): see the file's head. */
export async function checkQuoteLine(caller: CommandCaller, quoteId: string, lineId: string, body: { readonly picks: readonly LinePick[] }): Promise<CheckLineView> {
  invalidPicks(body.picks)
  const quote = await officeQuote(caller, quoteId)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const version = await readCurrentVersion(db, quote)
    const line = await quoteLineOf(db, version, lineId)
    const check = await checkStyleOptions(db, line.styleId, body.picks, { useDefaults: true })
    const ctx = await priceContextOf(db, quote, version, [line], now)
    const basis = basisOf(version)
    const before = decimal(line.unitPrice) ?? '0'
    const marginBefore = marginPctOf(netOfBasis(before, basis, rateOf(line)), decimal(line.unitCost))
    const { restart, frozen } = await quoteSurcharges(db, version, line, ctx, check.check.chosen)
    const surcharges = frozen.ok ? frozen.rows : new Map<string, Frozen>()
    const rows = rowsToWrite(check.check.chosen, body.picks, surcharges)
    const names = await valueNameMap(db, rows.map((row) => row.valueId))
    const preview = rows.map((row) => ({ ...row, id: newId() }))
    let pricing: CheckLineView['pricing'] = { repriced: false, held: restart.kind === 'HELD' ? restart.held : null, manualKept: false, unitPrice: asMoney('price', before), before: asMoney('price', before), optionsTotal: asMoney('price', surchargeTotal(rows.map((row) => ({ amount: row.surchargeAmount })))), change: asMoney('price', null), steps: asMoney('price', null), marginPct: asMoney('margin', marginBefore), marginBefore: asMoney('margin', marginBefore) }
    if (frozen.ok && check.check.ok) {
      const planned = await plannedPrice(db, ctx, version, line, restart, chargesOf(preview.map((row) => ({ id: row.id, name: names.get(row.valueId) ?? 'Option', text: row.freeText, amount: row.surchargeAmount, pct: row.surchargePct }))))
      if ('plan' in planned) {
        pricing = {
          ...pricing,
          repriced: true,
          manualKept: manualChangeOf(planned.plan.steps) !== null,
          unitPrice: asMoney('price', planned.plan.unitPrice),
          steps: asMoney('price', planned.plan.steps.map((step) => ({ ...step }) as Record<string, unknown>)),
          marginPct: asMoney('margin', marginPctOf(netOfBasis(planned.plan.unitPrice, basis, rateOf(line)), decimal(line.unitCost))),
        }
      }
    }
    return {
      ...checkPartOf(check),
      chosen: rows.map((row) => ({ id: null, groupId: row.groupId, valueId: row.valueId, text: row.freeText, byDefault: row.byDefault, colourId: row.colourId, itemId: row.itemId, itemColourId: row.itemColourId, surchargeAmount: asMoney('price', row.surchargeAmount), surchargePct: asMoney('price', row.surchargePct) })),
      pricing,
      problem: frozen.ok ? null : { ...frozen.message },
    }
  })
}

/**
 * A choice written on a DRAFT quote line inside a command (B-W2b-340's save; B-W2b-374: also the copies of a duplicate and
 * the options of a pasted line): checked (the rules in their words, the colours and materials active, what each group takes),
 * each value's surcharge frozen, the rows replaced, the line priced again through B-W2b-330's waterfall. Every refusal is
 * thrown BEFORE the first write (a caller may leave a line's options out in words and go on in the same transaction). The
 * caller refreshes the version's money.
 */
export async function applyQuoteLinePicks(
  tools: CommandTools,
  current: QuoteRow,
  version: VersionRow,
  line: LineRecord,
  picks: readonly LinePick[],
  at = 'body/picks',
  /** B-W2b-374: a copy's source surcharges, kept when the line is not priced again (its price kept as sold holds them). */
  kept?: readonly { readonly valueId: string; readonly amount: string | null; readonly pct: string | null }[],
) {
  const { tx, now } = tools
  invalidPicks(picks)
  if (line.kind === 'FEE') throw new InvalidStateError('A fee takes no options.')
  const check = await checkStyleOptions(tx, line.styleId, picks, { useDefaults: true })
  if (!check.check.ok) throw refusedIn(check)
  await assertExtras(tx, current.companyId, picks)
  // B-W2b-374 (XF3:05): a colour or material its group does not take is refused in words (409), before the database would.
  await assertPicksTake(tx, picks, at)
  const ctx = await priceContextOf(tx, current, version, [line], now)
  const { restart, frozen } = await quoteSurcharges(tx, version, line, ctx, check.check.chosen)
  if (!frozen.ok) throw new DomainError('conflict', frozen.message.en, [{ path: at, message: frozen.message.en }])
  const before = await quoteOptions(tx, line.id)
  const surcharges = kept && restart.kind === 'HELD' ? orderSurcharges(kept, frozen.rows) : frozen.rows
  const rows = rowsToWrite(check.check.chosen, picks, surcharges)
  const actorId = actorIdOf(tools)
  await tx.quoteLineOption.deleteMany({ where: { lineId: line.id } })
  if (rows.length > 0) await tx.quoteLineOption.createMany({ data: rows.map((row) => ({ id: newId(), lineId: line.id, partyId: version.partyId, ...row, createdById: actorId })) })
  // The price again, through the waterfall (B-W2b-330), with the options as written.
  let repriced: { held: RepriceHeld | null } = { held: restart.kind === 'HELD' ? restart.held : null }
  if (restart.kind !== 'HELD') {
    const fresh = await priceContextOf(tx, current, version, [line], now)
    const written = await quoteOptions(tx, line.id)
    const names = await valueNameMap(tx, written.map((row) => row.valueId))
    const planned = await plannedPrice(tx, fresh, version, line, restart, chargesOf(written.map((row) => ({ id: row.id, name: names.get(row.valueId) ?? 'Option', text: row.freeText, amount: row.surchargeAmount, pct: row.surchargePct }))))
    if ('plan' in planned) {
      await writeLinePrice(tools, current, version, fresh, line, planned.plan, planned.start)
      repriced = { held: null }
    } else repriced = { held: planned.held }
  }
  return { before, rows, check, repriced }
}

/** PUT /sales/quotes/:quoteId/lines/:lineId/options (quotes.manage): see the file's head. */
export async function saveQuoteOptions(caller: CommandCaller, quoteId: string, lineId: string, body: SaveQuoteOptionsBody, idempotencyKey?: string) {
  invalidPicks(body.picks)
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  const context = officeContextOf(caller)
  return onQuote(caller, quote, { name: 'quotes.configureLine', idempotencyKey, input: { quoteId, lineId, ...body }, version: body.version }, async (tools, current, version) => {
    const { tx, now } = tools
    assertDraft(version)
    const line = await quoteLineOf(tx, version, lineId)
    const { before, rows, check, repriced } = await applyQuoteLinePicks(tools, current, version, line, body.picks)
    // B-W2b-423 (KS4:01): the line costed again, its options' own cost with it.
    await refreshVersion(tools, current, version, new Set([line.id]))
    tools.audit({
      action: 'quotes.configureLine',
      recordType: 'Quote',
      recordId: current.id,
      companyId: current.companyId,
      before: { lineId: line.id, options: audited(before) },
      after: { lineId: line.id, options: audited(rows), warnings: check.check.warnings.map((finding) => finding.message.en), outsideCertificate: check.summary.outsideCertificate, newWaterfall: repriced.held === null, held: repriced.held },
    })
    tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'changed', lineId: line.id } })
    const detail = await detailInCommand(tools, current.id)
    const row = (await readQuote(tx, current.id))!
    const fresh = await readCurrentVersion(tx, row)
    const lineNow = await quoteLineOf(tx, fresh, line.id)
    return { ...detail, line: await quoteLineView(tx, context, row, fresh, lineNow, await priceContextOf(tx, row, fresh, [lineNow], now)) }
  })
}

// ---- the order line -------------------------------------------------------------------------------------------------------

const ORDER_LINE_COLUMNS = { id: true, orderId: true, partyId: true, seq: true, kind: true, quantity: true, styleId: true, colourwayId: true, unitPrice: true, unitCost: true, vatRatePct: true, priceSteps: true, quoteLineId: true } as const

async function orderLineOf(db: Reader, orderId: string, lineId: string) {
  const line = isUuid(lineId) ? await db.salesOrderLine.findFirst({ where: { id: lineId, orderId }, select: ORDER_LINE_COLUMNS }) : null
  if (!line) throw new NotFoundError('Order line not found.')
  return line
}
type OrderLine = Awaited<ReturnType<typeof orderLineOf>>

async function workOrderCells(db: Reader, lineId: string): Promise<number> {
  return db.workOrderSize.count({ where: { salesOrderLineId: lineId, workOrder: { status: { not: 'CANCELLED' } } } })
}

/** Why the person may not change an order line's options now, in words (null: they may). */
function orderHeld(context: OfficeContext, order: Pick<OrderRow, 'companyId' | 'partyId' | 'status'>, line: OrderLine, cells: number) {
  if (!can(actorOf(context), ORDERS_MANAGE, { companyId: order.companyId, partyId: order.partyId })) return { it: 'Le opzioni si leggono: cambiarle spetta a chi gestisce gli ordini.', en: 'You may read the options: changing them is for people who manage orders.' }
  if (line.kind === 'FEE') return { it: 'Una spesa non ha opzioni.', en: 'A fee takes no options.' }
  return orderOptionsRefusal(order.status, cells)
}

/** The figure a new value's percent is taken of on an order line: its waterfall's start, else its price less its options. */
function orderBase(line: OrderLine, rows: readonly OptionRow[], basis: 'NET' | 'GROSS'): string {
  const steps = storedSteps(line.priceSteps)
  const rate = line.vatRatePct === null ? null : line.vatRatePct.toString()
  if (steps && steps[0]?.unitPrice !== undefined) return netOfBasis(steps[0].unitPrice, basis, rate)
  const net = netOfBasis(decimal(line.unitPrice) ?? '0', basis, rate)
  return surchargeChange(rows.map((row) => ({ amount: row.surchargeAmount })), [{ amount: net }])
}

async function orderLineView(db: Reader, context: OfficeContext, order: OrderRow, line: OrderLine): Promise<LineConfiguratorView> {
  const style = await db.style.findUniqueOrThrow({ where: { id: line.styleId }, select: { id: true, code: true, name: true, companyId: true, status: true } })
  const colourway = await db.colourway.findUniqueOrThrow({ where: { id: line.colourwayId }, select: { id: true, code: true, name: true } })
  const configurator = await styleConfiguratorOf(db, style, colourway, order.companyId)
  const rows = await orderOptions(db, line.id)
  const check = await checkStyleOptions(db, line.styleId, picksOfRows(rows), { useDefaults: rows.length === 0 })
  const steps = storedSteps(line.priceSteps)
  const cells = await workOrderCells(db, line.id)
  const held = orderHeld(context, order, line, cells)
  const basis = priceBasisOf(order.taxMode)
  const unitPrice = decimal(line.unitPrice) ?? '0'
  const rate = line.vatRatePct === null ? null : line.vatRatePct.toString()
  return {
    document: { kind: 'ORDER', id: order.id, number: order.number, version: order.version, status: order.status, revision: null, currency: order.currency, priceBasis: basis },
    line: {
      id: line.id,
      seq: line.seq,
      kind: line.kind,
      quantity: line.quantity,
      unitPrice: asMoney('price', unitPrice),
      listUnitPrice: asMoney('price', null),
      unitCost: asMoney('cost', decimal(line.unitCost)),
      marginPct: asMoney('margin', marginPctOf(netOfBasis(unitPrice, basis, rate), decimal(line.unitCost))),
      optionsTotal: asMoney('price', surchargeTotal(rows.map((row) => ({ amount: row.surchargeAmount })))),
    },
    ...configurator,
    chosen: rows.length > 0 ? chosenOfRows(rows) : check.check.chosen.map((entry) => ({ id: null, groupId: entry.groupId, valueId: entry.valueId, text: entry.text, byDefault: entry.byDefault, colourId: null, itemId: null, itemColourId: null, surchargeAmount: asMoney('price', null), surchargePct: asMoney('price', null) })),
    check: checkPartOf(check),
    // An order keeps the price it was accepted at: never priced again here.
    pricing: { holdsOptions: optionsPriced(steps, await stepSources(db, steps), rows.map((row) => ({ valueId: row.valueId, amount: row.surchargeAmount }))), held: null, manualKept: manualChangeOf(steps) !== null },
    artwork: await artworkOf(db, { kind: 'ORDER', line: { id: line.id, quoteLineId: line.quoteLineId } }),
    may: {
      configure: held === null,
      held,
      artwork: !ORDER_CLOSED.has(order.status) && can(actorOf(context), ORDERS_MANAGE, { companyId: order.companyId, partyId: order.partyId }) && can(actorOf(context), FILES_UPLOAD, { companyId: order.companyId }),
      // B-W2b-374 (XF3:04)
      share: mayShareArtwork(context, order),
    },
  }
}

/** GET /sales/orders/:orderId/lines/:lineId/configurator (orders.view). */
export async function orderLineConfigurator(caller: CommandCaller, orderId: string, lineId: string): Promise<LineConfiguratorView> {
  const order = await officeOrder(caller, orderId)
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => orderLineView(db, context, order, await orderLineOf(db, order.id, lineId)))
}

/** The surcharges a choice freezes on an order line (a value it had keeps its own) and what they add more than before. */
async function orderSurchargesOf(db: Reader, order: Pick<OrderRow, 'currency' | 'taxMode'>, line: OrderLine, current: readonly OptionRow[], chosen: readonly ChosenValue[]) {
  const prices = await valuePrices(db, chosen.map((entry) => entry.valueId))
  const fresh = frozenSurcharges(chosen.map((entry) => entry.valueId), prices, orderBase(line, current, priceBasisOf(order.taxMode)), order.currency)
  if (!fresh.ok) return fresh
  const merged = orderSurcharges(current.map((row) => ({ valueId: row.valueId, amount: row.surchargeAmount, pct: row.surchargePct })), fresh.rows)
  return { ok: true as const, rows: merged, change: surchargeChange(current.map((row) => ({ amount: row.surchargeAmount })), merged.values()) }
}

/** POST /sales/orders/:orderId/lines/:lineId/configurator/check (orders.view). */
export async function checkOrderLine(caller: CommandCaller, orderId: string, lineId: string, body: { readonly picks: readonly LinePick[] }): Promise<CheckLineView> {
  invalidPicks(body.picks)
  const order = await officeOrder(caller, orderId)
  return caller.withClient(async (db) => {
    const line = await orderLineOf(db, order.id, lineId)
    const check = await checkStyleOptions(db, line.styleId, body.picks, { useDefaults: true })
    const current = await orderOptions(db, line.id)
    const surcharges = await orderSurchargesOf(db, order, line, current, check.check.chosen)
    const rows = rowsToWrite(check.check.chosen, body.picks, surcharges.ok ? surcharges.rows : new Map())
    const basis = priceBasisOf(order.taxMode)
    const unitPrice = decimal(line.unitPrice) ?? '0'
    const rate = line.vatRatePct === null ? null : line.vatRatePct.toString()
    const margin = marginPctOf(netOfBasis(unitPrice, basis, rate), decimal(line.unitCost))
    return {
      ...checkPartOf(check),
      chosen: rows.map((row) => ({ id: null, groupId: row.groupId, valueId: row.valueId, text: row.freeText, byDefault: row.byDefault, colourId: row.colourId, itemId: row.itemId, itemColourId: row.itemColourId, surchargeAmount: asMoney('price', row.surchargeAmount), surchargePct: asMoney('price', row.surchargePct) })),
      pricing: {
        repriced: false,
        held: null,
        manualKept: false,
        unitPrice: asMoney('price', unitPrice),
        before: asMoney('price', unitPrice),
        optionsTotal: asMoney('price', surchargeTotal(rows.map((row) => ({ amount: row.surchargeAmount })))),
        change: asMoney('price', surcharges.ok ? surcharges.change : null),
        steps: asMoney('price', null),
        marginPct: asMoney('margin', margin),
        marginBefore: asMoney('margin', margin),
      },
      problem: surcharges.ok ? null : { ...surcharges.message },
    }
  })
}

/** PUT /sales/orders/:orderId/lines/:lineId/options (orders.manage): see the file's head. */
export async function saveOrderOptions(caller: CommandCaller, orderId: string, lineId: string, body: SaveOrderOptionsBody, idempotencyKey?: string) {
  invalidPicks(body.picks)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const context = officeContextOf(caller)
  const { result } = await command(caller, { name: 'orders.configureLine', idempotencyKey, input: { orderId, lineId, ...body } }, async (tools) => {
    const { tx } = tools
    const locked = await lockOrder(tx, order.id, body.version)
    const line = await orderLineOf(tx, order.id, lineId)
    if (line.kind === 'FEE') throw new InvalidStateError('A fee takes no options.')
    const refusal = orderOptionsRefusal(locked.status, await workOrderCells(tx, line.id))
    if (refusal) throw new InvalidStateError(refusal.en)
    const check = await checkStyleOptions(tx, line.styleId, body.picks, { useDefaults: true })
    if (!check.check.ok) throw refusedIn(check)
    await assertExtras(tx, order.companyId, body.picks)
    // B-W2b-374 (XF3:05)
    await assertPicksTake(tx, body.picks)
    const current = await orderOptions(tx, line.id)
    const surcharges = await orderSurchargesOf(tx, order, line, current, check.check.chosen)
    if (!surcharges.ok) throw new DomainError('conflict', surcharges.message.en, [{ path: 'body/picks', message: surcharges.message.en }])
    if (orderChangeHeld(surcharges.change, body.keepPrice === true)) {
      const words = `These options change what the options add by ${surcharges.change} a piece over what was accepted: keep the accepted price, or amend the order so the customer accepts the new one.`
      throw new DomainError('conflict', words, [{ path: 'body/keepPrice', message: words }])
    }
    const rows = rowsToWrite(check.check.chosen, body.picks, surcharges.rows)
    const actorId = actorIdOf(tools)
    await tx.salesOrderLineOption.deleteMany({ where: { lineId: line.id } })
    if (rows.length > 0) await tx.salesOrderLineOption.createMany({ data: rows.map((row) => ({ id: newId(), lineId: line.id, partyId: line.partyId, ...row, createdById: actorId })) })
    await tx.salesOrder.update({ where: { id: order.id }, data: { version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      action: 'orders.configureLine',
      recordType: 'SalesOrder',
      recordId: order.id,
      companyId: order.companyId,
      before: { lineId: line.id, options: audited(current) },
      after: { lineId: line.id, options: audited(rows), change: markMoney('price', surcharges.change), surchargeGiven: body.keepPrice === true && surcharges.change !== '0', warnings: check.check.warnings.map((finding) => finding.message.en) },
    })
    tools.emit({ type: 'sales_order.options_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, lineIds: [line.id], change: 'CHOSEN' } })
    const fresh = (await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { version: true, status: true } }))
    return { line: await orderLineView(tx, context, { ...order, version: fresh.version, status: fresh.status }, await orderLineOf(tx, order.id, line.id)) }
  })
  return result
}
