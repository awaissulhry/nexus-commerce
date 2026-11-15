import type { JobState } from '@nexus/factory-domain/integration-health/jobs'
import type { Job, JobRun } from './api'

/**
 * Jobs and integrations on screen (B-W2b-415; PLT-221; design admin.security sec:jobs, pop:run-now), pure: each job's name and
 * what it does in words (`admin-integration-health.json` aih.job.<key>), its state and result, why Run now is held, what a
 * bulk Run now reaches. A job the page has no words for shows its key (data).
 */

export const nameKey = (job: Pick<Job, 'key' | 'known'>): { key: string; params: Record<string, string> } => (job.known ? { key: `aih.job.${job.key}.name`, params: {} } : { key: 'aih.job.unknown.name', params: { code: job.key } })
export const whatKey = (job: Pick<Job, 'key' | 'known'>): string => (job.known ? `aih.job.${job.key}.what` : 'aih.job.unknown.what')

export const JOB_STATE_TONE: Readonly<Record<JobState, 'success' | 'info' | 'warning' | 'danger' | 'neutral'>> = {
  ok: 'success',
  running: 'info',
  stuck: 'danger',
  failing: 'danger',
  missed: 'warning',
  never: 'neutral',
}

export const RESULT_TONE: Readonly<Record<JobRun['status'], 'success' | 'info' | 'danger'>> = { SUCCEEDED: 'success', RUNNING: 'info', FAILED: 'danger' }

/** Why Run now is held for this job (a key), or null. */
export function runNowHeldKey(job: Pick<Job, 'runNow'>, canRun: boolean): string | null {
  if (!canRun) return 'aih.runNow.held.NO_RIGHT'
  return job.runNow.held ? `aih.runNow.held.${job.runNow.held}` : null
}

/** What a bulk Run now reaches among the ticked jobs: those it asks, and the others counted by why. */
export function runNowReach(jobs: readonly Job[], canRun: boolean): { applies: Job[]; left: Array<{ key: string; count: number }> } {
  const applies: Job[] = []
  const left = new Map<string, number>()
  for (const job of jobs) {
    const held = runNowHeldKey(job, canRun)
    if (held === null) applies.push(job)
    else left.set(held, (left.get(held) ?? 0) + 1)
  }
  return { applies, left: [...left].map(([key, count]) => ({ key: key.replace('aih.runNow.held.', 'aih.runNow.left.'), count })) }
}

/** The jobs in the order the page shows them: the ones that need a person first (stuck, failing, missed), then by name. */
export function jobOrder(jobs: readonly Job[], nameOf: (job: Job) => string): Job[] {
  const rank: Readonly<Record<JobState, number>> = { stuck: 0, failing: 1, missed: 2, running: 3, ok: 4, never: 5 }
  return [...jobs].sort((a, b) => rank[a.state] - rank[b.state] || nameOf(a).localeCompare(nameOf(b)))
}

/** How many jobs need a person (stuck, failing, missed). */
export const needsCount = (jobs: readonly Job[]): number => jobs.filter((job) => job.state === 'stuck' || job.state === 'failing' || job.state === 'missed').length

/** A run's duration in words' parameters: seconds under two minutes, else minutes. */
export function durationOf(ms: number | null): { key: string; params: Record<string, number> } | null {
  if (ms === null) return null
  if (ms < 120_000) return { key: 'aih.run.seconds', params: { count: Math.max(0, Math.round(ms / 1000)) } }
  return { key: 'aih.run.minutes', params: { count: Math.round(ms / 60_000) } }
}
