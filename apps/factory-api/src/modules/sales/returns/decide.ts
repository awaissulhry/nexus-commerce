import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { fromMinorUnits } from '@nexus/factory-domain/core/money'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { SALES_RETURNS_DECIDE } from '@nexus/factory-domain/sales/returns/permissions'
import {
  decisionProblems,
  defaultCredit,
  DECIDING_STATUSES,
  effectWithAmount,
  effectWords,
  followUpOf,
  OUTCOMES_BY_DISPOSITION,
  outcomeWords,
  RETURN_DISPOSITIONS,
  STOCK_OUTCOMES,
  suggestedOutcome,
  type GoodsOutcome,
  type ReturnCause,
  type ReturnDisposition,
  type ReturnGrade,
  type ReturnStatus,
} from '@nexus/factory-domain/sales/returns/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { postMoves, type MoveDraft } from '../../inventory/ledger/post-moves'
import { defaultPlaceOf, finishedItemFor, finishedPlaces, readSkus, skuKey, standardCostFor, type SkuRow } from '../../inventory/finished/post'
import { officeReturn } from './access'
import { openSafetyEntries, type SafetyEntry } from './register'
import { lockReturn, recordOf, touchReturn } from './rma'
import { currencyOf, LINE_COLUMNS, lineKeyOf, lineValue, moveKeyPrefix, readLines, soldFactsOf, type LineRow, type Reader, type ReturnView, type RmaRow, type SoldFacts } from './store'

/**
 * The decision (B-W2a-43; SAL-341 "Disposition decides the outcome"; design rma.inspection "Each line inspected and
 * given a disposition that sets money, stock and work in one step", "Decide per line or select several and decide
 * once", "Effect in words"). Office only (sales.returns.decide over the RMA's company, site and customer); a credit
 * value only with the price grain (the contract refuses one sent without it).
 *
 *   preview  POST /sales/returns/:id/decisions/preview   per line: the outcome it would take, the credit it starts from,
 *                                                       what it is worth, the effect in words, every disposition with
 *                                                       its outcomes (each held with its reason), the problems
 *   decide   POST /sales/returns/:id/decisions           ONE command: the RMA row locked at the version read (RECEIVED or
 *                                                       INSPECTED), every named line received, graded and not decided;
 *                                                       its stock: an outcome that puts the goods into stock (RESTOCK into
 *                                                       finished goods, SECOND_QUALITY into the place named, QUARANTINE
 *                                                       into a quarantine place) posts ONE CUSTOMER_RETURN move (B-W2b-16;
 *                                                       an ADJUSTMENT before W2b) naming the line into that place of
 *                                                       the SKU's FINISHED item (made now when the SKU has none, as a
 *                                                       production receipt does) through postMoves, keyed
 *                                                       `return-line:<line>:1`, valued as a production receipt is (the
 *                                                       item's FROZEN standard cost of the company in force today,
 *                                                       inventory/finished/post.ts standardCostFor; second quality and
 *                                                       quarantine at the same standard: one FINISHED item per SKU; no
 *                                                       standard yet: unvalued until finance freezes one, whose freeze
 *                                                       values it); REPAIR, SCRAP and BACK_TO_CUSTOMER move
 *                                                       nothing (the goods never entered stock); the line's decision,
 *                                                       outcome and credit; the RMA → INSPECTED once every received line is
 *                                                       decided; a safety return's PPE register entry; events
 *                                                       return.decided, return.credit_due (lines with a credit: the credit
 *                                                       note is B-W2a-61's), return.status_changed.
 * A decided line is final here (a later correction is a stock move by the warehouse and a note on the thread).
 */

export interface DecisionLine {
  readonly lineId: string
  readonly disposition: ReturnDisposition
  readonly goodsOutcome?: GoodsOutcome | null | undefined
  /** Minor units (the price grain); left out: the disposition's default. */
  readonly creditAmount?: number | null | undefined
  /** Where stock goes: a finished-goods place (RESTOCK), a place of the site (SECOND_QUALITY), a quarantine place. */
  readonly toLocationId?: string | null | undefined
}

