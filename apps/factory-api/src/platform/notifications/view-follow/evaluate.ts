import type { FactoryDatabase } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { events as notificationEvents } from '@nexus/factory-domain/notifications/events'
import { eventFor } from '@nexus/factory-domain/events/define'
import { VIEW_FOLLOW_LIMITS, viewChange, viewFingerprint } from '@nexus/factory-domain/notifications/preferences/view-follow'
import { viewSeenBy, type ViewAudience } from '@nexus/factory-domain/views/rules'
import { callerFor, command, type CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { heldRoles } from '../../auth/roles/access'
import { exportSourceOf } from '../../exports/registry'
import { activeTenants, asSystem, systemContext } from '../../outbox/system'
import { followRefusal, viewIds } from './follow'

/**
 * Counting the followed views (B-W2b-385; PLT-151 "told when it changes or when an item enters or leaves the view"): the
 * scheduler's clustered cron `notifications.viewFollow` (every 15 minutes) takes, per tenant, the follows counted longest ago
 * (at most VIEW_FOLLOW_LIMITS.perRun) and counts each view AS ITS PERSON (their live roles; follow.ts viewIds: the list's own
 * read through its export source):
 *
 *   - the person no longer sees the view (a role view whose role they lost) or its list: not counted (their next count waits
 *     until they see it again; the follow stays theirs to remove);
 *   - the same rows: the follows' count time moves on, in ONE command for the tenant's run;
 *   - other rows: ONE command per follow moves its fingerprint, count and time forward and emits notification.view_changed
 *     (how many now and before; what came in and what left when the view's last ids are still known): the fan-out tells the
 *     person, by their preferences (FOLLOWING_CHANGED).
 *
 * The last ids of each follow are kept in Redis (`IdMemory`, 30 days): the database keeps only the fingerprint
 * (ViewFollower.lastFingerprint), which says THAT the rows changed, not WHICH (a schema need for a durable `lastIds` is named
 * in this step's notes). When the memory does not match the stored fingerprint (Redis emptied, the first change right after a
 * follow), the person is told how many rows the view holds now, without came-in / left.
 */

const viewChanged = notificationEvents.find((event) => event.type === 'notification.view_changed')!

/** The last ids of each follow, beside its fingerprint. */
export interface IdMemory {
  get(key: string): Promise<{ readonly fingerprint: string; readonly ids: readonly string[] } | null>
  set(key: string, value: { readonly fingerprint: string; readonly ids: readonly string[] }): Promise<void>
}

const MEMORY_SECONDS = 30 * 24 * 60 * 60

/** The memory in Redis (the scheduler's connection): `<prefix>:view-follow:<tenant>:<follow>`, 30 days. */
export function redisIdMemory(redis: { get(key: string): Promise<string | null>; set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown> }, prefix: string): IdMemory {
  const keyOf = (key: string) => `${prefix}:view-follow:${key}`
  return {
    async get(key) {
      const raw = await redis.get(keyOf(key))
      if (!raw) return null
      try {
        const value = JSON.parse(raw) as { fingerprint?: unknown; ids?: unknown }
        return typeof value.fingerprint === 'string' && Array.isArray(value.ids) ? { fingerprint: value.fingerprint, ids: value.ids.filter((id): id is string => typeof id === 'string') } : null
      } catch {
        return null
      }
    },
    async set(key, value) {
      await redis.set(keyOf(key), JSON.stringify(value), 'EX', MEMORY_SECONDS)
    },
  }
}

/** A memory in this process only (tests). */
export function localIdMemory(): IdMemory {
  const kept = new Map<string, { fingerprint: string; ids: readonly string[] }>()
  return {
    async get(key) {
      return kept.get(key) ?? null
    },
    async set(key, value) {
      kept.set(key, { fingerprint: value.fingerprint, ids: [...value.ids] })
    },
  }
}

export interface ViewFollowRunOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly memory: IdMemory
  readonly clock?: Clock
}

export interface ViewFollowRun {
  readonly counted: number
  readonly changed: number
  readonly skipped: number
  readonly failed: number
}

/** The person as a reader of lists: their live office roles (two-factor taken as proved, as the export worker reads). */
function readerFor(system: CommandCaller, tenantId: string, userId: string, actor: Actor, companyId: string | null, requestId: string): CommandCaller {
  const context: OfficeContext = Object.freeze({ audience: 'office', tenantId, actorId: userId, ...(companyId ? { companyId } : {}), grants: actor.grants, requestId })
  return { factoryContext: context, withClient: (work) => system.withClient(work) }
}

