'use client'
/**
 * MCP full control C9 — a change plan on the Approvals page (section 05 §3.1): ONE card for up to 200 changes.
 *
 *   1  one summary sentence (Nexus wrote it from the steps), and why this person may not approve it, if so
 *   2  one tick per KIND of consequence ("120 × Set master price — reach a marketplace or a buyer; can be undone"):
 *      a person confirms each kind they are agreeing to, not each of 200 rows
 *   3  one list of the steps (PlanStepList): filter it, untick a step to leave it out. ONE tab stop: the arrow keys
 *      move between the steps' ticks, and the next Tab reaches the counted button (the 2026-10-02 browser check)
 *   4  ONE counted button: "Approve 137 changes"; with steps unticked, "Make a plan of the N ticked changes" first —
 *      the API re-checks the smaller plan as this person and the original is superseded (the AQ.8 amend rule)
 *
 * After Approve the row comes back parked, with the page's usual Undo and Hold (ParkedRow): "Done with Undo". The
 * API decides everything (change-plan.service.ts); this card never approves a step it was not shown.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Banner, Card, EmptyState, Field } from '@/design-system/components'
import { Button, Checkbox, Input, Pill } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { commandConflictMessage, sendCommand, useCommandKey } from '@/lib/command-key'
import { kindSentence, planButton, rovingTarget, STEP_STATUS, stepMatches, stepWhat, type PlanDetail, type PlanKind, type PlanStep } from './planWords'
import './planCard.css'

/** The plan's row in the outside list, as far as this card reads it. */
export interface PlanRow {
  id: string
  preview: Record<string, unknown> | null
  cannotApprove?: string | null
  plan: { summary: string | null; planHash: string | null; steps: number | null; kinds: PlanKind[] }
}

/**
 * The steps, one row each: the Keep tick, the step, the change, what it changes, where it lands, its fate.
 *
 * ONE tab stop (roving tabindex): the tick of the step last focused takes Tab, the others wait for the arrow keys
 * (rovingTarget), and the next Tab leaves the list. A NexusGrid here took Tab through every cell.
 */
