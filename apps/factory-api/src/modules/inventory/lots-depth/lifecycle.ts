import { isUuid } from '@nexus/factory-domain/core/ids'
import { CAUSE_WORDS, lifecycleCause, lifecycleFits, lifecycleFor, type LifecycleCause, type LotLifecycle, type LotQuality } from '@nexus/factory-domain/inventory/lots-depth/lifecycle'
import { INVENTORY_LOTS_MANAGE } from '@nexus/factory-domain/inventory/lots-depth/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { factsOf, lotFor } from './store'

/**
 * The lot lifecycle moved by its events (B-W2b-313; SCM-236): the database moves Lot.lifecycle on W1's quality decisions
 * (QUARANTINE at receipt, RELEASED at the release, BLOCKED at a block or rejection: B-W2b-277's Lot_lifecycle trigger); this
 * moves it from the ledger: IN_USE at the first issue, DEPLETED when the last unit goes out, RETURNED when the goods went
 * back to the supplier, and back again when stock returns (factory-domain inventory/lots-depth lifecycle.ts says which).
 *
 *   syncLifecycleInCommand   inside a caller's command (the split, a check): the lot's row locked, its moves read, the
 *                            lifecycle written when it differs, with its audit row (`inventory.lotLifecycle`, from → to and
 *                            the cause) and `lot.lifecycle_changed`. A system-derived column: the lot's version is NOT
 *                            bumped, so a quality decision a person is typing never fails on it.
 *   syncLifecycle            its own command, run only when something differs (a command records at least one audit row)
 *   the worker's handler     `inventory.lotLifecycle` on every stock move of a lot and every quality decision: the move's
 *                            lot, as the tenant's system; idempotent (it compares and writes only a difference)
 *   POST /inventory/lots/:lotId/lifecycle/check   the same now, by a person (inventory.lots.manage)
 */

export interface LifecycleChange {
  readonly lotId: string
  readonly code: string
  readonly from: LotLifecycle
  readonly to: LotLifecycle
  readonly cause: LifecycleCause
}

/** Inside a command: the lot's lifecycle brought in line with its quality status and ledger; the change, or null. */
export async function syncLifecycleInCommand(tools: Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit'>, lotId: string): Promise<LifecycleChange | null> {
  const { tx, now } = tools
  // The row's lock: two handlers of one lot (two moves at once) write one after the other, the second sees the first.
  await tx.$queryRaw`SELECT 1 FROM "Lot" WHERE "id" = ${lotId}::uuid FOR UPDATE`
  const lot = await tx.lot.findUnique({ where: { id: lotId }, select: { id: true, code: true, companyId: true, siteId: true, qualityStatus: true, lifecycle: true } })
  if (!lot) return null
  const facts = (await factsOf(tx, [lot.id])).get(lot.id)!
  const quality = lot.qualityStatus as LotQuality
  const from = lot.lifecycle as LotLifecycle
  const to = lifecycleFor(quality, facts)
  if (to === from || !lifecycleFits(quality, to)) return null
  const cause = lifecycleCause(from, to)
  await tx.lot.update({ where: { id: lot.id }, data: { lifecycle: to, updatedAt: now }, select: { id: true } })
  tools.audit({ action: 'inventory.lotLifecycle', recordType: 'Lot', recordId: lot.id, companyId: lot.companyId, siteId: lot.siteId, before: { lifecycle: from }, after: { lifecycle: to, cause }, reason: CAUSE_WORDS[cause] })
  tools.emit({ type: 'lot.lifecycle_changed', subject: lot.id, companyId: lot.companyId, siteId: lot.siteId, payload: { lotId: lot.id, code: lot.code, from, to, cause } })
  return { lotId: lot.id, code: lot.code, from, to, cause }
}

/** Thrown inside the command when a concurrent writer already did the work: rolls back an empty command. */
class Unchanged extends Error {}

/**
 * The lot's lifecycle checked against its ledger, written only when it differs (the check reads first, outside any
 * transaction, then again under the row's lock inside the command). Null: nothing to change.
 */
export async function syncLifecycle(caller: CommandCaller, lotId: string, options: { readonly causationId?: string; readonly idempotencyKey?: string } = {}): Promise<LifecycleChange | null> {
  if (!isUuid(lotId)) return null
  const needed = await caller.withClient(async (client) => {
    const lot = await client.lot.findUnique({ where: { id: lotId }, select: { qualityStatus: true, lifecycle: true } })
    if (!lot) return false
    const facts = (await factsOf(client, [lotId])).get(lotId)!
    const to = lifecycleFor(lot.qualityStatus as LotQuality, facts)
    return to !== lot.lifecycle && lifecycleFits(lot.qualityStatus as LotQuality, to)
  })
  if (!needed) return null
  try {
    const { result } = await command(
      caller,
      { name: 'inventory.lotLifecycle', idempotencyKey: options.idempotencyKey, input: { lotId }, ...(options.causationId ? { causationId: options.causationId } : {}) },
      async (tools) => {
        const change = await syncLifecycleInCommand(tools, lotId)
        if (!change) throw new Unchanged()
        return change
      },
    )
    return result
  } catch (error) {
    if (error instanceof Unchanged) return null
    throw error
  }
}

/** The lot ids an event names: a stock move's lot, a quality decision's lot. */
export function lotIdsOf(payload: unknown): string[] {
  const data = (payload ?? {}) as { lotId?: unknown }
  if (typeof data.lotId === 'string' && isUuid(data.lotId)) return [data.lotId]
  return []
}

export const LIFECYCLE_EVENTS = ['inventory.moved', 'lot.released', 'lot.blocked', 'lot.rejected'] as const

/**
 * The worker's handler (listed in background.ts for B-W2b-313): every stock move of a lot and every quality decision moves
 * its lot's lifecycle when the ledger says so, as the tenant's system (audit audience SYSTEM). A lot that needs nothing is
 * left alone (no command); a repeated event finds nothing to do.
 */
export function lotLifecycleHandler(): EventHandler {
  return defineHandler({
    name: 'inventory.lotLifecycle',
    events: [...LIFECYCLE_EVENTS],
    async handle(event, { caller }) {
      for (const lotId of lotIdsOf(event.payload)) {
        await syncLifecycle(caller, lotId, { causationId: event.eventId, idempotencyKey: `lot-lifecycle:${event.eventId}:${lotId}` })
      }
    },
  })
}

/** POST /inventory/lots/:lotId/lifecycle/check: the same, now, by a person. */
export async function checkLifecycle(caller: CommandCaller, lotId: string) {
  const { lot } = await lotFor(caller, lotId, INVENTORY_LOTS_MANAGE)
  const change = await syncLifecycle(caller, lot.id)
  return { changed: change !== null, from: (change?.from ?? lot.lifecycle) as LotLifecycle, to: (change?.to ?? lot.lifecycle) as LotLifecycle }
}
