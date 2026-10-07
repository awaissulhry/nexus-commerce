/**
 * Platform health — do the writes really reach the channel, and by which road.
 *
 *   ads-writes    the Amazon ad writes queued in the last 24 h by how they settled (AdMutation, read by
 *                 advertising/ads-write-outcomes.service.ts): applied, refused by the write gate, failed at Amazon,
 *                 still unsettled past their hold. Why: auto-bid counted gate-refused writes as "applied" — an engine's
 *                 own count is not proof; the settled state is.
 *   queue-drain   whether the queue workers carry the ad writes or the once-a-minute drain cron does it all. Why: BullMQ
 *                 refused job ids with ':' so every write waited for the drain. BullMQ add errors are only logged (never
 *                 recorded), so the check measures their effect: the drain's share of the ad writes dispatched.
 */
import prisma from '../../../db.js'
import { HOUR, plural, type HealthCheck, type Verdict } from '../types.js'
import type { AdWriteOutcomes } from '../../advertising/ads-write-outcomes.service.js'

// ── ads-writes ───────────────────────────────────────────────────────────────────────────────────────

export function judgeAdWrites(o: AdWriteOutcomes): Verdict {
  const attempted = o.applied + o.failed + o.refusedByGate
  const oldest = o.stuck.reduce((m, s) => Math.max(m, s.minutesLate), 0)
  const evidence = { ...o, attempted }
  const parts: string[] = []
  if (o.stuckTotal) parts.push(`${plural(o.stuckTotal, 'ad write')} ${o.stuckTotal === 1 ? 'is' : 'are'} still unsent more than ${o.stuckAfterMinutes} minutes after ${o.stuckTotal === 1 ? 'its' : 'their'} hold ended (the oldest ${oldest} minutes late)`)
  if (attempted >= 5 && o.applied === 0) parts.push(`none of the ${attempted} ad writes of the last 24 h reached Amazon (${o.refusedByGate} refused by the write gate, ${o.failed} failed)`)
  else if (attempted && o.refusedByGate / attempted >= 0.5 && o.refusedByGate >= 5) parts.push(`${o.refusedByGate} of ${attempted} ad writes were refused by the write gate`)
  if (o.failed) parts.push(`${plural(o.failed, 'ad write')} failed at Amazon`)

  const fail = (o.stuckTotal > 0 && oldest > 120) || (attempted >= 5 && o.applied === 0) || (o.failed >= 5 && o.failed / Math.max(1, attempted) >= 0.3)
  const warn = o.stuckTotal > 0 || o.failed > 0 || (attempted > 0 && o.refusedByGate / attempted >= 0.5 && o.refusedByGate >= 5)
  const gateTop = o.gateStages.slice(0, 3).map((g) => `${g.stage} ${g.count}`).join(', ')

  if (!parts.length) {
    return {
      status: 'ok',
      message: attempted
        ? `${o.applied} of ${attempted} ad writes of the last 24 h reached Amazon${o.refusedByGate ? ` (${o.refusedByGate} refused by the write gate${gateTop ? `: ${gateTop}` : ''})` : ''}; nothing is waiting past its hold.`
        : 'No ad write was queued in the last 24 h, and nothing is waiting past its hold.',
      likelyCause: null, nextStep: null, evidence,
    }
  }
  let likelyCause: string
  if (o.stuckTotal) likelyCause = 'Nothing picks the writes up: the ads worker is down or its queue refuses the jobs, and the drain-ads-sync cron is not running (see Queue path and Scheduled jobs).'
  else if (o.applied === 0 && o.refusedByGate >= o.failed) likelyCause = `The write gate refuses them${gateTop ? ` (${gateTop})` : ''}: the campaigns are off the live-write allowlist, the account is halted, or the market's connection is not live with writes enabled.`
  else likelyCause = `Amazon refused them${o.failures[0] ? ` ("${o.failures[0].error}")` : ''}.`
  return {
    status: fail ? 'fail' : warn ? 'warn' : 'ok',
    message: `${parts.join('; ')}.`,
    likelyCause,
    nextStep: o.stuckTotal
      ? 'Check the worker service on Railway and drain-ads-sync on the Sync Logs hub; cancel-queued-ad-write removes a write that is no longer right.'
      : 'Read ad-changes for the refused and failed writes (each says why); an engine that keeps writing into a refusal should be turned down until the cause is fixed.',
    evidence,
  }
}

export const adWritesCheck: HealthCheck<AdWriteOutcomes> = {
  id: 'ads-writes',
  subsystem: 'channel-writes',
  title: 'Amazon ad writes',
  watches: 'The Amazon ad writes of the last 24 h really reached Amazon: how many were applied, refused by the write gate or failed, and none waits past its hold.',
  async gather(ctx) {
    const { adWriteOutcomes } = await import('../../advertising/ads-write-outcomes.service.js')
    return adWriteOutcomes(new Date(ctx.now.getTime() - 24 * HOUR), ctx.now)
  },
  judge: judgeAdWrites,
}

// ── queue-drain ──────────────────────────────────────────────────────────────────────────────────────

