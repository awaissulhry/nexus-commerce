'use client'

/**
 * Negative Targeting page, Rules view — three small parts the detail's tabs share (2026-10-11): a chip whose meaning is
 * on hover and focus, the reading lines, and "X not read" with Try again (audit M4: a failed read says so, never "none").
 */
import { Button, Skeleton, Tag, Tooltip } from '@/design-system/primitives'
import { Banner } from '@/design-system/components'
import { readError } from './wasteRulesModel'
import styles from './rules.module.css'

/** A chip whose meaning is on hover and focus (a hold: its label, and its reason). */
export function HintTag({ label, hint, tone = 'neutral' }: { label: string; hint: string; tone?: 'neutral' | 'warning' | 'info' }) {
  return <Tooltip label={hint} portal><span tabIndex={0} aria-label={`${label}: ${hint}`}><Tag tone={tone}>{label}</Tag></span></Tooltip>
}

export function Loading({ label = 'Reading' }: { label?: string }) {
  return <div className={styles.stack} aria-busy="true" aria-label={label}><Skeleton height={16} /><Skeleton height={16} /><Skeleton height={16} /></div>
}

/** "X not read" with Try again; the server's own sentence under it when it said one (never a bare HTTP code). */
export function NotRead({ what, error, onRetry }: { what: string; error: string; onRetry?: () => void }) {
  return (
    <Banner tone="danger" title={`${what} not read`} action={onRetry ? <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button> : undefined}>
      {readError(error)}
    </Banner>
  )
}
