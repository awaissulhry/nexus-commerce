import { createHash } from 'node:crypto'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import type { TaskActor } from '@nexus/factory-domain/inventory/tasks/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'

/**
 * What every source of warehouse tasks shares (B-W2b-292; SCM-274; ./sources, one file each, listed in ./sources/index.ts):
 * a source follows the events of its record, reads the record as it stands now (as the tenant's system caller, the worker's
 * office role), and only when a task must be made, changed, done or cancelled writes it in ONE system command keyed by the
 * event and the source, so a repeated job answers from its receipt. The event's own command is never slowed or failed by a
 * source: the task appears a moment after the receipt, the hold or the pick list.
 */

export interface TaskSource {
  /** Lower camel case, unique among the sources (the command key's part). */
  readonly name: string
  readonly events: readonly string[]
  handle(caller: CommandCaller, event: EventEnvelope): Promise<void>
}

export const defineTaskSource = (source: TaskSource): TaskSource => Object.freeze({ ...source, events: Object.freeze([...source.events]) })

/** A source that follows time, not an event (a count schedule falls due): the scheduler's cron runs `tick` per tenant. */
export interface TimedTaskSource {
  readonly name: string
  tick(caller: CommandCaller, now: Date): Promise<{ readonly made: number; readonly cancelled: number }>
}

/** A key derived from another (an Idempotency-Key's 128 characters at most): the two joined, else hashed. */
export function derivedKey(key: string, suffix: string): string {
  const joined = `${key}:${suffix}`
  return joined.length <= 128 ? joined : `k.${createHash('sha256').update(joined).digest('hex').slice(0, 64)}`
}

/** The source's one system command for this event (only when there is something to write). */
export async function sourceCommand(caller: CommandCaller, source: string, event: EventEnvelope, input: Record<string, unknown>, work: (tools: CommandTools) => Promise<void>): Promise<void> {
  // A command answers JSON: the tasks it wrote are its audit rows and events, so its receipt keeps only that it ran.
  await command(caller, { name: 'inventory.warehouseTaskSource', idempotencyKey: derivedKey(`task-source.${source}`, event.eventId), input: { source, eventId: event.eventId, ...input }, causationId: event.eventId }, async (tools) => {
    await work(tools)
    return { ran: source }
  })
}

/** Who posted a stock move: a floor worker (a move with its device), an office user, or nobody (the system). */
export function posterOf(move: { readonly createdById: string | null; readonly deviceId: string | null }): TaskActor | null {
  if (!move.createdById) return null
  return move.deviceId ? { kind: 'WORKER', id: move.createdById } : { kind: 'USER', id: move.createdById }
}
