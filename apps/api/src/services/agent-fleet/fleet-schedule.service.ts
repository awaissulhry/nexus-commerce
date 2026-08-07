/**
 * FX.1 — "when does the fleet run next?" node-cron schedules but does not
 * expose next-fire times, so the minimal cron evaluator (now in
 * ./cron-eval.ts — pure, shared with the workflow registry) answers it.
 *
 * WF.4c — the schedule this reports is the EFFECTIVE one: an active
 * workflow revision's trigger when one exists, the env/code cron otherwise.
 * A stored `manual` trigger reports as not scheduled — the same truth the
 * re-armed clock in fleet-sweep.job.ts executes, read from the same place,
 * so this page and the actual firing cannot disagree.
 */
import prisma from '../../db.js'
import { nextCronFire } from './cron-eval.js'
import { getEffectiveDefinition } from './workflow-registry.service.js'

export { nextCronFire } from './cron-eval.js'

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
    let schedule = d.schedule
    let manual = false
    try {
      const eff = await getEffectiveDefinition(d.key)
      const trig = eff.definition?.trigger
      if (trig?.type === 'manual') manual = true
      else if (trig?.type === 'schedule' && typeof trig.cron === 'string') schedule = trig.cron
    } catch {
      /* stored layer unreadable ⇒ the env/code schedule stands */
    }
    const lastRun = await prisma.cronRun.findFirst({
      where: { jobName: d.key },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, status: true, outputSummary: true },
    })
    jobs.push({
      key: d.key,
      label: d.label,
      schedule: manual ? 'manual' : schedule,
      enabled: enabled && !manual,
      nextFireAt: enabled && !manual ? nextCronFire(schedule, now) : null,
      lastRun,
    })
  }
  return { jobs }
}
