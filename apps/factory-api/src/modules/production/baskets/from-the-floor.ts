import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { LateReason, LateState } from '@nexus/factory-domain/production/baskets/signals'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID } from '../../../core/context'
import { workerGatesFor } from '../../people/privacy/worker-gate'
import { smallAddresses } from '../../product/images/small-pictures'
import { refuse } from '../calls/access'
import { officeOf } from '../scans/access'
import { workerNames } from '../scans/store'
import { reachesWorkOrder, workOrderWhere } from '../work-orders/scope'

/**
 * From the floor (owb- order workflow, S5 fl4 step 4; `_owb-fl-common.md` § 3 "fl4"; design P/fplus.js floorSec "From the
 * floor": Share with the customer / Keep inside; "Changed on the floor"; Will be late with its answer). The base's slot
 * `W/areas/production/baskets/parts/FromTheFloorPart.tsx`, mounted in S2's order Production tab, reads it:
 *
 *   GET  /production/baskets/from-the-floor?salesOrderId=   workorders.view, the brand wall (an order of a customer the reader
 *                                                          does not reach is not found)
 *     photos    the floor's photos of the order's work orders: a floor note's picture (a PHOTO of the work order the floor
 *               uploaded: shared with the site's floor, made by the system for the tablet) and a problem's photo (a PHOTO
 *               of a help call on one of them); `shared` once a copy reached the customer (a PARTNER copy naming it as its
 *               source: today's POST /files/:fileId/use-on, sales or the owner — nothing else shares a floor photo)
 *     changes   "Changed on the floor": baskets moved BACK and route edits, one line per act (its groupId), who did it as the
 *               office reads people (an office user by name; a worker only through the site's worker gate, else "The floor")
 *     late      the Will be late warnings of the order's work orders and their state
 *   POST /production/baskets/late/:id/answer {state}        orders.manage: OPEN → KEPT ("The date holds") or CHANGED ("Change the
 *                                                          promise…": the promise itself is changed by its own command), once
 *                                                          (the base's guard G6); the brand wall: company + that customer
 *
 * The customer reads none of this: no stage notice comes from a move or a warning, and a floor photo reaches them only when sales
 * shares it.
 */

const MAX_ROWS = 100
const basketsOfWords = (codes: readonly string[]): string[] => codes.slice(0, 20)

