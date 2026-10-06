'use client'
/**
 * Approvals grid (docs/approvals-grid/PLAN.md §4; Owner decision 2 = A, 2026-10-05) — "Automate this kind…".
 *
 * One kind of change (one tool), in this business, as Settings › AI › Claude › Rules sets it — the same rule, read with
 * GET /api/claude/trust and saved with `claudeApi.setRule`; no new kind of rule:
 *   - only the levels this kind allows (the row's ceiling and the rule's, whichever is lower); a kind that always needs a
 *     person says why and offers nothing;
 *   - the limits for Auto, pre-filled from the kind's limits now, with what THIS request shows as a hint (never filled
 *     in); the limits the settings page cannot edit either are shown, not changed;
 *   - a history test while the person edits (GET /api/claude/trust/:tool/simulate, 400 ms after the last change);
 *   - lowering, keeping, or only tightening saves at once; raising the level or loosening a limit first asks for the
 *     2FA code with the DS StepUpModal (and so does any save the API answers with `mfa_required`);
 *   - "Also approve this one" is never ticked for the person: the PAGE approves the row after onSaved.
 * The API decides and refuses; its sentence is shown as it is, inside the modal.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { QueueRow, RuleSimulation } from '@nexus/shared/approval-queue'
import { Banner, Field, KeyValue, Modal } from '@/design-system/components'
import { Button, Checkbox, Input, RadioCard, Spinner } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import Link from '@/lib/workspaces/Link'
import { claudeApi, ClaudeApiError } from '@/app/settings/ai/claude/claudeApi'
import { pauseSentence, raiseText, type Autonomy, type ClaudeRule, type Raise } from '@/app/settings/ai/claude/claudeWords'
import { StepUpModal } from '@/design-system/patterns'
import type { AutomateModalProps } from './contracts'
import {
  alwaysNeedsYouWords,
  AUTOMATE_NOTE,
  boundsHint,
  ceilingNote,
  CHOICE_HINT,
  CHOICE_LABEL,
  exampleWords,
  FIXED_LIMIT_HINT,
  fieldErrors,
  fixedLimits,
  leadSentence,
  levelChoices,
  mayAlsoApprove,
  modalTitle,
  notOfferedWords,
  numberLimits,
  requestHint,
  rowOffersChoices,
  saveLabel,
  savePlan,
  serverErrorField,
  simulatePath,
  simulationWords,
  TEST_DAYS,
  TEST_NOTE,
  testLimits,
  type AutomateLevel,
  type SavePlan,
} from './automateWords'
import '@/app/settings/ai/claude/claude.css'
import './automate.css'

const PORTAL = 'fleet-portal'

const message = (error: unknown) => (error instanceof Error && error.message ? error.message : 'That could not be completed. Try again.')

type Loaded =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; rule: ClaudeRule | null; autonomy: Autonomy }

type Test =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'done'; sim: RuleSimulation }
  | { state: 'failed'; error: string; field: string | null }

export function AutomateModal({ row, onClose, onSaved }: AutomateModalProps) {
  if (!row) return null
  return <AutomateDialog key={row.id} row={row} onClose={onClose} onSaved={onSaved} />
}

function AutomateDialog({ row, onClose, onSaved }: { row: QueueRow } & Omit<AutomateModalProps, 'row'>) {
  const offers = rowOffersChoices(row)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [chosen, setChosen] = useState<AutomateLevel | null>(null)
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [alsoApprove, setAlsoApprove] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The save that waits for the person's 2FA code. */
  const [pending, setPending] = useState<{ patch: Extract<SavePlan, { kind: 'save' }>['patch']; level: AutomateLevel; raise: Raise } | null>(null)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [test, setTest] = useState<Test>({ state: 'idle' })
  const leadId = useId()
  const limitsId = useId()
  const fieldBase = useId()
  const testId = useId()
  const group = useRef<HTMLDivElement>(null)

  // The kind's rule now (levels, ceiling, limits) and the business's brakes. Not read for a kind that offers nothing.
  useEffect(() => {
    if (!offers) return
    let live = true
    claudeApi.rules().then(
      (rules) => {
        if (!live) return
        const rule = rules.tools.find((tool) => tool.name === row.toolName) ?? null
        setLoaded({ state: 'ready', rule, autonomy: rules.autonomy })
        // The level now is chosen to start with — when this kind may take it here (Off is set on the settings page).
        const now = rule ? levelChoices(rule, row.automation.max).find((level) => level === rule.level) : undefined
        if (now) setChosen(now)
      },
      (err) => live && setLoaded({ state: 'failed', error: message(err) }),
    )
    return () => {
      live = false
    }
  }, [offers, row.toolName, row.automation.max])

  const rule = loaded.state === 'ready' ? loaded.rule : null
  const choices = useMemo(() => (rule ? levelChoices(rule, row.automation.max) : []), [rule, row.automation.max])
  const fields = useMemo(() => (rule ? numberLimits(rule) : []), [rule])
  const fixed = useMemo(() => (rule ? fixedLimits(rule.limitsSchema, rule.limits) : []), [rule])
  const errors = useMemo(() => (chosen === 'auto' ? fieldErrors(fields, typed) : {}), [chosen, fields, typed])
  const plan = useMemo<SavePlan | null>(() => (rule && chosen ? savePlan(rule, chosen, typed) : null), [rule, chosen, typed])
  const approvable = mayAlsoApprove(row)

  // Once the rule is read, the chosen level takes the focus (the Modal focused its first control while it loaded).
  const focused = useRef(false)
  useEffect(() => {
    const radio = group.current?.querySelector<HTMLInputElement>('input:checked') ?? group.current?.querySelector<HTMLInputElement>('input')
    if (focused.current || !radio) return
    focused.current = true
    const active = document.activeElement
    if (!active || active === document.body || active.classList.contains('nds-modal-x') || active.classList.contains('nds-modal')) radio.focus()
  }, [choices, chosen])

  // The history test, 400 ms after the last change of level or limits. Only Auto runs anything by itself.
  useEffect(() => {
    if (!rule || chosen !== 'auto') {
      setTest({ state: 'idle' })
      return
    }
    const limits = testLimits(rule, typed)
    if (fields.length && !limits) {
      setTest({ state: 'idle' })
      return
    }
    const controller = new AbortController()
    setTest({ state: 'testing' })
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`${getBackendUrl()}${simulatePath(rule.name, limits)}`, { cache: 'no-store', signal: controller.signal })
          const data = (await response.json().catch(() => ({}))) as RuleSimulation & { error?: string }
          if (controller.signal.aborted) return
          if (response.ok) setTest({ state: 'done', sim: data })
          else {
            const words = data.error ?? 'The history test could not run. Try again.'
            setTest({ state: 'failed', error: words, field: response.status === 400 ? serverErrorField(words, fields) : null })
          }
        } catch (err) {
          if (!controller.signal.aborted) setTest({ state: 'failed', error: `The history test could not run: ${message(err)}`, field: null })
        }
      })()
    }, 400)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [rule, chosen, typed, fields])

  const finish = (level: AutomateLevel) => {
    onSaved({ level, alsoApprove: approvable && alsoApprove })
    onClose()
  }

  const save = async () => {
    if (!rule || !chosen || !plan || busy) return
    if (plan.kind === 'invalid') {
      setError('Check the limits: each one is a number inside its bounds.')
      return
    }
    if (plan.kind === 'nothing') {
      if (approvable && alsoApprove) finish(chosen)
      return
    }
    setError(null)
    if (plan.needsCode) {
      setCodeError(null)
      setPending({ patch: plan.patch, level: chosen, raise: plan.raise })
      return
    }
    // A brake (lower, keep, tighten): sent at once. If the API judges it a raise after all, it asks for the code.
    setBusy(true)
    try {
      await claudeApi.setRule(rule.name, plan.patch)
      finish(chosen)
    } catch (err) {
      if (err instanceof ClaudeApiError && err.code === 'mfa_required') {
        setCodeError(null)
        setPending({ patch: plan.patch, level: chosen, raise: plan.raise })
      } else setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  const submitCode = async (code: string) => {
    if (!rule || !pending) return
    setBusy(true)
    setCodeError(null)
    try {
      await claudeApi.setRule(rule.name, { ...pending.patch, code })
      const level = pending.level
      setPending(null)
      finish(level)
    } catch (err) {
      setCodeError(message(err))
    } finally {
      setBusy(false)
    }
  }

  const ready = loaded.state === 'ready'
  const nothingToChoose = !offers || (ready && (!rule || !choices.length))
  const canSave = !busy && !!plan && plan.kind !== 'invalid' && (plan.kind !== 'nothing' || (approvable && alsoApprove))
  const allRules = <Link href="/settings/ai/claude" className="aq-auto-link">All rules</Link>
  const stepUp = pending ? raiseText(pending.raise) : null

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={modalTitle(row)}
        size="md"
        className={PORTAL}
        footer={
          nothingToChoose || loaded.state !== 'ready' ? (
            <>
              {allRules}
              <span className="aq-auto-grow" />
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </>
          ) : (
            <>
              {allRules}
              <span className="aq-auto-grow" />
              <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
                {busy ? 'Saving…' : plan ? saveLabel(plan, approvable && alsoApprove) : 'Save'}
              </Button>
            </>
          )
        }
      >
        <div className="aq-auto">
          {!offers ? (
            <p className="aq-auto-lead">{alwaysNeedsYouWords(row)}</p>
          ) : loaded.state === 'loading' ? (
            <p className="aq-auto-busy" role="status"><Spinner size={14} /> Reading your rule for this kind…</p>
          ) : loaded.state === 'failed' ? (
            <Banner tone="danger" title="Your rules could not be read">{loaded.error}</Banner>
          ) : !rule ? (
            <p className="aq-auto-lead">{notOfferedWords(row)}</p>
          ) : !choices.length ? (
            <p className="aq-auto-lead">{alwaysNeedsYouWords(row)}</p>
          ) : (
            <>
              {error && <Banner tone="danger" onDismiss={() => setError(null)}>{error}</Banner>}
              <p className="aq-auto-lead" id={leadId}>{leadSentence(row)}</p>
              <div className="aq-auto-choices" role="radiogroup" aria-labelledby={leadId} ref={group}>
                {choices.map((level) => (
                  <RadioCard
                    key={level}
                    name={`${leadId}-level`}
                    value={level}
                    checked={chosen === level}
                    selected={chosen === level}
                    disabled={busy}
                    onChange={() => setChosen(level)}
                    title={level === rule.level ? `${CHOICE_LABEL[level]} (now)` : CHOICE_LABEL[level]}
                    description={CHOICE_HINT[level]}
                  />
                ))}
              </div>
              {ceilingNote(choices) && <p className="aq-auto-note">{ceilingNote(choices)}</p>}
              <p className="aq-auto-note">{AUTOMATE_NOTE}</p>

              {chosen === 'auto' && loaded.autonomy.paused && (
                <Banner tone="warning" title="Changes that run by rule are paused">{pauseSentence(loaded.autonomy)}</Banner>
              )}

              {chosen === 'auto' && (fields.length > 0 || fixed.length > 0) && (
                <section className="aq-auto-section" aria-labelledby={limitsId}>
                  <h3 className="aq-auto-h" id={limitsId}>Limits</h3>
                  <p className="aq-auto-note">A request outside these limits waits for you instead.</p>
                  {rule.limitsInvalid && <p className="aq-auto-note">The limits saved for this kind no longer fit it. Saving sets them again.</p>}
                  {fields.map((field) => {
                    const hint = [boundsHint(field), requestHint(field, row)].filter(Boolean).join(' · ')
                    const fromServer = test.state === 'failed' && test.field === field.key ? test.error : null
                    return (
                      <Field
                        key={field.key}
                        label={field.label}
                        htmlFor={`${fieldBase}-${field.key}`}
                        hint={hint || undefined}
                        error={errors[field.key] ?? fromServer ?? undefined}
                      >
                        <Input
                          id={`${fieldBase}-${field.key}`}
                          inputMode="decimal"
                          value={typed[field.key] ?? field.value}
                          disabled={busy}
                          onChange={(event) => setTyped((now) => ({ ...now, [field.key]: event.target.value }))}
                        />
                      </Field>
                    )
                  })}
                  {fixed.length > 0 && (
                    <KeyValue dense items={fixed.map((limit) => ({ label: limit.label, value: limit.value, hint: FIXED_LIMIT_HINT }))} />
                  )}
                </section>
              )}

              {chosen === 'auto' && (
                <section className="aq-auto-section" aria-labelledby={testId}>
                  <h3 className="aq-auto-h" id={testId}>Test against your last {TEST_DAYS} days</h3>
                  <div aria-live="polite">
                    {test.state === 'testing' && <p className="aq-auto-busy"><Spinner size={14} /> Testing these limits…</p>}
                    {test.state === 'idle' && fields.length > 0 && Object.keys(errors).length > 0 && (
                      <p className="aq-auto-note">Fix the limits above to test them.</p>
                    )}
                    {test.state === 'failed' && !test.field && <Banner tone="warning">{test.error}</Banner>}
                    {test.state === 'failed' && test.field && <p className="aq-auto-note">The test did not run: see the limit above.</p>}
                    {test.state === 'done' && <SimulationResult sim={test.sim} row={row} />}
                  </div>
                  <p className="aq-auto-sub">{TEST_NOTE}</p>
                </section>
              )}

              {approvable && (
                <Checkbox
                  label="Also approve this one"
                  checked={alsoApprove}
                  disabled={busy}
                  onChange={(event) => setAlsoApprove(event.target.checked)}
                />
              )}
            </>
          )}
        </div>
      </Modal>
      <StepUpModal
        open={!!pending}
        title={stepUp?.title ?? ''}
        sentence={stepUp?.sentence ?? ''}
        busy={busy}
        error={codeError}
        onSubmit={(code) => void submitCode(code)}
        onClose={() => setPending(null)}
        className={PORTAL}
      />
    </>
  )
}

function SimulationResult({ sim, row }: { sim: RuleSimulation; row: QueueRow }) {
  const words = simulationWords(sim, row)
  return (
    <>
      <p className="aq-auto-result">
        {words.headline}
        {words.rejected ? ` ${words.rejected}` : ''}
      </p>
      {sim.examples.length > 0 && (
        <ul className="aq-auto-examples" aria-label="Requests you rejected that would have run">
          {sim.examples.slice(0, 5).map((example) => {
            const { what, why } = exampleWords(example)
            return (
              <li key={example.id}>
                {what}
                <span className="aq-auto-example-why">{why}</span>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
