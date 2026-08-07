'use client'

/**
 * NAF.WF.3b — the editor: composition only, structured panels beside a live
 * canvas (operator decision D1 — no free-drag wiring). Each step is a card;
 * its "hands … to" picker IS the edge editor; gates are three plain choices.
 * Drafts are inert, so edits apply with no ceremony — Publish is the one
 * consequential act and carries all of it: the categorized diff, the plain
 * consequences, and the recorded-not-live caveat until stored execution
 * ships (WF.4). The server re-validates everything on save; the checklist
 * here is a courtesy mirror, never the authority.
 *
 * The trigger is deliberately absent: the fleet honors the env cron until
 * WF.4, and an editable schedule the fleet ignores would be a lie.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Plus, X } from 'lucide-react'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { RoutineCanvas } from './RoutineCanvas'
import type { StepLive } from './RoutineCanvas'
import {
  computeDiff,
  definitionToStory,
  diffIsEmpty,
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
  const [dialog, setDialog] = useState<'none' | 'save' | 'publish'>('none')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [serverErr, setServerErr] = useState<string | null>(null)

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
        Nothing changes until you publish — and until stored execution ships, even a published
        revision is recorded, not live: runs keep following the built-in definition.
      </div>

      {restored ? (
        <p className="wf-vnote">
          Restored an unsaved draft from this browser. Discard returns to the active wiring.
        </p>
      ) : null}

      <div className="wf-editgrid">
        <div className="wf-steps">
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
              <Plus size={13} />
              <select
                aria-label="Add a worker to this routine"
                value=""
                onChange={(e) => { if (e.target.value) addStep(e.target.value) }}
              >
                <option value="">Add a worker…</option>
                {addable.map((c) => (
                  <option key={c.key} value={c.key}>{c.name ?? c.key} · {c.tier}</option>
                ))}
              </select>
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

      {dialog !== 'none' ? (
        <div className="acr-pg-confirmwrap" role="dialog" aria-modal="true">
          <div className="acr-pg-confirm">
            <h4>{dialog === 'publish' ? 'Publish this wiring?' : 'Save as a draft revision?'}</h4>
            <DiffList diff={diff} />
            {dialog === 'publish' ? (
              <p>
                Publishing records this as the active revision. Until stored execution ships,
                runs keep following the built-in — this changes the record, not tonight&rsquo;s
                behaviour. Revert-to-built-in stays one click and cannot fail.
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
