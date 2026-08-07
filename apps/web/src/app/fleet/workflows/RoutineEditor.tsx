'use client'

/**
 * NAF.WF.3b — the editor: composition only, structured panels beside a live
 * canvas (operator decision D1 — no free-drag wiring). Each step is a card;
 * its "hands … to" picker IS the edge editor; gates are three plain choices.
 * Drafts are inert, so edits apply with no ceremony — Publish is the one
 * consequential act and carries all of it: the categorized diff and the
 * plain consequences. Since WF.4 shipped stored execution, publishing is
 * LIVE: the active revision is the wiring that runs. The server
 * re-validates everything on save; the checklist here is a courtesy
 * mirror, never the authority.
 *
 * The trigger unlocked with WF.4c: the clock re-arms from the stored
 * definition the moment a revision activates or reverts, so what this panel
 * publishes is what actually fires — no restart, no drift.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FlaskConical, Plus, X } from 'lucide-react'
import { Menu } from '@/design-system/components/Menu'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { classifyFailure } from '../_shared/run-health'
import { RoutineCanvas } from './RoutineCanvas'
import type { StepLive } from './RoutineCanvas'
import {
  computeDiff,
  definitionToStory,
  diffIsEmpty,
  prettyCron,
  tierArtifact,
  topoCols,
  type CharterRow,
  type WfDefinition,
  type WfDiff,
} from './lib'

const GATE_COPY: Record<'inherit' | 'ask' | 'act', { label: string; hint: string }> = {
  inherit: { label: 'Inherit', hint: 'Today’s behaviour — the tool’s policy and the fleet floors decide.' },
  ask: { label: 'Ask first', hint: 'Every proposal from this step waits for you in Approvals.' },
  act: { label: 'May act', hint: 'The tool’s own policy decides; always-ask tools still ask — that floor cannot be loosened.' },
}

export function DiffList({ diff }: { diff: WfDiff }) {
  if (diffIsEmpty(diff)) return <p className="wf-vnote">No changes — the draft matches what is active.</p>
  return (
    <ul className="wf-difflist">
      {diff.stepsAdded.map((k) => <li key={`sa-${k}`} className="add">+ step: {k}</li>)}
      {diff.stepsRemoved.map((k) => <li key={`sr-${k}`} className="rem">− step: {k}</li>)}
      {diff.gatesChanged.map((g) => (
        <li key={`g-${g.charterKey}`} className="chg">gate: {g.charterKey} — {g.from} → {g.to}</li>
      ))}
      {diff.edgesAdded.map((e) => <li key={`ea-${e}`} className="add">+ connection: {e}</li>)}
      {diff.edgesRemoved.map((e) => <li key={`er-${e}`} className="rem">− connection: {e}</li>)}
      {diff.triggerChanged ? <li className="chg">trigger changed</li> : null}
    </ul>
  )
}

function draftKey(routineKey: string): string {
  return `naf-wf-draft-${routineKey}`
}

interface TestStepRow {
  charterKey: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'stopped'
  findingCount: number
  costUSD: number
  errorMessage: string | null
  haltedReason: string | null
}
interface TestStatus {
  testId: string
  walking: boolean
  steps: TestStepRow[]
  totals: { costUSD: number; findings: number }
}

/** The taxonomy sentence for a failed/stopped test step — run-health's
 *  voice, never re-derived. */
function testStepSentence(s: TestStepRow): string | null {
  if (s.status !== 'failed' && s.status !== 'stopped') return null
  const f = classifyFailure({
    status: 'done',
    ok: false,
    errorMessage: s.errorMessage,
    haltedReason: s.haltedReason,
    createdAt: '',
  })
  return f?.sentence ?? null
}

