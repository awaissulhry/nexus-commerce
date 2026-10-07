/**
 * safeJobId (lib/job-id.ts) — every id it builds passes BullMQ's own rule, and the same parts give the same id.
 *
 * Seen in production on 2026-10-07 (00:27–01:51 UTC, API, worker and scheduler): every queued ad write logged
 * "[ads-mutation] BullMQ enqueue failed (cron drain will handle)" with "Custom Id cannot contain :" (id "ads-sync:<row>"),
 * so each write waited for the drain cron instead of its own job.
 *
 *   1  the ids BullMQ refused (control: the old shapes are refused here too) pass once built by safeJobId
 *   2  a ":" inside a part, a bare number, the business prefix WorkspaceQueue adds: all still pass
 *   3  stable (the id is BullMQ's dedupe key) and distinct for distinct rows; the ad write's id is the one #465 deployed
 */
import { describe, expect, it } from 'vitest'
import { Job } from 'bullmq'
import { adsSyncJobId, safeJobId } from './job-id.js'

/** BullMQ's own check, offline: a Job on a stand-in queue, validated exactly as `add` validates it. */
function bullmqRefusal(jobId: string): string | null {
  const queue = { opts: {}, keys: {}, toKey: (key: string) => key, qualifiedName: 'bull:check', client: Promise.resolve({}) }
  try {
    const job = new Job(queue as never, 'check', {}, { jobId })
    ;(job as unknown as { validateOptions(data: unknown): void }).validateOptions(job.asJSON())
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const ROW = 'cmtest0000001aaaabbbbcccc' // a made-up id in the shape of a queue row id

describe('safeJobId', () => {
  it('control: the shapes BullMQ refused are refused by the offline check', () => {
    expect(bullmqRefusal(`ads-sync:${ROW}`)).toBe('Custom Id cannot contain :')
    expect(bullmqRefusal(`readiness:${ROW}`)).toBe('Custom Id cannot contain :')
    expect(bullmqRefusal(`${ROW}:PRICE_UPDATE:retry:1791363346416`)).toBe('Custom Id cannot contain :')
    expect(bullmqRefusal('1791363346416')).toBe('Custom Id cannot be integers')
  })

  it('builds ids BullMQ accepts — with a ":" in a part, a bare number, and the business prefix', () => {
    const ids = [
      adsSyncJobId(ROW),
      safeJobId(adsSyncJobId(ROW), 'retry', 1791363346416),
      safeJobId('readiness', ROW),
      safeJobId(ROW, 'PRICE_UPDATE', 'retry', 1791363346416),
      safeJobId('cache', 'refresh', ROW),
      safeJobId('search', 'index', ROW),
      safeJobId('a:b', 'c:d:e'),
      safeJobId(1791363346416),
    ]
    for (const id of ids) {
      expect(id).not.toContain(':')
      expect(bullmqRefusal(id), id).toBeNull()
      // WorkspaceQueue (lib/workspace-jobs.ts) prefixes "w_<business>_".
      expect(bullmqRefusal(`w_nexus_legacy_workspace_${id}`), id).toBeNull()
    }
  })

  it('is stable and keeps distinct rows apart; the ad write id is "ads-sync-<row>" (as deployed by #465)', () => {
    expect(adsSyncJobId(ROW)).toBe(`ads-sync-${ROW}`)
    expect(adsSyncJobId(ROW)).toBe(adsSyncJobId(ROW))
    expect(adsSyncJobId(ROW)).not.toBe(adsSyncJobId('cmtest0000002aaaabbbbcccc'))
    expect(safeJobId('readiness', ROW)).toBe(`readiness-${ROW}`)
    expect(safeJobId('cache', 'refresh', ROW)).toBe(`cache-refresh-${ROW}`)
    expect(safeJobId(ROW, 'PRICE_UPDATE', 'retry', 5)).toBe(`${ROW}-PRICE_UPDATE-retry-5`)
    expect(safeJobId(42)).toBe('job-42')
  })
})
