'use client'

/**
 * IO.1 — the apply job (D15.6), under the sync-queue console's honesty rules (#357).
 *
 * Four of those rules do real work here, and each one is a bug PES.3 already paid for:
 *
 *  1. **The server's own verdict is rendered, never paraphrased.** `jobStateNote` holds the
 *     sentences; this file chooses none of them.
 *  2. **An unrecognised state reads as unexplained, never as success.** `gateNote`'s `default:`
 *     branch is the precedent — a shared default once reported an unknown publish mode as `live`.
 *  3. **`PARTIAL` is not `SUCCESS`.** A job that refused seven rows has not done the work, and the
 *     tone follows the verdict rather than the fact that the run ended (D15.13.5).
 *  4. **Silence is never reassurance.** A revert that left cells alone says so, with the count.
 *
 * The polling loop is the only thing this component owns outright, and it is deliberately dumb:
 * ask, render what came back, stop when the job settles.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { ProgressBar } from '@/design-system/components'
import { Button } from '@/design-system/primitives'

import type { ImportDiff, ImportJob, ImportJobOutcome } from './contract'
import {
  isKnownJobState,
  jobIsQuiet,
  jobIsSettled,
  jobStallNote,
  jobStateNote,
  outcomeSentence,
  revertBlockedReason,
  revertOutcomeSentence,
  revertScope,
} from './diffModel'
import type { ImportTransport } from './transport'

import styles from './import.module.css'

/** How often a running job is asked again. Slow enough not to hammer, fast enough to feel live. */
const POLL_MS = 1500

export interface ImportJobPanelProps {
  job: ImportJob
  transport: ImportTransport
  onJob: (job: ImportJob) => void
  diff?: ImportDiff | null
}

