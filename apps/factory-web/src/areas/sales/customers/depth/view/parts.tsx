'use client'

import type { ReactNode } from 'react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money } from '../../../../parties/_shared/model'
import { NS, type Notice, type Words } from '../model'

/** The page's translate, a `Words` said with it, and the page's dates and amounts. */
export function useSay() {
  const t = useT(NS)
  const locale = useLocale()
  const say = (words: Words | null | undefined): string => (words ? t(words.key, words.params) : '')
  const day = (value: string) => formatDate(value.length === 10 ? `${value}T12:00:00Z` : value, { locale })
  const when = (value: string) => formatDateTime(value, { locale })
  const amount = (minor: number, currency: string) => money(minor, currency, locale) ?? ''
  return { t, say, day, when, amount, locale }
}

/** A card's title row with its actions. */
export function Head({ title, hint, action, level = 2 }: { title: string; hint?: ReactNode; action?: ReactNode; level?: 2 | 3 }) {
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <div className="fw-cdp-head">
      <div className="fw-cdp-head-text">
        <Heading className="fw-cdp-title">{title}</Heading>
        {hint ? <p className="fw-cdp-hint">{hint}</p> : null}
      </div>
      {action ? <div className="fw-cdp-head-actions">{action}</div> : null}
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
      <div className="fw-cdp-loading" aria-busy="true">
        <p className="fw-cdp-hint" role="status">
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
      <section className="fw-cdp-card" aria-label={label ?? title}>
        <Head title={title} hint={hint} action={action} />
        {children}
      </section>
    </Card>
  )
}

/** A write's notice (done, or what went wrong), dismissible. */
export function NoticeLine({ notice, onDismiss }: { notice: Notice; onDismiss?: (() => void) | undefined }) {
  const { say } = useSay()
  if (!notice) return null
  return <Banner tone={notice.tone} title={say(notice.words)} onDismiss={onDismiss} />
}
