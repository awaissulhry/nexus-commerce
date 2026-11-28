import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { BASKET_SIGNAL_LIMITS, SIGNAL_REFUSALS } from '@nexus/factory-domain/production/baskets/signals'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { floorOf, refuse } from '../calls/access'
import { namedWorker } from '../calls/station'
import type { FlagsBody } from './signals-contract'

/**
 * Do this first (owb- order workflow, S5 fl3 step 3; design "leader row: Do this first"; `_owb-fl-common.md` § 1 D: a leader
 * act, floor.lead as help calls check it today):
 *
 *   POST /production/baskets/flags   { bundleIds 1..50, kind FIRST, on, clientEventId }: on → one open FIRST per basket (a
 *                                    basket that has one stays); off → its open one cleared, once (the …_floor_baskets_2
 *                                    guards: a cleared flag never changes again). One command, one Undo-able act.
 *
 * Baskets of the device's own site only (another site's: not found). Who set or cleared it is named only where the site names
 * workers (and the worker acknowledged the notice); the device always. The basket read (fl1) and the lists show the flag.
 */

export const FLOOR_LEAD = 'floor.lead' as Permission

const keyOf = (context: FloorContext, clientEventId: string) => `${context.deviceId}.${clientEventId}`

export interface SignalBasket {
  readonly id: string
  readonly code: string
  readonly siteId: string
  readonly workOrderId: string
  readonly companyId: string
}

/**
 * The baskets named, each of the device's site and reached with floor.lead (a basket the device cannot see, or of another site:
 * not found). At most 50, each once.
 */
export async function leaderBaskets(caller: CommandCaller, context: FloorContext, ids: readonly string[]): Promise<SignalBasket[]> {
  const wanted = [...new Set(ids)]
  if (wanted.length > BASKET_SIGNAL_LIMITS.bundles) refuse(SIGNAL_REFUSALS.TOO_MANY)
  const rows = await caller.withClient((db) => db.bundle.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, siteId: true, workOrderId: true, workOrder: { select: { companyId: true } } } }))
  const found = new Map(rows.map((row) => [row.id, row]))
  return wanted.map((id) => {
    const row = found.get(id)
    if (!row || row.siteId !== context.siteId || !can(actorOf(context), FLOOR_LEAD, { companyId: row.workOrder.companyId, siteId: row.siteId })) throw new NotFoundError('Basket not found.')
    return { id: row.id, code: row.code, siteId: row.siteId, workOrderId: row.workOrderId, companyId: row.workOrder.companyId }
  })
}

/** POST /production/baskets/flags, or the offline queue (production.baskets.flag). */
export async function setFlags(caller: CommandCaller, body: FlagsBody, key?: string) {
  const context = floorOf(caller)
  const baskets = await leaderBaskets(caller, context, body.bundleIds)
  const deviceTime = body.occurredAt ? parseInstant(body.occurredAt) : null
  const { result, replayed } = await command(
    caller,
    { name: 'production.flagBaskets', idempotencyKey: key ?? keyOf(context, body.clientEventId), input: body, ...(deviceTime ? { deviceTime } : {}) },
    async (tools) => {
      const { tx, now } = tools
      const ids = baskets.map((basket) => basket.id)
      // The open flags of these baskets, locked: a second leader at the same moment waits, then sees this one's.
      await tx.$queryRaw`SELECT "id" FROM "BasketFlag" WHERE "bundleId" = ANY(${ids}::uuid[]) AND "kind"::text = ${body.kind} AND "clearedAt" IS NULL FOR UPDATE`
      const open = await tx.basketFlag.findMany({ where: { bundleId: { in: ids }, kind: body.kind, clearedAt: null }, select: { id: true, bundleId: true, version: true } })
      const openOf = new Map(open.map((flag) => [flag.bundleId, flag]))
      const named = await namedWorker(tx, context.siteId, context.actorId)
      let changed = 0
      if (body.on) {
        // One act marks many baskets under one client event id (the unique key is device + event + basket).
        const toSet = baskets.filter((basket) => !openOf.has(basket.id))
        for (const basket of toSet) {
          const flagId = newId()
          await tx.basketFlag.create({
            data: {
              id: flagId,
              companyId: basket.companyId,
              siteId: basket.siteId,
              workOrderId: basket.workOrderId,
              bundleId: basket.id,
              kind: body.kind,
              setAt: now,
              setByWorkerId: named?.workerId ?? null,
              employeeId: named?.employeeId ?? null,
              deviceId: context.deviceId,
              clientEventId: body.clientEventId,
            },
            select: { id: true },
          })
          tools.audit({ action: 'production.flagBaskets', recordType: 'Bundle', recordId: basket.id, companyId: basket.companyId, siteId: basket.siteId, after: { flagId, kind: body.kind, on: true, workerId: named?.workerId ?? null, deviceId: context.deviceId, setAt: toUtcIso(now) } })
          changed++
        }
      } else {
        for (const basket of baskets) {
          const flag = openOf.get(basket.id)
          if (!flag) continue
          await tx.basketFlag.update({ where: { id: flag.id }, data: { clearedAt: now, clearedByWorkerId: named?.workerId ?? null, version: { increment: 1 } }, select: { id: true } })
          tools.audit({ action: 'production.flagBaskets', recordType: 'Bundle', recordId: basket.id, companyId: basket.companyId, siteId: basket.siteId, before: { flagId: flag.id, on: true }, after: { flagId: flag.id, kind: body.kind, on: false, workerId: named?.workerId ?? null, deviceId: context.deviceId, clearedAt: toUtcIso(now) } })
          changed++
        }
      }
      return { changed, stay: baskets.length - changed, flags: baskets.map((basket) => ({ bundleId: basket.id, code: basket.code, first: body.on })) }
    },
  )
  return { ...result, replayed }
}
