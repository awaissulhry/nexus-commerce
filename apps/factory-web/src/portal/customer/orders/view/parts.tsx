'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { AlertCircle, Lock } from 'lucide-react'
import { EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useOrderWords } from '../words'

/**
 * Small parts of the Orders & tracking views (B-W2b-191): the "not part of your access" panel (design noPermission), a
 * failed read in our words with Try again (never drawn as an empty list), a skeleton in the shape of the content with
 * "Still loading…" after about a second, the quiet line for a role without prices, and the size run of a line (composed:
 * the DS SizeGridView shows one measure per size; a line's ordered / shipped / open per size, or its production stages
 * per size, is several — anatomy D25, named in the step's notes).
 */

export function NotInAccess({ admins, homeHref }: { admins: readonly string[]; homeHref: string }) {
  const { t } = useOrderWords()
  return (
    <div className="fw-pord">
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
  const { t } = useOrderWords()
  return (
    <div className="fw-pord-failed" role="alert">
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
  const { t } = useOrderWords()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fw-pord-loading" role="status" aria-busy="true" aria-label={label ?? t('state.loading')}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={height} />
      ))}
      {slow ? <p className="fw-pord-hint">{t('state.stillLoading')}</p> : null}
    </div>
  )
}

export function PricesNote() {
  const { t } = useOrderWords()
  return <p className="fw-pord-quiet">{t('prices.none')}</p>
}

export interface SizeRun {
  /** The column heads after "Size". */
  heads: readonly string[]
  rows: readonly { size: string; cells: readonly ReactNode[] }[]
}

/** A line's sizes, one row each (a phone stacks them). */
export function SizeRunTable({ label, run }: { label: string; run: SizeRun }) {
  const { t } = useOrderWords()
  return (
    <SummaryTable
      label={label}
      columns={[t('sizes.size'), ...run.heads]}
      rows={run.rows.map((row) => ({ id: row.size, cells: [row.size, ...row.cells] }))}
      align={[undefined, ...run.heads.map(() => 'right' as const)]}
      stackOnPhone
    />
  )
}
