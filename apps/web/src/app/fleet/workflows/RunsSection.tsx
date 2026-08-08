'use client'

/**
 * NAF.WF (S3) — the routine's runs: one row per orchestration, expandable
 * into its per-worker runs. Outcomes are plain sentences from the shared
 * failure taxonomy (`run-health.classifyFailure`) — never re-derived here.
 * The full step trace stays on the worker's page (the trace UI lives inside
 * WorkerClient, owned by another stream); each expanded run links there.
 * No version column until versions exist — an always-empty column teaches
 * nothing.
 */

import { Fragment, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { classifyFailure } from '../_shared/run-health'
import { agoTs, fmtDuration, type RunGroup, type RunRow } from './lib'

const SHOW = 12

/* S3.a — the summary line carries a WORD; the sentence only appears when there
   is something to explain. Nine of twelve rows said "finished clean" inside a
   694.8px column sized by the longest failure sentence in the table; splitting
   the word from the explanation is what stops an outlier setting the width for
   every row. Both come from the shared taxonomy — never re-derived here. */
function groupOutcome(g: RunGroup): {
  chip: 'ok' | 'fail' | 'halt' | 'run'
  word: string
  why: string | null
} {
  if (g.running) return { chip: 'run', word: 'running now…', why: null }
  if (g.ok) return { chip: 'ok', word: 'finished clean', why: null }
  const finished = g.rows.filter((r) => r.status !== 'running')
  if (finished.length === 1) {
    const f = classifyFailure(finished[0]!)
    if (f) {
      return {
        chip: f.severe ? 'fail' : 'halt',
        word: f.severe ? 'failed' : 'stopped at a limit',
        why: f.sentence,
      }
    }
  }
  const haltN = finished.filter((r) => r.haltedReason != null).length
  const failN = finished.filter((r) => !r.ok && r.haltedReason == null).length
  if (failN === 0 && haltN > 0) {
    return {
      chip: 'halt',
      word: 'stopped at a limit',
      why: `${haltN} of ${finished.length} workers stopped at one of their own limits.`,
    }
  }
  const bits: string[] = []
  if (failN > 0) bits.push(`${failN} of ${finished.length} failed`)
  if (haltN > 0) bits.push(`${haltN} stopped at a limit`)
  return { chip: 'fail', word: 'failed', why: bits.join(' · ') || null }
}

/** One mark per worker in the orchestration, coloured by how that worker's run
 *  ended — so a group answers "how did the pieces go" without being expanded.
 *  Same vocabulary as the run bars on the list. */
function StepMarks({ g }: { g: RunGroup }) {
  return (
    <span className="wf-stepmarks" aria-hidden>
      {g.rows.map((r) => {
        const o = runOutcome(r)
        return <span key={r.id} className={`wf-stepmark ${o.chip}`} title={o.text} />
      })}
    </span>
  )
}

function runOutcome(r: RunRow): { chip: 'ok' | 'fail' | 'halt' | 'run'; text: string } {
  if (r.status === 'running') return { chip: 'run', text: 'running now…' }
  const f = classifyFailure(r)
  if (f) return { chip: f.severe ? 'fail' : 'halt', text: f.sentence }
  return { chip: 'ok', text: 'finished clean' }
}

function runDuration(r: RunRow): string {
  if (!r.endedAt) return '—'
  return fmtDuration(new Date(r.endedAt).getTime() - new Date(r.createdAt).getTime())
}

const CHIP_WORD: Record<'ok' | 'fail' | 'halt' | 'run', string> = {
  ok: 'acr-pg-ok',
  fail: 'acr-pg-warn',
  halt: 'wf-halt',
  run: 'wf-run',
}

export function RunsSection({
  groups,
  nameByKey,
  fetchCapReached,
  revisionNoById,
}: {
  groups: RunGroup[]
  /** Charter key → display name, for the expanded per-worker rows. */
  nameByKey: Map<string, string>
  /** True when the runs feed returned its 100-row cap — coverage is partial. */
  fetchCapReached: boolean
  /** Revision id → revision number, so a stamped run can say which wiring
   *  served it (WF.4a). Unstamped runs are code-path runs and say nothing. */
  revisionNoById?: Map<string, number>
}) {
  const [open, setOpen] = useState<string | null>(null)
  const visible = groups.slice(0, SHOW)

  return (
    <section className="acr-card">
      <header className="wf-cardhead">
        <h3>Runs</h3>
        <span className="wf-legend">
          {groups.length === 0
            ? null
            : groups.length > SHOW
              ? `latest ${SHOW} of ${groups.length} on record`
              : `${groups.length} on record`}
          {fetchCapReached ? ' · from the newest 100 recorded runs' : ''}
        </span>
      </header>

      {groups.length === 0 ? (
        <div className="acr-pg-empty">
          <strong>No runs yet.</strong>
          When this routine runs, every execution lands here: who ran, what it produced, what it
          cost, and — if something went wrong — what, in plain words.
        </div>
      ) : (
        <div className="acr-pg-tablewrap">
          {/* S3.a — `table-layout: fixed` with declared widths. The old auto
              layout let the longest failure sentence size the Outcome column
              for every row: 694.8px, 44.2% of the table, filled 12.3% by the
              nine rows that only said "finished clean". */}
          <table className="acr-pg-tbl wf-runs">
            <colgroup>
              <col className="wf-c-when" />
              <col className="wf-c-prov" />
              <col className="wf-c-out" />
              <col className="wf-c-num" />
              <col className="wf-c-num" />
              <col className="wf-c-num" />
              <col className="wf-c-exp" />
            </colgroup>
            <thead>
              <tr>
                <th>When</th>
                <th>Started by</th>
                <th>Outcome</th>
                <th className="num">Findings</th>
                <th className="num">Cost</th>
                <th className="num">Duration</th>
                <th className="num">Workers</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((g) => {
                const o = groupOutcome(g)
                const isOpen = open === g.id
                return (
                  <Fragment key={g.id}>
                    <tr className="wf-grouprow">
                      <td title={new Date(g.startedAt).toLocaleString()}>{agoTs(g.startedAt)}</td>
                      <td>
                        {g.rows[0]?.trigger === 'schedule' ? 'the clock' : 'by hand'}
                        {(() => {
                          const revId = g.rows[0]?.workflowRevisionId
                          const n = revId ? revisionNoById?.get(revId) : undefined
                          return n != null ? <span className="wf-sub">wiring rev {n}</span> : null
                        })()}
                      </td>
                      <td>
                        <span className="wf-outcell">
                          <span className={CHIP_WORD[o.chip]}>{o.word}</span>
                          <StepMarks g={g} />
                        </span>
                      </td>
                      {/* A known zero is a zero. An em-dash on this page means
                          "unknown", which is a different thing. */}
                      <td className="num">{g.findings}</td>
                      <td className="num">${g.costUSD.toFixed(4)}</td>
                      <td className="num">{fmtDuration(g.durationMs)}</td>
                      <td className="num wf-expandcell">
                        {/* The worker count stops being a column that reads "1"
                            twelve times and becomes the affordance's label — it
                            says what expanding will show, which is the only
                            reason the number matters. */}
                        <button
                          type="button"
                          className="wf-expandbtn"
                          aria-expanded={isOpen}
                          aria-label={
                            isOpen
                              ? 'Collapse this run'
                              : `Show the ${g.runs} worker${g.runs === 1 ? '' : 's'} in this run`
                          }
                          onClick={() => setOpen(isOpen ? null : g.id)}
                        >
                          {g.runs} worker{g.runs === 1 ? '' : 's'}
                          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                      </td>
                    </tr>
                    {o.why ? (
                      <tr className="wf-whyrow">
                        <td />
                        <td colSpan={6}>
                          <span className={`wf-whytext ${CHIP_WORD[o.chip]}`}>{o.why}</span>
                        </td>
                      </tr>
                    ) : null}
                    {isOpen
                      ? g.rows.map((r) => {
                          const ro = runOutcome(r)
                          return (
                            <tr key={r.id} className="wf-subrow">
                              <td className="wf-subname" colSpan={2}>
                                {nameByKey.get(r.agentKey) ?? r.agentKey}
                              </td>
                              <td>
                                <span className={`wf-suboutcome ${CHIP_WORD[ro.chip]}`}>
                                  {ro.text}
                                </span>
                              </td>
                              <td className="num">{r.findingCount}</td>
                              <td className="num">${Number(r.costUSD || 0).toFixed(4)}</td>
                              <td className="num">{runDuration(r)}</td>
                              {/* `full story →` used to render inside the
                                  WORKERS column, right-aligned as a number. */}
                              <td>
                                <Link className="wf-sublink" href={`/fleet/workers/${r.agentKey}`}>
                                  full story →
                                </Link>
                              </td>
                            </tr>
                          )
                        })
                      : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