export interface QueueFacts {
  /** ENABLE_QUEUE_WORKERS as the API (the producer) sees it: '1' = writes go to the queue; null = unset; undefined = not known. */
  apiQueueWorkers: string | null | undefined
  /** Why the API's flag could not be read. */
  unknownWhy: string | null
  workerReporting: boolean | null
  /** Ad write rows of the outbound queue the drain cron processed in 24 h (sum of its `processed=` lines). */
  drainProcessed: number
  drainRuns: number
  /** Ad write rows of the outbound queue that settled in 24 h (sent, failed or skipped). */
  dispatched: number
}

/** PURE. The drain's share of the ad writes, judged against whether the queue path is meant to carry them. */
export function judgeQueue(f: QueueFacts): Verdict {
  const share = f.dispatched ? Math.min(1, f.drainProcessed / f.dispatched) : 0
  const evidence = {
    apiQueueWorkers: f.apiQueueWorkers === undefined ? 'unknown' : f.apiQueueWorkers ?? 'unset',
    workerReporting: f.workerReporting,
    drainProcessed: f.drainProcessed,
    drainRunsWithWork: f.drainRuns,
    dispatched: f.dispatched,
    drainShare: Math.round(share * 100) / 100,
    bullmqAddErrors: 'not recorded: addJobSafely only logs them ("enqueue failed — cron will drain the PENDING row" in the API logs)',
  }
  if (f.apiQueueWorkers === undefined) {
    return { status: 'unknown', message: `Could not measure whether the queue path is on: ${f.unknownWhy ?? 'the API reports no flags'}.`, likelyCause: null, nextStep: null, evidence }
  }
  if (f.apiQueueWorkers !== '1') {
    return {
      status: 'ok',
      message: `Queue workers are off in the API, so the drain-ads-sync cron is the dispatch path by design: it carried ${f.drainProcessed} ad write rows in 24 h.`,
      likelyCause: null, nextStep: null, evidence,
    }
  }
  if (f.dispatched >= 5 && share >= 0.8) {
    return {
      status: 'warn',
      message: `The drain cron carried ${f.drainProcessed} of the ${f.dispatched} ad write rows sent in 24 h although queue workers are on: the queue is not taking them, so each write waits up to a minute (or longer) for the drain.`,
      likelyCause: 'Adding the job to BullMQ fails (a refused job id, Redis unreachable, or the enqueue circuit open), or the worker does not consume the ads-sync queue.',
      nextStep: f.workerReporting === false
        ? 'The worker reports no heartbeat: open the worker service on Railway.'
        : 'Search the API logs for "addJobSafely: enqueue failed" or "enqueue timed out", and the worker logs for the ads-sync queue.',
      evidence,
    }
  }
  return {
    status: 'ok',
    message: f.dispatched
      ? `The queue carries the ad writes: the drain cron picked up ${f.drainProcessed} of ${f.dispatched} in 24 h.`
      : 'No ad write was sent in 24 h, so the queue path had nothing to carry.',
    likelyCause: null, nextStep: null, evidence,
  }
}

export const queueDrainCheck: HealthCheck<QueueFacts> = {
  id: 'queue-drain',
  subsystem: 'queues',
  title: 'Queue path',
  watches: 'With queue workers on, the queue — not the once-a-minute drain cron — carries the ad writes (the drain carrying nearly all of them means the queue refuses its jobs).',
  async gather(ctx) {
    const since = new Date(ctx.now.getTime() - 24 * HOUR)
    const [{ readLiveProcesses, readFlag, snapshotsOf }, { AD_SYNC_TYPES }] = await Promise.all([
      import('../../../lib/runtime-status/process-snapshot.js'),
      import('../../ads-core/ad-mutation-state.js'),
    ])
    const [live, drains, dispatched] = await Promise.all([
      readLiveProcesses(),
      prisma.cronRun.findMany({
        where: { jobName: 'drain-ads-sync', startedAt: { gte: since }, outputSummary: { not: { startsWith: 'processed=0' } } },
        select: { outputSummary: true },
        take: 5000,
      }),
      prisma.outboundSyncQueue.count({
        where: { syncType: { in: [...AD_SYNC_TYPES] }, syncStatus: { in: ['SUCCESS', 'FAILED', 'SKIPPED'] }, updatedAt: { gte: since } },
      }),
    ])
    const flag = readFlag(live, 'api', 'ENABLE_QUEUE_WORKERS')
    const processed = drains.reduce((n, r) => n + Number(/processed=(\d+)/.exec(r.outputSummary ?? '')?.[1] ?? 0), 0)
    return {
      apiQueueWorkers: flag.known ? flag.raw : undefined,
      unknownWhy: flag.known ? null : flag.unknown?.reason ?? null,
      workerReporting: live.redisUnavailable ? null : snapshotsOf(live, 'worker').length > 0,
      drainProcessed: processed,
      drainRuns: drains.filter((r) => /processed=[1-9]/.test(r.outputSummary ?? '')).length,
      dispatched,
    }
  },
  judge: judgeQueue,
}
