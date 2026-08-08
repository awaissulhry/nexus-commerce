'use client'

/**
 * NAF.SB.AS / AS.1 — create one assignment.
 *
 * Four decisions, in the order an operator would say them out loud: which
 * worker · what it points at · what you want back · by when. Only the first
 * two are required, and the second is only offered where it can actually be
 * enforced.
 *
 * Three things this deliberately does NOT do:
 *
 *  - It does not require a free-text brief. The research is explicit that a
 *    required essay makes the typed target decorative; the field is optional
 *    and prefilled from the worker's own description.
 *  - It offers no prompt box. `promptOverride` REPLACES a charter's whole
 *    system prompt rather than appending to it, so a free-text instruction
 *    here would silently destroy the worker's charter for that run.
 *  - It offers no "may it act" toggle. Every worker caps at OBSERVE or
 *    PROPOSE today, so the control would bind nothing — and this series'
 *    rule is that a control which is not enforced must not be rendered.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Target, Loader2 } from 'lucide-react'
import { Drawer } from '@/design-system/components/Drawer'
import { DateField } from '@/design-system/components/DateField'
import { getBackendUrl } from '@/lib/backend-url'
import { searchOptions } from '@/lib/option-search'

interface AssignableWorker {
  key: string
  name: string
  tier: string
  description: string | null
  targetKinds: TargetKind[]
  refusal?: string
}

type TargetKind = 'CAMPAIGN' | 'MARKETPLACE' | 'PORTFOLIO'

/** Plain words, in the order an operator would reach for them. */
const KIND_LABEL: Record<TargetKind, string> = {
  CAMPAIGN: 'One campaign',
  PORTFOLIO: 'One portfolio',
  MARKETPLACE: 'One marketplace',
}

interface PortfolioOption {
  portfolioId: string
  name: string
  campaignCount: number
  marketplaces: string[]
}

interface CampaignOption {
  id: string
  externalCampaignId: string | null
  name: string
  marketplace: string
  status: string
}

const MARKETPLACES = ['IT', 'DE', 'FR', 'ES']
/** Mirrors the server's BULK_CAP; the server refuses over it rather than truncating. */
const BULK_CAP = 25

/**
 * Three briefs, from the master document's own examples. They replace a
 * prefill: an example you choose is a decision, a prefill is a default nobody
 * decided. Deliberately short and deliberately not worker-specific — a
 * per-worker list would drift the day a charter's wording changed, which is
 * exactly how the prefill went wrong.
 */
const WANT_EXAMPLES = ['Find wasted spend', 'Propose bids', 'Audit structure']

/**
 * What steps 2–4 are, shown before a worker is chosen so the whole task is
 * legible at once. The wording matches the live headings exactly — two names
 * for one step would be the defect this page has spent six phases removing.
 */
const GHOST_STEPS = [
  {
    n: 2,
    title: 'What should it look at?',
    optional: false,
    hint: 'One campaign, one marketplace, one portfolio — or your whole account.',
  },
  {
    n: 3,
    title: 'What do you want back?',
    optional: true,
    hint: 'A note for you. It does not change what the worker does.',
  },
  {
    n: 4,
    title: 'By when?',
    optional: true,
    hint: 'A deadline only colours the row. It never starts anything.',
  },
] as const