/** One run over every active tenant (the cron's tick; tests call it with their clock and memory). */
export async function runViewFollows(options: ViewFollowRunOptions): Promise<ViewFollowRun> {
  const result = { counted: 0, changed: 0, skipped: 0, failed: 0 }
  const requestId = `notifications-view-follow-${newId()}`
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const now = (options.clock ?? serverClock).now()
      const follows = await asSystem(options.database, tenantId, requestId, (client) =>
        client.viewFollower.findMany({
          orderBy: [{ lastCountedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
          take: VIEW_FOLLOW_LIMITS.perRun,
          select: { id: true, userId: true, viewId: true, lastFingerprint: true, lastCount: true, lastCountedAt: true, version: true, view: { select: { listKey: true, state: true, companyId: true, ownerId: true, audience: true, roleId: true, roleDefault: true } }, user: { select: { status: true, requireMfa: true } } },
        }),
      )
      const unchanged: string[] = []
      for (const follow of follows) {
        try {
          if (follow.user.status !== 'ACTIVE') {
            result.skipped += 1
            continue
          }
          const held = await caller.withClient((client) => heldRoles(client, follow.userId, now))
          const actor: Actor = { audience: 'office', tenantId, grants: sessionGrants(follow.user, held, true) }
          const roleIds = [...new Set(held.map((entry) => entry.roleId))]
          const seen = viewSeenBy({ ownerId: follow.view.ownerId, audience: follow.view.audience as ViewAudience, roleId: follow.view.roleId, roleDefault: follow.view.roleDefault }, { userId: follow.userId, roleIds, save: false, manage: false })
          const source = exportSourceOf(follow.view.listKey)
          if (!seen || followRefusal(source, actor, follow.view.companyId) !== null) {
            result.skipped += 1
            continue
          }
          const counted = await viewIds(readerFor(caller, tenantId, follow.userId, actor, follow.view.companyId, requestId), source!, follow.view.state)
          const fingerprint = viewFingerprint(counted.ids)
          const memoryKey = `${tenantId}:${follow.id}`
          const remembered = await options.memory.get(memoryKey)
          result.counted += 1
          if (fingerprint === follow.lastFingerprint) {
            if (follow.lastCountedAt !== null) unchanged.push(follow.id)
            if (remembered?.fingerprint !== fingerprint) await options.memory.set(memoryKey, { fingerprint, ids: counted.ids })
            continue
          }
          const known = follow.lastFingerprint !== null && remembered?.fingerprint === follow.lastFingerprint ? viewChange(remembered.ids, counted.ids) : null
          const changed = await command(caller, { name: 'notifications.viewCounted', idempotencyKey: `view-follow-${follow.id}-${fingerprint}`, input: { followId: follow.id, fingerprint } }, async (tools) => {
            const row = await tools.tx.viewFollower.findUnique({ where: { id: follow.id }, select: { id: true, version: true, lastCountedAt: true, lastFingerprint: true } })
            // Unfollowed meanwhile, or counted by another run since: nothing to tell.
            if (!row || row.lastFingerprint !== follow.lastFingerprint) return false
            const at = row.lastCountedAt && row.lastCountedAt > tools.now ? row.lastCountedAt : tools.now
            await tools.tx.viewFollower.update({ where: { id: row.id }, data: { lastFingerprint: fingerprint, lastCount: counted.ids.length, lastCountedAt: at, version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
            tools.audit({ recordType: 'ViewFollower', recordId: row.id, before: { count: follow.lastCount }, after: { count: counted.ids.length, capped: counted.capped, ...(known ? known : {}) } })
            if (follow.lastFingerprint !== null) {
              tools.emit(eventFor(viewChanged, { subject: follow.viewId, companyId: follow.view.companyId, payload: { followerId: row.id, viewId: follow.viewId, userId: follow.userId, count: counted.ids.length, previousCount: follow.lastCount ?? 0, entered: known?.entered ?? null, left: known?.left ?? null, capped: counted.capped } }))
            }
            return true
          })
          await options.memory.set(memoryKey, { fingerprint, ids: counted.ids })
          if (changed.result && follow.lastFingerprint !== null) result.changed += 1
        } catch (error) {
          result.failed += 1
          options.log.error({ err: error, tenantId, followId: follow.id }, 'a followed view could not be counted')
        }
      }
      if (unchanged.length > 0) {
        await command(caller, { name: 'notifications.viewsCounted', input: { follows: unchanged.length, requestId } }, async (tools) => {
          // Only forward (the database refuses a count time going back).
          await tools.tx.viewFollower.updateMany({ where: { id: { in: unchanged }, lastCountedAt: { lt: tools.now } }, data: { lastCountedAt: tools.now, updatedAt: tools.now } })
          tools.audit({ recordType: 'ViewFollower', recordId: unchanged[0]!, after: { unchanged: unchanged.length } })
          return null
        })
      }
    } catch (error) {
      result.failed += 1
      options.log.error({ err: error, tenantId }, 'the followed views of a tenant could not be counted')
    }
  }
  return result
}

export function viewFollowCron(options: Omit<ViewFollowRunOptions, 'clock'>): CronJob {
  return defineCron({
    name: 'notifications.viewFollow',
    schedule: '*/15 * * * *',
    async run() {
      const result = await runViewFollows(options)
      if (result.counted + result.failed > 0) options.log.info({ ...result }, 'followed views counted')
    },
  })
}
