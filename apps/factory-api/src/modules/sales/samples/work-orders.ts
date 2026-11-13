import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { ORDER_STATUSES_FOR_WORK_ORDERS, openSizes } from '@nexus/factory-domain/production/work-orders/cells'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { WorkOrderBody } from '@nexus/factory-domain/sales/samples/contracts'
import { SALES_SAMPLES_MANAGE } from '@nexus/factory-domain/sales/samples/permissions'
import {
  cellsForLines,
  cellsOf,
  cellsWithoutLine,
  lineRefusal,
  revisionRefusal,
  roundLabel,
  withoutLineRefusal,
  workOrderRefusal,
  type SampleKind,
  type SampleStage,
} from '@nexus/factory-domain/sales/samples/rules'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { hasSeries, readOrderLines, type Reader } from '../../production/work-orders/store'
import { createSampleWorkOrder, createWorkOrder, type SampleWorkOrder } from '../../production/work-orders/work-orders'
import { readRound } from './rounds'
import { databaseRefusal, dayOrNull, officeRound, readRoundRow, refuse, type RoundData } from './store'
// B-W2b-365: the configuration sampled (the cells of a work order without an order line carry it).
import { sampleOptionGroups, sampleOptionValues } from './work-order-options'

/**
 * The sample work order (B-W2b-246; MES-018 "Sample and prototype work orders"; design products.samples › Sample "What was
 * made"): a WorkOrder of kind SAMPLE made by W1's own create (modules/production/work-orders createWorkOrder, its `sample`
 * option): the same lines, cells, site, number series and checks, the round's pinned revision, then W1's release, cutting,
 * bundles, scans and the W2b-1 pay rules exactly as for any other work order (pay reads the scans and the operation's work
 * centre, never the kind). Made, it moves a REQUESTED round to IN_MAKING in the same command.
 *
 *   GET  /sales/samples/rounds/:roundId/work-order-options   what the "Make sample work order" dialog needs: the order lines of
 *                                                            the style it can be made on (its customer's, when it has one),
 *                                                            what each would take, the plants, what stops it, in words
 *   POST /sales/samples/rounds/:roundId/work-orders          sales.samples.manage + workorders.manage at the making site
 *
 * A round is made on the order that charges its samples (a SIZE_GRID line of the style), or, B-W2b-284 (W2b-5 wave 34: a
 * SAMPLE work order's cell may name no order line), without one: an internal or uncharged proto, fit or salesman round
 * (`withoutLineRefusal`) makes its work order from its own cells, each a colourway and size of the style (a cell of "any
 * colourway" takes the colourway asked, else the style's only active one). Such a work order ships on no order's shipment,
 * is invoiced on no order and comes back on no return (shipping, invoicing and returns refuse it in words). B-W2b-365: its
 * cells carry the configuration sampled (`optionValueIds`, ./work-order-options), as an order line's cells carry its picks.
 */

const LINE_LIMIT = 100

