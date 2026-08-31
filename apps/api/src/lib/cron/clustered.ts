// EV.4 — cluster-safe cron.
//
// THE PROBLEM THIS EXISTS FOR
// 117 jobs are registered at boot with node-cron, and node-cron is per-process.
// A second API replica runs every one of them a second time: two order syncs,
// two repricing evaluators, two ads autopilots, two alert evaluators, all
// writing to the same database. This platform has a recorded incident of
// exactly that — one accidental local run doubled scheduled-bulk-action, the
// alert evaluator and both order syncs for seven and a half hours.
//
// So the buses being cross-replica (EV.3) did NOT make a second replica safe.
// This is the other half.
//
// HOW
// A drop-in replacement for `import cron from 'node-cron'`. Same `schedule`
// and `validate`, same returned ScheduledTask (callers hold it and call
// .stop()). The only difference is that a tick first tries to claim a
// short-lived Redis lock for that job and that minute; whichever replica wins
// runs it, and the others return immediately.
//
// Per-TICK, not a leader election. A leader has a failover gap — if it dies
// mid-minute, nobody runs anything until its lease expires. A per-tick claim
// has no such gap: the next tick is simply won by whoever is alive.
//
// 🔴 IT FAILS OPEN. If Redis is unreachable the tick RUNS rather than skips.
// With one replica — which is the deployed reality — a fail-closed lock would
// silently stop all 117 jobs the moment Redis hiccupped, which is far worse
// than the duplicate it would be preventing. The lock is a multi-replica
// safety device, not a correctness gate for single-replica operation.

import nodeCron from 'node-cron'
import { logger } from '../../utils/logger.js'

export type ScheduledTask = ReturnType<typeof nodeCron.schedule>

/** How long a tick's claim is held. Longer than any tick needs, shorter than
 *  the shortest schedule (1 minute) so the next tick is always contestable. */
const LOCK_TTL_MS = 50_000

/** Registrations seen per (file, expression), so two identical jobs in one
 *  file get distinct keys. Deterministic: every replica loads the same modules
 *  in the same order, so the same job gets the same index everywhere. */
const registrationCounts = new Map<string, number>()

/**
 * Identify the registering module from the call stack.
 *
 * Done ONCE per job at registration, never per tick, so the cost is nil. A
 * file path is stable across restarts and identical across replicas, which is
 * what the key needs to be — unlike a handler's identity, which is not.
 */
function callerFile(): string {
  const stack = new Error().stack ?? ''
  for (const line of stack.split('\n').slice(2)) {
    const match = line.match(/\(?([^()\s]+\.(?:ts|js)):\d+:\d+\)?/)
    if (match && !match[1].includes('/lib/cron/')) {
      return match[1].split('/').slice(-2).join('/')
    }
  }
  return 'unknown'
}

/** PURE. The lock key for one job's tick. Exported for testing — a key that
 *  collides silently makes two different jobs suppress each other. */
export function tickLockKey(jobId: string, atMs: number): string {
  // Minute granularity: every schedule here is minute-based, so one claim per
  // job per minute is exactly the deduplication needed.
  const minute = Math.floor(atMs / 60_000)
  return `nexus:cron:${jobId}:${minute}`
}

/** PURE. The stable identity of a registration. */
export function jobIdFor(file: string, expression: string, index: number): string {
  return `${file}:${expression}:${index}`
}

/**
 * Claim this job's tick. True = run it here.
 *
 * Returns TRUE on any Redis failure — see the fail-open note in the header.
 */
async function claimTick(jobId: string): Promise<boolean> {
  let redis
  try {
    const queue = await import('../queue.js')
    redis = queue.redis.connection
  } catch {
    return true // no queue module / no Redis configured — single-process behaviour
  }
  try {
    const key = tickLockKey(jobId, Date.now())
    const result = await redis.set(key, process.pid.toString(), 'PX', LOCK_TTL_MS, 'NX')
    return result === 'OK'
  } catch (error) {
    logger.warn('clustered cron: lock unavailable, running the tick anyway', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    })
    return true
  }
}

/**
 * Drop-in for node-cron's schedule. The handler runs on exactly one replica
 * per tick when Redis is reachable, and on every replica when it is not.
 */
function schedule(
  expression: string,
  handler: (...args: never[]) => void | Promise<void>,
  options?: Parameters<typeof nodeCron.schedule>[2],
): ScheduledTask {
  const file = callerFile()
  const countKey = `${file}:${expression}`
  const index = registrationCounts.get(countKey) ?? 0
  registrationCounts.set(countKey, index + 1)
  const jobId = jobIdFor(file, expression, index)

  return nodeCron.schedule(
    expression,
    async (...args: never[]) => {
      if (!(await claimTick(jobId))) {
        // Another replica has this minute. Not an error, and not worth a log
        // line 117 times a minute.
        return
      }
      await handler(...args)
    },
    options,
  )
}

/** Unchanged passthrough — validation is local and has nothing to coordinate. */
const validate = (expression: string): boolean => nodeCron.validate(expression)

export { schedule, validate }
export default { schedule, validate }
