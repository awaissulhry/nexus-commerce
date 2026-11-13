import { ConflictError, ForbiddenError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { SALES_RETURNS_DECIDE, SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import type { RemakeOrderBody } from '@nexus/factory-domain/sales/fittings/contracts'
import { REMAKE_OUTCOMES, remakeOutcomeProblem, remakeProfileProblem } from '@nexus/factory-domain/sales/fittings/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { makeManualOrderInCommand } from '../orders/manual'
import { mayOn, officeReturn } from '../returns/access'
import { lockReturn, touchReturn } from '../returns/rma'
import { readLines, readRma, type LineRow, type Reader, type RmaRow } from '../returns/store'
import { styleRefusal } from './store'

/**
 * The remake order of a made-to-measure unit (B-W2b-360; SAL-353 "Remake order for made-to-measure"; the plan: "a remake of a
 * made-to-measure unit from a return, on the profile it was made to or a new one"). W2a refused the REMAKE disposition ("comes
 * later"); B-W2b-346 records the customer's wish (returnsOutcomes.remakeAsked); this step decides it and makes the order:
 *
 *   the decision   W2a's POST /sales/returns/:id/decisions takes REMAKE for a line whose order line is a MADE_TO_MEASURE unit
 *                  whose style's template has its made-to-measure rules on (GATE-MTM; `remakeDecisionFor`, one marked block in
 *                  returns/decide.ts): its goods are scrapped or held in quarantine (REMAKE_OUTCOMES; default scrapped: a unit made
 *                  to a body never goes back into stock), its other checks a Replace's (received, graded, the credit)
 *   GET  /sales/returns/:id/remake-order     the RMA's units: per line its unit (order line, the revision it was made to, the
 *                                            rider's newest, made-to-measure started), its remake order when made, why not yet
 *   POST /sales/returns/:id/remake-order     sales.returns.decide on the RMA, orders.manage and sales.measurements.view over its
 *                                            customer. ONE command: the RMA row locked at the version read (RECEIVED or
 *                                            INSPECTED), the lines named (default every REMAKE line not yet remade) each a new
 *                                            MADE_TO_MEASURE unit of ONE new order of the RMA's company and customer (W2a's
 *                                            manual order in the command, as the replacement order: its number, addresses and
 *                                            terms; no credit check, no approval rule: a remake is not a sale), the same style
 *                                            and colourway, one piece of its base size, at no price, made to the revision it was
 *                                            made to or to the rider's newest (a fitting's new measures); the order waits
 *                                            (PENDING_APPROVAL) while a unit's measures wait for the factory review (B-W2b-358's
 *                                            rule: the review's CONFIRM lets it go on). Each line's remake is the audit row
 *                                            `fittings.remakeOrdered` on the ReturnLine (the database lets ReturnLine.
 *                                            replacementLineId name only a Replace or a Size exchange: schema need), the order's
 *                                            customer reference the RMA's number; the RMA's version moves; remake_order.made and
 *                                            the order's own sales_order.created.
 */

export const REMAKE_ACTION = 'fittings.remakeOrdered'
/** A remade unit's goods, when the decision names no outcome. */
export const REMAKE_DEFAULT_OUTCOME = REMAKE_OUTCOMES[0]

interface UnitFacts {
  readonly orderLine: { readonly id: string; readonly orderId: string; readonly orderNumber: string; readonly seq: number; readonly styleId: string; readonly styleCode: string; readonly colourwayId: string; readonly colourwayCode: string; readonly baseSize: string | null; readonly description: string | null }
  readonly madeTo: { readonly id: string; readonly revision: number; readonly partyId: string; readonly riderName: string; readonly garmentType: string; readonly reviewStatus: string }
  readonly newest: { readonly id: string; readonly revision: number; readonly partyId: string; readonly riderName: string; readonly garmentType: string; readonly reviewStatus: string }
  /** Why a unit of its style cannot be made now (GATE-MTM, PRD-017), or null. */
  readonly refusal: string | null
}

const PROFILE_FACTS = { id: true, revision: true, partyId: true, riderName: true, garmentType: true, reviewStatus: true } as const

/** The made-to-measure unit a return line takes back (its order line's, or its invoice line's order line's), or null. */
export async function unitOfLine(db: Reader, line: Pick<LineRow, 'salesOrderLineId' | 'invoiceLineId'>): Promise<UnitFacts | null> {
  const orderLineId = line.salesOrderLineId ?? (line.invoiceLineId ? ((await db.invoiceLine.findUnique({ where: { id: line.invoiceLineId }, select: { salesOrderLineId: true } }))?.salesOrderLineId ?? null) : null)
  if (!orderLineId) return null
  const orderLine = await db.salesOrderLine.findUnique({ where: { id: orderLineId }, select: { id: true, orderId: true, seq: true, kind: true, styleId: true, colourwayId: true, baseSize: true, description: true, measurementProfileId: true, style: { select: { code: true } }, colourway: { select: { code: true } }, order: { select: { number: true } } } })
  if (!orderLine || orderLine.kind !== 'MADE_TO_MEASURE' || !orderLine.measurementProfileId) return null
  const madeTo = await db.measurementProfile.findUnique({ where: { id: orderLine.measurementProfileId }, select: PROFILE_FACTS })
  if (!madeTo) return null
  const newest = (await db.measurementProfile.findFirst({ where: { partyId: madeTo.partyId, riderName: madeTo.riderName, garmentType: madeTo.garmentType }, orderBy: [{ revision: 'desc' }, { id: 'desc' }], select: PROFILE_FACTS }))!
  return {
    orderLine: { id: orderLine.id, orderId: orderLine.orderId, orderNumber: orderLine.order.number, seq: orderLine.seq, styleId: orderLine.styleId, styleCode: orderLine.style.code, colourwayId: orderLine.colourwayId, colourwayCode: orderLine.colourway.code, baseSize: orderLine.baseSize, description: orderLine.description },
    madeTo: { ...madeTo, reviewStatus: madeTo.reviewStatus as string },
    newest: { ...newest, reviewStatus: newest.reviewStatus as string },
    refusal: await styleRefusal(db, orderLine.styleId, madeTo.garmentType),
  }
}

/**
 * The REMAKE decision of a return line (returns/decide.ts, in its own marked block): the problems at `at` — a made-to-measure unit
 * whose style's template has its made-to-measure rules on, its goods scrapped or held in quarantine. W2a's other checks run as for
 * a Replace beside these.
 */
export async function remakeDecisionFor(db: Reader, line: Pick<LineRow, 'seq' | 'salesOrderLineId' | 'invoiceLineId'>, goodsOutcome: string, at: string): Promise<{ problems: Issue[] }> {
  const unit = await unitOfLine(db, line)
  if (!unit) return { problems: [{ path: `${at}/disposition`, message: `Line ${line.seq} is not a made-to-measure unit: a remake is for made-to-measure units (replace it instead).` }] }
  const problems: Issue[] = []
  if (unit.refusal) problems.push({ path: `${at}/disposition`, message: unit.refusal })
  const outcome = remakeOutcomeProblem(goodsOutcome)
  if (outcome) problems.push({ path: `${at}/goodsOutcome`, message: outcome })
  return { problems }
}

/** The remakes ordered for these return lines (line id → its order, line and revision), from their audit rows. */
async function remakesOf(db: Reader, lineIds: readonly string[]): Promise<Map<string, { orderId: string; number: string; orderLineId: string; profileId: string }>> {
  if (lineIds.length === 0) return new Map()
  const rows = await db.auditLog.findMany({ where: { recordType: 'ReturnLine', recordId: { in: [...lineIds] }, action: REMAKE_ACTION }, select: { recordId: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  const out = new Map<string, { orderId: string; number: string; orderLineId: string; profileId: string }>()
  for (const row of rows) {
    const after = (row.after ?? {}) as { orderId?: unknown; orderNumber?: unknown; orderLineId?: unknown; profileId?: unknown }
    if (typeof after.orderId === 'string' && typeof after.orderNumber === 'string' && typeof after.orderLineId === 'string' && typeof after.profileId === 'string' && !out.has(row.recordId)) {
      out.set(row.recordId, { orderId: after.orderId, number: after.orderNumber, orderLineId: after.orderLineId, profileId: after.profileId })
    }
  }
  return out
}

const RECEIVED = ['RECEIVED', 'INSPECTED']

async function remakeViewOf(db: Reader, rma: RmaRow, may: boolean) {
  const lines = await readLines(db, rma.id)
  const made = await remakesOf(db, lines.map((line) => line.id))
  const orders = new Map((made.size === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: [...new Set([...made.values()].map((entry) => entry.orderId))] } }, select: { id: true, status: true } })).map((row) => [row.id, row.status as string]))
  const views = []
  for (const line of lines) {
    const unit = await unitOfLine(db, line)
    const remade = made.get(line.id)
    const held = remade
      ? null
      : !unit
        ? null
        : unit.refusal ??
          (line.disposition === null ? `Decide line ${line.seq} Remake first (its goods scrapped or held in quarantine).` : line.disposition !== 'REMAKE' ? `Line ${line.seq} is decided ${line.disposition.toLowerCase().replace('_', ' ')}.` : !RECEIVED.includes(rma.status) ? `Return ${rma.number} is ${rma.status.toLowerCase()}.` : null)
    views.push({
      lineId: line.id,
      seq: line.seq,
      description: line.description,
      disposition: line.disposition as string | null,
      goodsOutcome: line.goodsOutcome as string | null,
      unit: unit
        ? {
            orderLineId: unit.orderLine.id,
            orderId: unit.orderLine.orderId,
            orderNumber: unit.orderLine.orderNumber,
            seq: unit.orderLine.seq,
            style: unit.orderLine.styleCode,
            colourway: unit.orderLine.colourwayCode,
            baseSize: unit.orderLine.baseSize,
            madeTo: { id: unit.madeTo.id, revision: unit.madeTo.revision, review: unit.madeTo.reviewStatus },
            newest: { id: unit.newest.id, revision: unit.newest.revision, review: unit.newest.reviewStatus },
            started: unit.refusal === null,
          }
        : null,
      remakeOrder: remade ? { ...remade, status: orders.get(remade.orderId) ?? '' } : null,
      held,
    })
  }
  const open = views.filter((view) => view.unit && !view.remakeOrder && view.held === null && view.disposition === 'REMAKE')
  return {
    returnId: rma.id,
    number: rma.number,
    status: rma.status as string,
    version: rma.version,
    lines: views,
    outcomes: [...REMAKE_OUTCOMES],
    may: { order: may && open.length > 0 },
    why: !may ? 'Making the remake order needs sales.returns.decide on the return, and orders.manage and sales.measurements.view over its customer.' : open.length === 0 ? 'No line decided Remake waits for its remake order.' : null,
  }
}

const mayOrder = (context: Parameters<typeof mayOn>[0], rma: RmaRow): boolean =>
  mayOn(context, SALES_RETURNS_DECIDE, rma) && mayOn(context, ORDERS_MANAGE, rma) && can(actorOf(context), SALES_MEASUREMENTS_VIEW, { companyId: rma.companyId, partyId: rma.partyId })

/** GET /sales/returns/:id/remake-order */
export async function getRemake(caller: CommandCaller, returnId: string) {
  const { context, rma } = await officeReturn(caller, returnId, SALES_RETURNS_VIEW)
  return { remake: await caller.withClient((db) => remakeViewOf(db, rma, mayOrder(context, rma))) }
}

/** POST /sales/returns/:id/remake-order */
export async function makeRemakeOrder(caller: CommandCaller, returnId: string, body: RemakeOrderBody, idempotencyKey?: string) {
  const { context, rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_DECIDE)
  if (!mayOn(context, ORDERS_MANAGE, seen)) throw new ForbiddenError(`Making the remake order needs ${ORDERS_MANAGE} over the customer.`)
  if (!can(actorOf(context), SALES_MEASUREMENTS_VIEW, { companyId: seen.companyId, partyId: seen.partyId })) throw new ForbiddenError("Making the remake order needs sales.measurements.view over the customer (the rider's measures).")
  if (body.promiseDate && body.promiseDate < businessDate(new Date())) throw new ValidationError('The promise date is today or later.', [{ path: 'body/promiseDate', message: 'Today or later.' }])
  const { result } = await command(caller, { name: 'fittings.makeRemakeOrder', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const { tx } = tools
    const rma = await lockReturn(tools, seen.id, body.version, ['RECEIVED', 'INSPECTED'], 'its remake order is made')
    const lines = await readLines(tx, rma.id)
    const made = await remakesOf(tx, lines.map((line) => line.id))
    const named = body.lines ?? lines.filter((line) => line.disposition === 'REMAKE' && !made.has(line.id)).map((line) => ({ lineId: line.id, profileId: undefined as string | undefined }))
    if (named.length === 0) throw new InvalidStateError(`No line of return ${rma.number} decided Remake waits for its remake order.`)
    const problems: Issue[] = []
    const planned: { line: LineRow; unit: UnitFacts; profileId: string; reviewStatus: string; input: { styleId: string; colourwayId: string; sizes: { size: string; quantity: number }[]; unitPrice: string; description: string } }[] = []
    const seenIds = new Set<string>()
    for (const [index, entry] of named.entries()) {
      const at = `body/lines/${index}`
      const line = lines.find((row) => row.id === entry.lineId)
      if (!line) {
        problems.push({ path: `${at}/lineId`, message: 'Not a line of this return.' })
        continue
      }
      if (seenIds.has(line.id)) problems.push({ path: `${at}/lineId`, message: `Line ${line.seq} is named twice.` })
      seenIds.add(line.id)
      if (line.disposition !== 'REMAKE') {
        problems.push({ path: `${at}/lineId`, message: line.disposition === null ? `Decide line ${line.seq} Remake first.` : `Line ${line.seq} is decided ${line.disposition.toLowerCase().replace('_', ' ')}, not Remake.` })
        continue
      }
      if (made.has(line.id)) {
        problems.push({ path: `${at}/lineId`, message: `Line ${line.seq} has its remake order already (${made.get(line.id)!.number}).` })
        continue
      }
      const unit = await unitOfLine(tx, line)
      if (!unit) {
        problems.push({ path: `${at}/lineId`, message: `Line ${line.seq} is not a made-to-measure unit.` })
        continue
      }
      if (unit.refusal) problems.push({ path: `${at}/lineId`, message: unit.refusal })
      const profile = entry.profileId ? (entry.profileId === unit.newest.id ? unit.newest : entry.profileId === unit.madeTo.id ? unit.madeTo : await tx.measurementProfile.findUnique({ where: { id: entry.profileId }, select: PROFILE_FACTS })) : unit.newest
      if (!profile) {
        problems.push({ path: `${at}/profileId`, message: 'Not a measurement profile revision of the rider.' })
        continue
      }
      const wrong = remakeProfileProblem(unit.madeTo, profile, unit.newest.revision)
      if (wrong) problems.push({ path: `${at}/profileId`, message: wrong })
      if (!unit.orderLine.baseSize) problems.push({ path: `${at}/lineId`, message: `The unit of line ${line.seq} names no base size: the remake is made from its base size.` })
      const description = `Remake for ${rma.number} line ${line.seq}: ${unit.orderLine.description ?? `${unit.orderLine.styleCode} ${unit.orderLine.colourwayCode}`}`.slice(0, 300)
      planned.push({ line, unit, profileId: profile.id, reviewStatus: profile.reviewStatus as string, input: { styleId: unit.orderLine.styleId, colourwayId: unit.orderLine.colourwayId, sizes: [{ size: unit.orderLine.baseSize ?? '', quantity: 1 }], unitPrice: '0', description } })
    }
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'Some lines cannot be remade like this.', problems)
    const order = await makeManualOrderInCommand(
      tools,
      {
        companyId: rma.companyId,
        partyId: rma.partyId,
        ...(rma.contactId ? { contactId: rma.contactId } : {}),
        customerRef: (body.customerRef ?? '').trim() || rma.number,
        promiseDate: body.promiseDate ?? null,
        paymentTermsId: null,
        depositPct: null,
        internalNote: (body.internalNote ?? '').trim() || `Remake for return ${rma.number}.`,
        lines: planned.map((entry) => entry.input),
      },
      null,
      // A remake of a returned unit is not new credit: no credit check (and no approval rule), as the replacement order.
      null,
      // B-W2b-360: each line a made-to-measure unit on its revision (W2a's maker writes it so).
      { units: planned.map((entry) => ({ measurementProfileId: entry.profileId, baseSize: entry.unit.orderLine.baseSize })) },
    )
    const orderLines = await tx.salesOrderLine.findMany({ where: { orderId: order.orderId }, select: { id: true, seq: true }, orderBy: { seq: 'asc' } })
    const status = (await tx.salesOrder.findUniqueOrThrow({ where: { id: order.orderId }, select: { status: true } })).status as string
    for (const [index, entry] of planned.entries()) {
      const target = orderLines[index]!
      tools.audit({ action: REMAKE_ACTION, recordType: 'ReturnLine', recordId: entry.line.id, companyId: rma.companyId, siteId: rma.siteId, after: { orderId: order.orderId, orderNumber: order.number, orderLineId: target.id, orderLineSeq: target.seq, profileId: entry.profileId, madeToProfileId: entry.unit.madeTo.id, unitLineId: entry.unit.orderLine.id } })
    }
    await touchReturn(tools, rma)
    tools.audit({ recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, after: { remakeOrderId: order.orderId, remakeOrderNumber: order.number, lineIds: planned.map((entry) => entry.line.id), waits: status === 'PENDING_APPROVAL' } })
    tools.emit({ type: 'remake_order.made', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, orderId: order.orderId, orderNumber: order.number, lineIds: planned.map((entry) => entry.line.id), waits: status === 'PENDING_APPROVAL' } })
    if (planned.some((entry) => entry.reviewStatus !== 'CONFIRMED') && status !== 'PENDING_APPROVAL') throw new ConflictError('The remake order did not wait for the factory review of its measures.')
    return { order: { id: order.orderId, number: order.number, status } }
  })
  const fresh = await caller.withClient(async (db) => remakeViewOf(db, (await readRma(db, seen.id))!, mayOrder(context, seen)))
  return { remake: fresh, order: result.order }
}
