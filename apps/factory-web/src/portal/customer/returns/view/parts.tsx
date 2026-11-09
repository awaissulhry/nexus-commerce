'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, Lock, WifiOff } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useReturnWords } from '../words'

/**
 * Small parts of the Returns & claims views (B-W2b-197): the "not part of your access" panel (design noPermission), a
 * failed read in our words with Try again (never drawn as an empty list), a skeleton in the shape of the content with
 * "Still loading…" after about a second, and the offline line.
 */

export function NotInAccess({ admins, homeHref }: { admins: readonly string[]; homeHref: string }) {
  const { t } = useReturnWords()
  return (
    <div className="fw-pret">
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
  const { t } = useReturnWords()
  return (
    <div className="fw-pret-failed" role="alert">
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

/** A skeleton in the shape of the content; after about a second it says it is still loading. */
export function Loading({ rows = 3, height = 64, label }: { rows?: number; height?: number; label?: string }) {
  const { t } = useReturnWords()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fw-pret-loading" role="status" aria-busy="true" aria-label={label ?? t('state.loading')}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={height} />
      ))}
      {slow ? <p className="fw-pret-hint">{t('state.stillLoading')}</p> : null}
    </div>
  )
}

export function OfflineBanner({ since }: { since: string | null }) {
  const { t, time } = useReturnWords()
  if (!since) return null
  return <Banner tone="warning" icon={<WifiOff size={16} aria-hidden />} title={t('offline.title', { time: time(since) })} />
}

/** A record that could not be read, or is not the person's (it answers as one that does not exist). */
export function RecordGone({ kind, listHref, onRetry }: { kind: 'missing' | 'error'; listHref: string; onRetry?: () => void }) {
  const { t } = useReturnWords()
  return (
    <div className="fw-pret">
      <EmptyState
        icon={<AlertCircle size={24} aria-hidden />}
        title={kind === 'missing' ? t('record.missing') : t('record.failed')}
        description={kind === 'missing' ? t('record.missingBody') : t('record.failedBody')}
        action={
          kind === 'missing' ? (
            <Button asChild>
              <a href={listHref}>{t('record.toList')}</a>
            </Button>
          ) : (
            <Button onClick={() => onRetry?.()}>{t('state.retry')}</Button>
          )
        }
      />
    </div>
  )
}
