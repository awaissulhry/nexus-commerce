import type { Prisma } from '@nexus/factory-db'
import { checklistOfLines, type MarkedStep } from '@nexus/factory-domain/production/instructions/rules'
import { operationPlaceOf, publishedStepsOf } from '../instructions/lookup'
import type { Reader } from '../scans/store'

/**
 * The steps' reads (B-W2b-47). Every read names its columns, selects no relation and runs as the caller (row-level security
 * keeps a floor device to its own site); inside a command they run on its one connection.
 */

/**
 * The steps of a work order's operation (B-W2b-214, WI1:01): the steps of the PUBLISHED version of the operation's work
 * instruction (its revision's own, else the one for every style; instructions/lookup.ts), each with its icon and critical
 * point, the words in `language` when asked; until an instruction of the operation is published, the `[ ] CODE words` lines
 * typed in the routing step (B-W2b-47; B-W2b-74: an unplanned operation has no routing step, so no typed lines). A step's
 * code is what a tick names (OperationChecklistResult.stepCode). The tick and hold rules are factory-domain checklists/rules'.
 */
export async function stepsOfOperation(db: Reader, operationId: string, language?: string | null): Promise<MarkedStep[]> {
  const place = await operationPlaceOf(db, operationId)
  if (!place) return []
  const published = await publishedStepsOf(db, place, language)
  if (published) return published
  return place.routingSeq === null ? [] : checklistOfLines(place.typedLines)
}

export const TICK = {
  id: true,
  workOrderId: true,
  workOrderOperationId: true,
  bundleId: true,
  stepCode: true,
  outcome: true,
  workerId: true,
  stationId: true,
  deviceId: true,
  clientEventId: true,
  deviceTime: true,
  serverTime: true,
} as const satisfies Prisma.OperationChecklistResultSelect
export type TickRow = Prisma.OperationChecklistResultGetPayload<{ select: typeof TICK }>

/** Every tick of the bundle at the operation, oldest first. */
export async function readTicks(db: Reader, bundleId: string, operationId: string): Promise<TickRow[]> {
  return db.operationChecklistResult.findMany({ where: { bundleId, workOrderOperationId: operationId }, select: TICK, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })
}

export async function readTickByClient(db: Reader, deviceId: string, clientEventId: string): Promise<TickRow | null> {
  return db.operationChecklistResult.findFirst({ where: { deviceId, clientEventId }, select: TICK })
}

/** Every tick of the bundle at any operation, oldest first (the work order record). */
export async function readBundleTicks(db: Reader, bundleId: string): Promise<TickRow[]> {
  return db.operationChecklistResult.findMany({ where: { bundleId }, select: TICK, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })
}
