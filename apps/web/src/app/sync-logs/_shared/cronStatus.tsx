/**
 * How the sync-logs hub shows a CronRun row's status. One place, so the row and the KPI tile cannot
 * describe the same run two ways.
 *
 * Only SUCCESS is green. PARTIAL and NOT_CONFIGURED (apps/api `CronCompletedStatus`) are runs that finished
 * without proving everything — the channel contract run records them — so they are warnings, never healthy.
 * A status this file does not know is neutral: unknown is not good.
 */
import { Pill, type Tone } from '@/design-system/primitives'

type CronRow = { status: string }

/** Completed, but not a pass. */
export const INCOMPLETE_CRON_STATUSES: readonly string[] = ['PARTIAL', 'NOT_CONFIGURED']

/** A CronRun status as a status tone. */
export function cronStatusTone(status: string): Tone {
  switch (status) {
    case 'SUCCESS': return 'success'
    case 'FAILED': return 'danger'
    case 'RUNNING': return 'info'
    default: return INCOMPLETE_CRON_STATUSES.includes(status) ? 'warning' : 'neutral'
  }
}

/** How many jobs' latest run finished without proving everything. */
export function incompleteCronCount(latest: readonly CronRow[]): number {
  return latest.filter((j) => INCOMPLETE_CRON_STATUSES.includes(j.status)).length
}

/** The cron KPI tile's tone from the latest row of every job and the stuck-run count. */
export function cronKpiTone(latest: readonly CronRow[], stale: number): 'good' | 'warn' | 'bad' {
  if (stale > 0 || latest.some((j) => j.status === 'FAILED')) return 'bad'
  if (latest.some((j) => j.status === 'RUNNING') || incompleteCronCount(latest) > 0) return 'warn'
  return 'good'
}

/** A row's status in words, in its tone — the words carry it, not the colour of a dot. */
export function CronStatusPill({ status }: { status: string }) {
  return <Pill tone={cronStatusTone(status)} dot>{status}</Pill>
}
