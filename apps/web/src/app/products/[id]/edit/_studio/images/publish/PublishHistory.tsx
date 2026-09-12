'use client'

/**
 * PES.7 — the publish record, read honestly.
 *
 * 🔴 There are TWO logs of the same events and they cannot be joined (see `auditEvents.ts` for the
 * measurement). This surface therefore shows them as two logs, says once why they do not line up,
 * and never merges them on a timestamp guess.
 *
 * 🔴 Neither log's status field is rendered verbatim (see `jobs.ts`): on this product 37 of 78 rows
 * say IN_PROGRESS while carrying both a finish time and Amazon's per-SKU report, and the 6 that say
 * DONE carry neither.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button, Pill } from '@/design-system/primitives'

import { apiGet } from '../api'
import { failureHeadline, summariseAudit, readAuditEntry, type AuditEntry } from './auditEvents'
import { HealthCards } from './HealthCards'
import { readJob, summariseJobs, type PublishJob } from './jobs'
import styles from '../channel/amazon/matrix.module.css'

export interface PublishHistoryProps { productId: string }

const JOB_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'info'> = {
  done: 'success', failed: 'danger', rejected: 'danger', running: 'info',
  endedNoRejections: 'neutral', endedUnrecorded: 'warning', stalled: 'warning',
}
const EVENT_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'info'> = {
  started: 'info', completed: 'success', failed: 'danger', bulk: 'neutral', other: 'neutral',
}

/**
 * 🔴 A cap, not a truncation — the rest is reachable.
 *
 * Both logs are newest-first, and on this product every one of the 25 newest attempts is eBay:
 * the 43 rows whose status contradicts their own record are all older Amazon feeds, so a hard cut
 * at 25 hid every row the notice above is talking about. A count an operator cannot click into is
 * an assertion they have to take on trust.
 */
const MAX_ROWS = 25

