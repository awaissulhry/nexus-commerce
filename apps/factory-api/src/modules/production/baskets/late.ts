import { newId } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { lateWarningsOf, rowEventIds, type LateReason, type LateState } from '@nexus/factory-domain/production/baskets/signals'
import { command, type CommandCaller } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { floorOf } from '../calls/access'
import { namedWorker } from '../calls/station'
import { leaderBaskets } from './flags'
import type { LateBody } from './signals-contract'

/**
 * Will be late (owb- order workflow, S5 fl3 step 3; design "leader row: Will be late", the late window: 1 · 2 · 3 · 5 days, why;
 * `_owb-fl-common.md` § 1 D: a leader act, floor.lead):
 *
 *   POST /production/baskets/late   { bundleIds 1..50, days, reason, clientEventId }: one OPEN FloorLateWarning per work order
 *                                   of the baskets (the base's table and guard G6) — naming its basket when it is about one,
 *                                   else the whole work order. The office answers each once in fl4's From the floor (KEPT:
 *                                   the date holds; CHANGED: the promise moves). The customer reads nothing of it.
 *
 * Baskets of the device's own site only. The team leader is named only where the site names workers (and they acknowledged the
 * notice); the device always.
 */

const keyOf = (context: FloorContext, clientEventId: string) => `${context.deviceId}.${clientEventId}`

export interface LateWarningView {
  readonly id: string
  readonly workOrderId: string
  readonly bundleId: string | null
  readonly basketCodes: string[]
  readonly days: number
  readonly reason: LateReason
  readonly state: LateState
}

/** POST /production/baskets/late, or the offline queue (production.baskets.late). */
export async function sayLate(caller: CommandCaller, body: LateBody, key?: string): Promise<{ readonly warnings: LateWarningView[]; readonly replayed: boolean }> {
  const context = floorOf(caller)
  const baskets = await leaderBaskets(caller, context, body.bundleIds)
  const codeOf = new Map(baskets.map((basket) => [basket.id, basket.code]))
  const companyOf = new Map(baskets.map((basket) => [basket.workOrderId, basket.companyId]))
  const groups = lateWarningsOf(baskets)
  const eventIds = rowEventIds(body.clientEventId, groups.length)
  const deviceTime = body.occurredAt ? parseInstant(body.occurredAt) : null
  const { result, replayed } = await command(
    caller,
    { name: 'production.sayLate', idempotencyKey: key ?? keyOf(context, body.clientEventId), input: body, ...(deviceTime ? { deviceTime } : {}) },
    async (tools) => {
      const { tx, now } = tools
      const named = await namedWorker(tx, context.siteId, context.actorId)
      const warnings: LateWarningView[] = []
      for (const [index, group] of groups.entries()) {
        const warningId = newId()
        await tx.floorLateWarning.create({
          data: {
            id: warningId,
            siteId: context.siteId,
            workOrderId: group.workOrderId,
            bundleId: group.bundleId,
            days: body.days,
            reason: body.reason,
            workerId: named?.workerId ?? null,
            employeeId: named?.employeeId ?? null,
            deviceId: context.deviceId,
            clientEventId: eventIds[index]!,
            deviceTime,
            createdAt: now,
            updatedAt: now,
            createdById: named?.workerId ?? null,
          },
          select: { id: true },
        })
        const basketCodes = group.bundleIds.map((id) => codeOf.get(id) ?? id)
        tools.audit({
          action: 'production.sayLate',
          recordType: 'WorkOrder',
          recordId: group.workOrderId,
          companyId: companyOf.get(group.workOrderId) ?? null,
          siteId: context.siteId,
          after: { warningId, bundleId: group.bundleId, bundleIds: group.bundleIds, days: body.days, reason: body.reason, workerId: named?.workerId ?? null, deviceId: context.deviceId, at: toUtcIso(now) },
        })
        warnings.push({ id: warningId, workOrderId: group.workOrderId, bundleId: group.bundleId, basketCodes, days: body.days, reason: body.reason, state: 'OPEN' })
      }
      return { warnings }
    },
  )
  return { ...result, replayed }
}
