'use client'

/**
 * NAF.SB.ACT.5 (DT.4) — one run, told as a story.
 *
 * This is the page's payoff: a row says WHAT happened, and this says WHY. It
 * reads the existing `GET /agent/fleet/runs/:id/trace` (FX.1), which already
 * labels every step in plain language server-side — so, like the stream, this
 * file decides how things LOOK and never what they MEAN.
 *
 * Three decisions worth stating, because each rejects something the industry
 * does and the reason is in the data:
 *
 * 1. **A list, not a waterfall.** Langfuse, Phoenix and Datadog all draw a
 *    nested span tree. We have 126 steps across 53 runs — median 3, max 5 —
 *    and `spanId`/`parentSpanId` are written by NO code, so there is no
 *    parent/child structure to draw. A tree over three lines is the maze the
 *    page exists to avoid.
 *
 * 2. **No controls.** No retry, no re-run, no approve, no cancel. A record is
 *    read; every one of those lives on the page that owns it. Retry is also
 *    the wrong instinct here specifically: 21 of the 25 severe failures this
 *    fleet has ever had were "could not reach the provider", which a retry
 *    cannot fix — it only spends the attempt again.
 *
 * 3. **It lives in `_shared/`** so the worker page can render the same drawer
 *    rather than growing a second one. Copying it would create exactly the
 *    disagreement `run-health.ts` exists to prevent.
 *
 * Built defensively on purpose: an INCOMPLETE trace response has twice taken
 * the worker page down through its error boundary, so every array here is
 * guarded rather than assumed.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Check, Copy, X } from 'lucide-react'

/* ── the shape the trace endpoint returns (fleet-trace.service.ts) ─────── */

export interface TraceStep {
  seq: number
  type: string
  name: string
  label: string
  ok: boolean
  latencyMs: number | null
  costUSD: number
  inputTokens: number
  outputTokens: number
  errorMessage: string | null
  output: unknown
}

export interface RunTrace {
  shape: 'agent-step' | 'legacy-json'
  run: {
    id: string
    agentKey: string
    mode: string | null
    trigger: string
    status: string
    ok: boolean
    costUSD: number
    latencyMs: number | null
    haltedReason: string | null
    errorMessage: string | null
    createdAt: string
    model: string | null
    findingCount: number
  }
  steps?: TraceStep[]
  evidence?: Array<{
    id: string
    key: string
    dataVintage: string | null
    preview: string
    truncated: boolean
  }>
  output?: unknown
  findings?: Array<{
    id: string
    kind: string
    entityType: string
    entityId: string
    severity: string
    confidence: unknown
    rationale: string
  }>
}

/* ── formatting ────────────────────────────────────────────────────────── */

function fmtMs(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}

/** Cents, and blank when it is genuinely nothing — never a row of `$0.0000`. */
function fmtCost(usd: number): string {
  return usd > 0 ? `$${usd.toFixed(4)}` : '—'
}

/** Why the run happened, as a sentence. Mirrors the spine's vocabulary. */
function whyItRan(run: RunTrace['run']): string {
  const by = run.trigger === 'schedule' ? 'a schedule started it' : 'a person started it by hand'
  const mode =
    run.mode === 'sweep' ? 'as part of the nightly sweep'
      : run.mode === 'council' ? 'as part of the weekly council'
      : run.mode === 'preview' ? 'as a test run — nothing it decided was written'
      : run.mode === 'ask' ? 'because someone asked it a question'
      : run.mode === 'custom' ? 'as part of a custom routine'
      : run.mode ? `in ${run.mode} mode` : ''
  return mode ? `${by}, ${mode}.` : `${by}.`
}

/* ── the drawer ────────────────────────────────────────────────────────── */