/** GET /production/baskets/from-the-floor. */
export async function fromTheFloor(caller: CommandCaller, query: { readonly salesOrderId: string }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const order = isUuid(query.salesOrderId) ? await caller.withClient((db) => db.salesOrder.findUnique({ where: { id: query.salesOrderId }, select: { id: true, companyId: true, partyId: true } })) : null
  if (!order || !can(actor, WORKORDERS_VIEW, { companyId: order.companyId, partyId: order.partyId })) throw new NotFoundError('Order not found.')
  const read = await caller.withClient(async (db) => {
    const workOrders = await db.workOrder.findMany({
      where: { AND: [workOrderWhere(actor, WORKORDERS_VIEW), { sizes: { some: { salesOrderLine: { is: { orderId: order.id } } } } }] },
      select: { id: true, siteId: true },
    })
    const workOrderIds = workOrders.map((workOrder) => workOrder.id)
    if (workOrderIds.length === 0) return null
    const bundles = await db.bundle.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { id: true, code: true, workOrderId: true, status: true } })
    const codeOf = new Map(bundles.map((bundle) => [bundle.id, bundle.code]))

    // Photos: the floor notes' pictures (uploaded for the tablet by the system, shared with the site's floor) and problems' photos.
    const calls = await db.helpCall.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { id: true, workOrderId: true, bundleId: true } })
    const callOf = new Map(calls.map((call) => [call.id, call]))
    const photos = await db.storedFile.findMany({
      where: {
        kind: 'PHOTO',
        status: 'AVAILABLE',
        OR: [
          { recordType: 'WorkOrder', recordId: { in: workOrderIds }, createdById: SYSTEM_ACTOR_ID, floorSiteId: { not: null } },
          ...(calls.length > 0 ? [{ recordType: 'HelpCall', recordId: { in: calls.map((call) => call.id) } }] : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: MAX_ROWS,
      select: { id: true, recordType: true, recordId: true, createdAt: true, contentType: true, originalName: true, storeAccountId: true, thumbnailKey: true },
    })
    const sharedIds = new Set(
      photos.length === 0 ? [] : (await db.storedFile.findMany({ where: { sourceFileId: { in: photos.map((photo) => photo.id) }, visibility: { has: 'PARTNER' }, status: { not: 'DELETED' } }, select: { sourceFileId: true } })).map((row) => row.sourceFileId),
    )

    // Changed on the floor: BACK moves and route edits, one line per act.
    const moves = await db.basketMove.findMany({ where: { workOrderId: { in: workOrderIds }, kind: 'BACK' }, orderBy: [{ serverTime: 'desc' }, { id: 'asc' }], take: MAX_ROWS, select: { groupId: true, bundleId: true, reason: true, note: true, serverTime: true, workerId: true, userId: true, siteId: true, toOperation: { select: { name: true } } } })
    const edits = await db.basketRouteEdit.findMany({ where: { workOrderId: { in: workOrderIds } }, orderBy: [{ serverTime: 'desc' }, { id: 'asc' }], take: MAX_ROWS, select: { groupId: true, bundleId: true, kind: true, reason: true, note: true, serverTime: true, workerId: true, userId: true, siteId: true, operation: { select: { name: true } } } })
    const gates = await workerGatesFor(db, [...moves, ...edits].map((row) => row.siteId))
    const workerIds = [...moves, ...edits].filter((row) => gates.at(row.siteId).open).map((row) => row.workerId)
    const names = await workerNames(db, workerIds)
    const userIds = [...new Set([...moves, ...edits].flatMap((row) => (row.userId ? [row.userId] : [])))]
    const users = new Map((userIds.length === 0 ? [] : await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
    const whoOf = (row: { readonly workerId: string | null; readonly userId: string | null; readonly siteId: string }) => (row.userId ? (users.get(row.userId) ?? 'The office') : (gates.at(row.siteId).name(row.workerId, names) ?? 'The floor'))
    const EDIT_WORDS: Record<string, string> = { SKIP: 'Skipped', PUT_BACK: 'Put back', ADD: 'Added', NORMAL: 'Back to the normal route' }
    const groups = new Map<string, { at: Date; kind: 'BACK' | 'ROUTE'; codes: string[]; words: string; reason: string | null; who: string }>()
    for (const move of moves) {
      const group = groups.get(move.groupId) ?? { at: move.serverTime, kind: 'BACK' as const, codes: [], words: `Back to ${move.toOperation?.name ?? 'an earlier step'}${move.note ? `: ${move.note}` : ''}`, reason: move.reason ?? null, who: whoOf(move) }
      group.codes.push(codeOf.get(move.bundleId) ?? move.bundleId)
      groups.set(move.groupId, group)
    }
    for (const edit of edits) {
      const group = groups.get(edit.groupId) ?? { at: edit.serverTime, kind: 'ROUTE' as const, codes: [], words: edit.kind === 'NORMAL' ? EDIT_WORDS.NORMAL! : `${EDIT_WORDS[edit.kind] ?? edit.kind} ${edit.operation.name}${edit.note ? `: ${edit.note}` : ''}`, reason: edit.reason, who: whoOf(edit) }
      if (!group.codes.includes(codeOf.get(edit.bundleId) ?? edit.bundleId)) group.codes.push(codeOf.get(edit.bundleId) ?? edit.bundleId)
      groups.set(edit.groupId, group)
    }

    // Will be late: each warning, about its basket or the whole work order (then the work order's live baskets).
    const lates = await db.floorLateWarning.findMany({ where: { workOrderId: { in: workOrderIds } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: MAX_ROWS, select: { id: true, workOrderId: true, bundleId: true, days: true, reason: true, state: true, createdAt: true, version: true } })

    return {
      photos,
      sharedIds,
      callOf,
      changes: [...groups.values()].sort((a, b) => b.at.getTime() - a.at.getTime()),
      late: lates.map((late) => ({
        id: late.id,
        days: late.days,
        reason: late.reason as LateReason,
        state: late.state as LateState,
        at: toUtcIso(late.createdAt),
        basketCodes: basketsOfWords(late.bundleId ? [codeOf.get(late.bundleId) ?? late.bundleId] : bundles.filter((bundle) => bundle.workOrderId === late.workOrderId && bundle.status === 'ACTIVE').map((bundle) => bundle.code)),
        version: late.version,
      })),
      codeOf,
    }
  })
  if (!read) return { photos: [], changes: [], late: [] }
  const addresses = await smallAddresses(caller, read.photos)
  return {
    photos: read.photos.map((photo) => {
      const call = photo.recordType === 'HelpCall' ? read.callOf.get(photo.recordId) : undefined
      return {
        fileId: photo.id,
        src: addresses.get(photo.id)?.url ?? null,
        at: toUtcIso(photo.createdAt),
        basketCode: call?.bundleId ? (read.codeOf.get(call.bundleId) ?? null) : null,
        workOrderId: call?.workOrderId ?? photo.recordId,
        shared: read.sharedIds.has(photo.id),
      }
    }),
    changes: read.changes.map((change) => ({ at: toUtcIso(change.at), kind: change.kind, basketCodes: basketsOfWords(change.codes), words: change.words, reason: change.reason, who: change.who })),
    late: read.late,
  }
}

/** POST /production/baskets/late/:id/answer: the office answers a late warning once. */
export async function answerLate(caller: CommandCaller, lateId: string, body: { readonly state: 'KEPT' | 'CHANGED'; readonly version?: number | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = isUuid(lateId)
    ? await caller.withClient((db) => db.floorLateWarning.findUnique({ where: { id: lateId }, select: { id: true, state: true, version: true, workOrder: { select: { id: true, companyId: true, siteId: true, partyId: true } } } }))
    : null
  // The brand wall: a warning on a work order of a customer the reader does not reach is not found.
  if (!known || !reachesWorkOrder(actorOf(context), ORDERS_MANAGE, known.workOrder)) throw new NotFoundError('Late warning not found.')
  const answered = { code: 'ANSWERED', message: 'This warning was answered already.', fix: 'Read the order again: it shows the answer.' }
  if (known.state !== 'OPEN') refuse(answered)
  const { result, replayed } = await command(caller, { name: 'production.answerLate', idempotencyKey, input: { lateId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "FloorLateWarning" WHERE "id" = ${lateId}::uuid FOR UPDATE`
    const row = await tx.floorLateWarning.findUnique({ where: { id: lateId }, select: { state: true, version: true } })
    if (!row || row.state !== 'OPEN') refuse(answered)
    if (body.version !== undefined && body.version !== row!.version) refuse({ code: 'STALE', message: `This warning changed since you read it (version ${row!.version}).`, fix: 'Read it again.' })
    await tx.floorLateWarning.update({ where: { id: lateId }, data: { state: body.state, answeredAt: now, answeredById: context.actorId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'production.answerLate', recordType: 'WorkOrder', recordId: known.workOrder.id, companyId: known.workOrder.companyId, siteId: known.workOrder.siteId, before: { lateId, state: 'OPEN' }, after: { lateId, state: body.state, answeredAt: toUtcIso(now) } })
    return { late: { id: lateId, state: body.state as LateState, answeredAt: toUtcIso(now) } }
  })
  return { ...result, replayed }
}