export function PlanStepList({ steps, unticked, busy, onToggle }: {
  steps: PlanStep[]
  unticked: ReadonlySet<number>
  busy: boolean
  onToggle: (step: number) => void
}) {
  const [active, setActive] = useState(0)
  const ticks = useRef<Array<HTMLInputElement | null>>([])
  const base = useId()
  const current = Math.min(active, Math.max(steps.length - 1, 0))
  return (
    <div className="plan-steps">
      <div className="plan-steps-head" aria-hidden="true">
        <span>Keep</span><span>Step</span><span>Change</span><span>What it changes</span><span>Reaches</span><span>Status</span>
      </div>
      <ol
        className="plan-steps-list"
        aria-label="The steps of this plan. Arrow keys move between them; Space keeps or leaves out a step."
        onKeyDown={(event) => {
          const next = rovingTarget(event.key, current, steps.length)
          if (next === null) return
          event.preventDefault()
          setActive(next)
          ticks.current[next]?.focus()
        }}
      >
        {steps.map((step, index) => {
          const what = `${base}-${step.step}`
          return (
            <li key={step.step} className="plan-step">
              <span className="plan-step-keep">
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
              <span className="plan-step-no"><span className="plan-step-label">Step </span>{step.step}</span>
              <span className="plan-step-change">{step.title}</span>
              <span className="plan-step-what" id={what}>{stepWhat(step)}</span>
              <span className="plan-step-reach">
                {step.outbound ? <Pill tone="warning" size="sm">Marketplace or buyer</Pill> : <Pill tone="neutral" size="sm">Nexus only</Pill>}
              </span>
              <span className="plan-step-status">{STEP_STATUS[step.status] ?? step.status}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function PlanCard({
  approval,
  busy,
  onDecide,
  onChanged,
}: {
  approval: PlanRow
  busy: boolean
  onDecide: (id: string, decision: 'approve' | 'reject', reason?: string) => void
  /** The plan was replaced by a smaller one: the list is read again. */
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<PlanDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [unticked, setUnticked] = useState<Set<number>>(new Set())
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [amending, setAmending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const amendKey = useCommandKey()
  const filterId = useId()
  const waitingId = useId()

  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/agent/fleet/approvals/${encodeURIComponent(approval.id)}/plan`, { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!alive) return
        if (response.ok) setDetail(data as PlanDetail)
        else setLoadError((data as { error?: string }).error ?? 'The steps of this plan could not be read.')
      })
      .catch(() => alive && setLoadError('Nexus could not be reached. Try again in a moment.'))
    return () => { alive = false }
  }, [approval.id])

  const kinds = detail?.kinds?.length ? detail.kinds : approval.plan.kinds
  const total = detail?.steps ?? approval.plan.steps ?? 0
  const title = detail?.title || (typeof approval.preview?.title === 'string' ? approval.preview.title : 'A change plan')
  const summary = detail?.summary ?? approval.plan.summary
  const notYours = approval.cannotApprove ?? null
  const button = planButton({ total, kept: total - unticked.size, kinds, ticked, busy: busy || amending || !detail || notYours !== null })
  const shown = useMemo(() => (detail?.list ?? []).filter((step) => stepMatches(step, filter)), [detail, filter])

  const toggle = (step: number) => setUnticked((now) => {
    const next = new Set(now)
    if (next.has(step)) next.delete(step)
    else next.add(step)
    return next
  })

  const amend = async () => {
    if (!detail) return
    setAmending(true)
    setError(null)
    try {
      const keep = detail.list.map((step) => step.step).filter((step) => !unticked.has(step))
      // A keyed command: a press whose answer was lost replays the stored answer, never makes a second smaller plan.
      const { response, body, conflict } = await sendCommand<{ error?: string }>(
        amendKey,
        `${getBackendUrl()}/api/agent/fleet/approvals/${encodeURIComponent(approval.id)}/plan-amend`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep }) },
      )
      if (conflict) setError(commandConflictMessage(conflict, 'request for a smaller plan'))
      else if (!response.ok) setError(body?.error ?? 'The smaller plan could not be made.')
      else onChanged()
    } catch {
      setError('Nexus could not be reached. Try again in a moment.')
    } finally {
      setAmending(false)
    }
  }

  return (
    <Card header={title} description={summary ?? undefined} headingLevel={4} className="plan-card">
      <div className="plan-card-body">
        {notYours && <Banner tone="warning" title="You cannot approve this plan">{notYours} You can still reject it.</Banner>}
        {loadError && <Banner tone="danger">{loadError}</Banner>}

        <fieldset className="plan-kinds" disabled={busy || amending}>
          <legend>Tick each kind of change to approve it</legend>
          {kinds.map((kind) => (
            <Checkbox
              key={kind.tool}
              tone={kind.outbound || kind.reversibility === 'none' ? 'warning' : undefined}
              label={kindSentence(kind)}
              checked={ticked.has(kind.tool)}
              onChange={(event) => setTicked((now) => {
                const next = new Set(now)
                if (event.target.checked) next.add(kind.tool)
                else next.delete(kind.tool)
                return next
              })}
            />
          ))}
        </fieldset>

        <Field label="Filter the steps" hint="By step number, change or what it touches. Untick a step to leave it out." htmlFor={filterId}>
          <Input id={filterId} size="sm" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </Field>
        {detail ? (
          shown.length ? (
            <PlanStepList steps={shown} unticked={unticked} busy={busy || amending} onToggle={toggle} />
          ) : (
            <EmptyState title="No step matches" description="Clear the filter to see every step." />
          )
        ) : !loadError ? (
          <p className="plan-note" role="status">Reading the steps…</p>
        ) : null}

        {error && <Banner tone="danger" onDismiss={() => setError(null)}>{error}</Banner>}
        {button.waiting && <p className="plan-note" id={waitingId}>{button.waiting}</p>}
        <div className="plan-actions">
          <Button
            variant="primary"
            disabled={button.disabled}
            aria-describedby={button.waiting ? waitingId : undefined}
            onClick={() => (button.action === 'approve' ? onDecide(approval.id, 'approve') : void amend())}
          >
            {amending ? 'Checking the smaller plan…' : button.label}
          </Button>
          <Button variant="secondary" disabled={busy || amending} onClick={() => onDecide(approval.id, 'reject')}>
            Reject the plan
          </Button>
        </div>
        <p className="plan-note">
          After you approve, it waits a short undo window, then each step runs in order and is checked again first: a
          step whose facts moved meanwhile is skipped with its reason, and the others go on.
        </p>
      </div>
    </Card>
  )
}
