/**
 * Platform health watchdog (2026-10-07) — what became of the Amazon ad writes Nexus queued, read from their typed record
 * (AdMutation, AX-ZD.1). AdMutation is advertising-owned (scripts/check-context-boundary.mjs), so the read lives here and
 * the watchdog's `ads-writes` check (services/platform-health/checks/writes.checks.ts) only calls it.
 *
 * Why: auto-bid counted writes the write gate refused as "applied", and with BullMQ refusing job ids writes waited for a
 * drain cron. An engine's own summary cannot be trusted to say a write reached Amazon; the mutation's settled state can:
 *   APPLIED     Amazon accepted it
 *   FAILED      Amazon refused it, or it was dead-lettered
 *   CANCELLED   never sent: refused by the write gate (lastError "<stage>: <reason>"), local-only ("local-only: …"), or
 *               cancelled by a person (no error)
 *   SUPERSEDED  a newer write to the same field replaced it before it was sent
 *   PENDING / IN_FLIGHT  not settled yet — stuck once its hold has passed by more than 30 minutes
 *
 * Read only. Gate reasons are reported by their STAGE only (the text before the colon): a reason's text can carry a bid.
 */
import prisma from '../../db.js'

export interface AdWriteOutcomes {
  since: string
  applied: number
  failed: number
  superseded: number
  refusedByGate: number
  localOnly: number
  cancelledByPerson: number
  open: number
  /** Refusals by write-gate stage, most first. */
  gateStages: Array<{ stage: string; count: number }>
  /** Failures by the first words of their error (numbers removed), most first. */
  failures: Array<{ error: string; count: number }>
  /** Unsettled writes whose hold passed more than `stuckAfterMinutes` ago (any age up to 7 days). */
  stuck: Array<{ state: string; dueAt: string; minutesLate: number; entityType: string }>
  /** All of them (the list above holds the oldest 50). */
  stuckTotal: number
  stuckAfterMinutes: number
}

const STUCK_AFTER_MS = 30 * 60_000

const stageOf = (error: string) => error.split(':')[0].replace(/\d+([.,]\d+)?/g, '#').trim().slice(0, 60) || 'unknown'
const masked = (error: string) => error.replace(/\d+([.,]\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80)

function counted(values: string[]): Array<{ key: string; count: number }> {
  const map = new Map<string, number>()
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1)
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count)
}

/** The ad writes created since `since`, by how they settled, and the ones still unsettled past their hold. */
export async function adWriteOutcomes(since: Date, now: Date = new Date()): Promise<AdWriteOutcomes> {
  const [byState, cancelled, failed, open] = await Promise.all([
    prisma.adMutation.groupBy({ by: ['state'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.adMutation.findMany({ where: { createdAt: { gte: since }, state: 'CANCELLED' }, select: { lastError: true }, take: 5000 }),
    prisma.adMutation.findMany({ where: { createdAt: { gte: since }, state: 'FAILED' }, select: { lastError: true }, take: 2000 }),
    prisma.adMutation.findMany({
      where: { state: { in: ['PENDING', 'IN_FLIGHT'] }, createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } },
      select: { state: true, holdUntil: true, createdAt: true, entityType: true },
      orderBy: { createdAt: 'asc' },
      take: 2000,
    }),
  ])
  const count = (state: string) => byState.find((r) => r.state === state)?._count._all ?? 0
  const gate: string[] = []
  let localOnly = 0
  let person = 0
  for (const row of cancelled) {
    const error = row.lastError?.trim() ?? ''
    if (!error) person++
    else if (error.startsWith('local-only')) localOnly++
    else gate.push(stageOf(error))
  }
  const stuck = open
    .map((row) => {
      const due = row.holdUntil && row.holdUntil > row.createdAt ? row.holdUntil : row.createdAt
      return { state: row.state, due, late: now.getTime() - due.getTime(), entityType: row.entityType }
    })
    .filter((row) => row.late > STUCK_AFTER_MS)
  return {
    since: since.toISOString(),
    applied: count('APPLIED'),
    failed: count('FAILED'),
    superseded: count('SUPERSEDED'),
    refusedByGate: gate.length,
    localOnly,
    cancelledByPerson: person,
    open: count('PENDING') + count('IN_FLIGHT'),
    gateStages: counted(gate).slice(0, 8).map(({ key, count }) => ({ stage: key, count })),
    failures: counted(failed.map((row) => masked(row.lastError ?? 'no error recorded'))).slice(0, 5).map(({ key, count }) => ({ error: key, count })),
    stuck: stuck.slice(0, 50).map((row) => ({ state: row.state, dueAt: row.due.toISOString(), minutesLate: Math.round(row.late / 60_000), entityType: row.entityType })),
    stuckTotal: stuck.length,
    stuckAfterMinutes: STUCK_AFTER_MS / 60_000,
  }
}
