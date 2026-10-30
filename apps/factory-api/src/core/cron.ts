import nodeCron, { type ScheduledTask } from 'node-cron'
import type { Redis } from 'ioredis'
import { BUSINESS_TIME_ZONE } from '@nexus/factory-domain/core/time'
import { reportError } from '../observability/tracker'
import type { Log } from './queue'

/**
 * Clustered crons (plan A1 §3.1 "a Redis lock per job per minute"; Commerce hard rule 7 for the factory): the ONLY way
 * the factory schedules anything. node-cron runs in every process that registers a schedule, so a second scheduler
 * replica would run each job twice; here every tick first claims `<prefix>:cron:<job>:<tick>` in Redis
 * (SET NX PX), and only the replica that wins runs it. A per-tick claim, not a leader: when a replica dies, the next
 * tick is simply won by one that is alive. `scripts/factory/check-cron-clustered.mjs` refuses a node-cron import
 * anywhere but this file.
 *
 * Fails CLOSED: when Redis does not answer, nobody runs the tick (it is logged). The factory's jobs enqueue work or
 * check state, and the next tick catches up, so a skipped tick costs a minute; a doubled one could send two emails.
 * (Commerce fails open because 117 legacy jobs run on one replica; the factory starts with the lock.)
 *
 *   export const lagCheck = defineCron({ name: 'outbox.lag', schedule: '* * * * *', run: async ({ scheduledAt }) => … })
 *   const crons = startCrons([lagCheck], { redis, prefix, log })   // background.ts scheduler
 *   await crons.stop()
 *
 * The tick key is the scheduled second (node-cron hands every replica the same whole second), so a 5-field (minute)
 * schedule takes one claim per minute and a 6-field one per second. The claim lives `lockTtlMs` (default 50 s): keep it
 * shorter than the schedule's period and longer than a skew between replicas.
 */

export interface CronTick {
  readonly name: string
  /** The scheduled instant of this tick (whole second), the same on every replica. */
  readonly scheduledAt: Date
}

export interface CronJob {
  /** `<area>.<job>`, unique and stable: the lock key. */
  readonly name: string
  /** A node-cron expression: 5 fields (minute) or 6 (second). */
  readonly schedule: string
  /** Default Europe/Rome (the business time zone). */
  readonly timezone: string
  /** How long a tick's claim is held. Default 50 s. */
  readonly lockTtlMs: number
  run(tick: CronTick): Promise<void>
}

export interface CronSpec {
  readonly name: string
  readonly schedule: string
  readonly timezone?: string
  readonly lockTtlMs?: number
  run(tick: CronTick): Promise<void>
}

export class CronConfigError extends Error {
  override name = 'CronConfigError'
}

const NAME = /^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)+$/
export const CRON_LOCK_TTL_MS = 50_000

/** Declares a job; a bad name, expression or TTL throws at once (at import, so at boot). */
export function defineCron(spec: CronSpec): CronJob {
  if (typeof spec?.name !== 'string' || !NAME.test(spec.name)) throw new CronConfigError(`Cron name ${JSON.stringify(spec?.name)} is not <area>.<job>`)
  if (typeof spec.schedule !== 'string' || !nodeCron.validate(spec.schedule)) {
    throw new CronConfigError(`Cron ${spec.name}: ${JSON.stringify(spec.schedule)} is not a node-cron expression`)
  }
  const lockTtlMs = spec.lockTtlMs ?? CRON_LOCK_TTL_MS
  if (!Number.isSafeInteger(lockTtlMs) || lockTtlMs < 100) throw new CronConfigError(`Cron ${spec.name}: lockTtlMs must be a whole number of milliseconds from 100`)
  if (typeof spec.run !== 'function') throw new CronConfigError(`Cron ${spec.name} has no run()`)
  return Object.freeze({ name: spec.name, schedule: spec.schedule, timezone: spec.timezone ?? BUSINESS_TIME_ZONE, lockTtlMs, run: spec.run })
}

/** The claim key of one tick: `<prefix>:cron:<job>:<scheduled second>`. */
export function cronLockKey(prefix: string, name: string, scheduledAt: Date): string {
  return `${prefix}:cron:${name}:${Math.floor(scheduledAt.getTime() / 1000)}`
}

export type TickOutcome = 'ran' | 'failed' | 'taken' | 'no_lock'

export interface CronSettings {
  readonly redis: Redis
  readonly prefix: string
  readonly log: Log
  /** Who holds a claim (logged in Redis as the value). Default the process id. */
  readonly holder?: string
}

/** One tick of one job on this replica: claim it, run it if the claim is ours. Exported for tests. */
export async function runTick(job: CronJob, scheduledAt: Date, settings: CronSettings): Promise<TickOutcome> {
  const key = cronLockKey(settings.prefix, job.name, scheduledAt)
  let claimed: boolean
  try {
    claimed = (await settings.redis.set(key, settings.holder ?? String(process.pid), 'PX', job.lockTtlMs, 'NX')) === 'OK'
  } catch (error) {
    settings.log.error({ cron: job.name, err: error }, 'cron tick skipped: the Redis lock is unavailable')
    return 'no_lock'
  }
  if (!claimed) return 'taken'
  try {
    await job.run({ name: job.name, scheduledAt })
    return 'ran'
  } catch (error) {
    settings.log.error({ cron: job.name, err: error }, 'cron tick failed')
    reportError(error, { cron: job.name }) // B-W2a-42 (PLT-218)
    return 'failed'
  }
}

export interface CronScheduler {
  /** Stops every schedule and waits for running ticks. */
  stop(): Promise<void>
}

/** Schedules the jobs, each tick through `runTick`. Two jobs with one name are refused. */
export function startCrons(jobs: readonly CronJob[], settings: CronSettings): CronScheduler {
  const names = new Set<string>()
  for (const job of jobs) {
    if (names.has(job.name)) throw new CronConfigError(`Cron ${job.name} is scheduled twice`)
    names.add(job.name)
  }
  const running = new Set<Promise<TickOutcome>>()
  const tasks: ScheduledTask[] = jobs.map((job) =>
    nodeCron.schedule(
      job.schedule,
      (context) => {
        const tick = runTick(job, context.date, settings)
        running.add(tick)
        void tick.finally(() => running.delete(tick))
        return tick
      },
      { name: job.name, timezone: job.timezone, noOverlap: true },
    ),
  )
  return {
    async stop() {
      await Promise.all(tasks.map(async (task) => task.destroy()))
      await Promise.allSettled([...running])
    },
  }
}
