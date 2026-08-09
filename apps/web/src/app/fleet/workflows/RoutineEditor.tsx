'use client'

/**
 * NAF.WF.3b — the editor: composition only, structured panels beside a live
 * picture (operator decision D1 — no free-drag wiring). Each step is a card;
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
 *
 * WF-S5R / S5.a — the picture is `RoutinePipeline`, the same component the
 * read view uses, in `composing` mode. It was the xyflow canvas until now,
 * because S2R replaced the READ view and deliberately left `RoutineCanvas`
 * alone for this file to keep importing. That left every number S2R had just
 * removed sitting here: 8.7% node ink on the two-step custom, 14.3% on the
 * six-step council, the latter at a `fitView` zoom of 0.7239 which put the
 * node sub at 7.96px. `RoutineCanvas.tsx` had no other importer and is gone.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FlaskConical, Lock, Plus, X } from 'lucide-react'
import { Menu } from '@/design-system/components/Menu'
import { Checkbox, Input, Textarea } from '@/design-system/primitives'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { classifyFailure } from '../_shared/run-health'
import { RoutinePipeline } from './RoutinePipeline'
import {
  computeDiff,
  cronIsEvaluable,
  definitionToStory,
  diffIsEmpty,
  incomingFor,
  nextCronFires,
  prettyCron,
  tierArtifact,
  topoCols,
  type CharterRow,
  type WfDefinition,
  type WfDiff,
} from './lib'

/**
 * S5.b — the presets. Every builder that gets cron input right ships them,
 * for the same reason: the operator's intent is nearly always one of a few
 * shapes, and typing five fields by hand to reach one is where wrong
 * expressions come from. Each is phrased by `prettyCron`, so this list can
 * never describe a schedule differently from the line under the field.
 */
const CRON_PRESETS = ['0 3 * * *', '0 7 * * 1-5', '0 5 * * 1', '0 * * * *']

const FIRE_FMT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false,
})

const GATE_COPY: Record<'inherit' | 'ask' | 'act', { label: string; hint: string }> = {
  inherit: { label: 'Inherit', hint: 'Today’s behaviour — the tool’s policy and the fleet floors decide.' },
  ask: { label: 'Ask first', hint: 'Every proposal from this step waits for you in Approvals.' },
  act: { label: 'May act', hint: 'The tool’s own policy decides; always-ask tools still ask — that floor cannot be loosened.' },
}

/**
 * S5.c — the ladder tightens, it never loosens, and until now the three rungs
 * rendered identically: the only trace of the limit was a `title` and a hint
 * line, so a control whose limits are invisible taught the operator it had
 * none. “May act” is the loosest rung this ladder reaches and it carries a
 * lock to say so.
 *
 * The lock is UNCONDITIONAL on purpose. The study proposed marking it only
 * where a worker’s tools carry an `alwaysAsk` floor — but `alwaysAsk` is a
 * per-TOOL flag on the server and `GET /agent/fleet/charters` (a sibling
 * stream’s route) does not expose it, so the client cannot know which workers
 * are floored. The sentence is true of every worker, so it is stated for every
 * worker rather than guessed per worker. Recorded in the WF doc as the field
 * to ask for.
 */