export function PublishHistory({ productId }: PublishHistoryProps) {
  const [jobs, setJobs] = useState<PublishJob[] | null>(null)
  const [audit, setAudit] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [allJobs, setAllJobs] = useState(false)
  const [allEvents, setAllEvents] = useState(false)

  const load = useCallback(async () => {
    const [jobRes, auditRes] = await Promise.all([
      apiGet<{ jobs: PublishJob[] }>(`/api/products/${productId}/image-publish-jobs?limit=100`),
      apiGet<{ items: AuditEntry[] }>(
        `/api/audit-log/search?entityType=Product&entityId=${productId}&search=imagePublish&limit=200`),
    ])
    // The job log is the primary record; a failing audit read must not blank the whole surface.
    if (!jobRes.ok) { setError(jobRes.message); return }
    setJobs(jobRes.data?.jobs ?? [])
    // `search` matches across four columns, so re-filter here rather than trust it to have
    // returned only publish actions.
    setAudit(auditRes.ok
      ? (auditRes.data?.items ?? []).filter((e) => e.action.startsWith('imagePublish'))
      : [])
    setError(null)
  }, [productId])

  useEffect(() => { if (open && jobs === null) void load() }, [jobs, load, open])

  const jobSummary = useMemo(() => (jobs ? summariseJobs(jobs) : null), [jobs])
  const auditSummary = useMemo(() => (audit ? summariseAudit(audit) : null), [audit])
  const events = useMemo(() => (audit ?? []).map(readAuditEntry), [audit])

  return (
    <section className={styles.truth}>
      <header className={styles.head}>
        <h3 className={styles.truthTitle}>Publish record</h3>
        {jobSummary && <span className={styles.count}>{jobSummary.total} attempts</span>}
        {jobSummary && jobSummary.skuRejected > 0 && (
          <Pill tone="danger">{jobSummary.skuRejected} SKUs rejected</Pill>
        )}
        {jobSummary && jobSummary.byState.failed > 0 && (
          <Pill tone="danger">{jobSummary.byState.failed} failed</Pill>
        )}
        {jobSummary && jobSummary.unknown > 0 && (
          <Pill tone="warning">{jobSummary.unknown} with no recorded outcome</Pill>
        )}
        <span className={styles.spacer} />
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </header>

      {/* The summary before the detail: what shape is each channel in, then the rows. */}
      {open && jobs && jobs.length > 0 && <HealthCards jobs={jobs} />}

      {open && error && <p className={styles.warning} role="alert">{error}</p>}
      {open && jobs === null && !error && <p className={styles.pickerState}>Reading the publish logs…</p>}

      {/* Said once, at the top, rather than implied by two lists that quietly disagree. */}
      {open && jobSummary && auditSummary && auditSummary.total > 0 && (
        <p className={styles.notice}>
          This product has two separate records of the same publishes and they cannot be matched to
          each other: {auditSummary.channelsMissingOutcomes.length > 0 && (
            <>{auditSummary.channelsMissingOutcomes.join(' and ')} records that a publish
              started and never records how it ended
              {auditSummary.channelsMissingStarts.length > 0 && ', while '}</>
          )}
          {auditSummary.channelsMissingStarts.length > 0 && (
            <>{auditSummary.channelsMissingStarts.join(' and ')} records the outcome but not the
              start, and its {auditSummary.unattributableOutcomes} outcome
              {auditSummary.unattributableOutcomes === 1 ? '' : 's'} carry no job reference</>
          )}. Both are shown below, unmerged — pairing them up would mean guessing which outcome
          belongs to which attempt.
        </p>
      )}

      {open && jobSummary && jobSummary.contradictory > 0 && (
        <p className={styles.notice}>
          {jobSummary.contradictory} of {jobSummary.total} attempts have a status that contradicts
          the rest of their own record — marked as still running while carrying a finish time, or
          marked complete with no finish time at all. The labels below are read from the whole row
          rather than from that field.
        </p>
      )}

      {open && jobSummary && jobSummary.failures.length > 0 && (
        <section className={styles.issues}>
          <span className={styles.issuesTitle}>Why publishes failed</span>
          <ul>
            {jobSummary.failures.slice(0, 6).map((f) => (
              <li key={f.message} title={f.message}>
                {f.count > 1 && <strong>{f.count}× </strong>}{failureHeadline(f.message)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── the job log ──────────────────────────────────────────── */}
      {open && jobs && jobs.length > 0 && (
        <div className={styles.recordBlock}>
          <div className={styles.recordHead}>
            <h4 className={styles.recordTitle}>Attempts</h4>
            <span className={styles.recordSource}>
              from the job log · {jobSummary?.skuLines ?? 0} SKU lines reported
            </span>
          </div>
          <div className={styles.jobList}>
            {(allJobs ? jobs : jobs.slice(0, MAX_ROWS)).map((j) => {
              const r = readJob(j)
              return (
                <div key={j.id} className={styles.jobRow} title={r.note ?? undefined}>
                  <Pill tone={JOB_TONE[r.state] ?? 'neutral'}>{r.label}</Pill>
                  <span className={styles.jobChannel}>
                    {j.channel}{j.marketplace ? ` · ${j.marketplace}` : ''}
                  </span>
                  <span className={styles.jobWhen}>{new Date(j.submittedAt).toLocaleString()}</span>
                  <span
                    className={styles.jobRef}
                    title={j.vendorEntityId
                      ? `The channel's own reference for this attempt — quote it when asking ${j.channel} what happened`
                      : 'No channel reference was recorded for this attempt'}
                  >
                    {j.vendorEntityId ?? '—'}
                  </span>
                  {j.errorMessage
                    ? <span className={styles.jobErr} title={j.errorMessage}>{failureHeadline(j.errorMessage)}</span>
                    : r.receipt
                      ? (
                        <span className={styles.receipt}>
                          {r.receipt.rejected > 0
                            ? <span className={styles.receiptBad}>{r.receipt.rejected} rejected</span>
                            : `${r.receipt.lines} SKUs, none rejected`}
                        </span>
                      )
                      : <span />}
                </div>
              )
            })}
          </div>
          {jobs.length > MAX_ROWS && (
            <Button size="sm" variant="ghost" onClick={() => setAllJobs((v) => !v)}>
              {allJobs
                ? `Show the ${MAX_ROWS} most recent`
                : `Show all ${jobs.length} attempts (${jobs.length - MAX_ROWS} older)`}
            </Button>
          )}
        </div>
      )}

      {/* ── the audit trail ──────────────────────────────────────── */}
      {open && events.length > 0 && (
        <div className={styles.recordBlock}>
          <div className={styles.recordHead}>
            <h4 className={styles.recordTitle}>Channel reports</h4>
            <span className={styles.recordSource}>
              from the audit log · {auditSummary?.total ?? 0} entries
              {auditSummary && auditSummary.dryRuns > 0 && ` · ${auditSummary.dryRuns} dry runs`}
              {/* Every entry measured has a null userId, so this log names no one. */}
              {' '}· no user recorded
            </span>
          </div>
          <div className={styles.jobList}>
            {(allEvents ? events : events.slice(0, MAX_ROWS)).map((e) => (
              <div key={e.id} className={styles.auditRow} title={e.detail ?? undefined}>
                <Pill tone={EVENT_TONE[e.kind] ?? 'neutral'}>{e.label}</Pill>
                <span className={styles.jobChannel}>
                  {e.channel ?? '—'}{e.marketplace ? ` · ${e.marketplace}` : ''}
                </span>
                <span className={styles.jobWhen}>{new Date(e.at).toLocaleString()}</span>
                <span
                  className={styles.jobRef}
                  title={e.reference
                    ? 'Amazon’s feed id — the same value the attempt above stores, so these two can be matched by eye'
                    : 'This entry carries no channel reference'}
                >
                  {e.reference ?? '—'}
                </span>
                <span className={e.detail ? styles.auditDetail : styles.auditLabel}>
                  {e.detail ? failureHeadline(e.detail) : e.facts}
                </span>
              </div>
            ))}
          </div>
          {events.length > MAX_ROWS && (
            <Button size="sm" variant="ghost" onClick={() => setAllEvents((v) => !v)}>
              {allEvents
                ? `Show the ${MAX_ROWS} most recent`
                : `Show all ${events.length} entries (${events.length - MAX_ROWS} older)`}
            </Button>
          )}
        </div>
      )}

      {open && jobs && jobs.length === 0 && events.length === 0 && (
        <p className={styles.pickerState}>No image publish has ever been attempted for this product.</p>
      )}
    </section>
  )
}
