'use client'

import Link from 'next/link'
import { CheckCircle2, Circle, CircleAlert, CircleDashed, Clock } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'

export type SetupState = 'done' | 'needs' | 'waiting' | 'blocked' | 'unknown' | 'failed' | 'checking'

export interface SetupStep {
  id: string
  /** Message keys of `admin`. */
  name: string
  state: SetupState
  /** The fact the state comes from, in words (a message key with its values). */
  detail: { key: string; params?: Readonly<Record<string, string | number>>; /** A right's message key, drawn as `{need}`. */ need?: string }
  /** About how long it takes, minutes. */
  minutes: number
  /** Where it is done; absent while its page is not built yet. */
  href?: string
}

const TONE = { done: 'success', needs: 'warning', waiting: 'info', blocked: 'danger', unknown: 'neutral', failed: 'danger', checking: 'neutral' } as const
const ICON = { done: CheckCircle2, needs: CircleAlert, waiting: Clock, blocked: CircleAlert, unknown: CircleDashed, failed: CircleAlert, checking: Circle } as const

/**
 * SetupChecklist — the design's new DS part (02 "New DS parts": ordered steps with a live state from real checks, the
 * time each takes and a 'Do it' link), built here from DS Card, Pill and Button until the DS adds it (DS gap). Each
 * step's state is a fact read from the API ("Done", "Needs you", "Waiting for …", "Blocked by …"), never a tick box.
 */
export function SetupChecklist({ steps, title, onRetry }: { steps: readonly SetupStep[]; title: string; onRetry?: (id: string) => void }) {
  const t = useT('admin')
  return (
    <Card header={title} headingLevel={2} className="fw-adm-checklist">
      <ol className="fw-adm-steps">
        {steps.map((step, index) => {
          const Icon = ICON[step.state]
          return (
            <li key={step.id} className={`fw-adm-step is-${step.state}`}>
              <span className="fw-adm-step-icon" aria-hidden>
                <Icon size={18} />
              </span>
              <span className="fw-adm-step-body">
                <span className="fw-adm-step-line">
                  <span className="fw-adm-step-name">
                    <span className="fw-adm-sr">{t('overview.stepNumber', { n: index + 1 })} </span>
                    {t(step.name)}
                  </span>
                  <Pill tone={TONE[step.state]}>{t(`overview.state.${step.state}`)}</Pill>
                </span>
                <span className="fw-adm-step-detail">{t(step.detail.key, { ...step.detail.params, ...(step.detail.need ? { need: t(step.detail.need) } : {}) })}</span>
                <span className="fw-adm-step-meta">{t('overview.minutes', { count: step.minutes })}</span>
              </span>
              <span className="fw-adm-step-go">
                {step.state === 'failed' && onRetry ? (
                  <Button size="sm" onClick={() => onRetry(step.id)}>
                    {t('common.retry')}
                  </Button>
                ) : step.state !== 'done' && step.href ? (
                  <Button size="sm" variant={step.state === 'needs' ? 'primary' : 'secondary'} asChild>
                    <Link href={step.href}>
                      {t('overview.doIt')}
                      <span className="fw-adm-sr"> {t(step.name)}</span>
                    </Link>
                  </Button>
                ) : step.state === 'done' && step.href ? (
                  <Button size="sm" variant="quiet" asChild>
                    <Link href={step.href}>
                      {t('overview.open')}
                      <span className="fw-adm-sr"> {t(step.name)}</span>
                    </Link>
                  </Button>
                ) : null}
              </span>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}
