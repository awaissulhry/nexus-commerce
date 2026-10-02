/**
 * MCP full control P3 — the bulk operation history, read in one place: the history page (GET
 * /api/bulk-operations/history and /api/bulk-operations/:id/items, bulk-operations.routes.ts) and Claude's
 * `job-history` read call these.
 *
 * The jobs and their items come from BulkActionService (listJobs, listItems); the history adds who ran each job, by
 * name. Moved from the route without a change in behaviour (bulk-history.service.vitest.test.ts holds the route's
 * answers byte for byte). Rollback, retry and cancel are writes and stay in the route.
 */

import prisma from '../../db.js'
import { BulkActionService } from '../bulk-action.service.js'

const bulkActionService = new BulkActionService(prisma)

/** The history's filters. `status` also takes 'active' (not finished yet) and 'terminal' (finished in any way). */
export interface BulkHistoryQuery {
  /** 50 by default, held between 1 and 100 (listJobs). */
  limit?: number
  status?: string
  actionType?: string
  since?: Date
}

/** The newest bulk jobs, each with `createdByName`: who ran it (a person's name, or a label such as "Schedule"). */
export async function bulkHistory(filters: BulkHistoryQuery) {
  return bulkActionService.withActorNames(await bulkActionService.listJobs(filters))
}

/**
 * One job's items in the order they ran, each with its SKU and channel label (null when the product or listing has
 * since been deleted). `limit`: 200 by default, held between 1 and 1000 (listItems).
 */
export async function bulkJobItems(jobId: string, filters: { status?: string; limit?: number }) {
  return bulkActionService.listItems(jobId, filters)
}
