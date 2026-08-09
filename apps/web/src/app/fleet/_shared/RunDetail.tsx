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
import { AlertTriangle, Check, Copy } from 'lucide-react'
import { Drawer } from '@/design-system/components'

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

/** How much of an error a reader can take before it stops being a message and
 *  becomes a wall. Measured on production: one step's schema-validation error
 *  is 1,366 characters, rendered 322px tall — 31% of the drawer's scroll
 *  height, for one line of the six sections. */
const ERROR_PREVIEW = 240

/**
 * A verbatim error, verbatim — but not first.
 *
 * Part 3 asks for "the verbatim error on a failed step", and it is right: a
 * truncated error is useless to whoever has to fix it. It does not follow that
 * the whole of it should be the first thing in the drawer. The cause is almost
 * always in the opening clause (`narrative: Too big` here); the remaining 1,100
 * characters are an enumeration of every enum value the validator knows.
 *
 * So: the opening, then the length, then the choice. Copy takes the WHOLE
 * message whatever is on screen, because the support case this protects is
 * served by pasting rather than by scrolling.
 */
function VerbatimError({ text, tone }: { text: string; tone: 'bad' | 'warn' }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const long = text.length > ERROR_PREVIEW
  const shown = open || !long ? text : `${text.slice(0, ERROR_PREVIEW).trimEnd()}…`
  return (
    <div className={tone === 'bad' ? 'sba-dbad' : 'sba-dwarn'}>
      <p className="sba-derrtext">{shown}</p>
      {long ? (
        <p className="sba-derractions">
          <button type="button" className="sba-inlinebtn" onClick={() => setOpen(!open)}>
            {open ? 'Show less' : `Show the whole message (${text.length.toLocaleString()} characters)`}
          </button>
          <button
            type="button"
            className="sba-inlinebtn"
            onClick={() => {
              void navigator.clipboard?.writeText(text)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 2000)
            }}
          >
            {copied ? 'Copied' : 'Copy it'}
          </button>
        </p>
      ) : null}
    </div>
  )
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
        const body = (await r.json()) as Partial<RunTrace> | null
        // S5R — guard the SHAPE, not only the arrays. This file's header has
        // always said "an INCOMPLETE trace response has twice taken the worker
        // page down through its error boundary, so every array here is guarded"
        // — and then read `trace.run.trigger` without checking `run` existed.
        // A 200 carrying the wrong object crashed the whole page through the
        // error boundary, which is the same failure the arrays were guarded
        // against, arriving through the one door nobody checked.
        if (!body || typeof body !== 'object' || !body.run) {
          throw new Error('That run came back in a shape this page cannot read.')
        }
        return body as RunTrace
      })
      .then((t) => live && setTrace(t))
      .catch((e: unknown) => live && setErr(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [backend, runId])

  /* Escape, the focus trap, the portal and the focus return belong to the DS
     `Drawer` since S5R. The hand-rolled shell met exactly ONE of the five
     WAI-ARIA APG requirements for the `role="dialog" aria-modal="true"` it
     declared — Escape — and measured 51 Tab presses to reach from the top of
     the page, against the 41 that made the Assignments stream fix the shared
     component for all 22 of its consumers. */

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
    <Drawer open onClose={onClose} title="What it did" width={620} className="sba-drawer fleet-portal">
      <>
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
                  <VerbatimError text={trace.run.errorMessage} tone="bad" />
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
                        {s.errorMessage ? (
                          <VerbatimError text={s.errorMessage} tone="bad" />
                        ) : null}
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
      </>
    </Drawer>
  )
}