const GATE_FLOOR = 'The loosest this ladder reaches. Tools that always ask — pricing, publishing, spend, customer messages — still queue for your approval; no gate can loosen that floor.'

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
  /* S5.d — the stored draft is OFFERED, not applied. It used to load itself
     and announce that in one quiet line; Power Automate treats the same moment
     as a banner with an explicit Recover command, and it is right to: what is
     on screen when you arrive should be what you published, unless you say
     otherwise. */
  const [pendingRestore, setPendingRestore] = useState<WfDefinition | null>(null)
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
        if (!diffIsEmpty(computeDiff(baseline, parsed))) setPendingRestore(parsed)
      }
    } catch {
      /* a corrupt stored draft is silently ignored — baseline stands */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routineKey])
  useEffect(() => {
    /* While an offer is open the stored draft is the operator's to keep or
       drop, so it is not overwritten underneath them. */
    if (pendingRestore) return
    try {
      /* The mirror holds a draft only while there IS one. Prod caught the
         alternative: "Throw it away" removed the key, the effect then re-ran
         and wrote the baseline straight back, so the button left a stored
         copy behind. Harmless today — a stored baseline differs from the
         baseline by nothing, so it is never offered — but a stored draft that
         is not a draft is a trap for whoever changes that condition next. */
      if (diffIsEmpty(computeDiff(baseline, draft))) {
        localStorage.removeItem(draftKey(routineKey))
      } else {
        localStorage.setItem(draftKey(routineKey), JSON.stringify(draft))
      }
    } catch {
      /* storage full — editing still works, only the mirror is lost */
    }
  }, [draft, baseline, routineKey, pendingRestore])

  /* Every edit goes through here, so touching the wiring while an offer is
     open counts as answering it: you chose what is on screen. Without this the
     mirror would stay suspended and the new edits would be the ones lost —
     the opposite of what the mirror is for. */
  const edit = useCallback((fn: (d: WfDefinition) => WfDefinition) => {
    setPendingRestore(null)
    setDraft(fn)
  }, [])

  const byKey = useMemo(() => new Map(charters.map((c) => [c.key, c])), [charters])
  const present = useMemo(() => new Set(draft.steps.map((s) => s.charterKey)), [draft])
  const addable = useMemo(
    () => charters.filter((c) => !present.has(c.key)),
    [charters, present],
  )
  const diff = useMemo(() => computeDiff(baseline, draft), [baseline, draft])

  /* One peel, two answers: the checklist sentence below and the per-card
     marks. They cannot disagree about which steps are in the loop. */
  const topo = useMemo(() => topoCols(draft.steps, draft.edges), [draft])

  const problems = useMemo(() => {
    const out: string[] = []
    /* S5.b — the server refuses a schedule exactly when `nextCronFire`
       returns null (`validateDefinition`), and this is that same rule via the
       mirrored evaluator. Before this, three expressions the server refuses —
       `not a cron`, `99 99 * * *` and empty — listed ZERO problems here with
       Publish enabled, and the middle one previewed as "Nightly at 99:99
       UTC". The sentence is the server's own, in the checklist's voice. */
    if (draft.trigger.type === 'schedule' && !cronIsEvaluable(draft.trigger.cron)) {
      out.push(
        `The schedule "${draft.trigger.cron}" is not a cron expression this fleet can evaluate.`,
      )
    }
    if (draft.trigger.type === 'schedule' && draft.steps.length === 0) {
      out.push('A scheduled workflow needs at least one step — a clock that starts nothing teaches nothing.')
    }
    if (topo.cyclic) {
      out.push('The connections form a loop. Work must flow one way — remove one of the circular hand-offs.')
    }
    return out
  }, [draft, topo])

  /* S6.c groundwork, needed here because the panel now renders the list:
     the walk order comes from `topoLevels`, which sorts each level
     alphabetically, so the panel listed Keyword harvester before Negative
     miner while the cards listed them the other way. Two orders for two
     steps on one screen. The panel follows the CARDS; the walk order is a
     server concern the operator never asked about. */
  const orderedTestSteps = useMemo(() => {
    if (!testStatus) return []
    const byStep = new Map(testStatus.steps.map((s) => [s.charterKey, s]))
    const inCardOrder = draft.steps
      .map((s) => byStep.get(s.charterKey))
      .filter((s): s is TestStepRow => Boolean(s))
    // Anything the walk knows about that the draft no longer does still shows.
    const seen = new Set(inCardOrder.map((s) => s.charterKey))
    return [...inCardOrder, ...testStatus.steps.filter((s) => !seen.has(s.charterKey))]
  }, [testStatus, draft])

  const walkPosition = useMemo(() => {
    if (!testStatus?.walking) return null
    const done = testStatus.steps.filter((s) => s.status !== 'pending').length
    return { at: Math.max(1, done), of: testStatus.steps.length }
  }, [testStatus])

  const badCron = draft.trigger.type === 'schedule' && !cronIsEvaluable(draft.trigger.cron)

  const setGate = (charterKey: string, gate: 'ask' | 'act' | 'inherit') =>
    edit((d) => ({
      ...d,
      steps: d.steps.map((s) => (s.charterKey === charterKey ? { ...s, gate } : s)),
    }))

  const toggleEdge = (from: string, to: string, artifact: 'finding' | 'plan' | 'strategy') =>
    edit((d) => {
      const exists = d.edges.some((e) => e.from === from && e.to === to)
      return {
        ...d,
        edges: exists
          ? d.edges.filter((e) => !(e.from === from && e.to === to))
          : [...d.edges, { from, to, artifact }],
      }
    })

  const addStep = (charterKey: string) =>
    edit((d) => ({ ...d, steps: [...d.steps, { charterKey, gate: 'inherit' }] }))

  const removeStep = (charterKey: string) =>
    edit((d) => ({
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
            <FlaskConical size={13} />{' '}
            {walkPosition ? `Testing… step ${walkPosition.at} of ${walkPosition.of}` : 'Test this draft…'}
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

      {pendingRestore ? (
        <div className="wf-restore" role="status">
          <span>
            You left an unsaved draft of this routine in this browser. Nothing on screen has
            changed yet — what you see is the wiring that is live.
          </span>
          <span className="wf-restoreacts">
            <button
              className="acr-btn"
              onClick={() => { setDraft(pendingRestore); setPendingRestore(null) }}
            >
              Use that draft
            </button>
            <button
              className="acr-btn"
              onClick={() => {
                try { localStorage.removeItem(draftKey(routineKey)) } catch { /* mirror only */ }
                setPendingRestore(null)
              }}
            >
              Throw it away
            </button>
          </span>
        </div>
      ) : null}

      {/* S6.a — the panel sits where the button that started it is. It used
          to render after the editor grid, which measured 1020.6px on the
          two-step custom against a 962px viewport: confirm a spend, wait 43
          seconds, and nothing on screen changes. On the council's 1741.8px
          grid it was ~1150px below the fold. */}
      {test && testStatus ? (
        <section className="wf-testpanel" role="status" aria-live="polite">
          <header className="wf-cardhead">
            <h3><FlaskConical size={15} /> Test run</h3>
            <span className="wf-legend">
              {testStatus.walking ? 'testing…' : 'finished'} · $
              {testStatus.totals.costUSD.toFixed(4)} spent ·{' '}
              {testStatus.totals.findings} would-be finding
              {testStatus.totals.findings === 1 ? '' : 's'}
            </span>
          </header>
          {/* Cards in a fitted grid, the dialect S5.a settled for the picture:
              fit the tracks, cap the card. The old flex rows spent 432px of
              1572 — 72.5% dead — in a zone no section had ever audited. */}
          <div className="wf-teststeps">
            {orderedTestSteps.map((s) => {
              const sentence = testStepSentence(s)
              return (
                <div className={`wf-teststep is-${s.status}`} key={s.charterKey}>
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
                  <span className="wf-sub">
                    {s.costUSD > 0 ? `$${s.costUSD.toFixed(4)}` : s.status === 'running' ? 'spending…' : ''}
                  </span>
                </div>
              )
            })}
          </div>
          <p className="wf-vnote">
            Nothing above was written to the board, and no proposal was queued — the model spend
            is the only real thing a test does.
          </p>
        </section>
      ) : null}

      <div className="wf-editgrid">
        <div className="wf-steps">
          {/* S5.c — the card that CAUSED the error wears it. Power Automate's
              designer puts a failure both in a summary and on the card that
              produced it; this editor had only the summary, at the bottom of a
              1741.8px column, which is nowhere near the field you just typed
              in. The checklist stays — it is the summary. */}
          <div className={`wf-stepcard${badCron ? ' is-bad' : ''}`}>
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
                    edit((d) => ({
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
                  onClick={() => edit((d) => ({ ...d, trigger: { type: 'manual' } }))}
                >
                  Manual
                </button>
              </div>
            </div>
            {draft.trigger.type === 'schedule' ? (
              <>
                <label className="wf-gatelabel" htmlFor="wf-cron-input">Schedule (cron, UTC)</label>
                <div className="wf-cronrow">
                  <Input
                    id="wf-cron-input"
                    fieldClassName={`wf-cronfield${badCron ? ' is-bad' : ''}`}
                    className="wf-croninput"
                    value={draft.trigger.cron}
                    aria-invalid={badCron}
                    aria-describedby="wf-cron-means"
                    onChange={(e) =>
                      edit((d) => ({
                        ...d,
                        trigger: { type: 'schedule', cron: e.target.value },
                      }))
                    }
                  />
                  <Menu
                    label="Common schedules"
                    items={CRON_PRESETS.map((c) => ({
                      id: c,
                      label: prettyCron(c),
                      onSelect: () =>
                        edit((d) => ({ ...d, trigger: { type: 'schedule', cron: c } })),
                    }))}
                  />
                </div>
                <span
                  id="wf-cron-means"
                  className={`wf-sub${badCron ? ' wf-cronbad' : ''}`}
                >
                  {prettyCron(draft.trigger.cron)}
                  {!badCron
                    ? ' · the clock re-arms the moment you publish'
                    : /* Prod caught this: `0 3 1 * *` is well-formed cron and the
                         fleet still refuses it, because `nextCronFire` scans
                         only 8 days ahead and the 1st of next month is further
                         off than that. The parity is exact — the SERVER refuses
                         it for the same reason — but "not a schedule this fleet
                         can read" reads as "you typed it wrong", so the line
                         names the real limit instead of implying a typo. */
                      ' — it must be a five-field cron that fires at least once every 8 days'}
                </span>
                {/* The next fires are the safety net for anything the sentence
                    above can only echo: a schedule the fleet CAN evaluate but
                    cannot phrase still has to be checkable, and three real
                    timestamps are how. The server stays the authority — these
                    come from its own evaluator, mirrored. */}
                {!badCron ? (
                  <span className="wf-cronfires">
                    Next three:{' '}
                    {nextCronFires(draft.trigger.cron, 3)
                      .map((d) => FIRE_FMT.format(d))
                      .join(' · ')}{' '}
                    UTC
                  </span>
                ) : null}
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
            const inLoop = topo.cyclicKeys.has(s.charterKey)
            const from = incomingFor(s.charterKey, draft.edges)
            return (
              <div className={`wf-stepcard${inLoop ? ' is-bad' : ''}`} key={s.charterKey}>
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
                {inLoop ? (
                  <p className="wf-cardproblem" role="alert">
                    <AlertTriangle size={13} aria-hidden /> This step is in the loop — work
                    cannot flow back into it. Remove one of its hand-offs.
                  </p>
                ) : null}
                <div className="wf-gate">
                  <span className="wf-gatelabel">
                    <Term k="gate">Gate</Term>
                    <span className="wf-gatedir"> · tightens, never loosens</span>
                  </span>
                  <div className="acr-pg-ladder">
                    {(['inherit', 'ask', 'act'] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        className={`acr-pg-rung ${s.gate === g ? 'on' : ''}${g === 'act' ? ' has-floor' : ''}`}
                        title={g === 'act' ? GATE_FLOOR : GATE_COPY[g].hint}
                        onClick={() => setGate(s.charterKey, g)}
                      >
                        {g === 'act' ? <Lock size={10} aria-hidden /> : null}
                        {GATE_COPY[g].label}
                      </button>
                    ))}
                  </div>
                  <span className="wf-sub">
                    {s.gate === 'act' ? GATE_FLOOR : GATE_COPY[s.gate].hint}
                  </span>
                </div>
                {artifact && targets.length > 0 ? (
                  <div className="wf-handsto">
                    <span className="wf-gatelabel">Hands {artifact === 'finding' ? 'findings' : artifact} to</span>
                    {targets.map((t) => {
                      const tc = byKey.get(t.charterKey)
                      const on = draft.edges.some((e) => e.from === s.charterKey && e.to === t.charterKey)
                      return (
                        <Checkbox
                          key={t.charterKey}
                          className="wf-handopt"
                          checked={on}
                          onChange={() => toggleEdge(s.charterKey, t.charterKey, artifact)}
                          label={tc?.name ?? t.charterKey}
                        />
                      )
                    })}
                  </div>
                ) : artifact ? null : (
                  <span className="wf-sub">Terminal — its output is read by code, not handed on.</span>
                )}
                {/* S5.c — the other direction. A card only ever stated what it
                    hands ON, so reading who feeds it meant opening every other
                    card: at six steps, twenty-five checkboxes to hold in your
                    head. Read-only by design — the pickers above are still the
                    one place an edge is written. */}
                <span className="wf-receives">
                  {from.length > 0
                    ? `Receives from ${from.map((k) => byKey.get(k)?.name ?? k).join(', ')}`
                    : 'Receives nothing — it reads its own evidence'}
                </span>
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

        <div className="wf-editpic">
          <RoutinePipeline
            story={definitionToStory(draft, charters)}
            charters={charters}
            lastGroup={null}
            composing
          />
          <p className="wf-vnote">
            The wiring as drafted. Code steps — grading, report cards — and{' '}
            <Term k="approval">your approval</Term> still wrap every routine; they are not
            editable wiring.
          </p>
        </div>
      </div>

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
            <Textarea
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