export function CreateAssignment({
  onClose,
  onCreated,
  prefill,
}: {
  onClose: () => void
  onCreated: () => void
  /** NAF.SB.AS.2 — a deep link from the object the operator was standing on
   *  (the campaigns grid) arrives here with the target already chosen. A URL
   *  carries no rules across the page boundary, which is why this is a link
   *  rather than the campaigns grid importing anything of ours. */
  prefill?: { kind: TargetKind; id: string; label: string } | null
}) {
  const [workers, setWorkers] = useState<AssignableWorker[] | null>(null)
  const [workerKey, setWorkerKey] = useState<string | null>(null)
  const [kind, setKind] = useState<TargetKind | null>(prefill?.kind ?? null)
  const [picked, setPicked] = useState<{ id: string; label: string }[]>(
    prefill ? [{ id: prefill.id, label: prefill.label }] : [],
  )
  const [wantBack, setWantBack] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * NAF.SB.AS.6 — what several targets MEAN.
   *
   * The picker has always allowed more than one, and the drawer used to
   * silently make a single assignment covering them all. Both readings are
   * legitimate — "look at these three together" is one job, "look at each of
   * these three" is three — so the operator is asked instead of guessed at.
   */
  const [mode, setMode] = useState<'together' | 'each'>('each')
  const [bulkResult, setBulkResult] = useState<{
    created: { id: string; target: string }[]
    refused: { target: string; reason: string }[]
  } | null>(null)

  useEffect(() => {
    void (async () => {
      const res = await fetch(`${getBackendUrl()}/api/agent/fleet/assignable-workers`, {
        cache: 'no-store',
        credentials: 'include',
      })
      const j = (await res.json()) as { workers: AssignableWorker[] }
      setWorkers(j.workers)
    })().catch((e) => setError(String(e)))
  }, [])

  const worker = workers?.find((w) => w.key === workerKey) ?? null
  const assignable = (workers ?? []).filter((w) => !w.refusal)
  const refused = (workers ?? []).filter((w) => w.refusal)

  /**
   * NAF.SB.AS-S1R — the brief is NOT prefilled, and that is the change.
   *
   * It used to fill itself from `worker.description`, which meant every
   * assignment made from the same worker carried an identical sentence — so the
   * list's second line was the same grey text on every row, looking like
   * information and carrying none. That measured as the reason a row was 56px
   * instead of 38px, i.e. five rows of visible list per screen spent saying
   * nothing (study §11.1 D2).
   *
   * A field that fills itself is not an answer. Three examples do the teaching
   * a blank box cannot, without manufacturing content nobody wrote.
   *
   * Also removed with it: a `wantBackTouched` guard whose setter was never
   * called anywhere in the file. It read as protection against overwriting a
   * typed note when the worker changed, and it protected nothing — pick a
   * worker, type your note, change your mind about the worker, and your note
   * was silently replaced.
   */

  const overCap = !!kind && mode === 'each' && picked.length > BULK_CAP
  const canSubmit = !!workerKey && (!kind || picked.length > 0) && !saving && !overCap

  /**
   * S2.c — what the commit bar says, in three moods.
   *
   * `blocker` names the ONE thing standing in the way, never a list of rules:
   * a form that recites its whole contract at someone who has done most of it
   * is nagging, not helping.
   */
  const kindNoun =
    kind === 'CAMPAIGN' ? 'campaign' : kind === 'PORTFOLIO' ? 'portfolio' : 'marketplace'
  const blocker = !workerKey
    ? 'Pick a worker to begin.'
    : overCap
      ? `${picked.length} is more than the ${BULK_CAP} this can make at once — remove some, or make one covering all of them.`
      : `Pick a ${kindNoun} to continue.`
  const targetPhrase = !kind
    ? 'your whole account'
    : picked.length === 1
      ? picked[0].label
      : `${picked.length} ${kindNoun}s`
  const consequence =
    kind && picked.length > 1 && mode === 'each'
      ? `Creates ${picked.length} assignments, one per ${kindNoun}. Nothing runs until you start it.`
      : `Creates 1 assignment · ${worker?.name ?? ''} on ${targetPhrase}. Nothing runs until you start it.`
  const receiptLine = bulkResult
    ? `${bulkResult.created.length} created${bulkResult.refused.length > 0 ? `, ${bulkResult.refused.length} refused` : ''}. None of them has run.`
    : ''

  const submit = useCallback(async () => {
    if (!workerKey) return
    setSaving(true)
    setError(null)
    try {
      // Several targets, one per assignment — the AS.6 path.
      if (kind && picked.length > 1 && mode === 'each') {
        const res = await fetch(`${getBackendUrl()}/api/agent/fleet/assignments/bulk`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            charterKey: workerKey,
            targetKind: kind,
            targets: picked.map((p) => ({ id: p.id, label: p.label })),
            wantBack: wantBack.trim() || null,
            dueAt: dueAt || null,
          }),
        })
        const j = (await res.json()) as {
          created?: { id: string; target: string }[]
          refused?: { target: string; reason: string }[]
          error?: string
        }
        if (!res.ok) {
          setError(j.error ?? `create failed (${res.status})`)
          return
        }
        // Stay open and show what actually happened per row. Closing on a
        // partial success would hide the refusals.
        setBulkResult({ created: j.created ?? [], refused: j.refused ?? [] })
        return
      }

      const res = await fetch(`${getBackendUrl()}/api/agent/fleet/assignments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          charterKey: workerKey,
          targetKind: kind,
          targetIds: picked.map((p) => p.id),
          targetLabels: picked.map((p) => p.label),
          wantBack: wantBack.trim() || null,
          dueAt: dueAt || null,
        }),
      })
      const j = (await res.json()) as { id?: string; error?: string }
      if (!res.ok) {
        setError(j.error ?? `create failed (${res.status})`)
        return
      }
      onCreated()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }, [workerKey, kind, picked, mode, wantBack, dueAt, onCreated])

  const undoBulk = useCallback(async () => {
    if (!bulkResult?.created.length) return
    setSaving(true)
    try {
      await fetch(`${getBackendUrl()}/api/agent/fleet/assignments/bulk-delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ids: bulkResult.created.map((c) => c.id) }),
      })
      onCreated()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }, [bulkResult, onCreated])

  return (
    <Drawer
      open
      onClose={onClose}
      title="New assignment"
      subtitle="One worker, one thing to look at."
      width={560}
      /* The Drawer portals to <body>, so it is OUTSIDE `.as-page` and none of
         this page's overrides reach it. This class is that root — the same
         lesson as Part 11's `.as-page`, one portal further out. */
      className="as-drawer"
      footer={
        /**
         * S2.c — the commit bar.
         *
         * Google Ads is the only researched create-flow that states the
         * consequence before you commit, and it spends a whole step on it. We
         * cannot afford a step; we can put the sentence next to the button,
         * which is the same idea at zero extra clicks.
         *
         * And when the form is not ready it carries the REASON — as text.
         * Before this, the only explanation lived in `title` on the disabled
         * Create button, and a disabled button suppresses pointer events in
         * every major browser, so that sentence could never be shown to
         * anybody, by mouse or otherwise.
         */
        <div className="as-commit">
          <p className={`as-commitline${canSubmit || bulkResult ? '' : ' blocked'}`}>
            {bulkResult ? receiptLine : canSubmit ? consequence : blocker}
          </p>
          <div className="as-commitacts">
            {!bulkResult && (
              <button className="acr-btn" onClick={onClose} disabled={saving}>
                Cancel
              </button>
            )}
            {!bulkResult && (
              <button
                className="acr-btn go"
                onClick={submit}
                disabled={!canSubmit}
                title="Creates it. It will not run until you start it."
              >
                {saving ? <Loader2 size={14} className="spin" /> : <Target size={14} />}
                {saving
                  ? 'Creating…'
                  : kind && picked.length > 1 && mode === 'each'
                    ? `Create ${picked.length}`
                    : 'Create it'}
              </button>
            )}
            {/* One action, one word. The footer used to say "Close" while the
                panel said "Done" — 700px apart, both calling the same
                function, and a first-timer had to guess whether they
                differed. The panel's copy is now the only one. */}
            {bulkResult && (
              <button className="acr-btn go" onClick={onCreated} disabled={saving}>
                Back to your assignments
              </button>
            )}
          </div>
        </div>
      }
    >
      {/* NAF.SB.AS.6 — what actually happened, per row. Shown INSTEAD of the
          form, because closing on a partial success would hide the refusals. */}
      {bulkResult && (
        <div className="as-step">
          <h3 className="as-receipt-h">
            {bulkResult.created.length} assignment
            {bulkResult.created.length === 1 ? '' : 's'} created
            {bulkResult.refused.length > 0 && `, ${bulkResult.refused.length} refused`}
          </h3>
          <p className="as-hint">
            None of them has run. They will sit in your list until you start
            them one at a time.
          </p>
          {bulkResult.created.length > 0 && (
            <ul className="as-bulklist">
              {bulkResult.created.map((c) => (
                <li key={c.id}>{c.target}</li>
              ))}
            </ul>
          )}
          {bulkResult.refused.length > 0 && (
            <div className="as-refusal as-mt10">
              {bulkResult.refused.map((r) => (
                <div key={r.target}>
                  <strong>{r.target}</strong> — {r.reason}
                </div>
              ))}
            </div>
          )}
          {/* No "Done" here: the footer owns the way out, and two words for
              one action is what this phase exists to remove. Undo stays,
              because it is a different action and only reachable here. */}
          {bulkResult.created.length > 0 && (
            <div className="as-receipt-undo">
              <button
                type="button"
                className="acr-btn"
                disabled={saving}
                onClick={undoBulk}
                title="Deletes the ones just created. Possible only because none of them has run."
              >
                Undo — delete {bulkResult.created.length}
              </button>
            </div>
          )}
        </div>
      )}

      {/* 1 — the worker */}
      {!bulkResult && <div className="as-step">
        <span className="as-steplabel">1 · Which worker?</span>
        {workers === null ? (
          <p className="as-hint">Loading…</p>
        ) : (
          <>
            {assignable.map((w) => (
              <button
                key={w.key}
                type="button"
                className="as-workerbtn"
                aria-pressed={workerKey === w.key}
                onClick={() => {
                  setWorkerKey(w.key)
                  // Keep a target the operator already chose (a deep link, or
                  // a worker swap) when the new worker can honour that kind.
                  // Clearing it silently would make them re-find a campaign
                  // among 220 for no reason they could see.
                  if (!kind || !w.targetKinds.includes(kind)) {
                    setKind(null)
                    setPicked([])
                  }
                }}
              >
                <span className="nm">{w.name}</span>
                <span className="ds">{w.description}</span>
              </button>
            ))}
            {assignable.length === 0 && (
              <p className="as-hint">No worker can be assigned right now.</p>
            )}
            {refused.length > 0 && (
              <p className="as-hint as-mt10">
                {refused.length} other worker{refused.length === 1 ? '' : 's'} cannot be
                assigned — most read your whole account every time, so a target
                would narrow nothing.{' '}
                <a href="/fleet/workers">Run those from Workers →</a>
              </p>
            )}
          </>
        )}
      </div>}

      {/**
        * S2.b — the shape of the task, from the moment it opens.
        *
        * Steps 2–4 did not exist until a worker was picked, so the form grew
        * from 321px to 1112px under the reader and there was no point at which
        * you could see how much was left. Measured with it: 461px — 59% — of
        * the drawer was blank on open, which is the first impression of this
        * page's primary action.
        *
        * These are the headings only, greyed and inert: what is coming, in
        * what order, and which parts you are allowed to skip. They are NOT a
        * stepper — §12.4 declined that with evidence — they are the same
        * single form, telling the truth about its own length.
        */}
      {!worker && !bulkResult && (
        <>
          {GHOST_STEPS.map((s) => (
            <div key={s.n} className="as-step as-step-ghost" aria-hidden="true">
              <span className="as-steplabel">
                {s.n} · {s.title}
                {s.optional ? <span className="opt"> — optional</span> : null}
              </span>
              <p className="as-hint">{s.hint}</p>
            </div>
          ))}
        </>
      )}

      {/* 2 — the target */}
      {worker && !bulkResult && (
        <div className="as-step">
          <span className="as-steplabel">2 · What should it look at?</span>
          <div className="as-kinds">
            {worker.targetKinds.map((k) => (
              <button
                key={k}
                type="button"
                className="as-kind"
                aria-pressed={kind === k}
                onClick={() => {
                  setKind(k)
                  setPicked([])
                }}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
            <button
              type="button"
              className="as-kind"
              aria-pressed={kind === null}
              onClick={() => {
                setKind(null)
                setPicked([])
              }}
            >
              The whole account
            </button>
          </div>

          {/* Only the kinds this worker's evidence can actually enforce are
              offered. Anything absent is absent WITH a reason, never greyed
              in silence — a control that cannot bind must not be rendered. */}
          {worker.targetKinds.length < 3 && (
            <p className="as-hint">
              {worker.name} can be pointed at{' '}
              {worker.targetKinds.map((k) => KIND_LABEL[k].replace('One ', 'a ')).join(' or ')}.
              {!worker.targetKinds.includes('MARKETPLACE') &&
                ' A whole marketplace is not offered here because the evidence it reads has nowhere to put one — it would narrow nothing.'}
            </p>
          )}

          {kind === 'CAMPAIGN' && <CampaignPicker picked={picked} onChange={setPicked} />}
          {kind === 'PORTFOLIO' && <PortfolioPicker picked={picked} onChange={setPicked} />}
          {kind === 'MARKETPLACE' && (
            <div className="as-kinds as-mt10">
              {MARKETPLACES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className="as-kind"
                  aria-pressed={picked[0]?.id === m}
                  onClick={() => setPicked([{ id: m, label: m }])}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          {/* NAF.SB.AS.6 — several targets: ask what they mean, never guess. */}
          {kind && picked.length > 1 && (
            <div className="as-bulk">
              <span className="as-steplabel as-mb8">
                You picked {picked.length}. What do you mean?
              </span>
              <div className="as-kinds">
                <button
                  type="button"
                  className="as-kind"
                  aria-pressed={mode === 'each'}
                  onClick={() => setMode('each')}
                >
                  {picked.length} separate assignments
                </button>
                <button
                  type="button"
                  className="as-kind"
                  aria-pressed={mode === 'together'}
                  onClick={() => setMode('together')}
                >
                  One covering all {picked.length}
                </button>
              </div>
              <p className="as-hint">
                {mode === 'each'
                  ? `${picked.length} assignments, one per ${kind === 'CAMPAIGN' ? 'campaign' : kind === 'PORTFOLIO' ? 'portfolio' : 'marketplace'}, each started and read on its own.`
                  : `One assignment that looks at all ${picked.length} together and reports once.`}{' '}
                Either way nothing runs until you start it.
              </p>
              {picked.length > BULK_CAP && mode === 'each' && (
                <p className="as-err as-mt8">
                  {picked.length} is more than the {BULK_CAP} this can make at
                  once. Remove some, or make one covering all of them.
                </p>
              )}
            </div>
          )}

          <Preflight worker={worker} kind={kind} picked={picked} />
        </div>
      )}

      {/* 3 — the brief */}
      {worker && !bulkResult && (
        <div className="as-step">
          <label htmlFor="as-want">3 · What do you want back? (optional)</label>
          <textarea
            id="as-want"
            className="acr-pg-search as-wantbox"
            value={wantBack}
            placeholder="What does finished look like?"
            onChange={(e) => setWantBack(e.target.value)}
          />
          <div className="as-wantchips">
            {WANT_EXAMPLES.map((w) => (
              <button
                key={w}
                type="button"
                className="acr-pg-chip"
                onClick={() => setWantBack(w)}
                title="Use this as your note. You can edit it, and you can leave the box empty."
              >
                {w}
              </button>
            ))}
          </div>
          <p className="as-hint">
            A note for you — it does not change the worker&apos;s instructions.
            Leave it empty if you have nothing to add.
          </p>
        </div>
      )}

      {/* 4 — the deadline */}
      {worker && !bulkResult && (
        <div className="as-step">
          <span className="as-steplabel">4 · By when? (optional)</span>
          <DateField
            value={dueAt}
            onChange={setDueAt}
            clearable
            ariaLabel="Due date"
            placeholder="No deadline"
          />
          <p className="as-hint">
            A deadline colours the row and moves it up the list so you notice it
            slipped. It never starts anything and never stops anything.
          </p>
        </div>
      )}

      {error && <div className="as-err">{error}</div>}
    </Drawer>
  )
}

/**
 * The pre-flight sentence: what this will actually look at.
 *
 * One sentence by default. The reason a narrowed run finds LESS — n-gram
 * themes are account-wide and withheld — sits behind a disclosure, because a
 * beginner reads "3 of 4 evidence sections" as breakage.
 */
interface StaticPreflight {
  ok: boolean
  refusal?: string
  headline: string
  feeds: { key: string; label: string; honoured: boolean; notes: string[] }[]
  ceilingUSD: number
  fleetCeilingUSD: number
  fleetHalted: boolean
}
interface MeasuredPreflight {
  ok: boolean
  error?: string
  totalItems: number
  feeds: { key: string; label: string; items: number; caveats: string[]; cached: boolean }[]
}

/**
 * NAF.SB.AS.3 — what it will actually look at.
 *
 * The default state answers ONE question in ONE sentence. Everything else —
 * why a narrowed run finds less, what is held back, what stays account-wide —
 * lives behind a closed disclosure, because a beginner reads "3 of 4 evidence
 * sections" as breakage rather than as design.
 *
 * The static half costs nothing and updates as the target changes. The
 * measured half is a button that says what it costs before it runs: it reads
 * real evidence (no model, nothing written), which is real database work.
 */
function Preflight({
  worker,
  kind,
  picked,
}: {
  worker: AssignableWorker
  kind: TargetKind | null
  picked: { id: string; label: string }[]
}) {
  const [pre, setPre] = useState<StaticPreflight | null>(null)
  const [measured, setMeasured] = useState<MeasuredPreflight | null>(null)
  const [measuring, setMeasuring] = useState(false)

  const targetReady = !kind || picked.length > 0

  useEffect(() => {
    setMeasured(null)
    if (!targetReady) return
    const q = new URLSearchParams({ charterKey: worker.key })
    if (kind && picked.length) {
      q.set('targetKind', kind)
      q.set('targetIds', picked.map((p) => p.id).join(','))
      q.set('targetLabels', picked.map((p) => p.label).join(','))
    }
    let live = true
    void (async () => {
      const res = await fetch(
        `${getBackendUrl()}/api/agent/fleet/assignment-preflight?${q.toString()}`,
        { cache: 'no-store', credentials: 'include' },
      )
      if (!res.ok || !live) return
      setPre((await res.json()) as StaticPreflight)
    })().catch(() => undefined)
    return () => {
      live = false
    }
  }, [worker.key, kind, picked, targetReady])

  const measure = useCallback(async () => {
    setMeasuring(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/agent/fleet/assignment-preflight-measure`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            charterKey: worker.key,
            targetKind: kind,
            targetIds: picked.map((p) => p.id),
            targetLabels: picked.map((p) => p.label),
          }),
        },
      )
      setMeasured((await res.json()) as MeasuredPreflight)
    } catch (e) {
      setMeasured({ ok: false, error: String(e), totalItems: 0, feeds: [] })
    } finally {
      setMeasuring(false)
    }
  }, [worker.key, kind, picked])

  if (!targetReady) {
    return (
      <p className="as-preflightline waiting">
        Pick {kind === 'CAMPAIGN' ? 'a campaign' : kind === 'PORTFOLIO' ? 'a portfolio' : 'a marketplace'} and this
        will say exactly what {worker.name} will be allowed to look at.
      </p>
    )
  }
  if (!pre) {
    return (
      <p className="as-preflightline waiting">
        Checking what it will be allowed to look at…
      </p>
    )
  }

  return (
    <>
      <p className={`as-preflightline${pre.ok ? '' : ' bad'}`}>
        {pre.ok ? pre.headline : pre.refusal}
      </p>

      {pre.fleetHalted && (
        <p className="as-preflightnote">
          The fleet is halted right now, so this would stop before spending anything.
        </p>
      )}

      {pre.ok && (
        <details className="as-disclose">
          <summary>What will it read?</summary>
          <ul className="as-disclose-list">
            {pre.feeds.map((f) => (
              <li key={f.key}>
                <strong>{f.label}</strong>
                {f.notes.length > 0 && <> — {f.notes.join(' ')}</>}
              </li>
            ))}
          </ul>
          {kind && (
            <p className="as-disclose-p">
              A narrowed run finds <strong>less</strong> than one over your whole
              account. That is the point of pointing it at something, not a
              fault.
            </p>
          )}
          <p className="as-disclose-p">
            It cannot spend more than{' '}
            <strong>${pre.ceilingUSD.toFixed(2)}</strong> today across every run
            of this worker, inside a fleet ceiling of $
            {pre.fleetCeilingUSD.toFixed(2)}.
          </p>

          {!measured && (
            <button
              type="button"
              className="acr-btn as-measurebtn"
              onClick={measure}
              disabled={measuring}
            >
              {measuring ? 'Reading…' : 'Show me how much there is'}
            </button>
          )}
          {!measured && (
            <p className="as-hint">
              Reads the last 60 days of your search terms and may take a few
              seconds. It calls no AI and writes nothing.
            </p>
          )}

          {measured && !measured.ok && <p className="as-danger">{measured.error}</p>}
          {measured?.ok && (
            <div className="as-measured">
              <p>
                <strong>
                  {measured.totalItems} thing{measured.totalItems === 1 ? '' : 's'} to look at
                </strong>{' '}
                right now.
              </p>
              <ul className="as-disclose-list">
                {measured.feeds.map((f) => (
                  <li key={f.key}>
                    {f.label}: {f.items}
                  </li>
                ))}
              </ul>
              {measured.feeds.some((f) => f.caveats.length > 0) && (
                <p className="as-disclose-p">
                  {measured.feeds.flatMap((f) => f.caveats).slice(0, 2).join(' ')}
                </p>
              )}
            </div>
          )}
        </details>
      )}
    </>
  )
}


/**
 * Campaign picker — search-first, ENABLED by default (most of the estate is
 * paused, so an unfiltered list offers mostly dormant scope).
 *
 * TWO RULES, both from measuring the shipped version on production.
 *
 * 1. **IT DOES NOT SCROLL.** It used to be a 210px box holding 1940px of
 *    options — a window onto 10.8% of itself — sitting across 26.9% of the
 *    visible drawer while the drawer had 330px more below it. A wheel gesture
 *    aimed at the drawer moved the list instead, which is why the pre-flight
 *    and the last two steps were hard to reach at all. The drawer body is the
 *    only scroll container in the drawer, and this renders inline underneath
 *    it. (`overscroll-behavior: contain` does NOT fix this: it stops an inner
 *    scroller *chaining* to its parent, and the bug was *capture*.)
 * 2. **IT STATES ITS OWN ARITHMETIC.** It used to render `.slice(0, 40)` of 86
 *    running campaigns and say nothing about the other 46, so half the account
 *    was reachable only by guessing a substring. A cap is fine; a silent one
 *    is a lie, and a missing option cannot be discovered the way a missing row
 *    can be scrolled to.
 */
const PICKER_ROWS = 8

function CampaignPicker({
  picked,
  onChange,
}: {
  picked: { id: string; label: string }[]
  onChange: (v: { id: string; label: string }[]) => void
}) {
  const [all, setAll] = useState<CampaignOption[] | null>(null)
  const [q, setQ] = useState('')
  const [enabledOnly, setEnabledOnly] = useState(true)

  useEffect(() => {
    void (async () => {
      const res = await fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, {
        cache: 'no-store',
        credentials: 'include',
      })
      if (!res.ok) return setAll([])
      // The endpoint's envelope is { items, count } — not a bare array and not
      // { campaigns }. Checked against advertising.routes.ts rather than guessed.
      const j = (await res.json()) as { items?: CampaignOption[] }
      setAll(j.items ?? [])
    })().catch(() => setAll([]))
  }, [])

  const { matches, poolSize, pausedCount } = useMemo(() => {
    const live = (all ?? []).filter((c) => !!c.externalCampaignId)
    const paused = live.filter((c) => c.status !== 'ENABLED').length
    const pool = enabledOnly ? live.filter((c) => c.status === 'ENABLED') : live
    const mapped = pool.map((c) => ({
      value: c.externalCampaignId as string,
      label: `${c.name} · ${c.marketplace}`,
    }))
    // searchOptions ranks the way ads names need — plain substring matching
    // returns nothing for "gale broad" against "GALE | IT | Broad | Brand".
    return {
      matches: q.trim() ? searchOptions(q, mapped, (o) => o.label) : mapped,
      poolSize: mapped.length,
      pausedCount: paused,
    }
  }, [all, q, enabledOnly])

  const shown = matches.slice(0, PICKER_ROWS)
  const query = q.trim()

  return (
    <div className="as-picker">
      <input
        className="acr-pg-search as-pickersearch"
        placeholder="Search campaigns…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search campaigns"
        title="Every word you type must appear, in any order — so “gale broad” finds “GALE | IT | Broad | Brand”."
      />
      <label className="as-checkline">
        <input
          type="checkbox"
          checked={enabledOnly}
          onChange={(e) => setEnabledOnly(e.target.checked)}
        />
        Only campaigns that are running
        {pausedCount > 0 && enabledOnly ? ` (${pausedCount} paused are hidden)` : ''}
      </label>

      {picked.length > 0 && (
        <div className="as-picked">
          {picked.map((p) => (
            <button
              key={p.id}
              type="button"
              className="as-target"
              title="Remove this one"
              onClick={() => onChange(picked.filter((x) => x.id !== p.id))}
            >
              <Target size={11} />
              {p.label} ✕
            </button>
          ))}
        </div>
      )}

      {all === null ? (
        <p className="as-hint">Loading campaigns…</p>
      ) : (
        <>
          {/* The arithmetic, always. Nothing is hidden without being counted. */}
          <p className="as-pickcount">
            {query ? (
              matches.length > 0 ? (
                <>
                  <strong>{matches.length}</strong> match “{query}”
                  {matches.length > shown.length ? <> · showing {shown.length}</> : null}
                </>
              ) : (
                <>Nothing matches “{query}”.</>
              )
            ) : (
              <>
                <strong>{poolSize}</strong> campaign{poolSize === 1 ? '' : 's'}{' '}
                {enabledOnly ? 'running' : 'in your account'}
                {poolSize > shown.length ? (
                  <> · showing {shown.length} — type to narrow</>
                ) : null}
              </>
            )}
          </p>

          {matches.length === 0 && enabledOnly && pausedCount > 0 && (
            <p className="as-hint">
              {pausedCount} paused campaign{pausedCount === 1 ? ' is' : 's are'} hidden.{' '}
              <button type="button" className="as-linkbtn" onClick={() => setEnabledOnly(false)}>
                Include paused ones
              </button>
            </p>
          )}

          {shown.map((o) => (
            <button
              key={o.value}
              type="button"
              className="as-workerbtn"
              aria-pressed={picked.some((p) => p.id === o.value)}
              onClick={() =>
                onChange(
                  picked.some((p) => p.id === o.value)
                    ? picked.filter((p) => p.id !== o.value)
                    : [...picked, { id: o.value, label: o.label }],
                )
              }
            >
              <span className="nm as-optlabel">{o.label}</span>
            </button>
          ))}
        </>
      )}
    </div>
  )
}

/**
 * NAF.SB.AS.2 — the portfolio picker.
 *
 * Ten rows, so this is a plain list rather than a search surface. It shows the
 * campaign count and the marketplaces each portfolio spans, because a portfolio
 * is only meaningful as "these N campaigns" — and the server only returns
 * portfolios that HAVE campaigns, so nothing offered here can be refused later
 * for being empty.
 *
 * S2.a — it used to carry its own `maxHeight: 230; overflow-y: auto`, a second
 * wheel trap nobody had reported: the campaign picker had one, so this one
 * copied it. Ten rows never needed a scroller. The rule that replaces the
 * habit: **the drawer body is the only scroll container in the drawer.**
 */
function PortfolioPicker({
  picked,
  onChange,
}: {
  picked: { id: string; label: string }[]
  onChange: (v: { id: string; label: string }[]) => void
}) {
  const [all, setAll] = useState<PortfolioOption[] | null>(null)

  useEffect(() => {
    void (async () => {
      const res = await fetch(`${getBackendUrl()}/api/agent/fleet/assignment-portfolios`, {
        cache: 'no-store',
        credentials: 'include',
      })
      if (!res.ok) return setAll([])
      const j = (await res.json()) as { portfolios?: PortfolioOption[] }
      setAll(j.portfolios ?? [])
    })().catch(() => setAll([]))
  }, [])

  if (all === null) return <p className="as-hint">Loading portfolios…</p>
  if (all.length === 0) {
    return (
      <p className="as-hint">
        No portfolio has any campaigns in it, so there is nothing to point a
        worker at. Pick a campaign instead.
      </p>
    )
  }

  return (
    <div className="as-picker">
      {all.map((p) => {
        const on = picked.some((x) => x.id === p.portfolioId)
        return (
          <button
            key={p.portfolioId}
            type="button"
            className="as-workerbtn"
            aria-pressed={on}
            onClick={() => onChange(on ? [] : [{ id: p.portfolioId, label: p.name }])}
          >
            <span className="nm as-optlabel">{p.name}</span>
            <span className="ds">
              {p.campaignCount} campaign{p.campaignCount === 1 ? '' : 's'} ·{' '}
              {p.marketplaces.join(', ')}
            </span>
          </button>
        )
      })}
    </div>
  )
}
