/**
 * P3.6 (docs/channel-connections/FINAL-PLAN.md section 6 row P3.6, detail in §13.7) —
 * live dashboards and target levels per channel and operation.
 *
 * Done when: *each channel shows error rate, slow calls, backlog age and dead letters
 * against a target.*
 *
 * ## What was measured first (2026-09-20)
 *
 * - **No target level exists anywhere.** `slo` appears once in `apps/api/src`, in a
 *   comment on an unrelated route. There was nothing to be "against".
 * - The numbers themselves were scattered: `/sync-logs/api-calls` rolls calls up by
 *   channel, `/admin/outbound-latency` measures queue latency, the Ingress tab counts
 *   inbound events. **Nothing put the four together, and nothing compared any of them
 *   to a number a person had agreed.**
 * - The backlog is real and small: **1 PENDING row, 227 hours old** (SHOPIFY). A
 *   9-day-old queue row is exactly what "backlog age" is for, and nothing was showing
 *   it.
 *
 * ## 🔴 The honest denominator
 *
 * Of the 395 calls since the gateway landed, **only the 48 Shopify ones are real
 * traffic** — every eBay row is a test artefact (a `conn-1` account, a sandbox host, no
 * status code) and Amazon has 2. A dashboard "verified" against that is verified
 * against nothing, so this service reports `sampleSize` on every metric and a verdict
 * of `no_data` is a first-class answer, never a green one.
 *
 * ## Why a target is a number someone agreed, not a number we computed
 *
 * An SLO derived from recent behaviour ("p95 of the last week") always says the system
 * is fine, because it moves with the system. These are fixed defaults with env
 * overrides — a number that can be MISSED is the only kind worth showing.
 */

import type { PrismaClient } from '@prisma/client'
import prismaDefault from '../../db.js'

/** How far back the dashboard looks, unless the caller says otherwise. */
export const DEFAULT_WINDOW_HOURS = 24

/** A call slower than this is a "slow call". */
const int = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * The agreed numbers. Each is a ceiling: at or below it is `meeting`, above it is
 * `missing`.
 */
export const targets = {
  /** Percent of calls that failed. */
  errorRatePct: (): number => int(process.env.NEXUS_SLO_ERROR_RATE_PCT, 2),
  /** A call taking longer than this is slow. */
  slowCallMs: (): number => int(process.env.NEXUS_SLO_SLOW_CALL_MS, 5000),
  /** Percent of calls allowed to be slow. */
  slowCallPct: (): number => int(process.env.NEXUS_SLO_SLOW_CALL_PCT, 5),
  /** Hours the oldest waiting change may have been waiting. */
  backlogAgeHours: (): number => int(process.env.NEXUS_SLO_BACKLOG_AGE_HOURS, 1),
  /** Dead letters allowed in the window. Zero: a dead letter always needs a person. */
  deadLetters: (): number => int(process.env.NEXUS_SLO_DEAD_LETTERS, 0),
}

/**
 * `no_data` is not a pass.
 *
 * A metric with nothing behind it must never render green — that is the false green
 * this programme keeps finding. It is its own verdict so a screen can say "nothing
 * happened here" instead of "everything is fine here".
 */
export type Verdict = 'meeting' | 'missing' | 'no_data'

export interface Metric {
  /** What we measured. Null when there was nothing to measure. */
  value: number | null
  /** The agreed ceiling. */
  target: number
  verdict: Verdict
  /** How many observations the value rests on. 0 means the value is null. */
  sampleSize: number
  unit: 'percent' | 'hours' | 'count'
  /** One plain sentence, always present — including when there is no data. */
  note: string
}

export interface ChannelOperationHealth {
  operation: string
  calls: number
  failed: number
  errorRate: Metric
  slowCalls: Metric
}

export interface ChannelHealth {
  channel: string
  window: { since: Date; until: Date }
  calls: number
  errorRate: Metric
  slowCalls: Metric
  backlogAge: Metric
  deadLetters: Metric
  /** Worst verdict across the four — `no_data` only when ALL four have none. */
  verdict: Verdict
  /** The noisiest operations, worst error rate first. */
  operations: ChannelOperationHealth[]
}

/** Worst-wins, with `no_data` never masking a real miss and never counting as a pass. */
export function rollUp(verdicts: Verdict[]): Verdict {
  if (verdicts.includes('missing')) return 'missing'
  if (verdicts.includes('meeting')) return 'meeting'
  return 'no_data'
}