export function RoutineEditor({
  routineKey,
  charters,
  baseline,
  backend,
  onDone,
}: {
  routineKey: string
  charters: CharterRow[]
  /** What is active right now (effective definition) — the edit starting point
   *  and the thing every diff is computed against. */
  baseline: WfDefinition
  backend: string
  onDone: (changed: boolean) => void
}) {
  const [draft, setDraft] = useState<WfDefinition>(baseline)
  const [restored, setRestored] = useState(false)
  const [dialog, setDialog] = useState<'none' | 'save' | 'publish' | 'test'>('none')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [serverErr, setServerErr] = useState<string | null>(null)
  const [testEstimate, setTestEstimate] = useState<number | null>(null)
  const [test, setTest] = useState<{ id: string } | null>(null)
  const [testStatus, setTestStatus] = useState<TestStatus | null>(null)

  // A lost tab loses nothing: the draft mirrors to localStorage.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(draftKey(routineKey))
      if (stored) {
        const parsed = JSON.parse(stored) as WfDefinition
        if (!diffIsEmpty(computeDiff(baseline, parsed))) {
          setDraft(parsed)
          setRestored(true)
        }
      }
    } catch {
      /* a corrupt stored draft is silently ignored — baseline stands */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routineKey])
  useEffect(() => {
    try {
      localStorage.setItem(draftKey(routineKey), JSON.stringify(draft))
    } catch {
      /* storage full — editing still works, only the mirror is lost */
    }
  }, [draft, routineKey])

  const byKey = useMemo(() => new Map(charters.map((c) => [c.key, c])), [charters])
  const present = useMemo(() => new Set(draft.steps.map((s) => s.charterKey)), [draft])
  const addable = useMemo(
    () => charters.filter((c) => !present.has(c.key)),
    [charters, present],
  )
  const diff = useMemo(() => computeDiff(baseline, draft), [baseline, draft])

  const problems = useMemo(() => {
    const out: string[] = []
    if (draft.trigger.type === 'schedule' && draft.steps.length === 0) {
      out.push('A scheduled workflow needs at least one step — a clock that starts nothing teaches nothing.')
    }
    if (topoCols(draft.steps, draft.edges).cyclic) {
      out.push('The connections form a loop. Work must flow one way — remove one of the circular hand-offs.')
    }
    return out
  }, [draft])

  const liveByCharter = useMemo(() => {
    const m = new Map<string, StepLive>()
    for (const c of charters) {
      m.set(c.key, { autonomyLevel: c.autonomyLevel, degraded: c.degraded, running: false })
    }
    return m
  }, [charters])

  const setGate = (charterKey: string, gate: 'ask' | 'act' | 'inherit') =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s) => (s.charterKey === charterKey ? { ...s, gate } : s)),
    }))

  const toggleEdge = (from: string, to: string, artifact: 'finding' | 'plan' | 'strategy') =>
    setDraft((d) => {
      const exists = d.edges.some((e) => e.from === from && e.to === to)
      return {
        ...d,
        edges: exists
          ? d.edges.filter((e) => !(e.from === from && e.to === to))
          : [...d.edges, { from, to, artifact }],
      }
    })

  const addStep = (charterKey: string) =>
    setDraft((d) => ({ ...d, steps: [...d.steps, { charterKey, gate: 'inherit' }] }))

  const removeStep = (charterKey: string) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.filter((s) => s.charterKey !== charterKey),
      edges: d.edges.filter((e) => e.from !== charterKey && e.to !== charterKey),
    }))

  const discard = () => {
    try {
      localStorage.removeItem(draftKey(routineKey))
    } catch { /* nothing to lose */ }
    onDone(false)
  }

  /* WF.5 — poll a live test every 3s until every step is terminal. */
  useEffect(() => {
    if (!test) return
    let stop = false
    const tick = async () => {
      try {
        const r = await fetch(
          `${backend}/api/agent/fleet/workflows/${routineKey}/test/${test.id}`,
          { cache: 'no-store' },
        )
        if (!r.ok) return
        const s = (await r.json()) as TestStatus
        if (!stop) setTestStatus(s)
        if (!s.walking && s.steps.every((x) => x.status !== 'pending' && x.status !== 'running')) {
          stop = true
        }
      } catch { /* next tick retries */ }
    }
    void tick()
    const id = setInterval(() => { if (!stop) void tick() }, 3000)
    return () => { stop = true; clearInterval(id) }
  }, [test, backend, routineKey])

  const openTestDialog = async () => {
    setServerErr(null)
    setTestEstimate(null)
    setDialog('test')
    try {
      const keys = draft.steps.map((s) => s.charterKey).join(',')
      const r = await fetch(
        `${backend}/api/agent/fleet/workflows/${routineKey}/test-estimate?steps=${encodeURIComponent(keys)}`,
        { cache: 'no-store' },
      )
      if (r.ok) setTestEstimate(((await r.json()) as { estimatedCostUSD: number }).estimatedCostUSD)
    } catch { /* the dialog says "estimating…" honestly */ }
  }

  const startTest = async () => {
    setBusy(true)
    setServerErr(null)
    try {
      const r = await fetch(`${backend}/api/agent/fleet/workflows/${routineKey}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: draft }),
      })
      const body = (await r.json()) as { testId?: string; error?: string }
      if (!r.ok || !body.testId) throw new Error(body.error ?? `test failed to start (${r.status})`)
      setTestStatus(null)
      setTest({ id: body.testId })
      setDialog('none')
    } catch (e) {
      setServerErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = useCallback(
    async (activate: boolean) => {
      setBusy(true)
      setServerErr(null)
      try {
        const create = await fetch(`${backend}/api/agent/fleet/workflows/${routineKey}/revisions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ definition: draft, note: note.trim() }),
        })
        const created = (await create.json()) as { revision?: { id: string }; error?: string }
        if (!create.ok || !created.revision) {
          throw new Error(created.error ?? `save failed (${create.status})`)
        }
        if (activate) {
          const act = await fetch(
            `${backend}/api/agent/fleet/workflows/${routineKey}/revisions/${created.revision.id}/activate`,
            { method: 'POST' },
          )
          if (!act.ok) {
            const body = (await act.json().catch(() => ({}))) as { error?: string }
            throw new Error(body.error ?? `the draft saved, but activation failed (${act.status})`)
          }
        }
        try {
          localStorage.removeItem(draftKey(routineKey))
        } catch { /* mirror only */ }
        onDone(true)
      } catch (e) {
        setServerErr(e instanceof Error ? e.message : String(e))
        setBusy(false)
      }
    },
    [backend, routineKey, draft, note, onDone],
  )

  return (
    <section className="acr-card">
      <header className="wf-cardhead">
        <h3>Editing — a draft</h3>
        <div className="wf-editactions">
          <button className="acr-btn" onClick={discard} disabled={busy}>Discard</button>
          <button
            className="acr-btn"
            disabled={busy || problems.length > 0 || draft.steps.length === 0 || testStatus?.walking === true}
            onClick={() => void openTestDialog()}
            title="Run every step of this draft in preview: real evidence, real model, nothing written"
          >
            <FlaskConical size={13} /> Test this draft…
          </button>
          <button
            className="acr-btn"
            disabled={busy || problems.length > 0 || diffIsEmpty(diff)}
            onClick={() => { setNote(''); setServerErr(null); setDialog('save') }}
          >
            Save as draft
          </button>
          <button
            className="acr-btn primary"
            disabled={busy || problems.length > 0 || diffIsEmpty(diff)}
            onClick={() => { setNote(''); setServerErr(null); setDialog('publish') }}
          >
            Publish…
          </button>
        </div>
      </header>

      <div className="acr-banner warn" role="status">
        <AlertTriangle size={15} />
        Nothing changes until you publish. The moment you do, this wiring is live: the
        clock re-arms if the trigger changed, and every run stamps the revision that ran it.
      </div>

      {restored ? (
        <p className="wf-vnote">
          Restored an unsaved draft from this browser. Discard returns to the active wiring.
        </p>
      ) : null}

      <div className="wf-editgrid">
        <div className="wf-steps">
          <div className="wf-stepcard">
            <div className="wf-stephead">
              <span>
                <span className="nm"><Term k="trigger">Trigger</Term></span>
                <span className="acr-pg-muted"> · when this routine runs</span>
              </span>
            </div>
            <div className="wf-gate">
              <div className="acr-pg-ladder">
                <button
                  type="button"
                  className={`acr-pg-rung ${draft.trigger.type === 'schedule' ? 'on' : ''}`}
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      trigger: {
                        type: 'schedule',
                        cron:
                          baseline.trigger.type === 'schedule'
                            ? baseline.trigger.cron
                            : '45 4 * * *',
                      },
                    }))
                  }
                >
                  On a clock
                </button>
                <button
                  type="button"
                  className={`acr-pg-rung ${draft.trigger.type === 'manual' ? 'on' : ''}`}
                  onClick={() => setDraft((d) => ({ ...d, trigger: { type: 'manual' } }))}
                >
                  Manual
                </button>
              </div>
            </div>
            {draft.trigger.type === 'schedule' ? (
              <>
                <label className="wf-gatelabel" htmlFor="wf-cron-input">Schedule (cron, UTC)</label>
                <input
                  id="wf-cron-input"
                  className="wf-croninput"
                  value={draft.trigger.cron}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      trigger: { type: 'schedule', cron: e.target.value },
                    }))
                  }
                />
                <span className="wf-sub">
                  {prettyCron(draft.trigger.cron)} · the clock re-arms the moment you publish
                </span>
              </>
            ) : (
              <span className="wf-sub">
                Runs only when started by hand — publishing this disarms the clock.
              </span>
            )}
          </div>

          {draft.steps.map((s) => {
            const c = byKey.get(s.charterKey)
            const artifact = tierArtifact(c?.tier)
            const targets = draft.steps.filter((t) => t.charterKey !== s.charterKey)
            return (
              <div className="wf-stepcard" key={s.charterKey}>
                <div className="wf-stephead">
                  <span>
                    <span className="nm">{c?.name ?? s.charterKey}</span>
                    <span className="acr-pg-muted"> · {c?.tier ?? 'worker'}</span>
                  </span>
                  <button
                    type="button"
                    className="wf-stepremove"
                    aria-label={`Remove ${c?.name ?? s.charterKey} from this routine`}
                    onClick={() => removeStep(s.charterKey)}
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className="wf-gate">
                  <span className="wf-gatelabel"><Term k="gate">Gate</Term></span>
                  <div className="acr-pg-ladder">
                    {(['inherit', 'ask', 'act'] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        className={`acr-pg-rung ${s.gate === g ? 'on' : ''}`}
                        title={GATE_COPY[g].hint}
                        onClick={() => setGate(s.charterKey, g)}
                      >
                        {GATE_COPY[g].label}
                      </button>
                    ))}
                  </div>
                  <span className="wf-sub">{GATE_COPY[s.gate].hint}</span>
                </div>
                {artifact && targets.length > 0 ? (
                  <div className="wf-handsto">
                    <span className="wf-gatelabel">Hands {artifact === 'finding' ? 'findings' : artifact} to</span>
                    {targets.map((t) => {
                      const tc = byKey.get(t.charterKey)
                      const on = draft.edges.some((e) => e.from === s.charterKey && e.to === t.charterKey)
                      return (
                        <label key={t.charterKey} className="wf-handopt">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggleEdge(s.charterKey, t.charterKey, artifact)}
                          />
                          {tc?.name ?? t.charterKey}
                        </label>
                      )
                    })}
                  </div>
                ) : artifact ? null : (
                  <span className="wf-sub">Terminal — its output is read by code, not handed on.</span>
                )}
              </div>
            )
          })}

          {addable.length > 0 ? (
            <div className="wf-addstep">
              <Menu
                label={<><Plus size={13} /> Add a worker…</>}
                items={addable.map((c) => ({
                  id: c.key,
                  label: `${c.name ?? c.key} · ${c.tier}`,
                  onSelect: () => addStep(c.key),
                }))}
              />
            </div>
          ) : null}

          {problems.length > 0 ? (
            <div className="wf-problems" role="alert">
              {problems.map((p) => <p key={p}>{p}</p>)}
            </div>
          ) : null}
        </div>

        <div>
          <RoutineCanvas story={definitionToStory(draft, charters)} liveByCharter={liveByCharter} />
          <p className="wf-vnote">
            The wiring as drafted. Code steps — grading, report cards — and{' '}
            <Term k="approval">your approval</Term> still wrap every routine; they are not
            editable wiring.
          </p>
        </div>
      </div>

      {test && testStatus ? (
        <div className="wf-testpanel">
          <header className="wf-cardhead">
            <h3><FlaskConical size={15} /> Test run</h3>
            <span className="wf-legend">
              {testStatus.walking ? 'testing…' : 'finished'} · $
              {testStatus.totals.costUSD.toFixed(4)} spent ·{' '}
              {testStatus.totals.findings} would-be finding
              {testStatus.totals.findings === 1 ? '' : 's'}
            </span>
          </header>
          {testStatus.steps.map((s) => {
            const sentence = testStepSentence(s)
            return (
              <div className="wf-testrow" key={s.charterKey}>
                <span className="nm">{byKey.get(s.charterKey)?.name ?? s.charterKey}</span>
                {s.status === 'pending' ? (
                  <span className="acr-pg-muted">waiting its turn…</span>
                ) : s.status === 'running' ? (
                  <span className="wf-run">working now…</span>
                ) : s.status === 'done' ? (
                  <span className="acr-pg-ok">
                    would have reported {s.findingCount} finding{s.findingCount === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span className={s.status === 'stopped' ? 'wf-halt' : 'acr-pg-warn'}>
                    {sentence ?? (s.status === 'stopped' ? 'stopped at a limit' : 'failed')}
                  </span>
                )}
                {s.costUSD > 0 ? <span className="wf-sub">${s.costUSD.toFixed(4)}</span> : null}
              </div>
            )
          })}
          <p className="wf-vnote">
            Nothing above was written to the board, and no proposal was queued — the model spend
            is the only real thing a test does.
          </p>
        </div>
      ) : null}

      {dialog === 'test' ? (
        <div className="acr-pg-confirmwrap" role="dialog" aria-modal="true">
          <div className="acr-pg-confirm">
            <h4>Test this draft?</h4>
            <p>
              Every step runs in preview against today&rsquo;s board: real evidence, real model,{' '}
              <strong>nothing written</strong>. Hand-offs are not simulated yet — each worker is
              tested on its own. Estimated cost:{' '}
              <strong>
                {testEstimate != null ? `$${testEstimate.toFixed(4)}` : 'estimating…'}
              </strong>{' '}
              — model spend is real.
            </p>
            {serverErr ? <p className="acr-pg-warn">{serverErr}</p> : null}
            <div className="acr-pg-confirmbtns">
              <button className="acr-btn" onClick={() => setDialog('none')} disabled={busy}>
                Cancel
              </button>
              <button className="acr-btn primary" disabled={busy} onClick={() => void startTest()}>
                {busy ? 'Starting…' : 'Run the test'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog === 'save' || dialog === 'publish' ? (
        <div className="acr-pg-confirmwrap" role="dialog" aria-modal="true">
          <div className="acr-pg-confirm">
            <h4>{dialog === 'publish' ? 'Publish this wiring?' : 'Save as a draft revision?'}</h4>
            <DiffList diff={diff} />
            {dialog === 'publish' ? (
              <p>
                Publishing makes this the active revision — the wiring that actually runs,
                starting now. A trigger change re-arms the clock the moment you publish.
                Every revision stays in Versions, so going back is always one click.
              </p>
            ) : (
              <p>A draft is recorded and inert. You can activate it later from Versions.</p>
            )}
            <textarea
              className="wf-noteinput"
              placeholder="Why this change? (required — the change log IS the audit)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
            />
            {serverErr ? <p className="acr-pg-warn">{serverErr}</p> : null}
            <div className="acr-pg-confirmbtns">
              <button className="acr-btn" onClick={() => setDialog('none')} disabled={busy}>Cancel</button>
              <button
                className="acr-btn primary"
                disabled={busy || !note.trim()}
                onClick={() => void submit(dialog === 'publish')}
              >
                {busy ? 'Working…' : dialog === 'publish' ? 'Publish' : 'Save draft'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
