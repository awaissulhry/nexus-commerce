/**
 * Platform health watchdog (2026-10-07) — Claude's read of the daily platform checks: platform-health-checks.
 *
 * The watchdog (services/platform-health/, daily 06:20 UTC) measures the parts the ads run stands on — scheduled jobs and
 * processes, the data feeds per market, whether ad writes reached Amazon, approved plan steps, automation that cannot
 * progress, the queue path — and keeps one alert per failing check. This tool returns the newest run's checks with
 * their evidence, since when each one is not ok, and the open alerts, so the daily Claude ads run (and the Owner) reads
 * what is broken before deciding anything. A run older than 26 hours is stale: the watchdog not running is itself a
 * failure, and the answer says so. `live` measures every check now, in the API, without storing a row or raising an
 * alert.
 *
 * Read only and low risk: Nexus's own records, no marketplace call. Evidence holds counts, dates and names, never money,
 * and passes through claude-safe.ts.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool } from '../tool-types.js'
import { HEALTH_CHECKS } from '../../platform-health/registry.js'
import { safeText, safeTextOrNull, safeValue } from './claude-safe.js'

const CHECK_IDS = HEALTH_CHECKS.map((c) => c.id) as [string, ...string[]]
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
const TITLES = new Map(HEALTH_CHECKS.map((c) => [c.id, c.title]))

interface CheckView {
  id: string
  subsystem: string
  status: string
  message: string
  likelyCause: string | null
  nextStep: string | null
  evidence: unknown
  lastOkAt?: string | null
}

const view = (c: CheckView) => ({
  check: c.id,
  title: TITLES.get(c.id) ?? c.id,
  subsystem: c.subsystem,
  status: c.status,
  message: safeText(c.message, 1200),
  likelyCause: safeTextOrNull(c.likelyCause, 600),
  nextStep: safeTextOrNull(c.nextStep, 600),
  ...(c.lastOkAt !== undefined ? { lastOkAt: c.lastOkAt } : {}),
  evidence: safeValue(c.evidence),
})

const RANK: Record<string, number> = { fail: 0, warn: 1, unknown: 2, ok: 3 }
const keep = (status: string, filter: string) => filter === 'all' || (filter === 'problems' && status !== 'ok')

const platformHealthChecks: AgentTool = {
  name: 'platform-health-checks',
  title: 'Platform health checks',
  category: 'platform',
  description:
    'Nexus\'s own daily health checks of this business\'s platform, worst first: whether every scheduled job ran and '
    + 'finished, the scheduler and worker restarts, each data feed\'s newest data per market (ads daily reports, search '
    + 'terms and the other report feeds, Brand Analytics weeks and last night\'s report requests, Economics, keyword rank), '
    + 'whether ad writes really reached Amazon (applied, refused by the write gate, failed, stuck), approved plan steps '
    + 'skipped or failed by reason, ads rules held at the graduation gate only by the connection, automation at AUTO '
    + 'that writes nothing, and the queue path. Each check: ok, warn, fail or unknown (could not measure — never ok), '
    + 'in plain words with its likely cause, next step and evidence, and since when it is not ok; plus the open '
    + 'watchdog alerts. Read it first in a daily run. A run older than 26 hours is stale (the watchdog itself did not '
    + 'run): live: true measures every check now, without storing or alerting. Read only.',
  input: z.object({
    status: z.preprocess(lower, z.enum(['all', 'problems'])).optional().describe('all checks (default), or only those not ok'),
    check: z.preprocess(lower, z.enum(CHECK_IDS)).optional().describe('only this check, by its id'),
    live: z.boolean().optional().describe('measure every check now instead of reading the daily run (stores nothing, raises no alert; takes longer)'),
  }),
  requires: [F.adminView],
  riskTier: 'low',
  readOnly: true,
  handler: async (args) => {
    const filter = (args.status as string | undefined) ?? 'all'
    const only = args.check as string | undefined
    const pick = <T extends { id: string; status: string }>(rows: T[]) =>
      rows.filter((r) => (!only || r.id === only) && keep(r.status, filter)).sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9))
    const service = await import('../../platform-health/platform-health.service.js')

    if (args.live === true) {
      const now = new Date()
      const checks = only ? HEALTH_CHECKS.filter((c) => c.id === only) : HEALTH_CHECKS
      const results = await service.measurePlatformHealth(now, checks)
      const counts = { ok: 0, warn: 0, fail: 0, unknown: 0 } as Record<string, number>
      for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1
      return {
        ok: true,
        data: {
          measured: 'live',
          measuredAt: now.toISOString(),
          counts,
          checks: pick(results).map((r) => view(r)),
          hint: 'Measured just now by the API, not stored and no alert raised: the daily watchdog\'s run is what alerts. Settings that differ per process are the API\'s here.',
        },
      }
    }

    const reading = await service.readPlatformHealth()
    if (!reading.run) {
      return {
        ok: true,
        data: {
          run: null,
          checks: [],
          openAlerts: reading.openAlerts,
          hint: 'The daily platform health watchdog has not run in this business yet (it runs at 06:20 UTC, or with Run now on the Sync Logs hub). Call again with live: true to measure now.',
        },
      }
    }
    const checks = pick(reading.checks)
    return {
      ok: true,
      data: {
        run: reading.run,
        counts: reading.counts,
        checks: checks.map(view),
        openAlerts: reading.openAlerts.filter((a) => !only || a.check === only),
        ...(reading.run.stale
          ? { hint: `STALE: the newest watchdog run is ${reading.run.ageHours} hours old — the daily watchdog did not run, which is itself a failure (the scheduler may be down). Name it as a problem, and call again with live: true to measure now.` }
          : filter === 'all' && !only && reading.counts.fail + reading.counts.warn + reading.counts.unknown === 0
            ? { hint: 'Every check passed in the newest run.' }
            : {}),
      },
    }
  },
}

export const PLATFORM_HEALTH_TOOLS: AgentTool[] = [platformHealthChecks]