function metric(args: {
  value: number | null
  target: number
  sampleSize: number
  unit: Metric['unit']
  meetingNote: (v: number) => string
  missingNote: (v: number) => string
  emptyNote: string
  /** Default false: at-or-below the target is meeting. */
  higherIsWorse?: boolean
}): Metric {
  if (args.value === null || args.sampleSize === 0) {
    return { value: null, target: args.target, verdict: 'no_data', sampleSize: 0, unit: args.unit, note: args.emptyNote }
  }
  const missing = args.value > args.target
  return {
    value: args.value,
    target: args.target,
    verdict: missing ? 'missing' : 'meeting',
    sampleSize: args.sampleSize,
    unit: args.unit,
    note: missing ? args.missingNote(args.value) : args.meetingNote(args.value),
  }
}

const pct = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10

/** Channels we report on, derived from the gateway's own list rather than restated. */
export const HEALTH_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] as const

export interface ChannelHealthArgs {
  since?: Date
  until?: Date
  /** How many operations to break out per channel. */
  operationLimit?: number
  prisma?: PrismaClient
}

/**
 * The four numbers, per channel, against their targets — plus the noisiest operations.
 *
 * One pass per source rather than one per channel: a query per channel per metric would
 * be sixteen round-trips for a screen that refreshes.
 */
