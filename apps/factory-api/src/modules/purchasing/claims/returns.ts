import type { FactoryClient } from '@nexus/factory-db'
import { ForbiddenError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { CompanyLegal } from '@nexus/factory-domain/documents/model'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { availabilityOf } from '@nexus/factory-domain/inventory/reservations/rules'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { PURCHASING_CLAIMS_MANAGE, PURCHASING_CLAIMS_RETURN } from '@nexus/factory-domain/purchasing/claims/permissions'
import { expectedCredit, linesValue, returnProblems, type ClaimRemedy } from '@nexus/factory-domain/purchasing/claims/rules'
import type { SourceDdtRequest } from '@nexus/factory-domain/shipping/ddt/sources'
import { SHIPPING_DDT_ISSUE } from '@nexus/factory-domain/shipping/permissions'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { companyLegalOf } from '../../../platform/documents/documents'
import type { FileView } from '../../../platform/files/contract'
import type { FilesRuntime } from '../../../platform/files/service'
import { readSiteStock } from '../../inventory/issue/store'
import { postMoves, type MoveDraft } from '../../inventory/ledger/post-moves'
import { ReservationRefusedError } from '../../inventory/reservations/reserve'
import { demandWords, lockReservations, readDemands, readKeyFacts, reserveKeyOf, type ReserveKey } from '../../inventory/reservations/store'
import { issueSourceDdtInCommand, printSourceDdt } from '../../shipping/ddt/sources'
import { officeContextOf } from '../store'
import { assertMayAll, createClaimInCommand, detailInCommand, resolveClaim, type CreateInput } from './claims'
import { sendInCommand, type MailInput } from './send'
import { CLAIM_RECORD, claimInCommand, factsOf, officeClaim, readLines, type ClaimRow, type LineRow } from './store'
import type { ClaimDetailView } from './views'

/**
 * The goods of a return claim go back to the supplier (B-W2a-44; SCM-134; design purchasing.claims pop "Return to
 * supplier": "Lot, quantity, reason; creates the return DDT, takes stock out, records the credit expected"; record tab
 * "Goods returned"). Rule 2: rejected leather goes back to the tannery.
 *
 *   POST /purchasing/claims/:claimId/return   purchasing.claims.return + shipping.ddt.issue: lines of a RETURN claim that
 *        is SENT or ACCEPTED (default every line not gone yet) go back with ONE return DDT
 *   POST /purchasing/claims/returns            purchasing.claims.manage + .return + shipping.ddt.issue: "Return to
 *        supplier" in one go — a RETURN claim from a lot (its hides in stock, or its stock per place), discrepancies or
 *        typed lines, sent (by mail when asked), its goods out and the return DDT, in ONE command
 *
 * The goods out, in the caller's command (the claim's row is held): the reserve lock of each material and colour (a hide
 * an ACTIVE reservation holds is refused in words: release it first) → per line the place its goods leave from (the
 * one named, else the one place that holds all of it) → ONE postMoves batch: an ADJUSTMENT out per line (there is no
 * supplier-return reason in the ledger: the note says why; 409 before anything is written when a place lacks the stock;
 * valued in the command at the lot's cost) → each line's move (set once) and, when it had none, its cost and value from
 * the move's valuation → the credit asked again from the lines (not once the supplier accepted it) → THEN the return DDT
 * with B-W2a-17's issueSourceDdtInCommand (the lines sent now; it sets their DDT, once) → the PDF after the commit.
 * The answer says what the return leaves over-reserved (a quantity a reservation counted on).
 */

export type ReturnDdt = Omit<SourceDdtRequest, 'lineIds'> & { readonly internalNote?: string | null | undefined }

export interface ReturnAnswer {
  readonly claim: ClaimDetailView
  readonly moveIds: string[]
  readonly ddt: { readonly id: string; readonly number: string; readonly file: FileView | null; readonly pdfProblem: string | null }
  readonly claimLinesKeepingOldDdt: string[]
  readonly overReserved: { itemId: string; itemColourId: string | null; available: string; reserved: string }[]
}

const refuse = (problems: readonly Issue[]) => new ValidationError(problems.length === 1 ? problems[0]!.message : 'The goods cannot go back as they stand.', problems)

/** The place a line's goods leave from: the one named (of the claim's site, ours), else the one place that holds all of it. */
async function placeOf(tools: CommandTools, claim: ClaimRow, line: LineRow, named: string | null, path: string): Promise<string> {
  if (named) {
    const location = isUuid(named) ? await tools.tx.location.findUnique({ where: { id: named }, select: { id: true, code: true, siteId: true, status: true, kind: true } }) : null
    if (!location || location.siteId !== claim.siteId) throw refuse([{ path, message: "Not a location of the claim's site." }])
    if (location.status !== 'ACTIVE') throw refuse([{ path, message: `Location ${location.code} is archived.` }])
    if (location.kind === 'SUBCONTRACTOR') throw refuse([{ path, message: `Location ${location.code} is a workshop's: the goods go back from one of our places.` }])
    return location.id
  }
  const held = await readSiteStock(tools.tx, claim.siteId, { itemIds: [line.itemId], itemColourId: line.itemColourId, lotId: line.lotId, hideId: line.hideId })
  const need = new Dec(line.baseQuantity.toString())
  const whole = held.filter((balance) => balance.onHand.gte(need))
  if (whole.length === 1) return whole[0]!.locationId
  if (whole.length > 1) throw refuse([{ path, message: `Line ${line.seq}'s goods lie in ${whole.length} places: name the one they leave from.` }])
  if (held.length === 0) throw new InvalidStateError(`Line ${line.seq}'s goods are not in stock at the site: nothing of them can go back.`)
  // Spread over places, or less than the line: the ledger answers in its own words (409 before any move).
  if (held.reduce((sum, balance) => sum.plus(balance.onHand), new Dec(0)).gte(need)) throw refuse([{ path, message: `Line ${line.seq}'s goods are spread over ${held.length} places: name the one they leave from (or split the line).` }])
  return [...held].sort((a, b) => b.onHand.comparedTo(a.onHand))[0]!.locationId
}

/**
 * The goods of the claim's lines (named, else every one not gone) out of the site and onto ONE return DDT, inside the
 * caller's command. `places` names where a line's goods leave from (by line id).
 */
export async function returnGoodsInCommand(
  tools: CommandTools,
  context: OfficeContext,
  claimId: string,
  input: { readonly lineIds?: readonly string[] | undefined; readonly places?: ReadonlyMap<string, string> | undefined; readonly ddt: ReturnDdt; readonly company: CompanyLegal; readonly key: string },
): Promise<Omit<ReturnAnswer, 'claim' | 'ddt'> & { ddt: { id: string; number: string } }> {
  const { tx } = tools
  const claim = await claimInCommand(tx, claimId)
  const lines = await readLines(tx, claimId)
  if (input.lineIds) {
    const unknown = input.lineIds.findIndex((id) => !lines.some((line) => line.id === id))
    if (unknown !== -1) throw refuse([{ path: `body/lines/${unknown}/lineId`, message: 'Not a line of this claim.' }])
  }
  const problems = returnProblems(factsOf(claim, lines), input.lineIds)
  if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
  const going = lines.filter((line) => (input.lineIds ? input.lineIds.includes(line.id) : line.moveId === null))

  // The reserve lock of each material and colour, then: a hide an ACTIVE reservation holds does not leave.
  const keys = new Map<string, ReserveKey>(going.map((line) => {
    const key = { siteId: claim.siteId, itemId: line.itemId, itemColourId: line.itemColourId }
    return [reserveKeyOf(key), key]
  }))
  await lockReservations(tx, context.tenantId, [...keys.values()])
  const hideIds = going.flatMap((line) => (line.hideId ? [line.hideId] : []))
  if (hideIds.length > 0) {
    const holding = await tx.reservation.findMany({ where: { hideId: { in: hideIds }, status: 'ACTIVE' }, select: { id: true, hideId: true, workOrderId: true, salesOrderLineId: true } })
    if (holding.length > 0) {
      const demands = await readDemands(tx, holding, { withOrders: true })
      const hides = new Map((await tx.hide.findMany({ where: { id: { in: hideIds } }, select: { id: true, code: true } })).map((hide) => [hide.id, hide.code]))
      const issues = holding.map((row) => ({ path: `body/lines/${going.findIndex((line) => line.hideId === row.hideId)}`, message: `Hide ${hides.get(row.hideId!)} is reserved for ${demandWords(row, demands)}: release that reservation first.` }))
      throw new ReservationRefusedError(issues.length === 1 ? issues[0]!.message : `${issues.length} hides are reserved: release their reservations first.`, issues)
    }
  }

  // One batch: an ADJUSTMENT out per line, from its place.
  const party = await tx.party.findUnique({ where: { id: claim.partyId }, select: { code: true } })
  const drafts: MoveDraft[] = []
  for (const [index, line] of going.entries()) {
    const from = await placeOf(tools, claim, line, input.places?.get(line.id) ?? null, `body/lines/${index}/fromLocationId`)
    drafts.push({
      siteId: claim.siteId,
      reason: 'ADJUSTMENT',
      itemId: line.itemId,
      itemColourId: line.itemColourId,
      lotId: line.lotId,
      hideId: line.hideId,
      fromLocationId: from,
      quantity: quantityText(line.quantity),
      uom: line.uom,
      baseQuantity: quantityText(line.baseQuantity),
      reference: claim.number,
      note: `Returned to supplier ${party?.code ?? ''}: claim ${claim.number}, line ${line.seq}`.replace(/\s+/g, ' '),
    })
  }
  const posted = await postMoves(tools, drafts, { key: `purchasing.claims.return:${input.key}`, issuePath: (index) => `body/lines/${index}` })
  const valuations = new Map((await tx.stockValuation.findMany({ where: { moveId: { in: posted.map((move) => move.id) } }, select: { moveId: true, unitCost: true, valueAmount: true, currency: true } })).map((row) => [row.moveId, row]))
  for (const [index, line] of going.entries()) {
    const move = posted[index]!
    const value = valuations.get(move.id)
    // A line without a cost takes what its stock left at (the lot's cost), in the claim's currency.
    const valued = line.unitCost === null && value && value.currency === claim.currency ? { unitCost: value.unitCost.toFixed(6), creditAmount: Math.abs(value.valueAmount) } : null
    await tx.supplierClaimLine.update({ where: { id: line.id }, data: { moveId: move.id, ...(valued ?? {}), version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      action: 'purchasing.claims.returnLine',
      recordType: 'SupplierClaimLine',
      recordId: line.id,
      companyId: claim.companyId,
      siteId: claim.siteId,
      before: { moveId: null },
      after: { moveId: move.id, fromLocationId: move.fromLocationId, quantity: move.quantity, uom: move.uom, ...(valued ? { unitCost: markMoney('cost', valued.unitCost), creditAmount: markMoney('cost', valued.creditAmount) } : {}) },
    })
  }
  // The credit asked again from the lines' value (an amount the supplier accepted stays as agreed).
  if (claim.status !== 'ACCEPTED') {
    const all = await tx.supplierClaimLine.findMany({ where: { claimId }, select: { creditAmount: true } })
    const expected = expectedCredit(claim.remedy as ClaimRemedy | null, all)
    if (expected !== claim.expectedCreditAmount) await tx.supplierClaim.update({ where: { id: claimId }, data: { expectedCreditAmount: expected }, select: { id: true } })
  }

  // THEN the return DDT: the lines sent now (their DDT set once).
  const issued = await issueSourceDdtInCommand(tools, input.company, { type: 'SupplierClaim', id: claimId }, { ...input.ddt, lineIds: going.map((line) => line.id) })
  const status = (await claimInCommand(tx, claimId)).status
  tools.audit({
    action: 'purchasing.claims.returnGoods',
    recordType: CLAIM_RECORD,
    recordId: claimId,
    companyId: claim.companyId,
    siteId: claim.siteId,
    after: { lineIds: going.map((line) => line.id), moveIds: posted.map((move) => move.id), ddtId: issued.ddtId, ddt: issued.number, value: markMoney('cost', linesValue(await tx.supplierClaimLine.findMany({ where: { id: { in: going.map((line) => line.id) } }, select: { creditAmount: true } }))) },
  })
  tools.emit({
    type: 'supplier_claim.goods_returned',
    subject: claimId,
    companyId: claim.companyId,
    siteId: claim.siteId,
    payload: { supplierClaimId: claimId, number: claim.number, status: status as never, lineIds: going.map((line) => line.id), moveIds: posted.map((move) => move.id), ddtId: issued.ddtId },
  })

  // What the return leaves over-reserved (the reservations stay; the stock screens show it).
  const overReserved = []
  for (const key of keys.values()) {
    const facts = await readKeyFacts(tx, key, { withOrders: true })
    const figures = availabilityOf(facts.stock, facts.reservations)
    if (figures.overReserved) overReserved.push({ itemId: key.itemId, itemColourId: key.itemColourId, available: quantityText(figures.available), reserved: quantityText(figures.reserved) })
  }
  return { moveIds: posted.map((move) => move.id), ddt: { id: issued.ddtId, number: issued.number }, claimLinesKeepingOldDdt: [...issued.claimLinesKeepingOldDdt], overReserved }
}

const noDdtRight = (context: OfficeContext, scope: { companyId: string; siteId: string }) =>
  can(actorOf(context), SHIPPING_DDT_ISSUE, scope) ? null : new ForbiddenError('The return DDT needs the permission to issue DDTs (shipping.ddt.issue): ask the warehouse.')

export interface ReturnInput {
  readonly version: number
  /** The lines that go now, each from a place of the site (default every line not gone, from where it lies). */
  readonly lines?: readonly { readonly lineId: string; readonly fromLocationId?: string | undefined }[] | undefined
  readonly ddt: ReturnDdt
}

/** purchasing.claims.return + shipping.ddt.issue: lines of a sent or accepted return claim go back with their DDT. */
export async function returnGoods(files: FilesRuntime, caller: CommandCaller, claimId: string, input: ReturnInput, idempotencyKey?: string, onPdfError?: (error: unknown) => void): Promise<ReturnAnswer> {
  const { context, claim: seen } = await officeClaim(caller, claimId, PURCHASING_CLAIMS_RETURN)
  const forbidden = noDdtRight(context, seen)
  if (forbidden) throw forbidden
  const company = await companyLegalOf(caller, seen.companyId)
  const key = idempotencyKey ?? `g-${newId()}`
  const { result } = await command(
    caller,
    { name: 'purchasing.claims.returnGoods', idempotencyKey, input: { claimId, ...input }, record: { type: 'SupplierClaim', id: claimId, expectedVersion: input.version } },
    async (tools) => {
      const places = new Map((input.lines ?? []).flatMap((line) => (line.fromLocationId ? [[line.lineId, line.fromLocationId] as const] : [])))
      const out = await returnGoodsInCommand(tools, context, claimId, { ...(input.lines ? { lineIds: input.lines.map((line) => line.lineId) } : {}), places, ddt: input.ddt, company, key })
      return { ...out, claim: await detailInCommand(tools, claimId) }
    },
  )
  const printed = await printSourceDdt(files, caller, result.ddt.id, onPdfError)
  return { ...result, ddt: { ...result.ddt, file: printed.file, pdfProblem: printed.pdfProblem } }
}

export interface ReturnToSupplierInput extends Omit<CreateInput, 'kind'> {
  /** The claim's mail to the supplier; null or missing: the supplier learns it from the goods and their DDT. */
  readonly mail?: MailInput | null | undefined
  readonly ddt: ReturnDdt
}

/**
 * purchasing.claims.manage + .return + shipping.ddt.issue: "Return to supplier" in ONE command — the RETURN claim
 * (numbered, its lines from the lot, discrepancies or typed), sent, its goods out and the return DDT, the credit asked
 * from what the stock left at.
 */
export async function returnToSupplier(files: FilesRuntime, caller: CommandCaller, input: ReturnToSupplierInput, idempotencyKey?: string, onPdfError?: (error: unknown) => void): Promise<ReturnAnswer> {
  const context = officeContextOf(caller)
  const key = idempotencyKey ?? `g-${newId()}`
  const { mail, ddt, ...create } = input
  const { result } = await command(caller, { name: 'purchasing.claims.returnToSupplier', idempotencyKey, input }, async (tools) => {
    const claim = await resolveClaim(tools, { ...create, kind: 'RETURN' }, 'RETURN')
    assertMayAll(context, [PURCHASING_CLAIMS_MANAGE, PURCHASING_CLAIMS_RETURN], claim)
    const forbidden = noDdtRight(context, claim)
    if (forbidden) throw forbidden
    if (claim.lines.length === 0) throw refuse([{ path: 'body/lines', message: 'Name the goods that go back: a lot, hides or lines.' }])
    // The company's legal data for the DDT, read from its row in this transaction (the site named it only now).
    const company = await companyLegalOf({ factoryContext: caller.factoryContext, withClient: (work) => work(tools.tx as unknown as FactoryClient) }, claim.companyId)
    const made = await createClaimInCommand(tools, claim, { internalNote: create.internalNote })
    await sendInCommand(tools, context, made.id, { ...(create.remedy ? { remedy: create.remedy } : {}), mail: mail ?? null })
    const places = new Map(claim.lines.flatMap((line, index) => (line.fromLocationId ? [[made.lineIds[index]!, line.fromLocationId] as const] : [])))
    const out = await returnGoodsInCommand(tools, context, made.id, { places, ddt, company, key })
    return { ...out, claim: await detailInCommand(tools, made.id) }
  })
  const printed = await printSourceDdt(files, caller, result.ddt.id, onPdfError)
  return { ...result, ddt: { ...result.ddt, file: printed.file, pdfProblem: printed.pdfProblem } }
}
