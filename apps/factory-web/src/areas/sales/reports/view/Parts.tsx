'use client'

import type { ReactNode } from 'react'
import { EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import type { Read } from './types'

export const NAMESPACE = 'sales-reports'

/** A panel's head: its title, what it says, and its own controls. */
export function Head({ id, title, hint, children }: { id: string; title: string; hint?: string | undefined; children?: ReactNode }) {
  return (
    <div className="fw-slr-head">
      <div className="fw-slr-head-text">
        <h2 className="fw-slr-h2" id={id}>
          {title}
        </h2>
        {hint ? <p className="fw-slr-hint">{hint}</p> : null}
      </div>
      {children ? <div className="fw-slr-head-controls">{children}</div> : null}
    </div>
  )
}

/** Loading: the panel's shape in skeletons (tile skeletons for the strip, the chart frame with its axes named for a chart). */
export function Shape({ chart = true, tiles = false, axes }: { chart?: boolean; tiles?: boolean; axes?: string | undefined }) {
  const t = useT(NAMESPACE)
  if (tiles) {
    return (
      <div className="fw-slr-tiles-shape" role="status" aria-label={t('common.loading')}>
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} height={84} radius={8} />
        ))}
      </div>
    )
  }
  return (
    <div className="fw-slr-shape" role="status" aria-label={t('common.loading')}>
      {chart ? <Skeleton height={200} radius={8} /> : null}
      {axes ? <p className="fw-slr-muted">{axes}</p> : null}
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

export function stateOf<T>(read: Read<T>, failedTitle: string, onRetry?: () => void, options: { chart?: boolean; tiles?: boolean; axes?: string } = {}): ReactNode | null {
  if (read.status === 'loading' || read.status === 'idle') return <Shape chart={options.chart ?? true} tiles={options.tiles ?? false} axes={options.axes} />
  if (read.status === 'error') return <Failed title={failedTitle} problem={read.problem} onRetry={onRetry} />
  return null
}

/** A text button that reads as a link and opens what a number counts. */
export function Opens({ label, onOpen, children }: { label: string; onOpen: () => void; children: ReactNode }) {
  return (
    <button type="button" className="fw-slr-cell-link" onClick={onOpen} aria-label={label}>
      {children}
    </button>
  )
}
