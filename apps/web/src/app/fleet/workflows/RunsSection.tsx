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

function groupOutcome(g: RunGroup): { chip: 'ok' | 'fail' | 'halt' | 'run'; text: string } {
  if (g.running) return { chip: 'run', text: 'running now…' }
  if (g.ok) return { chip: 'ok', text: 'finished clean' }
  const finished = g.rows.filter((r) => r.status !== 'running')
  if (finished.length === 1) {
    const f = classifyFailure(finished[0]!)
    if (f) return { chip: f.severe ? 'fail' : 'halt', text: f.sentence }
  }
  const haltN = finished.filter((r) => r.haltedReason != null).length
  const failN = finished.filter((r) => !r.ok && r.haltedReason == null).length
  if (failN === 0 && haltN > 0) {
    return { chip: 'halt', text: `${haltN} of ${finished.length} stopped at a limit` }
  }
  const bits: string[] = []
  if (failN > 0) bits.push(`${failN} of ${finished.length} failed`)
  if (haltN > 0) bits.push(`${haltN} stopped at a limit`)
  return { chip: 'fail', text: bits.join(' · ') || 'failed' }
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
}: {
  groups: RunGroup[]
  /** Charter key → display name, for the expanded per-worker rows. */
  nameByKey: Map<string, string>
  /** True when the runs feed returned its 100-row cap — coverage is partial. */
  fetchCapReached: boolean
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
          <table className="acr-pg-tbl wf-runs">
            <thead>
              <tr>
                <th aria-label="Expand" />
                <th>When</th>
                <th>Started by</th>
                <th>Outcome</th>
                <th className="num">Workers</th>
                <th className="num">Findings</th>
                <th className="num">Cost</th>
                <th className="num">Duration</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((g) => {
                const o = groupOutcome(g)
                const isOpen = open === g.id
                return (
                  <Fragment key={g.id}>
                    <tr className="wf-grouprow">
                      <td className="wf-expandcell">
                        <button
                          type="button"
                          className="wf-expandbtn"
                          aria-expanded={isOpen}
                          aria-label={isOpen ? 'Collapse this run' : 'Show the workers in this run'}
                          onClick={() => setOpen(isOpen ? null : g.id)}
                        >
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td title={new Date(g.startedAt).toLocaleString()}>{agoTs(g.startedAt)}</td>
                      <td>{g.rows[0]?.trigger === 'schedule' ? 'the clock' : 'by hand'}</td>
                      <td>
                        <span className={CHIP_WORD[o.chip]}>{o.text}</span>
                      </td>
                      <td className="num">{g.runs}</td>
                      <td className="num">
                        {g.findings > 0 ? g.findings : <span className="acr-pg-muted">—</span>}
                      </td>
                      <td className="num">${g.costUSD.toFixed(4)}</td>
                      <td className="num">{fmtDuration(g.durationMs)}</td>
                    </tr>
                    {isOpen
                      ? g.rows.map((r) => {
                          const ro = runOutcome(r)
                          return (
                            <tr key={r.id} className="wf-subrow">
                              <td />
                              <td className="wf-subname" colSpan={2}>
                                {nameByKey.get(r.agentKey) ?? r.agentKey}
                              </td>
                              <td>
                                <span className={`wf-suboutcome ${CHIP_WORD[ro.chip]}`}>
                                  {ro.text}
                                </span>
                              </td>
                              <td className="num">
                                <Link className="wf-sublink" href={`/fleet/workers/${r.agentKey}`}>
                                  full story →
                                </Link>
                              </td>
                              <td className="num">
                                {r.findingCount > 0 ? r.findingCount : <span className="acr-pg-muted">—</span>}
                              </td>
                              <td className="num">${Number(r.costUSD || 0).toFixed(4)}</td>
                              <td className="num">{runDuration(r)}</td>
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
