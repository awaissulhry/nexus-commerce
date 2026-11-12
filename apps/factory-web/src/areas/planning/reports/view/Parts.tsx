'use client'

import type { ReactNode } from 'react'
import { EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import type { Read } from './types'

export const NAMESPACE = 'planning-reports'

/** A panel's head: its title, what it says, and its own controls. */
export function Head({ id, title, hint, children }: { id: string; title: string; hint?: string | undefined; children?: ReactNode }) {
  return (
    <div className="fw-plr-head">
      <div className="fw-plr-head-text">
        <h2 className="fw-plr-h2" id={id}>
          {title}
        </h2>
        {hint ? <p className="fw-plr-hint">{hint}</p> : null}
      </div>
      {children ? <div className="fw-plr-head-controls">{children}</div> : null}
    </div>
  )
}

/** Loading: the panel's shape in skeletons, the chart frame with its axes named (design "Skeleton chart frame"). */
export function Shape({ chart = true, axes }: { chart?: boolean; axes?: string | undefined }) {
  const t = useT(NAMESPACE)
  return (
    <div className="fw-plr-shape" role="status" aria-label={t('common.loading')}>
      {chart ? <Skeleton height={200} radius={8} /> : null}
      {axes ? <p className="fw-plr-muted">{axes}</p> : null}
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} height={20} />
      ))}
    </div>
  )
}

/** The panel failed: what failed in words, and Try again; the other panels stay (never drawn as empty). */
export function Failed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: (() => void) | undefined }) {
  const t = useT(NAMESPACE)
  return (
    <EmptyState
      title={title}
      description={t(problem)}
      action={
        <Button size="sm" onClick={() => onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  )
}

export function stateOf<T>(read: Read<T>, failedTitle: string, onRetry?: () => void, options: { chart?: boolean; axes?: string } = {}): ReactNode | null {
  if (read.status === 'loading' || read.status === 'idle') return <Shape chart={options.chart ?? true} axes={options.axes} />
  if (read.status === 'error') return <Failed title={failedTitle} problem={read.problem} onRetry={onRetry} />
  return null
}
