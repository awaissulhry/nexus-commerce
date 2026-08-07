'use client'

/**
 * FX.3 — one worker, fully explained: who I am, my pipeline (real steps
 * from real runs), what I read, what I produce, my limits, my report
 * card, my charter, my run history — every run replayable as a story via
 * the FX.1 trace endpoint. Plain sentences first, raw data last.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { PlanLabels } from '../../PlanStory'
import { CharterStudio } from './CharterStudio'
import { ConfirmSpend } from '@/app/fleet/_shared/autonomy'

interface Charter {
  key: string
  name: string
  tier: string
  version: number
  description?: string
  systemPrompt: string
  observationKeys: string[]
  toolNames: string[]
  modelFeature: string
  enabled: boolean
  autonomyLevel: string
  autonomyCap: string
  dailyBudgetUSD: number
  maxTokensPerRun: number
  maxFindingsPerRun: number
  dedupeKeyPattern?: string
  maxEvidenceAgeHours?: number
  degraded: boolean
  // AC.6
  pausedUntil?: string | null
  pausedReason?: string | null
  // AC.1
  activeRevisionNumber?: number
}
interface RunRow {
  id: string
  status: string
  ok: boolean
  trigger: string
  findingCount: number
  costUSD: string
  latencyMs: number | null
  haltedReason: string | null
  errorMessage: string | null
  createdAt: string
}
interface TraceStep {
  seq: number
  type: string
  label: string
  ok: boolean
  latencyMs: number | null
  costUSD: number
  inputTokens: number
  outputTokens: number
  errorMessage: string | null
}
interface Trace {
  shape: string
  run: { model: string | null; costUSD: number; findingCount: number }
  steps: TraceStep[]
  evidence: Array<{ key: string; dataVintage: string | null; preview: string; truncated: boolean }>
  findings: Array<{ id: string; kind: string; entityId: string; severity: string; rationale: string }>
}
interface FindingRow {
  id: string
  kind: string
  entityId: string
  severity: string
  status: string
  rationale: string
  createdAt: string
}
interface Scorecard {
  charterKey: string
  windowDays: number
  periodEnd: string
  findings: number
  promoted: number
  approved: number
  rejected: number
  shadowAgreement: string | null
  grade: string | null
  promotionEligible: boolean
  costUSD: string
}

const usd = (n: number | string) => `$${Number(n).toFixed(4)}`
const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const TIER_WORDS: Record<string, string> = {
  analyst: 'a worker — it reads evidence and reports findings; it cannot change anything',
  director: 'the planner — it turns findings into a ranked plan; it cannot execute',
  critic: 'the reviewer — its job is to find reasons to say no',
  auditor: 'the reporter — it writes the nightly brief; it changes nothing',
}
const LEVEL_WORDS: Record<string, string> = {
  OFF: 'switched off — it does not run',
  OBSERVE: 'watch-only — it runs and reports, and cannot change anything',
  PROPOSE: 'proposing — its suggestions queue for your approval, nothing more',
  AUTO: 'acting on its own, inside every safety gate',
}

const GRADE_WORDS: Record<string, string> = {
  A: 'excellent — its findings almost always match the engines',
  B: 'good — solid agreement with the engines',
  C: 'unproven or mixed — needs more evidence',
  D: 'poor — it disagrees with the engines more than it agrees',
  F: 'failing — it broke its output contract too often',
}

export function WorkerClient({ workerKey }: { workerKey: string }) {
  const backend = getBackendUrl()
  const [charter, setCharter] = useState<Charter | null>(null)
  const [runs, setRuns] = useState<RunRow[]>([])
  const [findings, setFindings] = useState<FindingRow[]>([])
  const [labels, setLabels] = useState<PlanLabels>({ campaigns: {}, targets: {} })
  const [scorecards, setScorecards] = useState<Scorecard[]>([])
  const [traces, setTraces] = useState<Record<string, Trace>>({})
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [audit, setAudit] = useState<Array<{
    id: string
    action: string
    note: string | null
    actor: string | null
    createdAt: string
  }>>([])
  const [showEvidence, setShowEvidence] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  /** SB.W — "Run it now" is one of only three paths that ignore the autonomy
   *  dial and call the model on a worker that is switched OFF. It fired
   *  immediately, with nothing said about cost. With the fleet deliberately
   *  dark it is the likeliest way to spend by accident, so it asks first. */
  const [confirmRun, setConfirmRun] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, r, f, s, au] = await Promise.all([
        fetch(`${backend}/api/agent/fleet/charters`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/runs?charterKey=${workerKey}&limit=20`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/findings?charterKey=${workerKey}&limit=30`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/scorecards?charterKey=${workerKey}&limit=8`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/charters/${workerKey}/audit`, { cache: 'no-store' }),
      ])
      if (c.ok) {
        const all = ((await c.json()) as { charters: Charter[] }).charters
        setCharter(all.find((x) => x.key === workerKey) ?? null)
      }
      if (r.ok) setRuns(((await r.json()) as { runs: RunRow[] }).runs)
      if (f.ok) {
        const fj = (await f.json()) as { findings: FindingRow[]; labels?: PlanLabels }
        setFindings(fj.findings)
        setLabels(fj.labels ?? { campaigns: {}, targets: {} })
      }
      if (s.ok) setScorecards(((await s.json()) as { scorecards: Scorecard[] }).scorecards)
      if (au.ok) setAudit(((await au.json()) as { audit: typeof audit }).audit)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [backend, workerKey])

  useEffect(() => {
    void load()
  }, [load])

  const patchCharter = useCallback(
    async (body: { enabled?: boolean; autonomyLevel?: string }) => {
      setBusy(true)
      try {
        const r = await fetch(`${backend}/api/agent/fleet/charters/${workerKey}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!r.ok) {
          const d = (await r.json().catch(() => null)) as { error?: string } | null
          setErr(d?.error ?? `update failed: ${r.status}`)
        } else {
          setErr(null)
        }
        await load()
      } finally {
        setBusy(false)
      }
    },
    [backend, workerKey, load],
  )

  const loadTrace = useCallback(
    async (runId: string) => {
      if (openRun === runId) {
        setOpenRun(null)
        return
      }
      setOpenRun(runId)
      if (!traces[runId]) {
        const r = await fetch(`${backend}/api/agent/fleet/runs/${runId}/trace`, { cache: 'no-store' })
        if (r.ok) {
          const t = (await r.json()) as Trace
          setTraces((prev) => ({ ...prev, [runId]: t }))
        }
      }
    },
    [backend, openRun, traces],
  )

  const lastRun = runs[0]
  const lastTrace = lastRun ? traces[lastRun.id] : undefined
  // fetch the newest run's trace once, for the pipeline section
  useEffect(() => {
    if (lastRun && !traces[lastRun.id]) {
      void fetch(`${backend}/api/agent/fleet/runs/${lastRun.id}/trace`, { cache: 'no-store' }).then(
        async (r) => {
          if (r.ok) {
            const t = (await r.json()) as Trace
            setTraces((prev) => ({ ...prev, [lastRun.id]: t }))
          }
        },
      )
    }
  }, [backend, lastRun, traces])

  const entityLabel = (entityId: string): string => {
    const head = entityId.split(':')[0] ?? ''
    const c = labels.campaigns[head] ?? labels.campaigns[entityId]
    if (c) {
      const rest = entityId.slice(head.length + 1)
      return rest ? `“${rest}” in ${c.name}` : c.name
    }
    const t = labels.targets[entityId]
    if (t) return `“${t.text}” in ${t.campaignName}`
    return entityId
  }

  if (loading && !charter) {
    return (
      <div className="acr-fleet" aria-busy="true" aria-label="Loading this worker">
        <div className="acr-card acr-fl-skeleton" style={{ height: 160 }} />
        <div className="acr-card acr-fl-skeleton" style={{ height: 220 }} />
        <div className="acr-card acr-fl-skeleton" style={{ height: 140 }} />
      </div>
    )
  }
  if (!charter) {
    return (
      <div className="acr-card">
        <p className="acr-fl-empty">No worker named “{workerKey}”.</p>
        <Link className="acr-btn" href="/marketing/ads/rules-automation/fleet">
          <ArrowLeft size={13} /> Back to the fleet
        </Link>
      </div>
    )
  }

  const card14 = scorecards.find((s) => s.windowDays === 14)

  return (
    <div className="acr-fleet">
      {err ? (
        <div className="acr-banner err" role="alert">
          {err}
          <button className="acr-btn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}

      {/* who I am */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>
            <Link href="/marketing/ads/rules-automation/fleet" className="acr-flw-back">
              <ArrowLeft size={14} />
            </Link>
            {charter.name}
          </h3>
          <div className="acr-fl-headright">
            <span className="acr-fl-pill">{charter.tier}</span>
            <span className={`acr-fl-pill ${charter.autonomyLevel === 'OFF' ? '' : 'acr-fl-pill-ok'}`}>
              {charter.autonomyLevel}
            </span>
            <button className="acr-btn" onClick={() => void load()}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </header>
        <p className="acr-fl-desc">{charter.description}</p>
        <p className="acr-flw-plain">
          This is {TIER_WORDS[charter.tier] ?? charter.tier}. Right now it is{' '}
          {LEVEL_WORDS[charter.autonomyLevel] ?? charter.autonomyLevel}. The most it can ever be
          given is <strong>{charter.autonomyCap}</strong> — that ceiling is written in code, and
          the dial below cannot exceed it.
        </p>
        <div className="acr-fl-dialrow">
          <span className="acr-fl-lbl">Autonomy</span>
          <div className="acr-dial">
            {(['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as const).map((lv) => {
              const order = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO']
              const overCap = order.indexOf(lv) > order.indexOf(charter.autonomyCap)
              return (
                <button
                  key={lv}
                  className={`acr-btn ${charter.autonomyLevel === lv ? 'on' : ''}`}
                  disabled={busy || overCap}
                  title={
                    overCap
                      ? `Above this worker's cap (${charter.autonomyCap}) — the ceiling is written in code`
                      : LEVEL_WORDS[lv]
                  }
                  onClick={() => void patchCharter({ autonomyLevel: lv })}
                >
                  {lv}
                </button>
              )
            })}
          </div>
          <label className="acr-fl-toggle">
            <input
              type="checkbox"
              checked={charter.enabled}
              disabled={busy}
              onChange={(e) => void patchCharter({ enabled: e.target.checked })}
            />
            enabled
          </label>
        </div>
        {charter.degraded ? (
          <p className="acr-fl-degraded">
            Its stored settings could not be read — it fails safe to OFF until that is fixed.
          </p>
        ) : null}
      </section>

      {/* my pipeline */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>Its pipeline — what a run looks like</h3>
          {lastRun ? <span className="acr-fl-sub">from its latest run, {ago(lastRun.createdAt)}</span> : null}
        </header>
        {lastTrace && lastTrace.steps.length > 0 ? (
          <ol className="acr-flw-pipeline">
            {lastTrace.steps.map((s) => (
              <li key={s.seq} className={s.ok ? '' : 'bad'}>
                <span className="acr-flw-pipestep">{s.label}</span>
                <span className="acr-flw-pipemeta">
                  {s.latencyMs != null ? `${(s.latencyMs / 1000).toFixed(1)}s` : ''}
                  {s.costUSD > 0 ? ` · ${usd(s.costUSD)}` : ''}
                  {s.errorMessage ? ` · ${s.errorMessage.slice(0, 90)}` : ''}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <ol className="acr-flw-pipeline">
            {charter.observationKeys.map((k) => (
              <li key={k}>
                <span className="acr-flw-pipestep">Read the evidence: {k.replace(/-/g, ' ')}</span>
              </li>
            ))}
            <li><span className="acr-flw-pipestep">Think it through (the model call)</span></li>
            <li><span className="acr-flw-pipestep">Check its own work against the contract</span></li>
            <li><span className="acr-flw-pipestep">Write findings to the shared board</span></li>
          </ol>
        )}
        <p className="acr-fl-sub">
          Every run follows this shape: evidence first (computed by code, never by the model),
          one model call, a strict format check — a run that fails the check writes nothing.
        </p>
      </section>

      {/* what I read */}
      <section className="acr-card">
        <header className="acr-fl-head"><h3>What it reads</h3></header>
        {lastTrace && lastTrace.evidence.length > 0 ? (
          lastTrace.evidence.map((e) => (
            <div key={e.key} className="acr-flw-evidence">
              <button
                className="acr-fl-checkstoggle"
                onClick={() => setShowEvidence(showEvidence === e.key ? null : e.key)}
              >
                {showEvidence === e.key ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {e.key.replace(/-/g, ' ')}
                {e.dataVintage ? (
                  <span className="acr-fl-sub">data as of {new Date(e.dataVintage).toLocaleString()}</span>
                ) : null}
              </button>
              {showEvidence === e.key ? (
                <pre className="acr-fl-raw">
                  {e.preview}
                  {e.truncated ? '\n… (preview truncated)' : ''}
                </pre>
              ) : null}
            </div>
          ))
        ) : (
          <p className="acr-fl-empty">
            Its evidence feeds: {charter.observationKeys.map((k) => k.replace(/-/g, ' ')).join(', ') || 'none'}.
            The actual data appears here after its first run.
          </p>
        )}
      </section>

      {/* what I produce */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>What it has found lately</h3>
          <span className="acr-fl-sub">{findings.length === 0 ? 'nothing yet' : `${findings.length} recent`}</span>
        </header>
        {findings.slice(0, 12).map((f) => (
          <div key={f.id} className="acr-flw-finding">
            <span className={`acr-fl-pill sev-${f.severity}`}>{f.severity}</span>
            <span className="acr-flw-findingtext">
              <strong>{f.kind.replace(/_/g, ' ')}</strong> · {entityLabel(f.entityId)}
            </span>
            <span className="acr-fl-sub">{f.rationale.slice(0, 160)}</span>
          </div>
        ))}
      </section>

      {/* my limits */}
      <section className="acr-card">
        <header className="acr-fl-head"><h3>Its limits — enforced by code, not promises</h3></header>
        <ul className="acr-flw-limits">
          <li>Spends at most <strong>{usd(charter.dailyBudgetUSD)}</strong> a day — past that, its runs are refused before the model is called.</li>
          <li>At most <strong>{charter.maxTokensPerRun.toLocaleString()}</strong> tokens per run — a runaway run is cut off mid-flight.</li>
          <li>Reports at most <strong>{charter.maxFindingsPerRun}</strong> findings per run.</li>
          {charter.maxEvidenceAgeHours ? (
            <li>Refuses to work from evidence older than <strong>{charter.maxEvidenceAgeHours}h</strong> — stale data fails loudly, at zero cost.</li>
          ) : null}
          {charter.dedupeKeyPattern ? (
            <li>Every finding carries a stable identity key, so the same issue never counts twice.</li>
          ) : null}
          <li>It has <strong>no write access to Amazon</strong> — nothing any worker produces reaches Amazon without passing the approval gate.</li>
        </ul>
      </section>

      {/* my report card */}
      <section className="acr-card">
        <header className="acr-fl-head"><h3>Its report card</h3></header>
        {scorecards.length === 0 ? (
          <p className="acr-fl-empty">
            Report cards are computed every night. This worker has none yet — they appear after
            its first night on the books.
          </p>
        ) : (
          <>
            {card14?.grade ? (
              <p className="acr-flw-plain">
                Current grade <strong>{card14.grade}</strong> — {GRADE_WORDS[card14.grade] ?? ''}.
                {card14.promotionEligible
                  ? ' It has earned the next rung of trust.'
                  : ' It has not yet earned a promotion.'}
              </p>
            ) : null}
            <table className="acr-fl-table">
              <thead>
                <tr>
                  <th>Window</th><th>Found</th><th>Into plans</th><th>Approved</th><th>Rejected</th><th>Agrees with engines</th><th>Grade</th><th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {scorecards.slice(0, 6).map((s) => (
                  <tr key={`${s.windowDays}-${s.periodEnd}`}>
                    <td>{s.windowDays}d to {new Date(s.periodEnd).toISOString().slice(0, 10)}</td>
                    <td>{s.findings}</td>
                    <td>{s.promoted}</td>
                    <td>{s.approved}</td>
                    <td>{s.rejected}</td>
                    <td>{s.shadowAgreement == null ? 'unknown' : `${Math.round(Number(s.shadowAgreement) * 100)}%`}</td>
                    <td>{s.grade ?? '—'}</td>
                    <td>{usd(s.costUSD)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      {/* AC.6 — run controls */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>Run controls</h3>
          {charter.pausedUntil ? (
            <span className="acr-fl-pill acr-fl-pill-halt">
              paused until {new Date(charter.pausedUntil).toLocaleString()}
            </span>
          ) : null}
        </header>
        <div className="acr-fl-dialrow">
          <button className="acr-btn" disabled={busy} onClick={() => setConfirmRun(true)}>
            Run it now
          </button>
          {charter.pausedUntil ? (
            <button
              className="acr-btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await fetch(`${backend}/api/agent/fleet/charters/${workerKey}/resume`, { method: 'POST' })
                  await load()
                } finally {
                  setBusy(false)
                }
              }}
            >
              Resume it now
            </button>
          ) : (
            <button
              className="acr-btn"
              disabled={busy}
              onClick={async () => {
                const days = window.prompt('Pause this worker for how many days?', '7')
                const n = Number(days)
                if (!Number.isFinite(n) || n <= 0) return
                const reason = window.prompt('Why? (recorded)') ?? ''
                setBusy(true)
                try {
                  const until = new Date(Date.now() + n * 24 * 3600_000).toISOString()
                  const r = await fetch(`${backend}/api/agent/fleet/charters/${workerKey}/pause`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ until, reason }),
                  })
                  if (!r.ok) setErr(`pause: ${r.status}`)
                  await load()
                } finally {
                  setBusy(false)
                }
              }}
            >
              Pause it for a while
            </button>
          )}
        </div>
        <p className="acr-fl-sub">
          A pause always has an end date, so stopping a worker is never a forgotten off switch.
          Running it now ignores the dial — it is how you test a worker that is switched off,
          and it is the one control here that spends money on a dark fleet.
        </p>
        {confirmRun ? (
          <ConfirmSpend
            workerName={charter.name}
            isOff={!charter.enabled || charter.autonomyLevel === 'OFF'}
            dailyBudgetUSD={Number(charter.dailyBudgetUSD)}
            what="Run it once now"
            busy={busy}
            onCancel={() => setConfirmRun(false)}
            onConfirm={async () => {
              setBusy(true)
              try {
                const r = await fetch(`${backend}/api/agent/fleet/run/${workerKey}`, { method: 'POST' })
                if (!r.ok) setErr(`run now: ${r.status}`)
                await load()
              } finally {
                setBusy(false)
                setConfirmRun(false)
              }
            }}
          />
        ) : null}
      </section>

      {/* AC.1–AC.3 — Charter Studio */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>Its charter — the instruction it actually runs on</h3>
          <span className="acr-fl-sub">code version {charter.version}</span>
        </header>
        <CharterStudio workerKey={workerKey} onChanged={() => void load()} />
      </section>

      {/* AC.7 — control history */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>What has been changed, and by whom</h3>
          <span className="acr-fl-sub">{audit.length === 0 ? 'nothing yet' : `${audit.length} changes`}</span>
        </header>
        {audit.length === 0 ? (
          <p className="acr-fl-empty">
            Every dial move, charter activation, policy edit and pause is recorded here with who
            did it and why.
          </p>
        ) : (
          <ul className="acr-fl-sweeps">
            {audit.map((a) => (
              <li key={a.id}>
                <span className="acr-fl-pill">{a.action.replace(/_/g, ' ')}</span>
                {a.note ? <span>{a.note}</span> : null}
                <span className="acr-fl-sub">
                  {a.actor ?? 'operator'} · {new Date(a.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* run history */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>Run history</h3>
          <span className="acr-fl-sub">{runs.length === 0 ? 'no runs yet' : `${runs.length} recent`}</span>
        </header>
        {runs.map((r) => (
          <div key={r.id} className="acr-fl-run">
            <button className="acr-fl-runhead" onClick={() => void loadTrace(r.id)}>
              {openRun === r.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span className={`acr-dot ${r.ok ? 'ok' : 'bad'}`} />
              {ago(r.createdAt)} · {r.trigger} · {r.findingCount} finding{r.findingCount === 1 ? '' : 's'} · {usd(r.costUSD)}
              {r.haltedReason ? ` · stopped: ${r.haltedReason}` : ''}
            </button>
            {openRun === r.id ? (
              traces[r.id] ? (
                <ol className="acr-flw-pipeline">
                  {traces[r.id]!.steps.map((s) => (
                    <li key={s.seq} className={s.ok ? '' : 'bad'}>
                      <span className="acr-flw-pipestep">{s.label}</span>
                      <span className="acr-flw-pipemeta">
                        {s.latencyMs != null ? `${(s.latencyMs / 1000).toFixed(1)}s` : ''}
                        {s.inputTokens > 0 ? ` · ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out` : ''}
                        {s.costUSD > 0 ? ` · ${usd(s.costUSD)}` : ''}
                        {s.errorMessage ? ` · ${s.errorMessage.slice(0, 90)}` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="acr-fl-empty">Loading the trace…</p>
              )
            ) : null}
          </div>
        ))}
      </section>
    </div>
  )
}