export interface DecisionsBody {
  readonly version: number
  readonly lines: readonly DecisionLine[]
  /** B-W2a-F8: the reason goods put back into stock inside a SOFT-locked month are posted anyway. */
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

interface PlannedDecision {
  readonly index: number
  readonly line: LineRow
  readonly sold: SoldFacts | undefined
  readonly disposition: ReturnDisposition
  readonly goodsOutcome: GoodsOutcome
  readonly creditAmount: number
  readonly value: number | null
  readonly place: { readonly id: string; readonly code: string } | null
  readonly sku: SkuRow | null
  readonly problems: Issue[]
}

const gradedOf = (line: LineRow, sold: SoldFacts | undefined) =>
  line.grade ? { grade: line.grade as ReturnGrade, cause: line.cause as ReturnCause | null, ppe: sold?.style?.ppe ?? false, reasonCode: line.reasonCode } : null

/** The outcome a disposition takes when none is named: the suggested one when it fits, else its first. */
function outcomeFor(disposition: ReturnDisposition, line: LineRow, sold: SoldFacts | undefined): GoodsOutcome {
  const allowed = OUTCOMES_BY_DISPOSITION[disposition]
  const graded = gradedOf(line, sold)
  const suggested = graded ? suggestedOutcome(graded) : null
  return suggested && allowed.includes(suggested) ? suggested : (allowed[0] ?? 'QUARANTINE')
}

async function placeFor(db: Reader, siteId: string, outcome: GoodsOutcome, toLocationId: string | null | undefined, at: string): Promise<{ place: { id: string; code: string } | null; problems: Issue[] }> {
  if (!STOCK_OUTCOMES.includes(outcome)) {
    return { place: null, problems: toLocationId ? [{ path: `${at}/toLocationId`, message: `The goods ${outcomeWords(outcome)}: they go into no place of the stock.` }] : [] }
  }
  if (outcome === 'RESTOCK') {
    const places = await finishedPlaces(db, siteId)
    const place = toLocationId ? places.find((entry) => entry.id === toLocationId && entry.status === 'ACTIVE') : defaultPlaceOf(places)
    if (!place) return { place: null, problems: [{ path: `${at}/toLocationId`, message: places.length === 0 ? 'The site has no finished-goods place: add one in the warehouse, or decide another outcome.' : 'Pick a finished-goods place of the site.' }] }
    return { place: { id: place.id, code: place.code }, problems: [] }
  }
  if (outcome === 'QUARANTINE') {
    const places = await db.location.findMany({ where: { siteId, kind: 'QUARANTINE', status: 'ACTIVE' }, select: { id: true, code: true } })
    const place = toLocationId ? places.find((entry) => entry.id === toLocationId) : places.length === 1 ? places[0] : undefined
    if (!place) return { place: null, problems: [{ path: `${at}/toLocationId`, message: places.length === 0 ? 'The site has no quarantine place: add one in the warehouse, or decide another outcome.' : 'Pick a quarantine place of the site.' }] }
    return { place, problems: [] }
  }
  const place = toLocationId && isUuid(toLocationId) ? await db.location.findUnique({ where: { id: toLocationId }, select: { id: true, code: true, siteId: true, status: true, kind: true } }) : null
  if (!place || place.siteId !== siteId || place.status !== 'ACTIVE' || place.kind === 'SUBCONTRACTOR') return { place: null, problems: [{ path: `${at}/toLocationId`, message: 'Name the second-quality place of the site the goods go to.' }] }
  return { place: { id: place.id, code: place.code }, problems: [] }
}

async function planDecisions(db: Reader, rma: Pick<RmaRow, 'id' | 'siteId'>, body: Pick<DecisionsBody, 'lines'>): Promise<PlannedDecision[]> {
  const lines = await readLines(db, rma.id)
  const byId = new Map(lines.map((line) => [line.id, line]))
  const sold = await soldFactsOf(db, lines)
  const planned: PlannedDecision[] = []
  const seen = new Set<string>()
  for (const [index, entry] of body.lines.entries()) {
    const at = `body/lines/${index}`
    const line = byId.get(entry.lineId)
    if (!line) throw new ValidationError('Not a line of this return.', [{ path: `${at}/lineId`, message: 'Not a line of this return.' }])
    const facts = sold.get(lineKeyOf(line))
    const problems: Issue[] = []
    if (seen.has(line.id)) problems.push({ path: `${at}/lineId`, message: `Line ${line.seq} is named twice.` })
    seen.add(line.id)
    if (line.disposition !== null) problems.push({ path: `${at}/lineId`, message: `Line ${line.seq} is decided already (${line.disposition}).` })
    const disposition = entry.disposition
    const goodsOutcome = entry.goodsOutcome ?? outcomeFor(disposition, line, facts)
    const value = lineValue(facts, line.receivedQuantity)
    const graded = gradedOf(line, facts)
    const decision = { disposition, goodsOutcome, ...(entry.creditAmount !== undefined && entry.creditAmount !== null ? { creditAmount: entry.creditAmount } : {}) }
    for (const problem of decisionProblems(decision, { received: line.receivedQuantity, value, ...(graded ?? {}) })) problems.push({ path: `${at}/${problem.path}`, message: problem.message })
    const creditAmount = entry.creditAmount ?? defaultCredit(disposition, value)
    const { place, problems: placeProblems } = await placeFor(db, rma.siteId, goodsOutcome, entry.toLocationId, at)
    problems.push(...placeProblems)
    let sku: SkuRow | null = null
    if (STOCK_OUTCOMES.includes(goodsOutcome)) {
      const orderLine = facts?.orderLine ?? null
      if (!orderLine || !line.size) problems.push({ path: `${at}/goodsOutcome`, message: `Line ${line.seq} names no style, colour and size, so it cannot go into stock: repair, scrap or send it back.` })
      else {
        sku = (await readSkus(db, orderLine.styleId, [{ colourwayId: orderLine.colourwayId, size: line.size }])).get(skuKey(orderLine.colourwayId, line.size)) ?? null
        if (!sku) problems.push({ path: `${at}/goodsOutcome`, message: `${facts?.style?.code ?? 'The style'} ${facts?.colourway?.code ?? ''} size ${line.size} has no SKU: generate the style's SKU matrix first.` })
      }
    }
    planned.push({ index, line, sold: facts, disposition, goodsOutcome, creditAmount, value, place, sku, problems })
  }
  return planned
}

const amountText = (amount: number | null, currency: string | null): string | null => (amount !== null && currency ? `${fromMinorUnits(amount, currency).toFixed(2)} ${currency}` : null)

/** Every disposition (but REMAKE, W2b) with its outcomes for a line, each held with its reason. */
function optionsOf(line: LineRow, sold: SoldFacts | undefined, value: number | null) {
  const graded = gradedOf(line, sold)
  return RETURN_DISPOSITIONS.filter((disposition) => disposition !== 'REMAKE').map((disposition) => ({
    disposition,
    outcomes: OUTCOMES_BY_DISPOSITION[disposition].map((outcome) => {
      const held = decisionProblems({ disposition, goodsOutcome: outcome }, { received: line.receivedQuantity, value, ...(graded ?? {}) }).find((problem) => problem.path === 'goodsOutcome')
      return { outcome, held: held?.message ?? null }
    }),
    defaultCredit: asMoney('price', defaultCredit(disposition, value)),
  }))
}

/** POST /sales/returns/:returnId/decisions/preview: what each decision would do. Writes nothing. */
export async function previewDecisions(caller: CommandCaller, returnId: string, body: Pick<DecisionsBody, 'lines'>) {
  const { rma } = await officeReturn(caller, returnId, SALES_RETURNS_DECIDE)
  return caller.withClient(async (client) => {
    const planned = await planDecisions(client, rma, body)
    return {
      ok: planned.every((entry) => entry.problems.length === 0) && DECIDING_STATUSES.includes(rma.status as ReturnStatus),
      problems: [...(DECIDING_STATUSES.includes(rma.status as ReturnStatus) ? [] : [{ path: 'status', message: `Return ${rma.number} is ${rma.status.toLowerCase()}: lines are decided once goods arrived, before it closes.` }]), ...planned.flatMap((entry) => entry.problems)],
      lines: planned.map((entry) => {
        const currency = currencyOf(entry.sold)
        const decision = { disposition: entry.disposition, goodsOutcome: entry.goodsOutcome, creditAmount: entry.creditAmount }
        return {
          lineId: entry.line.id,
          seq: entry.line.seq,
          disposition: entry.disposition,
          goodsOutcome: entry.goodsOutcome,
          creditAmount: asMoney('price', entry.creditAmount),
          receivedValue: asMoney('price', entry.value),
          currency,
          place: entry.place,
          followUp: followUpOf(entry.disposition, entry.creditAmount),
          effect: effectWords(decision, entry.place?.code ?? null),
          effectWithAmount: asMoney('price', effectWithAmount(decision, entry.place?.code ?? null, amountText(entry.creditAmount, currency))),
          options: optionsOf(entry.line, entry.sold, entry.value),
          problems: entry.problems,
        }
      }),
    }
  })
}

/** POST /sales/returns/:returnId/decisions */
export async function decideReturn(caller: CommandCaller, returnId: string, body: DecisionsBody, idempotencyKey?: string): Promise<{ return: ReturnView; moves: { lineId: string; moveId: string; locationId: string | null }[]; registerEntries: SafetyEntry[] }> {
  const { context, rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_DECIDE)
  if (body.lines.length === 0) throw new ValidationError('Decide at least one line.', [{ path: 'body/lines', message: 'Decide at least one line.' }])
  const { result } = await command(caller, { name: 'returns.decide', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const rma = await lockReturn(tools, seen.id, body.version, DECIDING_STATUSES, 'lines are decided')
    const planned = await planDecisions(tx, rma, body)
    const problems = planned.flatMap((entry) => entry.problems)
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'Some lines cannot be decided like this.', problems)

    // The stock first: one CUSTOMER_RETURN into its place per line whose goods go into stock (the SKU's FINISHED item), valued
    // at its frozen standard as a production receipt is (a month with a restocked return can then be closed for good).
    const day = businessDate(now)
    const drafts: MoveDraft[] = []
    const draftLine: PlannedDecision[] = []
    for (const entry of planned) {
      if (!entry.sku || !entry.place) continue
      const orderLine = entry.sold!.orderLine!
      const style = await tx.style.findUniqueOrThrow({ where: { id: orderLine.styleId }, select: { name: true, companyId: true, garmentTracking: true } })
      const itemId = await finishedItemFor(tools as CommandTools, entry.sku, { styleName: style.name, colourwayName: entry.sold!.colourway?.name ?? entry.sku.sku, garmentTracking: style.garmentTracking, companyId: style.companyId })
      const cost = await standardCostFor(tx, rma.companyId, itemId, day)
      drafts.push({
        siteId: rma.siteId,
        // B-W2b-16: a customer return of its own (StockMoveReason CUSTOMER_RETURN, B-W2b-01), naming the return line.
        reason: 'CUSTOMER_RETURN',
        returnLineId: entry.line.id,
        returnPartyId: entry.line.partyId,
        itemId,
        itemColourId: null,
        lotId: null,
        hideId: null,
        toLocationId: entry.place.id,
        quantity: String(entry.line.receivedQuantity),
        uom: 'PCS',
        reference: rma.number,
        note: `Customer return ${rma.number} line ${entry.line.seq}: the goods ${outcomeWords(entry.goodsOutcome)} (${entry.disposition}).`,
        idempotencyKey: `${moveKeyPrefix(entry.line.id)}1`,
        ...(cost ? { cost } : {}),
      })
      draftLine.push(entry)
    }
    const posted =
      drafts.length > 0
        ? await postMoves(tools, drafts, {
            issuePath: (index) => `body/lines/${draftLine[index]!.index}`,
            periodLockOverride: body.periodLockOverride,
          })
        : []
    const moves = posted.map((move, index) => ({ lineId: draftLine[index]!.line.id, moveId: move.id, locationId: move.toLocationId }))

    const actorId = context.actorId
    for (const entry of planned) {
      await tx.returnLine.update({
        where: { id: entry.line.id },
        data: { disposition: entry.disposition, goodsOutcome: entry.goodsOutcome, decidedAt: now, decidedById: actorId, creditAmount: entry.creditAmount, updatedAt: now, version: { increment: 1 } },
        select: { id: true },
      })
      tools.audit({
        action: 'returns.decideLine',
        recordType: 'ReturnLine',
        recordId: entry.line.id,
        companyId: rma.companyId,
        siteId: rma.siteId,
        before: { disposition: null },
        after: { disposition: entry.disposition, goodsOutcome: entry.goodsOutcome, creditAmount: markMoney('price', entry.creditAmount), placeId: entry.place?.id ?? null, moveIds: moves.filter((move) => move.lineId === entry.line.id).map((move) => move.moveId) },
      })
    }
    const after = await tx.returnLine.findMany({ where: { returnId: rma.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
    const everyDecided = after.filter((line) => line.receivedQuantity > 0).every((line) => line.disposition !== null)
    const inspected = everyDecided && rma.status === 'RECEIVED'
    await touchReturn(tools, rma, inspected ? { status: 'INSPECTED', inspectedAt: now } : {})
    if (inspected) {
      tools.audit({ action: 'returns.statusChanged', recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, before: { status: rma.status }, after: { status: 'INSPECTED', inspectedAt: toUtcIso(now) } })
      tools.emit({ type: 'return.status_changed', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, from: rma.status as ReturnStatus, to: 'INSPECTED' } })
    }
    const lineIds = planned.map((entry) => entry.line.id)
    tools.emit({ type: 'return.decided', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, lineIds, inspected, moveIds: moves.map((move) => move.moveId) } })
    const credited = planned.filter((entry) => entry.creditAmount > 0).map((entry) => entry.line.id)
    if (credited.length > 0) tools.emit({ type: 'return.credit_due', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, partyId: rma.partyId, lineIds: credited } })
    const registerEntries = await openSafetyEntries(tools, rma, after.filter((line) => lineIds.includes(line.id)))
    return { moves, registerEntries }
  })
  return { return: await recordOf(caller, seen.id), moves: result.moves, registerEntries: result.registerEntries }
}
