'use client'

/**
 * NAF.SB.AS / AS.1 — one assignment: where it is, why it is there, every
 * attempt it has made, and what came out of it.
 *
 * Boundaries this file keeps (study Part 3):
 *  - No trace viewer. Activity owns step traces; this links to the worker.
 *  - No approvals inbox and no approve/reject affordance, ever. Approvals
 *    owns the decision — and in v1 an assignment cannot produce one at all,
 *    which is said plainly rather than shipped as an empty panel.
 *  - Findings are capped at 12 with no filter bar. A scoped list that grows
 *    a filter is a sign the reader wanted Activity.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Play, Check, X, RotateCcw, Trash2, Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { useVisibilityPoll } from '../../_shared/use-visibility-poll'
import { ago, classifyFailure } from '../../_shared/run-health'
import {
  errorSentence,
  reasonSentence,
  shortReason,
  stateDef,
  type AssignmentState,
} from '../states'

interface RunRow {
  id: string
  status: string
  ok: boolean
  findingCount: number
  costUSD: number
  haltedReason: string | null
  errorMessage: string | null
  createdAt: string
  endedAt: string | null
}

interface Detail {
  id: string
  charterKey: string
  title: string
  targetKind: string | null
  targetIds: string[]
  targetLabels: string[]
  wantBack: string | null
  dueAt: string | null
  state: AssignmentState
  closeNote: string | null
  createdBy: string | null
  createdAt: string
  costUSD: number
  hasUnknownCost: boolean
  worker: {
    key: string
    name: string
    tier: string
    autonomyLevel: string
    autonomyCap: string
    dailyBudgetUSD: number
  } | null
  runs: RunRow[]
  findings: {
    id: string
    severity: string
    kind: string
    entityType: string
    entityId: string
    entityName: string | null
    rationale: string
    evidenceRefs: string[]
    dataVintage: string
    createdAt: string
  }[]
  findingTotal: number
  evidence: { id: string; key: string; dataVintage: string; computedAt: string }[]
}

export function AssignmentClient({ id }: { id: string }) {
  const router = useRouter()
  const [a, setA] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmStart, setConfirmStart] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /**
   * S3.e — the undo AS-S5 promised and nobody built.
   *
   * The study's own words: *"Close and Cancel apply immediately with no
   * dialog, and are reversible — a 6-second 'Closed. Undo' toast plus a real
   * Reopen route. Linear tolerates no-confirm only because it ships universal
   * undo; copy the pair or neither."* The Reopen route shipped at AS.1. The
   * undo half never did, so Close and Cancel produced no feedback at all —
   * half of a pair the study said to take whole or leave whole.
   */
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)

  const load = useCallback(async () => {
    const res = await fetch(`${getBackendUrl()}/api/agent/fleet/assignments/${id}`, {
      cache: 'no-store',
      credentials: 'include',
    })
    if (!res.ok) throw new Error(`assignment: ${res.status}`)
    setA((await res.json()) as Detail)
    setError(null)
  }, [id])

  const { asOf } = useVisibilityPoll(
    useCallback(async () => {
      try {
        await load()
      } catch (e) {
        setError(String(e))
        throw e
      }
    }, [load]),
  )

  const act = useCallback(
    async (
      path: string,
      body?: unknown,
      method = 'POST',
      done?: { text: string; undo?: () => void },
    ) => {
      setBusy(path)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/agent/fleet/assignments/${id}${path}`,
          {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            credentials: 'include',
            body: body ? JSON.stringify(body) : undefined,
          },
        )
        const j = (await res.json().catch(() => ({}))) as {
          error?: string
          alreadyRunning?: boolean
          haltedReason?: string
        }
        if (!res.ok) {
          setError(j.error ?? `failed (${res.status})`)
          return
        }
        if (method === 'DELETE') {
          router.push('/fleet/assignments')
          return
        }
        if (j.alreadyRunning) setToast({ text: 'A run was already open — showing it.' })
        else if (j.haltedReason)
          setToast({ text: 'It stopped before spending anything. See why below.' })
        else if (done) setToast(done)
        await load()
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(null)
        setConfirmStart(false)
        setConfirmDelete(false)
      }
    },
    [id, load, router],
  )

  if (error && !a) {
    return (
      <div className="acr-pg-empty">
        <p>Could not load this assignment.</p>
        <p className="acr-pg-muted">{error}</p>
        <Link className="acr-pg-sortbtn" href="/fleet/assignments">
          Back to assignments
        </Link>
      </div>
    )
  }
  if (!a) return <div className="acr-pg-empty"><p className="acr-pg-muted">Loading…</p></div>

  const def = stateDef(a.state)
  const latest = a.runs[0] ?? null
  const running = a.state === 'running'
  const everRan = a.runs.length > 0
  /** Open = not filed away. `open` is a reserved-ish word in JSX props here. */
  const open_ = a.state !== 'closed' && a.state !== 'cancelled'
  /** Days past the deadline, or null. Overdue is a flag, never a state. */
  const overdueDays = (() => {
    if (!a.dueAt || !open_) return null
    const d = Math.floor((Date.now() - new Date(a.dueAt).getTime()) / 86400_000)
    return d > 0 ? d : null
  })()

  return (
    /* S3.d — a root class this page alone wears. It had none, so every
       page-local override Part 11 wrote under `.as-page` missed it entirely —
       the same shape as `.as-page` failing to reach the portalled drawer in
       Part 12, one component further out. */
    <div className="as-detail">
      <Link className="as-backlink" href="/fleet/assignments">
        <ArrowLeft size={13} /> All assignments
      </Link>

      {/**
        * S3.b — the page finally says what it is looking at.
        *
        * Measured on the first render: the assignment's own title appeared
        * NOWHERE on its own page. The list shows it, Approvals renders it as
        * provenance, the drawer derives it — and the object's page showed the
        * shell's generic "Assignment" and left the operator to reassemble the
        * name from a grid.
        */}
      <h2 className="as-detail-title">{a.title}</h2>

      <div className="as-band">
        <div className="as-bandhead">
          <span className={`as-chip ${def.tone}`} title={def.tip}>
            <span className="as-dot" />
            {def.label}
          </span>
          {/* Overdue exists on the list — it colours the row and sorts it to
              the top — and did not exist here at all: a deadline two days past
              rendered in plain body colour. The object's own page was the one
              surface that did not know. */}
          {overdueDays !== null && (
            <span
              className="as-due over"
              title={`This was due ${new Date(a.dueAt!).toLocaleDateString()}. A deadline colours this and moves it up the list — it never starts anything and never stops anything.`}
            >
              {overdueDays}d late
            </span>
          )}
        </div>
        <p className="as-why">
          {def.pageWhy}
          {latest?.haltedReason && (
            <>
              {' '}
              <strong>{reasonSentence(latest.haltedReason)}</strong>
            </>
          )}
          {a.state === 'failed' && latest && <> {failureSentence(latest)}</>}
        </p>
        {/* The most important fact about this object used to be the last line
            of small print at the bottom of the page. It is one quiet, legible
            line here instead — not a panel, not a banner, and not repeated
            three times further down. */}
        <p className="as-bandfact">
          Nothing this finds reaches Amazon on its own. Every change goes
          through <Link href="/fleet/approvals">Approvals</Link> — and an
          assignment cannot put anything there yet, so this one never will.
        </p>
      </div>

      {/* the frozen brief */}
      <div className="as-briefcard">
        <div className="as-brief">
          <div>
            <span className="k">Worker</span>
            <span className="v">
              {a.worker ? (
                <Link href={`/fleet/workers/${a.worker.key}`}>{a.worker.name}</Link>
              ) : (
                a.charterKey
              )}
            </span>
          </div>
          <div>
            <span className="k">Points at</span>
            <span className="v">
              {a.targetKind
                ? a.targetLabels.join(', ') || a.targetIds.join(', ')
                : 'the whole account'}
            </span>
          </div>
          <div>
            <span className="k">Due</span>
            <span className="v">
              {a.dueAt ? new Date(a.dueAt).toLocaleDateString() : '—'}
            </span>
          </div>
          <div>
            <span className="k">Made</span>
            <span className="v">
              {ago(a.createdAt)}
              {a.createdBy ? ` by ${a.createdBy}` : ''}
            </span>
          </div>
          <div>
            <span className="k">Spent so far</span>
            <span
              className="v"
              /* S4.b — the same sentence the list uses. It described the same
                 quantity in different words on each surface, and neither said
                 what the currency was. */
              title={
                a.hasUnknownCost
                  ? 'What every run of this assignment has cost in model calls, in US dollars — model time is billed in USD even though your ads are in euro. One run stopped reporting and its cost cannot be known, so it is left out rather than counted as zero.'
                  : 'What every run of this assignment has cost in model calls, in US dollars — model time is billed in USD even though your ads are in euro.'
              }
            >
              ${a.costUSD.toFixed(2)}
              {a.hasUnknownCost && ' + unknown'}
            </span>
          </div>
        </div>
        {a.wantBack && (
          <p className="as-why as-wantback">
            <strong>What you wanted back:</strong> {a.wantBack}
          </p>
        )}
        {a.closeNote && (
          <p className="as-why">
            <strong>Closing note:</strong> {a.closeNote}
          </p>
        )}
      </div>

      {/**
        * S3.a — THREE TIERS, and only one of them spends.
        *
        * Everything here used to be `acr-pg-sortbtn`: transparent, borderless,
        * 16px. Measured on the first render of this page, *Start it* sat 85px
        * from *Delete* with nothing to tell them apart — and NN/g names
        * consequential options next to benign ones a top-ten application design
        * mistake. The one that calls a model and spends real money looked
        * exactly like the one that files the job away.
        *
        * The rule this encodes: **an action's appearance here is a statement
        * about its consequence, not about its importance.**
        */}
      <div className="as-actbar">
        {open_ && (
          <div className="as-spendzone">
            <span className="as-spendlabel">Running this costs money</span>
            <button
              className="acr-btn go"
              disabled={running || !!busy}
              onClick={() => setConfirmStart(true)}
              title={
                running
                  ? 'A run is already open. There is no way to stop it — it ends on its own, on a budget, or is closed after two hours.'
                  : 'Runs this worker now. This calls a model, which is real spend.'
              }
            >
              {busy === '/start' ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
              {everRan ? 'Start again' : 'Start it'}
            </button>
            <span className="as-spendnote">
              {running
                ? 'A run is open. It ends on its own, on a budget, or is closed after two hours.'
                : a.worker
                  ? `Up to $${a.worker.dailyBudgetUSD.toFixed(2)} today, across every run of this worker.`
                  : 'It calls a model, which is real spend.'}
            </span>
          </div>
        )}

        <div className="as-actgroup">
          {open_ && everRan && (
            <button
              className="acr-btn"
              disabled={!!busy || running}
              onClick={() =>
                act('/close', undefined, 'POST', {
                  text: 'Closed. Its runs and findings are kept.',
                  undo: () => act('/reopen'),
                })
              }
              /* S3.e — the list's row menu disables Close during a run with
                 this sentence; this page used to offer it. Two surfaces
                 disagreeing about one action on one object is worse than
                 either answer. */
              title={
                running
                  ? 'A run is open right now. Wait for it to come back — closing it would not stop it.'
                  : 'Done with it. Its runs and findings are kept, and Reopen puts it back.'
              }
            >
              <Check size={13} /> Close
            </button>
          )}
          {open_ && !everRan && (
            <button
              className="acr-btn"
              disabled={!!busy}
              onClick={() =>
                act('/cancel', undefined, 'POST', {
                  text: 'Cancelled. It never ran, and nothing was spent.',
                  undo: () => act('/reopen'),
                })
              }
              title="You called it off before it ran. Kept apart from Closed on purpose, and reversible."
            >
              <X size={13} /> Cancel
            </button>
          )}
          {!open_ && (
            <button
              className="acr-btn"
              disabled={!!busy}
              onClick={() => act('/reopen')}
              title="Puts it back among the open assignments, exactly as it was."
            >
              <RotateCcw size={13} /> Reopen
            </button>
          )}
        </div>

        {!everRan && (
          <div className="as-actdanger">
            <button
              className="acr-btn stop"
              disabled={!!busy}
              onClick={() => setConfirmDelete(true)}
              title="Removes it outright. Only possible because it has never run — once it has, its runs are the record and Close is the right ending."
            >
              <Trash2 size={13} /> Delete
            </button>
          </div>
        )}

        <span className="as-actspacer" />
        <span className="as-asofdetail" title="The time of the last successful read. This page re-reads itself about every 10 seconds while the tab is visible.">
          {asOf ? `as of ${asOf.toLocaleTimeString()}` : ''}
        </span>
      </div>

      {toast && (
        <div className="as-toast" role="status">
          <span className="as-toasttext">{toast.text}</span>
          {toast.undo && (
            <button
              className="acr-btn"
              disabled={!!busy}
              onClick={() => {
                const u = toast.undo
                setToast(null)
                u?.()
              }}
            >
              <RotateCcw size={13} /> Undo
            </button>
          )}
          <button className="as-toastx" onClick={() => setToast(null)} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      )}
      {error && <div className="as-err as-mb16">{error}</div>}

      {/**
        * S3.a — a confirm that actually interrupts.
        *
        * This used to be `.acr-pg-confirm` WITHOUT `.acr-pg-confirmwrap` — the
        * white card with the half that makes it a confirmation removed. On the
        * live page that measured as: no overlay, no `role="dialog"`, focus
        * never leaving `BODY`, **254px of content shoved down** when it opened,
        * and the page behind fully clickable — you could press Delete while
        * "spend money?" was on screen.
        *
        * `.acr-pg-confirmwrap` is the fleet's own pattern (Workflows ×4, the
        * shared autonomy dial ×2) and its stylesheet comment states the rule:
        * *"a change that starts spending should interrupt, and should survive a
        * page blur."* It is `position: fixed`, so it also costs zero reflow.
        *
        * Focus lands on the SAFE option, and Escape takes it. The research is
        * blunt about both: the safe path is the default, and focus must never
        * land on the consequential action.
        */}
      {confirmStart && a.worker && (
        <ConfirmPanel
          titleId="as-confirm-start"
          heading={`Run ${a.worker.name} now?`}
          onCancel={() => setConfirmStart(false)}
          cancelLabel="Not now"
          confirmLabel={everRan ? 'Start again' : 'Start it'}
          confirmIcon={<Play size={13} />}
          confirmTone="go"
          busy={!!busy}
          onConfirm={() => act('/start')}
        >
          <p>
            It will look at{' '}
            <strong>
              {a.targetKind
                ? a.targetLabels.join(', ') || a.targetIds.join(', ')
                : 'your whole account'}
            </strong>{' '}
            and nothing else.
          </p>
          <p>
            This calls a model, which is <strong>real spend</strong> even though
            nothing is written to Amazon. It cannot spend more than{' '}
            <strong>${a.worker.dailyBudgetUSD.toFixed(2)}</strong> today, across
            every run of this worker. Starting twice does nothing — if a run is
            already open you will be taken to it.
          </p>
          <p>
            This worker is <strong>{a.worker.autonomyLevel}</strong> and can only
            look and report. Nothing it finds reaches Amazon without passing
            through <Link href="/fleet/approvals">Approvals</Link>.
          </p>
        </ConfirmPanel>
      )}

      {confirmDelete && (
        <ConfirmPanel
          titleId="as-confirm-delete"
          heading="Delete this assignment?"
          onCancel={() => setConfirmDelete(false)}
          cancelLabel="Keep it"
          confirmLabel="Delete"
          confirmIcon={<Trash2 size={13} />}
          confirmTone="stop"
          busy={!!busy}
          onConfirm={() => act('', undefined, 'DELETE')}
        >
          <p>
            <strong>{a.title}</strong>
          </p>
          <p>
            It has never run, so there is nothing to lose but the row itself.
            Once an assignment has run, its attempts are the record and Close is
            the right ending instead.
          </p>
        </ConfirmPanel>
      )}

      {/* every attempt */}
      <h3 className="as-sectionh">Every time it has run</h3>
      {a.runs.length === 0 ? (
        <p className="as-nothing">
          It hasn&apos;t run yet — every worker in this fleet is switched off, so
          nothing will start it but you.
        </p>
      ) : (
        /**
         * S3.c — the cell says it short; the tooltip says it properly.
         *
         * Measured with 8 attempts: "How it went" took **1132px of 1614 —
         * 70% of the table** — because it printed `reasonSentence()`, the
         * long-form explanation with the fix in it. The list solved this at
         * AS.1 by printing `shortReason()` in a cell, and this page used the
         * long form where the short one belongs and then had nowhere left to
         * put the long one. Now the cell carries the phrase, the tooltip
         * carries the sentence, and the widths are declared rather than
         * allocated by whichever string happened to be longest.
         */
        <div className="acr-pg-tablewrap">
          <table className="acr-pg-tbl as-runs">
            <thead>
              <tr>
                <th className="c-when" title="When this attempt started. Hover any row for the exact time.">
                  When
                </th>
                <th title="What came back. Hover a row for the full reason and what to do about it.">
                  How it went
                </th>
                <th className="c-num" title="How many things this attempt judged worth your attention.">
                  Found
                </th>
                <th className="c-num" title="What this attempt cost in model calls, in US dollars.">
                  Cost
                </th>
                <th className="c-num" title="Wall-clock time from start to finish.">
                  Took
                </th>
              </tr>
            </thead>
            <tbody>
              {a.runs.map((r) => (
                <tr key={r.id}>
                  <td className="c-when">
                    {/* Every time on this page was relative and nothing offered
                        the real one — on a page whose subject is when this ran
                        and what it cost, that is the number you eventually
                        need. */}
                    <span title={new Date(r.createdAt).toLocaleString()}>{ago(r.createdAt)}</span>
                  </td>
                  <td className="c-went">
                    <span title={runFullSentence(r)}>{runShort(r)}</span>
                  </td>
                  <td className="c-num">{r.status === 'running' ? '—' : r.findingCount}</td>
                  <td className="c-num">
                    {r.haltedReason?.startsWith('orphaned:') ? (
                      <span title="Unknown — the reaper that closed this run does not record what it spent, so it is left out of the total rather than counted as zero.">
                        unknown
                      </span>
                    ) : (
                      `$${r.costUSD.toFixed(4)}`
                    )}
                  </td>
                  <td className="c-num">{duration(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* what came out of it */}
      <h3 className="as-sectionh as-mt22">
        What it found
      </h3>
      {a.findings.length === 0 ? (
        <p className="as-nothing">
          {everRan
            ? 'Nothing — it looked and found nothing worth reporting. That is a result, not a failure.'
            : 'Nothing yet — it has not run.'}
        </p>
      ) : (
        <div className="as-findings">
          {a.findings.map((f) => (
            <div className="as-finding" key={f.id}>
              <div className="hd">
                <span className={`as-sev ${f.severity}`}>{f.severity}</span>
                <strong className="as-fname">{f.entityName ?? f.entityId}</strong>
                <span className="acr-pg-muted as-fkind">
                  {f.kind}
                </span>
              </div>
              <p className="rat">{f.rationale}</p>
            </div>
          ))}
          <p className="as-caveat">
            {a.findingTotal > a.findings.length
              ? `Showing 12 of ${a.findingTotal}. `
              : ''}
            A <Term k="finding">finding</Term> here is a note for you — nothing
            reaches Amazon without passing through Approvals. These stay
            attributed to this assignment even if a later sweep sees the same
            thing again.
          </p>
          {a.evidence.length > 0 && (
            <p className="as-caveat">
              <strong>What they were read from:</strong>{' '}
              {a.evidence
                .map((e) => `${e.key} (data as of ${new Date(e.dataVintage).toLocaleString()})`)
                .join(' · ')}
              . If a run ever stops because the evidence was too old, this is
              the date it was judged against.
            </p>
          )}
        </div>
      )}

    </div>
  )
}

/**
 * The fleet's confirm, used properly: overlay, dialog role, focus on the safe
 * option, Escape to leave, and no reflow because the wrapper is `fixed`.
 */
function ConfirmPanel({
  titleId,
  heading,
  children,
  onCancel,
  onConfirm,
  cancelLabel,
  confirmLabel,
  confirmIcon,
  confirmTone,
  busy,
}: {
  titleId: string
  heading: string
  children: ReactNode
  onCancel: () => void
  onConfirm: () => void
  cancelLabel: string
  confirmLabel: string
  confirmIcon: ReactNode
  confirmTone: 'go' | 'stop'
  busy: boolean
}) {
  const safe = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    safe.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div
      className="acr-pg-confirmwrap"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="acr-pg-confirm as-confirm">
        <h4 id={titleId}>{heading}</h4>
        {children}
        <div className="acr-pg-confirmbtns">
          <button ref={safe} className="acr-btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button className={`acr-btn ${confirmTone}`} onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 size={13} className="spin" /> : confirmIcon} {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The phrase that goes in the cell — the same vocabulary the list uses. */
function runShort(r: RunRow): string {
  if (r.status === 'running') return 'running now…'
  if (r.haltedReason?.startsWith('orphaned:')) return 'stopped reporting'
  if (r.haltedReason) return shortReason(r.haltedReason) ?? 'stopped at a limit'
  if (!r.ok) return 'it broke'
  return r.findingCount > 0 ? 'finished' : 'finished — found nothing'
}

/** The sentence that goes in the tooltip: what happened, and what to do. */
function runFullSentence(r: RunRow): string {
  if (r.status === 'running')
    return 'This attempt is still open. There is no way to stop it — it ends on its own, on a budget, or is closed after two hours if it stops reporting.'
  if (r.haltedReason) return reasonSentence(r.haltedReason) ?? 'It stopped at a limit.'
  if (!r.ok) return failureSentence(r)
  return r.findingCount > 0
    ? `It ran and came back with ${r.findingCount} thing${r.findingCount === 1 ? '' : 's'} worth your attention.`
    : 'It ran, read the evidence, and judged that nothing needed doing. That is a result, not a failure.'
}

function failureSentence(r: RunRow): string {
  const f = classifyFailure({
    ok: r.ok,
    status: r.status,
    haltedReason: r.haltedReason,
    errorMessage: r.errorMessage,
  } as never)
  // AS.4 — a retired worker surfaces as `unknown charter: <key>`, which is
  // true about the code and baffling to an operator who can see the worker.
  return f?.sentence ?? errorSentence(r.errorMessage) ?? 'it broke'
}

function duration(r: RunRow): string {
  if (!r.endedAt) return '—'
  const ms = new Date(r.endedAt).getTime() - new Date(r.createdAt).getTime()
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}
