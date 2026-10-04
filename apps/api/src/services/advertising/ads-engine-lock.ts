/**
 * Group 1 (1e) — an ads engine runs live only when it is on, and never twice at once in one business.
 *
 * Review 2.4: "Run now" (the Sync Logs / Control Room trigger, and two rank-defend routes) called the engines'
 * `*Once` functions directly, so it skipped what the scheduled tick checks first: this business's switch, the env
 * flag that arms the engine, and the overlap guard — a boolean in the scheduler's memory that a Run now on the API
 * never sees.
 *
 * guardLiveRun(engine, fn) — what every LIVE run of an engine passes, the tick and every Run now alike (dry runs and
 * previews do not come here):
 *   1. this business's switch (engine-switch.service.ts): OFF refuses.
 *   2. the env flags that arm the engine, read AS THE SCHEDULER SEES THEM. Railway sets env per service, so the API's
 *      own process.env says nothing certain about the scheduler's; the scheduler publishes its flags
 *      (lib/runtime-status). Off refuses, and so does unknown (no scheduler heartbeat, Redis out of reach).
 *   3. withEngineLock.
 * A refusal is a plain sentence; the caller records it as "skipped: <sentence>".
 *
 * withEngineLock(workspaceId, engine, fn) — a Redis lease per business + engine, the lease of
 * lib/cron/workspace-lease.ts: `SET NX PX` takes it, the holder renews it every 20 s while the run is alive (so it
 * outlasts any run, however long), and `finally` releases it — only the holder's own token can. A holder that dies
 * stops renewing and the lease lapses within 90 s. A second run that finds it held does not wait: it answers "a run
 * is already in progress". No Redis, no lease, no run — the scheduler's own business ticks already require Redis.
 */
import { randomUUID } from 'node:crypto'
import { LEGACY_WORKSPACE_ID, workspaceContext } from '../../lib/workspace-context.js'
import { currentProcessRole, readLiveProcesses } from '../../lib/runtime-status/process-snapshot.js'
import { RELEASE_LEASE, RENEW_LEASE } from '../../lib/cron/workspace-lease.js'
import { logger } from '../../utils/logger.js'
import { engineMode, type EngineKey } from '../automation/engine-switch.service.js'
import { flagIs, schedulerFlagEnabled } from '../runtime-status/cron-status.service.js'

export type LockedEngine = Extract<EngineKey, 'rank-defend' | 'budget-enforce' | 'auto-bid' | 'tos-defense'>

interface ArmFlag { name: string; isEnabled: (raw: string | null) => boolean }
const ADS_CRON: ArmFlag = { name: 'NEXUS_ENABLE_AMAZON_ADS_CRON', isEnabled: flagIs.tolerant }

/**
 * Each engine's Control Room name, and the flags the scheduler needs before it schedules the engine at all
 * (runtime/scheduler.ts, and each job's own start function), parsed the way the scheduler parses them.
 */
export const LOCKED_ENGINES: Record<LockedEngine, { name: string; arm: readonly ArmFlag[] }> = {
  'rank-defend': { name: 'Rank & Dayparting', arm: [ADS_CRON, { name: 'NEXUS_ENABLE_RANK_DEFEND', isEnabled: flagIs.one }] },
  'tos-defense': { name: 'Top-of-Search defense', arm: [ADS_CRON, { name: 'NEXUS_ENABLE_TOS_DEFENSE_CRON', isEnabled: flagIs.tolerant }] },
  'auto-bid': { name: 'Bid optimiser', arm: [ADS_CRON] },
  // Its tick reads its own switch and NEXUS_BUDGET_ENFORCE_APPLY (observe or apply); it only needs the lock.
  'budget-enforce': { name: 'Budget enforcement', arm: [] },
}

// Both fields on both arms: apps/api is not strict, so `ran` alone does not narrow.
export type EngineRun<T> = { ran: true; value: T; reason?: undefined } | { ran: false; reason: string; value?: undefined }

export const RUN_IN_PROGRESS = 'a run is already in progress'

/** The business the caller runs in (a tick or a request); the legacy business when there is none. */
export const currentWorkspaceId = (): string => workspaceContext()?.workspaceId ?? LEGACY_WORKSPACE_ID

/**
 * Why a live run of this engine may not start now, in words — or null when it may. A switch that cannot be read
 * throws, exactly as in the tick: a failed read never runs an engine this business switched off.
 */