/** The round's style as the work order without an order line needs it: its code, size range and active colourways. */
async function styleFacts(db: Reader, round: Pick<RoundData, 'styleId'>) {
  const style = await db.style.findUniqueOrThrow({ where: { id: round.styleId }, select: { id: true, code: true, sizes: true } })
  const colourways = await db.colourway.findMany({ where: { styleId: style.id, status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  return { style, colourways }
}

const chargedOf = (round: Pick<RoundData, 'chargeAmountMinor'>): boolean => round.chargeAmountMinor !== null

/** B-W2b-284: why this round's work order cannot be made without an order line (null: it can). */
const noLineRefusalOf = (round: RoundData) =>
  withoutLineRefusal({ number: round.number, stage: round.stage as SampleStage, kind: round.kind as SampleKind, charged: chargedOf(round) })

/** GET /sales/samples/rounds/:roundId/work-order-options */
export async function workOrderOptions(caller: CommandCaller, roundId: string) {
  const { context, round } = await officeRound(caller, roundId)
  return caller.withClient(async (db) => {
    const revision = await db.styleRevision.findUniqueOrThrow({ where: { id: round.revisionId }, select: { id: true, revision: true, status: true } })
    const blockers: string[] = []
    const warnings: string[] = []
    const stage = workOrderRefusal({ number: round.number, stage: round.stage as SampleStage })
    if (stage) blockers.push(stage.message)
    const obsolete = revisionRefusal(revision)
    if (obsolete) blockers.push(`${obsolete.message} Change the round's revision first (while it is requested).`)
    if (!can(actorOf(context), WORKORDERS_MANAGE, { companyId: round.companyId })) blockers.push('Making a sample work order also needs workorders.manage (the production office).')
    if (!(await hasSeries(db, round.companyId, 'WORK_ORDER'))) blockers.push('The company has no active work order number series: an admin sets one up under Numbering (kind WORK_ORDER).')
    if (revision.status === 'DRAFT') warnings.push(`Revision ${revision.revision} is a draft: the sample work order is made now, and released once the revision is released.`)

    const ids = (
      await db.salesOrderLine.findMany({
        where: { styleId: round.styleId, kind: 'SIZE_GRID', companyId: round.companyId, ...(round.partyId ? { partyId: round.partyId } : {}), order: { status: { in: [...ORDER_STATUSES_FOR_WORK_ORDERS] } } },
        select: { id: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: LINE_LIMIT,
      })
    ).map((line) => line.id)
    const lines = [...(await readOrderLines(db, ids)).values()].filter((line) => can(actorOf(context), WORKORDERS_VIEW, { companyId: line.companyId }))
    // B-W2b-284: an internal or uncharged proto, fit or salesman round may be made without an order line.
    const noLine = noLineRefusalOf(round)
    const { colourways } = await styleFacts(db, round)
    const named = [...new Set(cellsOf(round.cells).flatMap((cell) => (cell.colourwayId ? [cell.colourwayId] : [])))]
    const colourwayOf = new Map((named.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: named } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const only = colourways.length === 1 ? colourways[0]! : null
    if (lines.length === 0 && noLine !== null) {
      blockers.push(
        round.partyId
          ? "The round's customer has no confirmed order line of this style to make the samples on: a work order cell names the order that charges the samples (add a line for them to an order)."
          : 'No confirmed order line of this style to make the samples on: a work order cell names a sales order line.',
      )
    }
    const cells = cellsOf(round.cells)
    const sites = await db.site.findMany({ where: { companyId: round.companyId, kind: 'PLANT', status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } })
    return {
      round: { id: round.id, number: round.number, stage: round.stage, version: round.version, revision, partyId: round.partyId },
      lines: lines.map((line) => ({
        id: line.id,
        orderId: line.orderId,
        orderNumber: line.orderNumber,
        seq: line.seq,
        partyId: line.partyId,
        colourwayId: line.colourwayId,
        colourwayCode: line.colourwayCode,
        styleRevisionId: line.styleRevisionId,
        siteId: line.siteId,
        open: openSizes(line),
        proposed: cellsForLines(cells, [{ id: line.id, colourwayId: line.colourwayId, orderNumber: line.orderNumber, seq: line.seq }], 'lines').lines[0]!.sizes,
      })),
      sites: sites.filter((site) => can(actorOf(context), WORKORDERS_MANAGE, { companyId: round.companyId, siteId: site.id })),
      withoutLine: {
        allowed: noLine === null,
        refusal: noLine,
        cells: cells.map((cell) => ({
          colourwayId: cell.colourwayId ?? only?.id ?? null,
          colourwayCode: cell.colourwayId ? (colourwayOf.get(cell.colourwayId) ?? null) : (only?.code ?? null),
          size: cell.size,
          quantity: cell.quantity,
        })),
        colourways,
        options: await sampleOptionGroups(db, round.styleId), // B-W2b-365
      },
      blockers,
      warnings,
    }
  })
}

/** POST /sales/samples/rounds/:roundId/work-orders */
export async function makeWorkOrder(caller: CommandCaller, roundId: string, body: WorkOrderBody, idempotencyKey?: string) {
  const { context, round } = await officeRound(caller, roundId, SALES_SAMPLES_MANAGE)
  refuse(workOrderRefusal({ number: round.number, stage: round.stage as SampleStage }))
  if (!can(actorOf(context), WORKORDERS_MANAGE, { companyId: round.companyId })) {
    throw new ForbiddenError('Making a sample work order also needs workorders.manage (the production office).')
  }
  const label = `Sample round ${round.number} · ${roundLabel(round.kind as SampleKind, round.roundNo)}`
  const note = body.note === undefined || body.note === null || body.note.trim() === '' ? label : body.note
  const due = body.dueDate ? { dueDate: body.dueDate } : round.dueDate ? { dueDate: dayOrNull(round.dueDate)! } : {}
  // The round's own writes in the work order's command: REQUESTED → IN_MAKING, its audit row and event.
  const sample = (revisionId: string): SampleWorkOrder => ({
    roundId: round.id,
    revisionId,
    version: body.version ?? round.version,
    inCommand: async (tools: CommandTools, made) => {
      const { tx } = tools
      const row = (await readRoundRow(tx, round.id))!
      refuse(workOrderRefusal({ number: row.number, stage: row.stage as SampleStage }))
      const stage = row.stage === 'REQUESTED' ? 'IN_MAKING' : row.stage
      if (stage !== row.stage) await tx.sampleRound.update({ where: { id: row.id }, data: { stage }, select: { id: true } })
      tools.audit({ action: 'sales.samples.makeWorkOrder', recordType: 'SampleRound', recordId: row.id, companyId: row.companyId, before: { stage: row.stage }, after: { stage, workOrderId: made.id, workOrderNumber: made.number } })
      tools.emit({
        type: 'sample_round.changed',
        subject: row.id,
        companyId: row.companyId,
        payload: { sampleRoundId: row.id, number: row.number, styleId: row.styleId, stage, previousStage: row.stage, change: 'WORK_ORDER', workOrderId: made.id },
      })
    },
  })
  if (!body.lines) return makeWithoutLine(caller, round, body, idempotencyKey, { note, due, sample })
  if (body.colourwayId !== undefined) throw new ValidationError('A colourway is named only for a work order without an order line.', [{ path: 'body/colourwayId', message: "Leave it out: each order line makes its own colourway." }])
  // B-W2b-365: on order lines each cell takes the options chosen on its line.
  if (body.optionValueIds !== undefined) throw new ValidationError('Options are named only for a work order without an order line.', [{ path: 'body/optionValueIds', message: 'Leave them out: each cell takes the options chosen on its order line.' }])
  const lineIds = body.lines.map((line) => line.salesOrderLineId)
  const named = new Set<string>()
  body.lines.forEach((line, index) => {
    if (named.has(line.salesOrderLineId)) throw new ValidationError('An order line is named twice.', [{ path: `body/lines/${index}/salesOrderLineId`, message: 'Name each order line once.' }])
    named.add(line.salesOrderLineId)
  })
  const { revision, lines } = await caller.withClient(async (db) => ({
    revision: await db.styleRevision.findUniqueOrThrow({ where: { id: round.revisionId }, select: { id: true, revision: true, status: true } }),
    lines: await readOrderLines(db, lineIds),
  }))
  refuse(revisionRefusal(revision))
  for (const lineId of lineIds) {
    const line = lines.get(lineId)
    if (!line || !can(actorOf(context), WORKORDERS_VIEW, { companyId: line.companyId })) throw new NotFoundError('Sales order line not found.')
    refuse(lineRefusal(round, line))
  }
  // Each line's sizes: as named, else the round's cells of its colourway (W1 checks them against what is open on the line).
  const asked = body.lines
  const auto = asked.map((line, index) => ({ line, index })).filter(({ line }) => !line.sizes)
  let planned = new Map<string, { size: string; quantity: number }[]>()
  if (auto.length > 0) {
    const plan = cellsForLines(
      cellsOf(round.cells),
      asked.map((line) => {
        const row = lines.get(line.salesOrderLineId)!
        return { id: row.id, colourwayId: row.colourwayId, orderNumber: row.orderNumber, seq: row.seq }
      }),
      'body/lines',
    )
    const autoPaths = new Set(auto.map(({ index }) => `body/lines/${index}`))
    const problems = plan.problems.filter((problem) => problem.path === 'body/lines' || autoPaths.has(problem.path))
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : "The round's cells do not fit these order lines.", problems)
    planned = new Map(plan.lines.map((line) => [line.salesOrderLineId, line.sizes]))
  }
  const input = {
    ...(body.siteId ? { siteId: body.siteId } : {}),
    styleRevisionId: round.revisionId,
    ...due,
    ...(body.priority !== undefined ? { priority: body.priority } : {}),
    note,
    lines: asked.map((line) => ({ salesOrderLineId: line.salesOrderLineId, sizes: line.sizes ?? planned.get(line.salesOrderLineId)! })),
  }
  const { workOrder } = await createWorkOrder(caller, input, idempotencyKey, sample(round.revisionId)).catch(databaseRefusal)
  return { workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status }, round: await readRound(caller, round.id) }
}

/**
 * B-W2b-284: the sample work order of an internal or uncharged proto, fit or salesman round, made without an order line from the
 * round's own cells (W1's createSampleWorkOrder: its cells name no order line and no party).
 */
async function makeWithoutLine(
  caller: CommandCaller,
  round: RoundData,
  body: WorkOrderBody,
  idempotencyKey: string | undefined,
  made: { note: string; due: { dueDate?: BusinessDate }; sample: (revisionId: string) => SampleWorkOrder },
) {
  refuse(noLineRefusalOf(round))
  const { revision, style, colourways, optionValueIds } = await caller.withClient(async (db) => ({
    revision: await db.styleRevision.findUniqueOrThrow({ where: { id: round.revisionId }, select: { id: true, revision: true, status: true } }),
    ...(await styleFacts(db, round)),
    // B-W2b-365: the configuration sampled, checked against the style's offer.
    optionValueIds: await sampleOptionValues(db, round.styleId, body.optionValueIds, 'body/optionValueIds'),
  }))
  refuse(revisionRefusal(revision))
  const plan = cellsWithoutLine(cellsOf(round.cells), { code: style.code, sizes: style.sizes, colourwayIds: colourways.map((row) => row.id) }, body.colourwayId ?? null, 'body')
  if (plan.problems.length > 0) throw new ValidationError(plan.problems.length === 1 ? plan.problems[0]!.message : "The round's cells cannot be made like this.", plan.problems)
  const input = {
    ...(body.siteId ? { siteId: body.siteId } : {}),
    ...made.due,
    ...(body.priority !== undefined ? { priority: body.priority } : {}),
    note: made.note,
    cells: plan.cells.map((cell) => ({ ...cell, optionValueIds })),
  }
  const { workOrder } = await createSampleWorkOrder(caller, input, idempotencyKey, { ...made.sample(round.revisionId), styleId: round.styleId, companyId: round.companyId }).catch(databaseRefusal)
  return { workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status }, round: await readRound(caller, round.id) }
}
