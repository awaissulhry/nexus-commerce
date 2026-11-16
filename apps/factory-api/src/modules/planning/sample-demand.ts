import { OPEN_WORK_ORDER_STATUSES, type PlanRevision, type PlanSampleWorkOrder, type WorkOrderIssue } from '@nexus/factory-domain/planning/explode'
import { readLines } from '../product/bom/store'
import { withoutCustomerSupplied } from '../product/bom-lines/store'
import { dayOf, issuedTo, type Reader, type SiteRow } from './store'
// B-W2b-GB29 (G226 × G222): a sample work order's leather takes an accepted cutting loss too, as the orders' revisions do.
import { planningLossOf, withPlanningLoss } from './leather/planning-loss'

/**
 * B-W2b-GB29 (G222, B-W2b-284's gap; B-W2b-319's demand view said SAMPLES "never planned"): the open SAMPLE work orders of
 * the site whose cells name no order line (an internal or uncharged round: PROTO, FIT, SALESMAN) are demand of their own in
 * every plan (the run, readiness, the shortage list): the work order's cells in its revision (its own, else the style's
 * RELEASED one), needed on its scheduled start (the planning board) else its due day, less what was issued to it
 * (factory-domain planning/explode `sampleOrderLines`). A sample work order made on an order line is that line's work order
 * (W1's reading, unchanged). Three reads; no permission (the plan's inputs).
 */
export async function readSampleWorkOrders(db: Reader, site: Pick<SiteRow, 'id'>): Promise<{ samples: PlanSampleWorkOrder[]; issues: WorkOrderIssue[]; revisions: PlanRevision[] }> {
  const rows = await db.workOrder.findMany({
    where: { siteId: site.id, kind: 'SAMPLE', status: { in: [...OPEN_WORK_ORDER_STATUSES] }, sizes: { some: {}, every: { salesOrderLineId: null } } },
    select: {
      id: true,
      number: true,
      status: true,
      styleId: true,
      styleRevisionId: true,
      dueDate: true,
      sampleRound: { select: { id: true, number: true, dueDate: true } },
      sizes: { select: { id: true, colourwayId: true, size: true, quantity: true }, orderBy: [{ colourwayId: 'asc' }, { size: 'asc' }, { id: 'asc' }] },
    },
    orderBy: { number: 'asc' },
  })
  if (rows.length === 0) return { samples: [], issues: [], revisions: [] }
  const unpinned = [...new Set(rows.filter((row) => row.styleRevisionId === null).map((row) => row.styleId))]
  const released = unpinned.length === 0 ? [] : await db.styleRevision.findMany({ where: { styleId: { in: unpinned }, status: 'RELEASED' }, select: { id: true, styleId: true }, orderBy: { revision: 'desc' } })
  const releasedOf = new Map<string, string>()
  for (const revision of released) if (!releasedOf.has(revision.styleId)) releasedOf.set(revision.styleId, revision.id)
  const samples: PlanSampleWorkOrder[] = rows.map((row) => {
    const due = row.dueDate ?? row.sampleRound?.dueDate ?? null
    return {
      workOrderId: row.id,
      workOrderNumber: row.number,
      status: row.status,
      roundId: row.sampleRound?.id ?? null,
      roundNumber: row.sampleRound?.number ?? null,
      styleId: row.styleId,
      revisionId: row.styleRevisionId ?? releasedOf.get(row.styleId) ?? null,
      dueDate: due ? dayOf(due) : null,
      cells: row.sizes.map((cell) => ({ id: cell.id, colourwayId: cell.colourwayId, size: cell.size, pieces: cell.quantity })),
    }
  })
  const revisions: PlanRevision[] = []
  for (const revisionId of [...new Set(samples.flatMap((sample) => (sample.revisionId ? [sample.revisionId] : [])))].sort()) {
    revisions.push({ id: revisionId, lines: await withoutCustomerSupplied(db, revisionId, await readLines(db, revisionId)) })
  }
  // B-W2b-GB29 (G226): the accepted cutting loss on the leather lines of a revision released before it (store.ts readDemand's rule).
  const loss = await planningLossOf(db, revisions.map((revision) => revision.id), revisions.flatMap((revision) => revision.lines.map((line) => line.itemId)))
  for (const [index, revision] of revisions.entries()) revisions[index] = { ...revision, lines: withPlanningLoss(loss, revision.id, revision.lines) }
  return { samples, issues: await issuedTo(db, site.id, samples.map((sample) => sample.workOrderId)), revisions }
}
