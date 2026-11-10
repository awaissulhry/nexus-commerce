import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { ORDER_STATUSES_FOR_WORK_ORDERS, openSizes } from '@nexus/factory-domain/production/work-orders/cells'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { WorkOrderBody } from '@nexus/factory-domain/sales/samples/contracts'
import { SALES_SAMPLES_MANAGE } from '@nexus/factory-domain/sales/samples/permissions'
import { cellsForLines, cellsOf, lineRefusal, revisionRefusal, roundLabel, workOrderRefusal, type SampleKind, type SampleStage } from '@nexus/factory-domain/sales/samples/rules'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { hasSeries, readOrderLines } from '../../production/work-orders/store'
import { createWorkOrder } from '../../production/work-orders/work-orders'
import { readRound } from './rounds'
import { databaseRefusal, dayOrNull, officeRound, readRoundRow, refuse } from './store'

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
 * A work order cell names a sales order line (WorkOrderSize.salesOrderLineId is NOT NULL, W1): a round is made on the order
 * that charges its samples (a SIZE_GRID line of the style). An internal or uncharged round has no such line: a schema need of
 * B-W2b-212, named in the notes.
 */

const LINE_LIMIT = 100

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
    if (lines.length === 0) {
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
  const auto = body.lines.map((line, index) => ({ line, index })).filter(({ line }) => !line.sizes)
  let planned = new Map<string, { size: string; quantity: number }[]>()
  if (auto.length > 0) {
    const plan = cellsForLines(
      cellsOf(round.cells),
      body.lines.map((line) => {
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
  const label = `Sample round ${round.number} · ${roundLabel(round.kind as SampleKind, round.roundNo)}`
  const input = {
    ...(body.siteId ? { siteId: body.siteId } : {}),
    styleRevisionId: round.revisionId,
    ...(body.dueDate ? { dueDate: body.dueDate } : round.dueDate ? { dueDate: dayOrNull(round.dueDate)! } : {}),
    ...(body.priority !== undefined ? { priority: body.priority } : {}),
    note: body.note === undefined || body.note === null || body.note.trim() === '' ? label : body.note,
    lines: body.lines.map((line) => ({ salesOrderLineId: line.salesOrderLineId, sizes: line.sizes ?? planned.get(line.salesOrderLineId)! })),
  }
  const { workOrder } = await createWorkOrder(caller, input, idempotencyKey, {
    roundId: round.id,
    revisionId: round.revisionId,
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
  }).catch(databaseRefusal)
  return { workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status }, round: await readRound(caller, round.id) }
}
