'use client'

/**
 * Approvals grid — a change plan in the drawer (build agent D2, 2026-10-05; PLAN §6).
 *
 * Reads GET /api/agent/fleet/approvals/:id/plan (its shape and words: `planWords.ts`), built on the design
 * system only:
 *   - one sentence per KIND of change ("120 × Set master price — reach a marketplace or a buyer; can be undone");
 *   - while it runs, "34 of 120 steps done" (DS JobProgress), re-read whenever the plan's counts move;
 *   - the steps as a LIST, never a grid, and ONE tab stop (the 2026-10-02 rule, settings/ai/claude/claudePage.vitest
 *     .test.ts): while the plan waits, the arrow keys move between the steps' Keep ticks; after that the list is
 *     read-only and itself the one stop, so its scroll area is reachable by keyboard;
 *   - "Keep only these N steps": POST …/plan-amend { keep } makes a smaller plan, re-checked by the API as this person;
 *     the original is replaced and the drawer moves to the new one.
 */
import { useId, useMemo, useRef, useState } from 'react'
import type { QueueDetail } from '@nexus/shared/approval-queue'
import { Banner, EmptyState, Field, JobProgress, ProgressBar } from '@/design-system/components'
import { Button, Checkbox, Input, Pill } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { commandConflictMessage, sendCommand, useCommandKey } from '@/lib/command-key'
import { STEP_STATUS, kindSentence, rovingTarget, stepMatches, stepWhat, type PlanStep } from './planWords'
import { planProgress } from './drawerWords'
import { usePlanDetail } from './useApprovalDetail'
import styles from './ApprovalDrawer.module.css'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The steps, one row each. `editable`: a Keep tick per step, one tab stop (roving); otherwise the list is the stop. */
export function PlanStepsList({ steps, editable, unticked, busy, onToggle }: {
  steps: PlanStep[]
  editable: boolean
  unticked: ReadonlySet<number>
  busy: boolean
  onToggle: (step: number) => void
}) {
  const [active, setActive] = useState(0)
  const ticks = useRef<Array<HTMLInputElement | null>>([])
  const base = useId()
  const current = Math.min(active, Math.max(steps.length - 1, 0))
  return (
    <ol
      className={styles.steps}
      aria-label={editable ? 'The steps of this plan. Arrow keys move between them; Space keeps or leaves out a step.' : 'The steps of this plan'}
      tabIndex={editable ? undefined : 0}
      onKeyDown={editable ? (event) => {
        const next = rovingTarget(event.key, current, steps.length)
        if (next === null) return
        event.preventDefault()
        setActive(next)
        ticks.current[next]?.focus()
      } : undefined}
    >
      {steps.map((step, index) => {
        const what = `${base}-${step.step}`
        const fate = STEP_STATUS[step.status] ?? step.status
        return (
          <li key={step.step} className={styles.step}>
            {editable && (
              <span className={styles.stepKeep}>
                <Checkbox
                  ref={(element) => { ticks.current[index] = element }}
                  aria-label={`Keep step ${step.step}`}
                  aria-describedby={what}
                  tabIndex={index === current ? 0 : -1}
                  checked={!unticked.has(step.step)}
                  disabled={busy}
                  onFocus={() => setActive(index)}
                  onChange={() => onToggle(step.step)}
                />
              </span>
            )}
            <span className={styles.stepMain}>
              <span className={styles.stepHead}>
                <span className={styles.stepNo}>Step {step.step}</span>
                <span className={styles.stepTitle}>{step.title}</span>
                {step.outbound ? <Pill tone="warning" size="sm">Marketplace or buyer</Pill> : <Pill tone="neutral" size="sm">Nexus only</Pill>}
                <span className={styles.stepFate}>{fate}</span>
              </span>
              <span className={styles.text} id={what}>{stepWhat(step)}</span>
              {step.reason && (step.status === 'skipped' || step.status === 'failed') && (
                <span className={styles.muted}>{step.status === 'failed' ? 'Why it failed' : 'Why it was skipped'}: {step.reason}</span>
              )}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function PlanSection({ detail, busy, onReplaced }: {
  detail: QueueDetail
  /** A decision on this row is in flight: no smaller plan meanwhile. */
  busy: boolean
  /** The smaller plan replaced this one: show the new request. */
  onReplaced: (newId: string) => void
}) {
  // Re-read the steps only when the plan moved (its state or its step counts), not on every queue poll.
  const signature = `${detail.state}|${detail.rawStatus}|${JSON.stringify(detail.plan?.byStatus ?? {})}`
  const { state, reload } = usePlanDetail(detail.id, signature)
  const [unticked, setUnticked] = useState<Set<number>>(() => new Set())
  const [filter, setFilter] = useState('')
  const [amending, setAmending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const amendKey = useCommandKey()
  const filterId = useId()

  const plan = state.kind === 'ready' ? state.plan : null
  const list = useMemo(() => plan?.list ?? [], [plan])
  const shown = useMemo(() => list.filter((step) => stepMatches(step, filter)), [list, filter])
  // Only a plan nobody decided can be made smaller (the API's own rule: "only a waiting plan can be edited").
  const editable = detail.rawStatus === 'pending' && !!plan
  const total = plan?.steps ?? detail.plan?.steps ?? 0
  const kept = list.length - [...unticked].filter((step) => list.some((s) => s.step === step)).length
  const counts = detail.plan ?? (plan ? { steps: plan.steps, byStatus: plan.byStatus } : null)
  const progress = counts ? planProgress(counts) : null
  const started = progress ? progress.value > 0 || detail.state === 'running' : false

  const toggle = (step: number) => setUnticked((now) => {
    const next = new Set(now)
    if (next.has(step)) next.delete(step)
    else next.add(step)
    return next
  })

  const keepOnly = async () => {
    if (!plan) return
    setAmending(true)
    setError(null)
    try {
      const keep = plan.list.map((step) => step.step).filter((step) => !unticked.has(step))
      // A keyed command: a press whose answer was lost replays the stored answer, never makes a second smaller plan.
      const { response, body, conflict } = await sendCommand<{ error?: string; approvalId?: string }>(
        amendKey,
        `${getBackendUrl()}/api/agent/fleet/approvals/${encodeURIComponent(detail.id)}/plan-amend`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep }) },
      )
      if (conflict) setError(commandConflictMessage(conflict, 'request for a smaller plan'))
      else if (!response.ok) setError(body?.error ?? 'The smaller plan could not be made.')
      else if (body?.approvalId) {
        setUnticked(new Set())
        onReplaced(body.approvalId)
      } else reload()
    } catch {
      setError('Nexus could not be reached. Try again in a moment.')
    } finally {
      setAmending(false)
    }
  }

  return (
    <section className={styles.section} aria-labelledby={`${filterId}-title`}>
      <h3 id={`${filterId}-title`} className={styles.sectionTitle}>{total ? `The plan: ${plural(total, 'step')}` : 'The plan'}</h3>
      {plan?.summary && <p className={styles.text}>{plan.summary}</p>}

      {progress && started && (
        <JobProgress
          label="Steps"
          value={progress.value}
          max={progress.max}
          detail={progress.words}
          note={detail.state === 'running' ? 'This updates by itself. You can close it.' : undefined}
        />
      )}

      {plan && plan.kinds.length > 0 && (
        <ul className={styles.kinds} aria-label="Kinds of change in this plan">
          {plan.kinds.map((kind) => <li key={kind.tool}>{kindSentence(kind)}</li>)}
        </ul>
      )}

      {state.kind === 'loading' && <ProgressBar indeterminate ariaLabel="Reading the steps of this plan" />}
      {state.kind === 'error' && (
        <Banner tone="danger" title="The steps could not be read." action={<Button size="sm" onClick={reload}>Try again</Button>}>{state.message}</Banner>
      )}
      {state.kind === 'ready' && state.stale && (
        <Banner tone="warning" title="Showing the steps Nexus read last." action={<Button size="sm" onClick={reload}>Try again</Button>}>
          The newest read failed: {state.stale}
        </Banner>
      )}

      {plan && list.length > 10 && (
        <Field label="Filter the steps" hint={editable ? 'By step number, change or what it touches. Untick a step to leave it out.' : 'By step number, change or what it touches.'} htmlFor={filterId}>
          <Input id={filterId} size="sm" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </Field>
      )}
      {plan && (shown.length
        ? <PlanStepsList steps={shown} editable={editable} unticked={unticked} busy={busy || amending} onToggle={toggle} />
        : <EmptyState title={list.length ? 'No step matches' : 'This plan has no steps'} description={list.length ? 'Clear the filter to see every step.' : undefined} />)}
      {plan && list.length < total && (
        <p className={styles.muted}>Showing the first {list.length} of {plural(total, 'step')}.</p>
      )}

      {error && <Banner tone="danger" title="No smaller plan was made" onDismiss={() => setError(null)}>{error}</Banner>}
      {editable && unticked.size > 0 && (
        <div className={styles.actions}>
          <Button size="md" disabled={busy || amending || kept === 0} onClick={() => void keepOnly()}>
            {amending ? 'Checking the smaller plan…' : `Keep only these ${plural(kept, 'step')}`}
          </Button>
          <Button size="md" variant="quiet" disabled={amending} onClick={() => setUnticked(new Set())}>Keep every step</Button>
          <p className={styles.muted}>
            {kept === 0
              ? 'Keep at least one step, or reject the plan.'
              : 'Nexus checks the smaller plan as you, then it replaces this one. You approve the new plan.'}
          </p>
        </div>
      )}
    </section>
  )
}
