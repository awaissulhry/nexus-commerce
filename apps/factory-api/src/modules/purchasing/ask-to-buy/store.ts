import type { Prisma } from '@nexus/factory-db'
import type { Reader } from '../store'

/**
 * Ask to buy's reads (B-W2b-332; factory-db buying-depth.prisma PurchaseRequest): the columns every read names, and the
 * people's names a request shows ("Anna asked"; an office person, never a floor worker; no figure per person anywhere).
 * Row-level security decides what a reader finds; who may see a request is the module's (./access.ts).
 */

export const ASKED_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  requestedById: true,
  requestedAt: true,
  source: true,
  itemId: true,
  itemColourId: true,
  description: true,
  quantity: true,
  uom: true,
  needDate: true,
  reason: true,
  workOrderId: true,
  shortage: true,
  status: true,
  approvalTaskId: true,
  rejectedAt: true,
  rejectedById: true,
  rejectReason: true,
  convertedAt: true,
  convertedById: true,
  purchaseOrderLineId: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  createdAt: true,
  workOrder: { select: { id: true, number: true } },
} as const satisfies Prisma.PurchaseRequestSelect
export type AskedRow = Prisma.PurchaseRequestGetPayload<{ select: typeof ASKED_COLUMNS }>

/** The office people's names (displayName), by id. */
export async function namesOf(db: Reader, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}