export function RunDetail({
  runId,
  backend,
  onClose,
}: {
  runId: string
  /** Base URL — passed in rather than resolved here, so a caller under a
   *  different origin (a stub, a test) works without patching this file. */
  backend: string
  onClose: () => void
}) {
  const [trace, setTrace] = useState<RunTrace | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [openEvidence, setOpenEvidence] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    setTrace(null)
    setErr(null)
    fetch(`${backend}/api/agent/fleet/runs/${runId}/trace`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'That run is no longer on record.' : `trace: ${r.status}`)
        return (await r.json()) as RunTrace
      })
      .then((t) => live && setTrace(t))
      .catch((e: unknown) => live && setErr(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [backend, runId])

  /* Escape closes. A drawer you cannot dismiss from the keyboard is a trap. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const copyDetails = useCallback(() => {
    if (!trace) return
    const lines = [
      `run id: ${trace.run.id}`,
      `worker: ${trace.run.agentKey}`,
      `mode: ${trace.run.mode ?? '—'} · trigger: ${trace.run.trigger}`,
      `model: ${trace.run.model ?? '—'}`,
      `started: ${trace.run.createdAt}`,
      `status: ${trace.run.status} · ok: ${trace.run.ok}`,
      `cost: $${trace.run.costUSD}`,
      trace.run.errorMessage ? `error: ${trace.run.errorMessage}` : '',
      trace.run.haltedReason ? `halted: ${trace.run.haltedReason}` : '',
    ].filter(Boolean)
    void navigator.clipboard?.writeText(lines.join('\n'))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }, [trace])

  const steps = trace?.steps ?? []
  const evidence = trace?.evidence ?? []
  const findings = trace?.findings ?? []
  const tokensIn = steps.reduce((n, s) => n + (s.inputTokens || 0), 0)
  const tokensOut = steps.reduce((n, s) => n + (s.outputTokens || 0), 0)
  // Naming the expensive step in words is the whole point of per-step cost.
  const dearest = steps.reduce<TraceStep | null>(
    (best, s) => (best === null || s.costUSD > best.costUSD ? s : best),
    null,
  )

  return (
    <div
      className="sba-drawerwrap"
      role="dialog"
      aria-modal="true"
      aria-label="What this run did"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="sba-drawer">
        <header className="sba-drawerhead">
          <h3>What it did</h3>
          <button className="acr-btn" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </header>

        <div className="sba-drawerbody">
          {err ? (
            <div className="acr-banner err">
              <AlertTriangle size={14} aria-hidden />
              <span>{err}</span>
            </div>
          ) : !trace ? (
            <p className="acr-pg-muted">Reading the run…</p>
          ) : trace.shape === 'legacy-json' ? (
            <>
              <p className="acr-pg-intro">
                This run predates the step-by-step record, so there is no story to tell — only
                what it saved at the time. It is shown verbatim below.
              </p>
              <pre className="sba-raw">{JSON.stringify(trace.output ?? {}, null, 2)}</pre>
            </>
          ) : (
            <>
              {/* 1 — why it ran */}
              <section className="sba-dsec">
                <h4>Why it ran</h4>
                <p>{whyItRan(trace.run)}</p>
                <p className="sba-dmeta">
                  {new Date(trace.run.createdAt).toLocaleString()}
                  {trace.run.model ? ` · thought with ${trace.run.model}` : ''}
                </p>
                {trace.run.haltedReason ? (
                  <p className="sba-dwarn">
                    It stopped part-way at one of its own limits: {trace.run.haltedReason}. That
                    limit worked — raise it, or accept the shorter answer.
                  </p>
                ) : null}
                {trace.run.errorMessage ? (
                  <p className="sba-dbad">{trace.run.errorMessage}</p>
                ) : null}
              </section>

              {/* 2 — what it did, step by step */}
              <section className="sba-dsec">
                <h4>Step by step</h4>
                {steps.length === 0 ? (
                  <p className="acr-pg-muted">
                    It recorded no steps. Runs that failed before they began often look like
                    this.
                  </p>
                ) : (
                  <ol className="sba-steps">
                    {steps.map((s) => (
                      <li key={s.seq} className={`sba-step${s.ok ? '' : ' bad'}`}>
                        <span className="sba-steplabel">{s.label}</span>
                        <span className="sba-stepmeta">
                          {fmtMs(s.latencyMs)}
                          {s.costUSD > 0 ? ` · ${fmtCost(s.costUSD)}` : ''}
                          {s.inputTokens || s.outputTokens
                            ? ` · ${(s.inputTokens + s.outputTokens).toLocaleString()} tokens`
                            : ''}
                          {dearest && s.seq === dearest.seq && dearest.costUSD > 0
                            ? ' · this is where the money went'
                            : ''}
                        </span>
                        {s.errorMessage ? <p className="sba-dbad">{s.errorMessage}</p> : null}
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {/* 3 — what it read */}
              {evidence.length > 0 ? (
                <section className="sba-dsec">
                  <h4>What it read</h4>
                  <p className="sba-dmeta">
                    Workers never compute their own numbers — code prepares this evidence before
                    the model is called.
                  </p>
                  {evidence.map((ev) => (
                    <div key={ev.id} className="sba-ev">
                      <button
                        type="button"
                        className="sba-evhead"
                        aria-expanded={openEvidence === ev.id}
                        onClick={() => setOpenEvidence(openEvidence === ev.id ? null : ev.id)}
                      >
                        {ev.key.replace(/[_-]+/g, ' ')}
                        {ev.dataVintage ? (
                          <span className="sba-dmeta">
                            {' '}
                            · gathered {new Date(ev.dataVintage).toLocaleString()}
                          </span>
                        ) : null}
                      </button>
                      {openEvidence === ev.id ? (
                        <>
                          <pre className="sba-raw">{ev.preview}</pre>
                          {ev.truncated ? (
                            <p className="sba-dmeta">
                              Shown to the first 4,000 characters. The worker read all of it.
                            </p>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ))}
                </section>
              ) : null}

              {/* 4 — what it found.
                  The second branch is not a nicety. Findings are UPSERTED on
                  (charterKey, entityType, entityId, dedupeKey), so a row stays
                  attached to the run that FIRST saw the thing. Measured on
                  production: 15 of the 25 runs reporting `findingCount > 0`
                  own zero finding rows. Hiding the section there would leave a
                  row saying "ran and found 11 things" above a drawer that
                  never mentions them — the page contradicting itself. */}
              {findings.length > 0 ? (
                <section className="sba-dsec">
                  <h4>What it found</h4>
                  {findings.map((f) => (
                    <div key={f.id} className="sba-finding">
                      <span className="sba-findinghead">
                        {f.kind.replace(/[_-]+/g, ' ')}
                        <span className={`sba-sev s-${f.severity}`}>{f.severity}</span>
                      </span>
                      <p>{f.rationale}</p>
                    </div>
                  ))}
                </section>
              ) : trace.run.findingCount > 0 ? (
                <section className="sba-dsec">
                  <h4>What it found</h4>
                  <p>
                    It reported {trace.run.findingCount}{' '}
                    {trace.run.findingCount === 1 ? 'thing' : 'things'}, and each had been seen
                    before.
                  </p>
                  <p className="sba-dmeta">
                    A finding is written down once and kept up to date, so it stays listed under
                    the run that first spotted it. This run confirmed them rather than
                    discovering them.
                  </p>
                </section>
              ) : null}

              {/* 5 — what it cost */}
              <section className="sba-dsec">
                <h4>What it cost</h4>
                <ul className="sba-costlist">
                  <li>
                    <span>Money</span>
                    <span>{fmtCost(trace.run.costUSD)}</span>
                  </li>
                  <li>
                    <span>Time</span>
                    <span>{fmtMs(trace.run.latencyMs)}</span>
                  </li>
                  <li>
                    <span>Words in / out</span>
                    <span>
                      {tokensIn.toLocaleString()} / {tokensOut.toLocaleString()}
                    </span>
                  </li>
                </ul>
              </section>

              {/* 6 — the identifiers, for when something needs reporting */}
              <section className="sba-dsec">
                <button type="button" className="sba-copy" onClick={copyDetails}>
                  {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                  {copied ? 'Copied' : 'Copy details for support'}
                </button>
                <p className="sba-dmeta">
                  <Link href={`/fleet/workers/${trace.run.agentKey}`}>
                    Open this worker&apos;s page →
                  </Link>
                </p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
