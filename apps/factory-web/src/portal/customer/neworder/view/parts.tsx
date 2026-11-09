'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, Lock } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useOrderingWords } from '../words'
import '../neworder.css'

/**
 * Small parts New order & reorder and the Catalogue share (B-W2b-194): the "not part of your access" panel (design
 * noPermission: their own admin to ask, and Home), a failed read in our words with Try again (never drawn as an empty
 * list), a skeleton in the shape of the content with "Still loading…" after about a second, and the quiet line for a role
 * without prices.
 */

export function NotInAccess({ admins, homeHref }: { admins: readonly string[]; homeHref: string }) {
  const { t } = useOrderingWords()
  return (
    <div className="fw-pno">
      <EmptyState
        icon={<Lock size={24} aria-hidden />}
        title={t('noAccess.title')}
        description={admins.length > 0 ? t('noAccess.ask', { names: admins.join(', ') }) : t('noAccess.askAdmin')}
        action={
          <Button asChild>
            <a href={homeHref}>{t('noAccess.home')}</a>
          </Button>
        }
      />
    </div>
  )
}

export function ReadFailed({ title, onRetry }: { title: string; onRetry?: () => void }) {
  const { t } = useOrderingWords()
  return (
    <div className="fw-pno-failed" role="alert">
      <AlertCircle size={18} aria-hidden />
      <span>{title}</span>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          {t('state.retry')}
        </Button>
      ) : null}
    </div>
  )
}

/** A skeleton in the shape of the content (cards or rows); after about a second it says it is still loading. */
export function Loading({ rows = 3, height = 64, label, cards = false }: { rows?: number; height?: number; label?: string; cards?: boolean }) {
  const { t } = useOrderingWords()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className={cards ? 'fw-pno-loading fw-pno-loading-cards' : 'fw-pno-loading'} role="status" aria-busy="true" aria-label={label ?? t('state.loading')}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={height} />
      ))}
      {slow ? <p className="fw-pno-hint">{t('state.stillLoading')}</p> : null}
    </div>
  )
}

export function PricesNote() {
  const { t } = useOrderingWords()
  return <p className="fw-pno-quiet">{t('prices.none')}</p>
}