export async function channelHealth(args: ChannelHealthArgs = {}): Promise<ChannelHealth[]> {
  const prisma = args.prisma ?? (prismaDefault as unknown as PrismaClient)
  const until = args.until ?? new Date()
  const since = args.since ?? new Date(until.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000)
  const slowMs = targets.slowCallMs()
  const window = { createdAt: { gte: since, lte: until } }

  const [byChannel, failedByChannel, slowByChannel, deadByChannel, backlog, byOperation, failedByOperation, slowByOperation] =
    await Promise.all([
      prisma.outboundApiCallLog.groupBy({ by: ['channel'], where: window, _count: { _all: true } }),
      prisma.outboundApiCallLog.groupBy({ by: ['channel'], where: { ...window, success: false }, _count: { _all: true } }),
      prisma.outboundApiCallLog.groupBy({ by: ['channel'], where: { ...window, latencyMs: { gt: slowMs } }, _count: { _all: true } }),
      prisma.webhookEvent.groupBy({ by: ['channel'], where: { ...window, status: 'dlq' }, _count: { _all: true } }),
      // The OLDEST thing still waiting, per channel. Not a count: one change stuck for
      // nine days is a worse fact than ninety queued in the last minute, and a count
      // cannot tell them apart.
      prisma.outboundSyncQueue.groupBy({
        by: ['targetChannel'], where: { syncStatus: 'PENDING' }, _min: { createdAt: true },
      }),
      prisma.outboundApiCallLog.groupBy({ by: ['channel', 'operation'], where: window, _count: { _all: true } }),
      prisma.outboundApiCallLog.groupBy({ by: ['channel', 'operation'], where: { ...window, success: false }, _count: { _all: true } }),
      prisma.outboundApiCallLog.groupBy({ by: ['channel', 'operation'], where: { ...window, latencyMs: { gt: slowMs } }, _count: { _all: true } }),
    ])

  const count = (rows: Array<{ channel?: unknown; targetChannel?: unknown; _count?: { _all?: number } }>, channel: string): number =>
    rows.filter((r) => String(r.channel ?? r.targetChannel) === channel).reduce((n, r) => n + (r._count?._all ?? 0), 0)

  const opKey = (r: { channel: unknown; operation: unknown }) => `${String(r.channel)}|${String(r.operation)}`
  const opFailed = new Map(failedByOperation.map((r) => [opKey(r as never), r._count?._all ?? 0]))
  const opSlow = new Map(slowByOperation.map((r) => [opKey(r as never), r._count?._all ?? 0]))

  const channels = [...new Set([
    ...HEALTH_CHANNELS,
    ...byChannel.map((r) => String(r.channel)),
    ...deadByChannel.map((r) => String(r.channel)),
    ...backlog.map((r) => String(r.targetChannel)),
  ])]

  return channels.map((channel) => {
    const calls = count(byChannel as never, channel)
    const failed = count(failedByChannel as never, channel)
    const slow = count(slowByChannel as never, channel)
    const dead = count(deadByChannel as never, channel)
    const oldest = backlog.find((r) => String(r.targetChannel) === channel)?._min?.createdAt ?? null
    const backlogHours = oldest ? Math.round(((until.getTime() - oldest.getTime()) / 3_600_000) * 10) / 10 : null

    const errorRate = metric({
      value: calls === 0 ? null : pct(failed, calls),
      target: targets.errorRatePct(), sampleSize: calls, unit: 'percent',
      meetingNote: (v) => `${v}% of ${calls} calls failed, within the ${targets.errorRatePct()}% target.`,
      missingNote: (v) => `${v}% of ${calls} calls failed — over the ${targets.errorRatePct()}% target.`,
      emptyNote: `No calls to ${channel} in this window, so there is no error rate to report.`,
    })
    const slowCalls = metric({
      value: calls === 0 ? null : pct(slow, calls),
      target: targets.slowCallPct(), sampleSize: calls, unit: 'percent',
      meetingNote: (v) => `${v}% of calls took over ${slowMs} ms, within the ${targets.slowCallPct()}% target.`,
      missingNote: (v) => `${v}% of calls took over ${slowMs} ms — over the ${targets.slowCallPct()}% target.`,
      emptyNote: `No calls to ${channel} in this window, so nothing can be called slow.`,
    })
    const backlogAge = metric({
      value: backlogHours,
      // One waiting row IS the sample: this measures the oldest, not an average.
      target: targets.backlogAgeHours(), sampleSize: oldest ? 1 : 0, unit: 'hours',
      meetingNote: (v) => `The oldest waiting change is ${v} h old, within the ${targets.backlogAgeHours()} h target.`,
      missingNote: (v) => `A change has been waiting ${v} h — over the ${targets.backlogAgeHours()} h target.`,
      emptyNote: `Nothing is waiting to go to ${channel}.`,
    })
    const deadLetters = metric({
      // Zero dead letters is a MEASUREMENT, not an absence: the ledger was asked and
      // answered none. It is `meeting`, and its sample is the window itself.
      value: dead,
      target: targets.deadLetters(), sampleSize: 1, unit: 'count',
      meetingNote: () => `No ${channel} event has given up in this window.`,
      missingNote: (v) => `${v} ${channel} event${v === 1 ? '' : 's'} gave up and will not be tried again.`,
      emptyNote: `Nothing to report.`,
    })

    const operations = byOperation
      .filter((r) => String(r.channel) === channel)
      .map((r) => {
        const opCalls = r._count?._all ?? 0
        const key = opKey(r as never)
        const opFail = opFailed.get(key) ?? 0
        const opSlowN = opSlow.get(key) ?? 0
        return {
          operation: String(r.operation),
          calls: opCalls,
          failed: opFail,
          errorRate: metric({
            value: opCalls === 0 ? null : pct(opFail, opCalls),
            target: targets.errorRatePct(), sampleSize: opCalls, unit: 'percent',
            meetingNote: (v) => `${v}% of ${opCalls} calls failed.`,
            missingNote: (v) => `${v}% of ${opCalls} calls failed — over the ${targets.errorRatePct()}% target.`,
            emptyNote: 'No calls.',
          }),
          slowCalls: metric({
            value: opCalls === 0 ? null : pct(opSlowN, opCalls),
            target: targets.slowCallPct(), sampleSize: opCalls, unit: 'percent',
            meetingNote: (v) => `${v}% over ${slowMs} ms.`,
            missingNote: (v) => `${v}% over ${slowMs} ms — over the ${targets.slowCallPct()}% target.`,
            emptyNote: 'No calls.',
          }),
        }
      })
      // Worst first, and a missed target always outranks a busy-but-healthy operation:
      // an operation failing 100% of 3 calls is the one to look at, not the one making
      // 26,838 successful ones.
      .sort((a, b) => (b.errorRate.value ?? -1) - (a.errorRate.value ?? -1) || b.calls - a.calls)
      .slice(0, args.operationLimit ?? 5)

    return {
      channel,
      window: { since, until },
      calls,
      errorRate, slowCalls, backlogAge, deadLetters,
      verdict: rollUp([errorRate.verdict, slowCalls.verdict, backlogAge.verdict, deadLetters.verdict]),
      operations,
    }
  })
}

/**
 * Everything one change did, in order — the other half of the P3.6 row.
 *
 * `traceId` is stamped on the queue row at creation and re-bound by the worker, so a
 * single indexed lookup answers "what happened to my edit". Before P3.6 the nearest
 * thing was `requestId`, which is a RUN id: one cron tick's id covers 1,243 calls.
 */
export async function callsForTrace(traceId: string, opts: { prisma?: PrismaClient } = {}) {
  const prisma = opts.prisma ?? (prismaDefault as unknown as PrismaClient)
  return prisma.outboundApiCallLog.findMany({
    where: { traceId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, channel: true, operation: true, method: true, statusCode: true, success: true,
      latencyMs: true, errorClass: true, errorCode: true, errorMessage: true,
      listingId: true, productId: true, createdAt: true,
    },
  })
}