export function ImportJobPanel({ job, transport, onJob, diff }: ImportJobPanelProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAllOutcomes, setShowAllOutcomes] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aborter = useRef<AbortController | null>(null)

  const settled = jobIsSettled(String(job.state))

  /*
   * When this job last CHANGED — not when the component mounted. A poll that returns an identical
   * job is not progress, and timing from mount would reset the clock on every re-render.
   */
  const [changedAt, setChangedAt] = useState(() => Date.now())
  const signature = `${String(job.state)}:${job.processed}`
  const lastSignature = useRef(signature)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (lastSignature.current !== signature) {
      lastSignature.current = signature
      setChangedAt(Date.now())
    }
  }, [signature])
  useEffect(() => {
    if (settled) return
    const t = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(t)
  }, [settled])
  const stall = jobStallNote(job, now - changedAt)

  /*
   * 🔴 `onJob` is held in a REF, and the effect does not depend on it.
   *
   * The caller passes an inline arrow, so `onJob` has a fresh identity on every render. Listed as a
   * dependency it re-ran this effect each time the parent re-rendered — tearing down and
   * re-arming the timer on every keystroke elsewhere in the drawer, so a poll that should fire once
   * every 1.5s could be rescheduled indefinitely and never fire at all. Same class as the DS hooks
   * that returned a fresh literal and broke every careful consumer (#166): a value whose IDENTITY
   * changes but whose MEANING does not must never sit in a dependency array.
   *
   * The deps are the three facts that genuinely mean "ask again": which job, how far it has got,
   * and whether it has settled.
   */
  const onJobRef = useRef(onJob)
  useEffect(() => {
    onJobRef.current = onJob
  })

  useEffect(() => {
    if (settled) return
    const controller = new AbortController()
    aborter.current = controller
    timer.current = setTimeout(async () => {
      try {
        const next = await transport.poll({ jobId: job.jobId, signal: controller.signal })
        if (!controller.signal.aborted) onJobRef.current(next)
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e))
      }
    }, POLL_MS)
    return () => {
      controller.abort()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [job.jobId, job.processed, settled, transport])

  const onRevert = useCallback(async () => {
    const controller = new AbortController()
    setBusy(true)
    setError(null)
    try {
      const next = await transport.revert({ jobId: job.jobId, signal: controller.signal })
      onJob(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [job.jobId, transport, onJob])

  const state = String(job.state)
  const known = isKnownJobState(state)
  const quiet = jobIsQuiet(job)
  /*
   * 🔴 Three tones, and the third is the point. An unknown state is NOT the loud tone and NOT the
   * quiet one — this build cannot vouch for what happened, and "cannot vouch" must never be drawn
   * in the reassuring palette.
   */
  const toneClass = !known ? styles.jobStateUnknown : quiet ? styles.jobStateQuiet : styles.jobStateLoud

  const revertBlocked = revertBlockedReason(job, Date.now())
  const willRestore = revertScope(job)
  const revertSummary = state === 'reverted' ? revertOutcomeSentence(job) : null

  const outcomes = job.outcomes ?? []
  /* Refusals and left-alone cells first — the entries that need a person, in the order they need one. */
  const ranked: ImportJobOutcome[] = [...outcomes].sort((a, b) => rank(a) - rank(b))
  const shown = showAllOutcomes ? ranked : ranked.slice(0, 20)

  return (
    <div className={styles.job}>
      <div className={styles.jobHead}>
        <span className={`${styles.jobState} ${toneClass}`}>{state}</span>
        {!settled && <span className={styles.note}>Refreshing…</span>}
      </div>

      {/* The server's own sentence, verbatim. */}
      <p className={`${styles.note} ${styles.noteStrong}`}>{jobStateNote(job)}</p>

      {job.note && <p className={styles.note}>{job.note}</p>}

      {!settled && (
        <div className={styles.jobProgress}>
          <ProgressBar value={job.total > 0 ? (job.processed / job.total) * 100 : 0} />
          <span className={styles.jobCount}>
            {job.processed} / {job.total}
          </span>
        </div>
      )}

      {/* A stalled job says so beside the server's own state, never instead of it. */}
      {stall && (
        <div className={styles.problem} role="alert">
          {stall}
        </div>
      )}

      {revertSummary && <p className={`${styles.note} ${styles.noteStrong}`}>{revertSummary}</p>}

      {error && (
        <div className={styles.problem} role="alert">
          {error}
        </div>
      )}

      {outcomes.length > 0 && (
        <>
          <ul className={styles.outcomes}>
            {shown.map((o) => (
              <li key={`${o.rowId} ${o.fieldKey}`} className={styles.outcome}>
                <span className={styles.outcomeRow}>{diff?.rows.find(row => row.productId === o.rowId)?.sku ?? o.rowId}</span>
                <span className={styles.outcomeField}>{diff?.columns?.find(column => column.key === o.fieldKey)?.label ?? o.fieldKey}</span>
                <span
                  className={`${styles.outcomeReason} ${
                    o.verdict === 'refused'
                      ? styles.outcomeRefused
                      : o.verdict === 'unchanged'
                        ? styles.outcomeLeftAlone
                        : ''
                  }`}
                >
                  {outcomeSentence(o)}
                </span>
              </li>
            ))}
          </ul>
          {ranked.length > shown.length && (
            <Button size="sm" onClick={() => setShowAllOutcomes(true)}>
              Show all {ranked.length} outcomes
            </Button>
          )}
        </>
      )}

      {/*
        The server did not list per-cell outcomes. That is a THIRD state — not "nothing was written"
        and not "everything was" — and it is said rather than left to an empty list
        (`reference_absence_is_not_an_answer`).
      */}
      {settled && outcomes.length === 0 && (
        <p className={styles.note}>
          The server listed no per-cell outcomes for this job, so this panel cannot say which cells were
          written. The import record on the server holds them.
        </p>
      )}

      <div className={styles.footer}>
        <span className={styles.footerNote}>
          {revertBlocked ??
            (willRestore == null
              ? 'Revert will restore the cells this import wrote. The server did not list them, so the count is not known here.'
              : `Revert will restore ${willRestore} ${willRestore === 1 ? 'cell' : 'cells'}, except any edited since.`)}
        </span>
        <Button size="sm" onClick={onRevert} disabled={busy || revertBlocked != null}>
          Revert this import
        </Button>
      </div>
    </div>
  )
}

/**
 * Refusals first — they are the only entries that need a person.
 *
 * `unchanged` sorts last, below `written`: a cell that already held the value is the least
 * informative outcome there is, and it is the most numerous on a re-uploaded file.
 */
function rank(o: ImportJobOutcome): number {
  if (o.verdict === 'refused') return 0
  if (o.verdict === 'written') return 1
  return 2
}
