'use client'

import type { ReactNode } from 'react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { NS, type Words } from '../model'

/** The page's translate, and a `Words` said with it. */
export function useSay() {
  const t = useT(NS)
  const say = (words: Words | null | undefined): string => (words ? t(words.key, words.params) : '')
  return { t, say }
}

/** A card's title row with its actions. */
export function Head({ title, hint, action, level = 2 }: { title: string; hint?: ReactNode; action?: ReactNode; level?: 2 | 3 }) {
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <div className="fw-spd-head">
      <div className="fw-spd-head-text">
        <Heading className="fw-spd-title">{title}</Heading>
        {hint ? <p className="fw-spd-hint">{hint}</p> : null}
      </div>
      {action ? <div className="fw-spd-head-actions">{action}</div> : null}
    </div>
  )
}

/** Loading (skeletons in the card's shape, "Still loading…" said) or a failed read with Try again; never drawn as empty. */
export function ReadOr({ status, problem, title, onRetry, rows = 3, children }: { status: 'loading' | 'error' | 'ready'; problem?: string; title: string; onRetry?: () => void; rows?: number; children?: ReactNode }) {
  const { t } = useSay()
  if (status === 'error') {
    return (
      <EmptyState
        title={t('read.failed', { what: title })}
        description={t(problem ?? 'problem.unavailable')}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {t('read.retry')}
            </Button>
          ) : undefined
        }
      />
    )
  }
  if (status === 'loading') {
    return (
      <div className="fw-spd-loading" aria-busy="true">
        <p className="fw-spd-hint" role="status">
          <Spinner size={14} /> {t('read.loading')}
        </p>
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} height={18} />
        ))}
      </div>
    )
  }
  return <>{children}</>
}

/** A card of the record: padded, with its title row. */
export function DepthCard({ title, hint, action, children, label }: { title: string; hint?: ReactNode; action?: ReactNode; children?: ReactNode; label?: string }) {
  return (
    <Card padded>
      <section className="fw-spd-card" aria-label={label ?? title}>
        <Head title={title} hint={hint} action={action} />
        {children}
      </section>
    </Card>
  )
}
