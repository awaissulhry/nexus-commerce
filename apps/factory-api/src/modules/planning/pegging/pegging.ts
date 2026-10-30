import { z } from 'zod'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import type { Prisma } from '@nexus/factory-db'
import type { CommandCaller } from '../../../core/command'
import { assertMayAt, officeContextOf, siteFor } from '../access'
import { pegDemand } from '../contract'
import { PEG_COLUMNS, pegTreeView } from './read'

/**
 * GET /planning/pegging (B-W2a-22; PLN-071 "pegging across many orders"; design planning.mrp Why drawer "pegging tree up
 * to the customer order or MTM unit"; planning.view over the run's site): the pegging of ONE of — a requirement (its
 * run), an order line, a work order, a purchase order line or a reservation (the site's latest DONE run, or `runId`) —
 * as a tree: each demand (order line × size, or a work order's pieces of it) with the supplies that cover it. So a
 * purchase order line answers which orders wait for it, and an order line which supplies its materials count on.
 */

export const peggingContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    runId: id().optional(),
    requirementId: id().optional(),
    salesOrderLineId: id().optional(),
    workOrderId: id().optional(),
    purchaseOrderLineId: id().optional(),
    reservationId: id().optional(),
  }),
  response: {
    200: output({
      run: output({ id: id(), siteId: id(), status: z.string(), startedAt: instant(), finishedAt: instant().nullable() }).nullable(),
      demands: z.array(pegDemand),
    }),
  },
})

type PeggingQuery = { readonly siteId?: string | undefined; readonly runId?: string | undefined; readonly requirementId?: string | undefined; readonly salesOrderLineId?: string | undefined; readonly workOrderId?: string | undefined; readonly purchaseOrderLineId?: string | undefined; readonly reservationId?: string | undefined }

const BY = ['requirementId', 'salesOrderLineId', 'workOrderId', 'purchaseOrderLineId', 'reservationId'] as const

export async function pegging(caller: CommandCaller, query: PeggingQuery) {
  const context = officeContextOf(caller)
  const named = BY.filter((key) => query[key] !== undefined)
  if (named.length !== 1) throw new ValidationError('Name one of a requirement, an order line, a work order, a purchase order line or a reservation.', [{ path: 'querystring', message: `Exactly one of ${BY.join(', ')}.` }])
  const by = named[0]!
  return caller.withClient(async (db) => {
    let runId: string | null
    if (by === 'requirementId') {
      const row = isUuid(query.requirementId!) ? await db.materialRequirement.findUnique({ where: { id: query.requirementId! }, select: { runId: true, run: { select: { companyId: true, siteId: true } } } }) : null
      assertMayAt(context, PLANNING_VIEW, row ? row.run : null, 'Requirement')
      runId = row!.runId
    } else if (query.runId) {
      const row = await db.planningRun.findUnique({ where: { id: query.runId }, select: { id: true, companyId: true, siteId: true } })
      assertMayAt(context, PLANNING_VIEW, row, 'Planning run')
      runId = row!.id
    } else {
      if (!query.siteId) throw new ValidationError('Name the site (or the run).', [{ path: 'querystring/siteId', message: 'The site whose latest plan to read.' }])
      const site = await siteFor(caller, query.siteId, PLANNING_VIEW, db)
      runId = (await db.planningRun.findFirst({ where: { siteId: site.id, status: 'DONE' }, select: { id: true }, orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }] }))?.id ?? null
    }
    if (runId === null) return { run: null, demands: [] }
    const run = await db.planningRun.findUniqueOrThrow({ where: { id: runId }, select: { id: true, siteId: true, status: true, startedAt: true, finishedAt: true } })
    const where: Prisma.RequirementPeggingWhereInput = { runId, [by]: query[by] }
    const rows = await db.requirementPegging.findMany({ where, select: PEG_COLUMNS, orderBy: [{ requirementId: 'asc' }, { seq: 'asc' }], take: 2000 })
    const firm = rows.length === 0 ? [] : await db.materialRequirement.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.requirementId))] } }, select: { id: true, firmedAt: true } })
    return {
      run: { id: run.id, siteId: run.siteId, status: run.status, startedAt: toUtcIso(run.startedAt), finishedAt: run.finishedAt ? toUtcIso(run.finishedAt) : null },
      demands: await pegTreeView(db, rows, new Map(firm.map((row) => [row.id, row.firmedAt !== null]))),
    }
  })
}
