import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { fromMinorUnits, toMinorUnits, type MinorUnits } from '@nexus/factory-domain/core/money'
import type { Grain } from '@nexus/factory-domain/auth/grains/grains'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { suggestedPriceOf, type WaterfallStep } from '@nexus/factory-domain/sales/price-waterfall/rules'
import { discountNeeded, GOAL_KIND_WORDS, goalProblems, restartOf, scaledPrice, TARGET_PRICE_REASON, totalFactor, type GoalTarget } from '@nexus/factory-domain/sales/quote-goalseek/rules'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { priceBasisOf, priceVersion, type MoneyLine, type PricedVersion } from '@nexus/factory-domain/sales/quotes/quotes'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { taxable } from '@nexus/factory-domain/tax/vat-treatment'
import { StaleVersionError, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { withPersonFloor } from '../price-waterfall/floors'
import { planLinePrice, priceContextOf, storedSteps, writeLinePrice, type LinePricePlan, type PriceContext, type PriceLineInput } from '../price-waterfall/quote-price'
import { refreshVersion } from '../quotes/pricing'
import { assertDraft, detailInCommand, onQuote } from '../quotes/quotes'
import { quoteRulesFor } from '../quotes/rules'
import { decimal, grainsOf, moneyLineOf, officeContextOf, officeQuote, readCurrentVersion, readLineRecords, readQuote, treatmentOfStored, type LineRecord, type QuoteRow, type Reader, type VersionRow } from '../quotes/store'

/**
 * Target price goal-seek (B-W2b-302; SAL-150; design sales.quotes quote.price.goalseek): POST /sales/quotes/:quoteId/goal-seek
 * (quotes.manage over the quote's company and customer). With `preview: true` it answers what each chosen line would sell at
 * — the waterfall B-W2b-330's PUT …/price would write (the line's start and discount kept, a MANUAL step to the target with the
 * reason TARGET_PRICE), the discount needed off the start, the margin before → after and against the floor, the quote's totals
 * before → after, whether an approval is then needed — and writes nothing. Without `preview` the same plan is written in ONE
 * command through 330's writer (each line: the price, the list price, the waterfall and the reason in one update, then the
 * sizes' own prices), all or none, then the version's money (W1 refreshVersion). A price under the line's cost is held (409 in
 * words): goal-seek never writes it — an approver must allow a price under cost, so the person prices the line by hand (Price &
 * margin) and the quote's margin rule asks for the yes. A target MARGIN needs the cost grain (a price from a margin shows the
 * cost): refused in words without it.
 */

export interface GoalSeekInput {
  readonly version: number
  readonly lineIds?: readonly string[] | undefined
  readonly target: GoalTarget
  readonly reasonCode?: string | undefined
  readonly note?: string | null | undefined
  readonly preview?: boolean | undefined
}

interface PlannedRow {
  readonly line: LineRecord
  readonly index: number
  readonly body: PriceLineInput
  readonly plan: LinePricePlan
  readonly startUnitPrice: string | null
}

interface Planned {
  readonly version: VersionRow
  readonly ctx: PriceContext
  readonly rows: PlannedRow[]
  readonly before: PricedVersion
  readonly after: PricedVersion
  readonly held: { lineId: string; seq: number; code: 'BELOW_COST' | 'REFUSED'; words: string }[]
  readonly targetMinor: MinorUnits | null
  readonly reasonCode: string
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** A line's money with a planned price: its unit price, list price and each size's own price after. */
const plannedMoneyLine = (line: LineRecord, plan: LinePricePlan | undefined): MoneyLine => {
  const base = moneyLineOf(line)
  if (!plan) return base
  const sizePrice = new Map(plan.sizesAfter.map((row) => [row.size, row.unitPrice]))
  return { ...base, unitPrice: plan.unitPrice, listUnitPrice: plan.listUnitPrice, sizes: line.sizes.map((row) => ({ ...row, unitPrice: sizePrice.has(row.size) ? sizePrice.get(row.size)! : row.unitPrice })) }
}

/** What the lines make on the quote's basis (net for a business, net + VAT for a consumer), in minor units. */
const amountOf = (priced: PricedVersion, indexes: ReadonlySet<number>): MinorUnits =>
  priced.lines.reduce((total, line, index) => (indexes.has(index) ? total + line.netAmount + (priced.basis === 'GROSS' ? line.vatAmount : 0) : total), 0)

/** The lines chosen: each a size-grid line of the current version, once (default: every size-grid line). */
function chosenLines(lines: readonly LineRecord[], lineIds: readonly string[] | undefined): LineRecord[] {
  if (lineIds === undefined) {
    const goods = lines.filter((line) => line.kind === 'SIZE_GRID')
    if (goods.length === 0) throw new DomainError('conflict', 'The quote has no line of goods to price: add a style first.', [{ path: 'body/lineIds', message: 'No size-grid line.' }])
    return goods
  }
  const issues: Issue[] = []
  const seen = new Set<string>()
  const chosen: LineRecord[] = []
  lineIds.forEach((lineId, index) => {
    const line = lines.find((entry) => entry.id === lineId)
    if (seen.has(lineId)) issues.push({ path: `body/lineIds/${index}`, message: 'This line is named twice.' })
    else if (!line) issues.push({ path: `body/lineIds/${index}`, message: 'Not a line of the current version.' })
    else if (line.kind === 'FEE') issues.push({ path: `body/lineIds/${index}`, message: `Line ${line.seq} is a fee: a fee is priced on its own (PATCH …/fees/:lineId).` })
    else if (line.kind !== 'SIZE_GRID') issues.push({ path: `body/lineIds/${index}`, message: `Line ${line.seq} is made to measure: made-to-measure comes later.` })
    else chosen.push(line)
    seen.add(lineId)
  })
  if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'Some lines cannot be priced to a target.', issues)
  return chosen
}

/** The plan: each chosen line's waterfall to the target, the money before and after, what is held. */
async function planGoal(db: Reader, quote: QuoteRow, version: VersionRow, body: GoalSeekInput, now: Date): Promise<Planned> {
  assertDraft(version)
  const lines = await readLineRecords(db, version.id)
  const chosen = chosenLines(lines, body.lineIds)
  const ctx = await priceContextOf(db, quote, version, lines, now)
  const reasonCode = body.reasonCode ?? TARGET_PRICE_REASON
  const note = blankToNull(body.note)
  const rules = await withPersonFloor(db, quote, version, await quoteRulesFor(db, quote.companyId), now)
  const money = (moneyLines: MoneyLine[]) =>
    priceVersion({ basis: priceBasisOf(version.taxMode), currency: version.currency, treatment: lines[0] ? treatmentOfStored(lines[0]) : taxable(22), lines: moneyLines, depositPct: decimal(version.depositPct), rules })
  const before = money(lines.map((line) => moneyLineOf(line)))
  const indexOf = new Map(lines.map((line, index) => [line.id, index]))
  const target = body.target

  const bodyFor = (line: LineRecord, net: string | null): { body: PriceLineInput; startUnitPrice: string | null } => {
    const listPrice = ctx.listed.lines.find((row) => row.line.id === line.id)?.priced.listPrice ?? null
    const restart = restartOf(storedSteps(ctx.extras.get(line.id)?.priceSteps ?? null), listPrice, decimal(line.unitPrice)!)
    const { startUnitPrice, discount, ...start } = restart
    const priceBody: PriceLineInput = {
      version: body.version,
      ...start,
      ...(target.kind === 'DISCOUNT' ? { discount: { pct: target.pct!, reasonCode, note } } : discount ? { discount } : {}),
      ...(net === null ? {} : { net: { unitPrice: net, reasonCode, note } }),
    }
    return { body: priceBody, startUnitPrice }
  }

  const held: Planned['held'] = []
  const plans = async (nets: (line: LineRecord) => string | null): Promise<PlannedRow[]> => {
    const rows: PlannedRow[] = []
    for (const line of chosen) {
      try {
        const net = target.kind === 'DISCOUNT' ? null : nets(line)
        const { body: priceBody, startUnitPrice } = bodyFor(line, net)
        rows.push({ line, index: indexOf.get(line.id)!, body: priceBody, plan: await planLinePrice(db, ctx, version, line, priceBody), startUnitPrice })
      } catch (error) {
        if (!(error instanceof DomainError) || error instanceof NotFoundError) throw error
        held.push({ lineId: line.id, seq: line.seq, code: 'REFUSED', words: `Line ${line.seq}: ${error.message}` })
      }
    }
    return rows
  }
  const afterOf = (rows: readonly PlannedRow[]) => {
    const byIndex = new Map(rows.map((row) => [row.index, row.plan]))
    return money(lines.map((line, index) => plannedMoneyLine(line, byIndex.get(index))))
  }

  let rows: PlannedRow[]
  let targetMinor: MinorUnits | null = null
  if (target.kind === 'UNIT_PRICE') rows = await plans(() => target.unitPrice!)
  else if (target.kind === 'DISCOUNT') rows = await plans(() => null)
  else if (target.kind === 'MARGIN') {
    rows = await plans((line) => {
      const suggested = suggestedPriceOf({ unitCost: line.costAmount === null ? null : decimal(line.unitCost), marginPct: target.marginPct!, currency: version.currency, onBasis: ctx.listed.onBasis })
      if ('problem' in suggested) throw new DomainError('conflict', suggested.problem)
      return suggested.unitPrice
    })
  } else {
    // TOTAL: one factor on the chosen lines' prices, corrected twice for what rounding moved.
    targetMinor = toMinorUnits(target.amount!, version.currency)
    const chosenIndexes = new Set(chosen.map((line) => indexOf.get(line.id)!))
    const othersIndexes = new Set(lines.map((_, index) => index).filter((index) => !chosenIndexes.has(index)))
    const chosenNow = fromMinorUnits(amountOf(before, chosenIndexes), version.currency)
    const othersNow = fromMinorUnits(amountOf(before, othersIndexes), version.currency)
    const factor = totalFactor(target.amount!, chosenNow, othersNow)
    if ('problem' in factor) throw new DomainError('conflict', factor.problem, [{ path: 'body/target/amount', message: factor.problem }])
    let k: Decimal = factor
    const wanted = new Dec(target.amount!).minus(othersNow)
    rows = []
    for (let round = 0; round < 3; round++) {
      held.length = 0
      rows = await plans((line) => scaledPrice(decimal(line.unitPrice)!, k, version.currency))
      const reached = fromMinorUnits(amountOf(afterOf(rows), chosenIndexes), version.currency)
      if (reached.eq(wanted) || reached.lte(0)) break
      k = k.times(wanted).dividedBy(reached)
    }
  }
  const after = afterOf(rows)
  for (const row of rows) {
    const line = after.lines[row.index]!
    if (line.marginAmount !== null && line.marginAmount < 0) held.push({ lineId: row.line.id, seq: row.line.seq, code: 'BELOW_COST', words: `Line ${row.line.seq} would sell below its cost: an approver must allow it. Goal-seek does not write it: price the line by hand (Price & margin); the quote then asks for the yes.` })
  }
  held.sort((a, b) => a.seq - b.seq)
  return { version, ctx, rows, before, after, held, targetMinor, reasonCode }
}

/** The answer (preview or written), as this caller may read it: the margin AMOUNT only with the cost grain. */
function answerOf(quote: QuoteRow, planned: Planned, body: GoalSeekInput, preview: boolean, grains: ReadonlySet<Grain>) {
  const { version, before, after, rows } = planned
  const cost = grains.has('cost')
  const amounts = (priced: PricedVersion) => asMoney('price', { netAmount: asMoney('price', priced.netAmount), vatAmount: asMoney('price', priced.vatAmount), grossAmount: asMoney('price', priced.grossAmount) })
  // What the quote makes on its basis after (a consumer's total is VAT included).
  const reachedMinor = planned.targetMinor === null ? null : after.basis === 'GROSS' ? after.grossAmount : after.netAmount
  const under = rows.filter((row) => after.lines[row.index]!.belowFloor).length
  const words = [
    preview ? `${rows.length} line(s) would take the target` : `${rows.length} line(s) priced to the target`,
    under > 0 ? `${under} under the margin floor: an approver decides` : null,
    planned.held.length > 0 ? `${planned.held.length} held` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  return {
    preview,
    quoteId: quote.id,
    versionId: version.id,
    revision: version.revision,
    currency: version.currency,
    priceBasis: before.basis,
    target: {
      kind: body.target.kind,
      unitPrice: asMoney('price', body.target.unitPrice ?? null),
      pct: asMoney('price', body.target.pct ?? null),
      marginPct: asMoney('margin', body.target.marginPct ?? null),
      amount: asMoney('price', body.target.amount ?? null),
      reasonCode: planned.reasonCode,
    },
    lines: rows.map((row) => {
      const was = before.lines[row.index]!
      const now = after.lines[row.index]!
      return {
        lineId: row.line.id,
        seq: row.line.seq,
        description: row.line.description,
        styleId: row.line.styleId,
        colourwayId: row.line.colourwayId,
        pieces: now.quantity,
        start: { kind: row.body.start, unitPrice: asMoney('price', row.plan.steps[0]?.unitPrice ?? row.startUnitPrice) },
        from: { unitPrice: asMoney('price', decimal(row.line.unitPrice)!), marginPct: asMoney('margin', was.marginPct) },
        to: { unitPrice: asMoney('price', row.plan.unitPrice), marginPct: asMoney('margin', now.marginPct), ...(cost ? { marginAmount: asMoney('margin', now.marginAmount) } : {}) },
        discountPct: asMoney('price', discountNeeded(row.plan.steps[0]?.unitPrice ?? row.startUnitPrice, row.plan.unitPrice)),
        steps: asMoney('price', row.plan.steps.map((step: WaterfallStep): Record<string, unknown> => ({ ...step }))),
        belowFloor: asMoney('margin', now.belowFloor),
        belowCost: asMoney('margin', now.marginAmount !== null && now.marginAmount < 0),
      }
    }),
    totals: asMoney('price', {
      before: amounts(before),
      after: amounts(after),
      target: asMoney('price', planned.targetMinor),
      gap: asMoney('price', reachedMinor === null || planned.targetMinor === null ? null : reachedMinor - planned.targetMinor),
    }),
    margin: asMoney('margin', { before: asMoney('margin', before.marginPct), after: asMoney('margin', after.marginPct), floorPct: asMoney('margin', after.marginFloorPct), floorRole: after.marginFloorRole ?? null }),
    approval: { neededBefore: before.approvalNeeded, neededAfter: after.approvalNeeded, rules: after.rules.filter((rule) => rule.broken).map((rule) => rule.message) },
    held: planned.held,
    words: `${GOAL_KIND_WORDS[body.target.kind]}: ${words}`,
  }
}

/** POST /sales/quotes/:quoteId/goal-seek (quotes.manage): see the module comment. */
export async function goalSeek(caller: CommandCaller, quoteId: string, body: GoalSeekInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const grains = grainsOf(context)
  if (body.target.kind === 'MARGIN' && !(grains.has('cost') && grains.has('margin'))) {
    throw new ForbiddenError("A target margin is worked out from the cost, which your role does not show: ask for a target unit price, a discount or a total instead (or someone with the cost grain sets the margin).")
  }
  const problems = goalProblems(body.target)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)

  if (body.preview) {
    const now = serverClock.now()
    return caller.withClient(async (client) => {
      const current = (await readQuote(client, quote.id))!
      if (current.version !== body.version) throw new StaleVersionError('Quote', current.id, current.version, body.version)
      const planned = await planGoal(client, current, await readCurrentVersion(client, current), body, now)
      return answerOf(current, planned, body, true, grains)
    })
  }

  return onQuote(caller, quote, { name: 'quotes.goalSeek', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    const planned = await planGoal(tools.tx, current, version, body, tools.now)
    if (planned.held.length > 0) {
      throw new DomainError('conflict', planned.held.length === 1 ? planned.held[0]!.words : `${planned.held.length} lines cannot take the target: ${planned.held.map((row) => row.words).join(' ')}`, planned.held.map((row) => ({ path: `lines/${row.lineId}`, message: row.words })))
    }
    for (const row of planned.rows) await writeLinePrice(tools, current, version, planned.ctx, row.line, row.plan, row.body.start)
    await refreshVersion(tools, current, version, new Set())
    tools.audit({
      action: 'quotes.goalSeek',
      recordType: 'Quote',
      recordId: current.id,
      companyId: current.companyId,
      after: {
        kind: body.target.kind,
        unitPrice: markMoney('price', body.target.unitPrice ?? null),
        pct: markMoney('price', body.target.pct ?? null),
        marginPct: markMoney('margin', body.target.marginPct ?? null),
        amount: markMoney('price', body.target.amount ?? null),
        reasonCode: planned.reasonCode,
        lines: markMoney(
          'price',
          planned.rows.map((row) => ({ lineId: row.line.id, from: decimal(row.line.unitPrice), to: row.plan.unitPrice })),
        ),
      },
    })
    return { ...answerOf(current, planned, body, false, grains), ...(await detailInCommand(tools, current.id)) }
  })
}
