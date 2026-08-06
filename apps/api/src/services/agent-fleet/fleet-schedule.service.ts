/**
 * FX.1 — "when does the fleet run next?" node-cron schedules but does not
 * expose next-fire times, so a minimal 5-field cron evaluator lives here:
 * parse each field into a match-set (supports *, N, N-M, step, lists) and
 * scan forward minute-by-minute, bounded to 8 days — deterministic,
 * dependency-free, and plenty for the fleet's two crons. All UTC (the
 * crons are scheduled in server time, which is UTC on Railway).
 */
import prisma from '../../db.js'

const SCAN_LIMIT_MINUTES = 8 * 24 * 60

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart ? Number(stepPart) : 1
    if (!Number.isInteger(step) || step < 1) return null
    let lo: number
    let hi: number
    if (rangePart === '*' || rangePart === '') {
      lo = min
      hi = max
    } else if (rangePart!.includes('-')) {
      const [a, b] = rangePart!.split('-').map(Number)
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null
      lo = a!
      hi = b!
    } else {
      const n = Number(rangePart)
      if (!Number.isInteger(n)) return null
      lo = n
      hi = n
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function nextCronFire(expr: string, from: Date): Date | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minute = parseField(fields[0]!, 0, 59)
  const hour = parseField(fields[1]!, 0, 23)
  const dom = parseField(fields[2]!, 1, 31)
  const month = parseField(fields[3]!, 1, 12)
  const dow = parseField(fields[4]!, 0, 6)
  if (!minute || !hour || !dom || !month || !dow) return null

  // Standard cron dom/dow semantics: when BOTH are restricted, either may
  // match; when one is *, the other decides.
  const domAll = fields[2] === '*'
  const dowAll = fields[4] === '*'

  const t = new Date(from)
  t.setUTCSeconds(0, 0)
  t.setUTCMinutes(t.getUTCMinutes() + 1)
  for (let i = 0; i < SCAN_LIMIT_MINUTES; i++) {
    const dayMatch =
      domAll && dowAll
        ? true
        : domAll
          ? dow.has(t.getUTCDay())
          : dowAll
            ? dom.has(t.getUTCDate())
            : dow.has(t.getUTCDay()) || dom.has(t.getUTCDate())
    if (
      minute.has(t.getUTCMinutes()) &&
      hour.has(t.getUTCHours()) &&
      month.has(t.getUTCMonth() + 1) &&
      dayMatch
    ) {
      return new Date(t)
    }
    t.setUTCMinutes(t.getUTCMinutes() + 1)
  }
  return null
}

export interface FleetScheduleJob {
  key: string
  label: string
  schedule: string
  enabled: boolean
  nextFireAt: Date | null
  lastRun: { startedAt: Date; status: string; outputSummary: string | null } | null
}

export async function getFleetSchedule(now: Date = new Date()): Promise<{
  jobs: FleetScheduleJob[]
}> {
  const enabled = process.env.NEXUS_ENABLE_FLEET_SWEEP_CRON === '1'
  const defs = [
    {
      key: 'fleet-sweep',
      label: 'Nightly analyst sweep',
      schedule: process.env.NEXUS_FLEET_SWEEP_SCHEDULE ?? '45 4 * * *',
    },
    {
      key: 'fleet-council',
      label: 'Weekly council',
      schedule: process.env.NEXUS_FLEET_COUNCIL_SCHEDULE ?? '15 5 * * 1',
    },
  ]
  const jobs: FleetScheduleJob[] = []
  for (const d of defs) {
    const lastRun = await prisma.cronRun.findFirst({
      where: { jobName: d.key },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, status: true, outputSummary: true },
    })
    jobs.push({
      ...d,
      enabled,
      nextFireAt: enabled ? nextCronFire(d.schedule, now) : null,
      lastRun,
    })
  }
  return { jobs }
}
