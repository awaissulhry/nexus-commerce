import type { Prisma } from '@nexus/factory-db'
import { stepsOfInstructions, type ChecklistStep } from '@nexus/factory-domain/production/checklists/rules'
import type { Reader } from '../scans/store'

/**
 * The steps' reads (B-W2b-47). Every read names its columns, selects no relation and runs as the caller (row-level security
 * keeps a floor device to its own site); inside a command they run on its one connection.
 */

/** The steps of a work order's operation: W2b-4's instructions replace this one read (factory-domain checklists/rules). */
export async function stepsOfOperation(db: Reader, operationId: string): Promise<ChecklistStep[]> {
  const operation = await db.workOrderOperation.findUnique({ where: { id: operationId }, select: { styleRevisionId: true, routingSeq: true } })
  if (!operation) return []
  const step = await db.routingOperation.findFirst({ where: { revisionId: operation.styleRevisionId, seq: operation.routingSeq }, select: { instructions: true } })
  return stepsOfInstructions(step?.instructions ?? null)
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
