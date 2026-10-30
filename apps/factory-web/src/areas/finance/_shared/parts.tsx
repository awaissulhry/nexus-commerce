'use client'

import type { KeyboardEvent, ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Circle, Clock, MinusCircle } from 'lucide-react'
import { Banner, Card, EmptyState, Modal } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import type { JourneyStep, Phrase, StepState } from './model'

/**
 * The Finance screens' small shared parts, composed from the design system (packages/ui is frozen; each part named here is
 * a stand-in for a part the design asks and the DS lacks): PartState (a part that loads or failed, never drawn as
 * empty), DialogFrame (a DS Modal with the confirm footer, ⌘↵), StepIcon, JourneyStrip (the design's "JourneyStrip"),
 * CheckList (the design's "NEW CheckList"), Bridge (the design's "NEW Bridge": from goods to what is left to pay).
 */

/** A part a tab reads, while it loads or when its read failed (with Try again). */
export function PartState({ problem, onRetry, label }: { problem: string | null; onRetry?: () => void; label: string }) {
  const t = useT('finance')
  if (problem) {
    return (
      <Card padded>
        <EmptyState
          title={t('part.failed', { part: label })}
          description={t(problem)}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        />
      </Card>
    )
  }
  return (
    <Card padded aria-busy="true">
      <p className="fw-fin-hint" role="status">
        <Spinner size={14} /> {t('part.loading', { part: label })}
      </p>
    </Card>
  )
}

/** ⌘↵ inside a dialog's form confirms it when nothing holds it. */
const confirmKeys = (held: string | null, go: () => void) => (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
    event.preventDefault()
    go()
  }
}

/** A dialog: its words, a refusal said inside it, Cancel and the primary (held with its reason); a done state with Done. */
export function DialogFrame({
  title,
  held,
  go,
  goLabel,
  onClose,
  children,
  problem,
  size = 'md',
  tone = 'primary',
  done,
}: {
  title: string
  held: string | null
  go: () => void
  goLabel: string
  onClose: () => void
  children: ReactNode
  problem?: Phrase | null
  size?: 'sm' | 'md' | 'lg'
  tone?: 'primary' | 'danger'
  done?: ReactNode
}) {
  const t = useT('finance')
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size={size}
      footer={
        done ? (
          <>
            <span className="grow" />
            <Button size="sm" variant="primary" onClick={onClose}>
              {t('common.done')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant={tone} heldReason={held} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
              {goLabel}
            </Button>
          </>
        )
      }
    >
      <form
        className="fw-fin-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held && !done) go()
        }}
        onKeyDown={done ? undefined : confirmKeys(held, go)}
      >
        {problem ? <Banner tone="danger" title={t(problem.key, problem.params)} /> : null}
        {done ?? children}
      </form>
    </Modal>
  )
}

export function StepIcon({ state }: { state: StepState }) {
  if (state === 'done') return <CheckCircle2 size={16} className="fw-fin-ico is-ok" aria-hidden />
  if (state === 'current') return <Clock size={16} className="fw-fin-ico is-waiting" aria-hidden />
  if (state === 'problem') return <AlertTriangle size={16} className="fw-fin-ico is-blocked" aria-hidden />
  if (state === 'skipped') return <MinusCircle size={16} className="fw-fin-ico" aria-hidden />
  return <Circle size={16} className="fw-fin-ico" aria-hidden />
}

/** The journey of an invoice (design "JourneyStrip"): each step's state in words for a screen reader too. */
export function JourneyStrip({ steps, words }: { steps: readonly JourneyStep[]; words: (step: JourneyStep) => string }) {
  const t = useT('finance')
  return (
    <ol className="fw-fin-journey" aria-label={t('journey.label')}>
      {steps.map((step, index) => (
        <li key={step.key} className={`fw-fin-journey-step is-${step.state}`}>
          {index > 0 && (
            <span className="fw-fin-journey-sep" aria-hidden>
              ›
            </span>
          )}
          <StepIcon state={step.state} />
          <span>{words(step)}</span>
          <span className="nds-vh">{t(`journey.state.${step.state}`)}</span>
        </li>
      ))}
    </ol>
  )
}

export interface CheckItem {
  id: string
  ok: boolean
  words: ReactNode
  fix?: ReactNode
}

/** The checks before an action (design "CheckList"): what passes, what fails with where to fix it. */
export function CheckList({ items, label }: { items: readonly CheckItem[]; label: string }) {
  return (
    <ul className="fw-fin-checks" aria-label={label}>
      {items.map((item) => (
        <li key={item.id} className="fw-fin-check">
          <StepIcon state={item.ok ? 'done' : 'problem'} />
          <span className="fw-fin-step-body">{item.words}</span>
          {item.fix}
        </li>
      ))}
    </ul>
  )
}

/** From goods to what is left to pay, step by step (design "Bridge"). */
export function Bridge({ rows, label }: { rows: ReadonlyArray<{ id: string; label: ReactNode; value: ReactNode; total?: boolean }>; label: string }) {
  return (
    <dl className="fw-fin-bridge" aria-label={label}>
      {rows.map((row) => (
        <div key={row.id} className="fw-fin-bridge-row">
          <dt className={row.total ? 'is-total' : undefined}>{row.label}</dt>
          <dd className={row.total ? 'is-total' : undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}
