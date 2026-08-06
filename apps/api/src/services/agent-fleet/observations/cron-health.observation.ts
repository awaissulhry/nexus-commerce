/**
 * NAF.A — the selftest evidence builder (plan D10): CronRun health over the
 * last 24h. Real data, read-only, marketplace-independent, zero ads
 * coupling — and the output is genuinely useful (the ACR engagement found
 * two feeds failing silently under SUCCESS crons).
 *
 * One groupBy over (jobName, status) yields counts and last-run-per-status;
 * the interesting set (failures, staleness, stuck RUNNING) is passed to the
 * analyst, the healthy remainder is summarised as a count so screening is
 * visible rather than silent (no-silent-caps rule).
 */
import prisma from '../../../db.js'
import type { ObservationBuilder } from '../observation-builder.js'

const WINDOW_HOURS = 24
/** RUNNING older than this with no newer run counts as stuck. */
const STUCK_RUNNING_HOURS = 2
/** Last run older than this is stale for the purposes of the selftest. */
const STALE_HOURS = 6
/** Hard cap on evidence size; overflow is counted, never silent. */
const MAX_JOBS = 40

interface JobHealth {
  jobName: string
  runs: number
  failures: number
  stuckRunning: number
  lastStatus: string
  lastRunAt: string
  staleHours: number
}

export const cronHealthBuilder: ObservationBuilder = {
  key: 'cron-health',
  ttlMinutes: 30,
  async build() {
    const now = Date.now()
    const since = new Date(now - WINDOW_HOURS * 3600_000)
    const grouped = await prisma.cronRun.groupBy({
      by: ['jobName', 'status'],
      where: { startedAt: { gte: since } },
      _count: { _all: true },
      _max: { startedAt: true },
    })

    const byJob = new Map<
      string,
      { runs: number; failures: number; stuckRunning: number; last: { status: string; at: Date } | null }
    >()
    for (const g of grouped) {
      const j = byJob.get(g.jobName) ?? {
        runs: 0,
        failures: 0,
        stuckRunning: 0,
        last: null,
      }
      const count = g._count._all
      const at = g._max.startedAt
      j.runs += count
      if (g.status === 'FAILED') j.failures += count
      if (
        g.status === 'RUNNING' &&
        at != null &&
        now - at.getTime() > STUCK_RUNNING_HOURS * 3600_000
      ) {
        j.stuckRunning += count
      }
      if (at != null && (j.last == null || at > j.last.at)) {
        j.last = { status: g.status, at }
      }
      byJob.set(g.jobName, j)
    }

    const all: JobHealth[] = [...byJob.entries()]
      .filter(([, j]) => j.last != null)
      .map(([jobName, j]) => ({
        jobName,
        runs: j.runs,
        failures: j.failures,
        stuckRunning: j.stuckRunning,
        lastStatus: j.last!.status,
        lastRunAt: j.last!.at.toISOString(),
        staleHours:
          Math.round(((now - j.last!.at.getTime()) / 3600_000) * 10) / 10,
      }))

    const interesting = all
      .filter(
        (j) =>
          j.failures > 0 || j.stuckRunning > 0 || j.staleHours >= STALE_HOURS,
      )
      .sort(
        (a, b) => b.failures - a.failures || b.staleHours - a.staleHours,
      )

    const jobs = interesting.slice(0, MAX_JOBS)
    return {
      payload: {
        windowHours: WINDOW_HOURS,
        generatedAt: new Date(now).toISOString(),
        totalJobs: all.length,
        healthyOmitted: all.length - interesting.length,
        truncated: interesting.length - jobs.length,
        staleThresholdHours: STALE_HOURS,
        jobs,
      },
      // Live DB read — the evidence is as fresh as this computation.
      dataVintage: new Date(now),
    }
  },
}