export async function liveRunRefusal(engine: LockedEngine): Promise<string | null> {
  const { name, arm } = LOCKED_ENGINES[engine]
  const gate = await engineMode(engine, 'AUTO')
  if (gate.mode === 'OFF') return `${name} is switched off for this business${gate.switched ? ` (by ${gate.switched.setBy})` : ''}`
  if (!arm.length) return null
  // In the scheduler the flags are this process's own; anywhere else, what the scheduler last published.
  const live = currentProcessRole() === 'scheduler' ? null : await readLiveProcesses()
  for (const flag of arm) {
    const reading = live ? schedulerFlagEnabled(live, flag.name, flag.isEnabled) : { value: flag.isEnabled(process.env[flag.name] ?? null), unknown: undefined }
    if (reading.value === null) return `whether ${name} is switched on cannot be read from the scheduler (${reading.unknown?.reason ?? 'no reading'})`
    if (!reading.value) return `${name} is switched off on the server (the scheduler's ${flag.name} is not on)`
  }
  return null
}

/** The Control Room drawer's question for a lever: null = Run now may start, or this file does not guard that engine. */
export async function runNowRefusal(leverKey: string): Promise<string | null> {
  return Object.prototype.hasOwnProperty.call(LOCKED_ENGINES, leverKey) ? liveRunRefusal(leverKey as LockedEngine) : null
}

/** A live run of an engine: the switch, the scheduler's arm flags, then the lock. */
export async function guardLiveRun<T>(engine: LockedEngine, fn: () => Promise<T>): Promise<EngineRun<T>> {
  const refusal = await liveRunRefusal(engine)
  if (refusal) return { ran: false, reason: refusal }
  return withEngineLock(currentWorkspaceId(), engine, fn)
}

/** The Redis commands the lease needs; ioredis has them. */
export interface EngineLockStore { status: string; eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> }

const CLAIM = `if redis.call('set', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 else return 0 end`
/** The lease length workspace-lease's RENEW sets; renewed well inside it. */
const LEASE_MS = 90_000
const RENEW_EVERY_MS = 20_000

export const engineLockKey = (workspaceId: string, engine: LockedEngine): string => `nexus:ads:engine-lock:${workspaceId}:${engine}`

let storeOverride: EngineLockStore | null | undefined

/** Test seam: a stand-in store (null = no Redis) instead of the queue's connection. */
export function setEngineLockStoreForTests(store: EngineLockStore | null | undefined): void {
  storeOverride = store
}

async function lockStore(): Promise<EngineLockStore | null> {
  if (storeOverride !== undefined) return storeOverride
  const { redis } = await import('../../lib/queue.js')
  return (redis?.connection ?? null) as unknown as EngineLockStore | null
}

/** Run `fn` holding this business's lease for the engine; answer "a run is already in progress" when another holds it. */
export async function withEngineLock<T>(workspaceId: string, engine: LockedEngine, fn: () => Promise<T>): Promise<EngineRun<T>> {
  const key = engineLockKey(workspaceId, engine)
  const token = randomUUID()
  let store: EngineLockStore | null
  try {
    store = await lockStore()
    if (!store || store.status !== 'ready') throw new Error('Redis is not connected')
    if (await store.eval(CLAIM, 1, key, token, LEASE_MS) !== 1) return { ran: false, reason: RUN_IN_PROGRESS }
  } catch (error) {
    logger.warn('[ads-engine-lock] lock unavailable — the run does not start', { engine, workspaceId, error: String(error) })
    return { ran: false, reason: `the lock that keeps two runs apart could not be taken (${error instanceof Error ? error.message : String(error)})` }
  }
  const held = store
  let renewing = false
  const timer = setInterval(async () => {
    if (renewing) return
    renewing = true
    try {
      if (held.status !== 'ready' || await held.eval(RENEW_LEASE, 1, key, token) !== 1) throw new Error('lease lost')
    } catch (error) {
      logger.error('[ads-engine-lock] lock lost while a run was in progress', { engine, workspaceId, error: String(error) })
    } finally { renewing = false }
  }, RENEW_EVERY_MS)
  timer.unref()
  try { return { ran: true, value: await fn() } }
  finally {
    clearInterval(timer)
    try { if (held.status === 'ready') await held.eval(RELEASE_LEASE, 1, key, token) }
    catch (error) { logger.warn('[ads-engine-lock] lock release failed; it lapses on its own within 90 s', { engine, workspaceId, error: String(error) }) }
  }
}
