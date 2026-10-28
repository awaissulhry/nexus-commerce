import { Queue, UnrecoverableError, Worker, type Job, type JobsOptions } from 'bullmq'
import { Redis } from 'ioredis'
import type { FactoryEnv } from '../env'

/**
 * The background queues (plan A1 §3.3): BullMQ on the factory's Redis. Every queue and every job key sits under the
 * process's queue prefix (FACTORY_QUEUE_PREFIX): `<prefix>:<queue>:…`, the cron locks under `<prefix>:cron:…` and the
 * live-screen channels under `<prefix>:live:…`. A local Redis is shared by every worktree, so a local or test process
 * must name its own prefix (the worktree's step, `w0_12`); there is no default to collide on.
 *
 * Every job is idempotent with a deterministic id (A1 §3.3): `add` takes the id, and adding an id that is still kept
 * is a no-op. Completed jobs are kept for a week, so a repeated publish of one event (a relay that crashed between
 * publishing and marking its row) does not run twice; consumers are idempotent by event id anyway.
 *
 * A job that fails its last attempt (or throws UnrecoverableError) is copied to the `dead-letter` queue before BullMQ
 * marks it failed: nothing consumes that queue, it waits for a person (the monitoring cron counts it).
 *
 * Queues:
 *   events          one job per published outbox event (job id = event id), consumed by the dispatcher
 *   event-handlers  one job per event and handler (job id = `<handler>.<event id>`), retried with backoff
 *   dead-letter     jobs that ran out of attempts
 */

export const QUEUE_NAMES = ['events', 'event-handlers', 'dead-letter'] as const
export type QueueName = (typeof QUEUE_NAMES)[number]

/** A job log: pino's (the API's app.log) fits, and so does background.ts's line logger. */
export interface Log {
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

export class QueueConfigError extends Error {
  override name = 'QueueConfigError'
}

const PREFIX = /^[a-z][a-z0-9_]{0,31}$/
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const WEEK_S = 7 * 24 * 60 * 60
const MONTH_S = 30 * 24 * 60 * 60

/**
 * The queue prefix of this process. local and test: FACTORY_QUEUE_PREFIX is required (the shared local Redis);
 * staging and production: it defaults to `factory` (each environment has its own Redis).
 */
export function queuePrefixFrom(value: string | undefined, environment: FactoryEnv['FACTORY_ENV']): string {
  const prefix = value === undefined || value === '' ? (environment === 'staging' || environment === 'production' ? 'factory' : undefined) : value
  if (prefix === undefined) {
    throw new QueueConfigError(
      `FACTORY_QUEUE_PREFIX is required with FACTORY_ENV=${environment}: the local Redis is shared by every worktree, so name this worktree's own (e.g. w0_12)`,
    )
  }
  if (!PREFIX.test(prefix)) throw new QueueConfigError(`FACTORY_QUEUE_PREFIX ${JSON.stringify(prefix)} must be 1-32 lower-case letters, digits or underscores, starting with a letter`)
  return prefix
}

/** A Redis connection for BullMQ (it needs `maxRetriesPerRequest: null`: a worker's blocking reads wait out an outage). */
export function queueConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false })
}

/** Defaults for every job: a few tries with exponential backoff, kept long enough for the id to dedupe repeats. */
export const JOB_DEFAULTS: Readonly<JobsOptions> = Object.freeze({
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: WEEK_S },
  removeOnFail: { age: MONTH_S },
})

/** What a dead-letter job holds. */
export interface DeadLetter {
  readonly queue: QueueName
  readonly jobId: string
  readonly name: string
  readonly data: unknown
  readonly attemptsMade: number
  readonly error: string
  readonly failedAt: string
}

export interface AddOptions extends Omit<JobsOptions, 'jobId' | 'repeat'> {
  /** Deterministic: the same work always gets the same id (no `:`, at most 200 characters). */
  readonly jobId: string
}

export interface WorkOptions {
  readonly concurrency?: number
}

export interface QueueKit {
  readonly prefix: string
  /** The queue (one instance per name and kit). */
  queue(name: QueueName): Queue
  /** Adds a job with its deterministic id; an id still kept is not added again. */
  add<Data>(queue: QueueName, name: string, data: Data, options: AddOptions): Promise<Job<Data>>
  /** A worker on one queue; a job that fails its last attempt is copied to the dead-letter queue first. */
  work<Data>(queue: Exclude<QueueName, 'dead-letter'>, processor: (job: Job<Data>) => Promise<unknown>, options?: WorkOptions): Worker<Data>
  /** Closes the kit's queues and workers (not the connection, which the caller owns). */
  close(): Promise<void>
}

export function assertJobId(jobId: string): string {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) {
    throw new QueueConfigError(`Job id ${JSON.stringify(jobId)} is not deterministic-id shaped (1-200 letters, digits, dots, underscores, hyphens; no colon)`)
  }
  return jobId
}

/** The queues of one prefix on one connection. */
export function openQueues({ connection, prefix }: { readonly connection: Redis; readonly prefix: string }): QueueKit {
  if (!PREFIX.test(prefix)) throw new QueueConfigError(`Queue prefix ${JSON.stringify(prefix)} is not valid`)
  const queues = new Map<QueueName, Queue>()
  const workers = new Set<Worker>()
  let closed = false

  const queue = (name: QueueName): Queue => {
    if (closed) throw new QueueConfigError('The queues are closed.')
    if (!(QUEUE_NAMES as readonly string[]).includes(name)) throw new QueueConfigError(`Unknown queue ${JSON.stringify(name)}`)
    let found = queues.get(name)
    if (!found) {
      found = new Queue(name, { connection, prefix, defaultJobOptions: { ...JOB_DEFAULTS } })
      queues.set(name, found)
    }
    return found
  }

  const add = <Data>(name: QueueName, jobName: string, data: Data, options: AddOptions): Promise<Job<Data>> =>
    queue(name).add(jobName, data, { ...options, jobId: assertJobId(options.jobId) }) as Promise<Job<Data>>

  async function deadLetter(from: QueueName, job: Job, error: unknown): Promise<void> {
    const letter: DeadLetter = {
      queue: from,
      jobId: String(job.id),
      name: job.name,
      data: job.data,
      attemptsMade: job.attemptsMade + 1,
      error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 2_000) : String(error).slice(0, 2_000),
      failedAt: new Date().toISOString(),
    }
    await add('dead-letter', `${from}.${job.name}`, letter, { jobId: `${from}.${job.id}`, removeOnComplete: false, removeOnFail: false })
  }

  return {
    prefix,
    queue,
    add,
    work<Data>(name: Exclude<QueueName, 'dead-letter'>, processor: (job: Job<Data>) => Promise<unknown>, options: WorkOptions = {}): Worker<Data> {
      if (closed) throw new QueueConfigError('The queues are closed.')
      const worker = new Worker<Data>(
        name,
        async (job) => {
          try {
            return await processor(job)
          } catch (error) {
            const attempts = job.opts.attempts ?? 1
            if (error instanceof UnrecoverableError || job.attemptsMade + 1 >= attempts) await deadLetter(name, job, error)
            throw error
          }
        },
        { connection, prefix, concurrency: options.concurrency ?? 4 },
      )
      workers.add(worker)
      return worker
    },
    async close() {
      closed = true
      await Promise.allSettled([...workers].map((worker) => worker.close()))
      await Promise.allSettled([...queues.values()].map((entry) => entry.close()))
      workers.clear()
      queues.clear()
    },
  }
}
