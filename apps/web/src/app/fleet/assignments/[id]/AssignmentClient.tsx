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

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Play, Check, X, RotateCcw, Trash2, Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { useVisibilityPoll } from '../../_shared/use-visibility-poll'
import { ago, classifyFailure } from '../../_shared/run-health'
import { reasonSentence, stateDef, type AssignmentState } from '../states'

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
    createdAt: string
  }[]
}

export function AssignmentClient({ id }: { id: string }) {
  const router = useRouter()
  const [a, setA] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmStart, setConfirmStart] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

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
    async (path: string, body?: unknown, method = 'POST') => {
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
        if (j.alreadyRunning) setToast('A run was already open — showing it.')
        else if (j.haltedReason) setToast('It stopped before spending anything. See why below.')
        await load()
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(null)
        setConfirmStart(false)
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

  return (
    <>
      <Link className="acr-pg-sortbtn" href="/fleet/assignments" style={{ marginBottom: 14 }}>
        <ArrowLeft size={13} /> All assignments
      </Link>

      {/* state + why */}
      <div className="acr-pg-ctrlrow" style={{ marginBottom: 16 }}>
        <span className={`as-chip ${def.tone}`} title={def.tip}>
          <span className="as-dot" />
          {def.label}
        </span>
        <p className="as-why">
          {def.tip}
          {latest?.haltedReason && (
            <>
              {' '}
              <strong>{reasonSentence(latest.haltedReason)}</strong>
            </>
          )}
          {a.state === 'failed' && latest && (
            <> {failureSentence(latest)}</>
          )}
        </p>
      </div>

      {/* the frozen brief */}
      <div className="acr-pg-ctrlbody" style={{ marginBottom: 18 }}>
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
              title={
                a.hasUnknownCost
                  ? 'One run stopped reporting and was closed after two hours. What it spent is unknown, so it is left OUT of this total rather than counted as zero.'
                  : 'The sum of every run this assignment has made.'
              }
            >
              ${a.costUSD.toFixed(4)}
              {a.hasUnknownCost && ' + unknown'}
            </span>
          </div>
        </div>
        {a.wantBack && (
          <p className="as-why" style={{ marginTop: 14 }}>
            <strong>What you wanted back:</strong> {a.wantBack}
          </p>
        )}
        {a.closeNote && (
          <p className="as-why">
            <strong>Closing note:</strong> {a.closeNote}
          </p>
        )}
      </div>

      {/* actions */}
      <div className="as-actions" style={{ marginBottom: 20 }}>
        {a.state !== 'closed' && a.state !== 'cancelled' && (
          <button
            className="acr-pg-sortbtn"
            disabled={running || !!busy}
            onClick={() => setConfirmStart(true)}
            title={
              running
                ? 'A run is already open. There is no way to stop it — it ends on its own or on a budget.'
                : 'Runs this worker now. This calls a model, which is real spend.'
            }
          >
            {busy === '/start' ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
            {everRan ? 'Start again' : 'Start it'}
          </button>
        )}
        {a.state !== 'closed' && a.state !== 'cancelled' && everRan && (
          <button className="acr-pg-sortbtn" disabled={!!busy} onClick={() => act('/close')}>
            <Check size={13} /> Close
          </button>
        )}
        {a.state !== 'closed' && a.state !== 'cancelled' && !everRan && (
          <button className="acr-pg-sortbtn" disabled={!!busy} onClick={() => act('/cancel')}>
            <X size={13} /> Cancel
          </button>
        )}
        {(a.state === 'closed' || a.state === 'cancelled') && (
          <button className="acr-pg-sortbtn" disabled={!!busy} onClick={() => act('/reopen')}>
            <RotateCcw size={13} /> Reopen
          </button>
        )}
        {!everRan && (
          <button
            className="acr-pg-sortbtn"
            disabled={!!busy}
            onClick={() => act('', undefined, 'DELETE')}
            title="Deletes it outright. Only possible because it has never run — once it has, its runs are the record and Close is the right ending."
          >
            <Trash2 size={13} /> Delete
          </button>
        )}
        <span style={{ flex: 1 }} />
        <span className="acr-pg-muted">{asOf ? `as of ${asOf.toLocaleTimeString()}` : ''}</span>
      </div>

      {toast && (
        <div className="as-preflight" style={{ marginBottom: 16 }}>
          {toast}{' '}
          <button className="acr-pg-sortbtn" onClick={() => setToast(null)}>
            OK
          </button>
        </div>
      )}
      {error && <div className="as-err" style={{ marginBottom: 16 }}>{error}</div>}

      {confirmStart && a.worker && (
        <div className="acr-pg-confirm" style={{ marginBottom: 18 }}>
          <p>
            Run <strong>{a.worker.name}</strong> on{' '}
            <strong>
              {a.targetKind
                ? a.targetLabels.join(', ') || a.targetIds.join(', ')
                : 'your whole account'}
            </strong>{' '}
            now?
          </p>
          <p className="acr-pg-muted" style={{ lineHeight: 1.6 }}>
            This calls a model, which is real spend even though nothing is
            written to Amazon. It cannot spend more than{' '}
            <strong>${a.worker.dailyBudgetUSD.toFixed(2)}</strong> today, across
            every run of this worker. Starting twice does nothing — if a run is
            already open you will be taken to it.
          </p>
          <p className="acr-pg-muted" style={{ lineHeight: 1.6 }}>
            This worker is <strong>{a.worker.autonomyLevel}</strong> and can only
            look and report. Nothing it finds reaches Amazon without passing
            through <Link href="/fleet/approvals">Approvals</Link>.
          </p>
          <div className="acr-pg-confirmbtns">
            <button className="acr-pg-sortbtn" onClick={() => setConfirmStart(false)}>
              Not now
            </button>
            <button className="acr-pg-sortbtn" onClick={() => act('/start')} disabled={!!busy}>
              {busy ? <Loader2 size={13} className="spin" /> : <Play size={13} />} Start it
            </button>
          </div>
        </div>
      )}

      {/* every attempt */}
      <h3 className="acr-pg-ctrlwhat">Every time it has run</h3>
      {a.runs.length === 0 ? (
        <div className="acr-pg-empty">
          <p>It hasn&apos;t run yet.</p>
          <p className="acr-pg-muted" style={{ maxWidth: '56ch', lineHeight: 1.6 }}>
            Every worker in this fleet is switched off, so nothing will start it
            but you.
          </p>
        </div>
      ) : (
        <div className="acr-pg-tablewrap">
          <table className="acr-pg-tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>How it went</th>
                <th>Found</th>
                <th>Cost</th>
                <th>Took</th>
              </tr>
            </thead>
            <tbody>
              {a.runs.map((r) => (
                <tr key={r.id}>
                  <td>{ago(r.createdAt)}</td>
                  <td>{runSentence(r)}</td>
                  <td>{r.status === 'running' ? '—' : r.findingCount}</td>
                  <td>
                    {r.haltedReason?.startsWith('orphaned:')
                      ? <span title="Unknown — the reaper that closed this run does not record what it spent.">unknown</span>
                      : `$${r.costUSD.toFixed(4)}`}
                  </td>
                  <td>{duration(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* what came out of it */}
      <h3 className="acr-pg-ctrlwhat" style={{ marginTop: 22 }}>
        What it found
      </h3>
      {a.findings.length === 0 ? (
        <div className="acr-pg-empty">
          <p className="acr-pg-muted">
            {everRan
              ? 'Nothing — it looked and found nothing worth reporting. That is a result, not a failure.'
              : 'Nothing yet.'}
          </p>
        </div>
      ) : (
        <div className="acr-pg-ctrlbody">
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
            Showing up to 12. A <Term k="finding">finding</Term> here is a note
            for you — nothing reaches Amazon without passing through Approvals.
            One honest caveat while this is new: a finding records the run that
            most recently <em>re-detected</em> it, so if a nightly sweep later
            sees the same thing, it will move off this list. That is being fixed.
          </p>
        </div>
      )}

      <p className="as-caveat">
        Assignments cannot produce approvals yet. Only the weekly council queues
        actions for your decision, and it does not read assignment runs — so
        this assignment will never put something in{' '}
        <Link href="/fleet/approvals">Approvals</Link>. Said plainly rather than
        shown as a panel that could only ever be empty.
      </p>
    </>
  )
}

function runSentence(r: RunRow): string {
  if (r.status === 'running') return 'running now…'
  if (r.haltedReason?.startsWith('orphaned:')) return 'stopped reporting — closed after 2h'
  if (r.haltedReason) return reasonSentence(r.haltedReason) ?? 'stopped at a limit'
  if (!r.ok) return failureSentence(r)
  return r.findingCount > 0 ? 'finished' : 'finished — found nothing'
}

function failureSentence(r: RunRow): string {
  const f = classifyFailure({
    ok: r.ok,
    status: r.status,
    haltedReason: r.haltedReason,
    errorMessage: r.errorMessage,
  } as never)
  return f?.sentence ?? r.errorMessage ?? 'it broke'
}

function duration(r: RunRow): string {
  if (!r.endedAt) return '—'
  const ms = new Date(r.endedAt).getTime() - new Date(r.createdAt).getTime()
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}
