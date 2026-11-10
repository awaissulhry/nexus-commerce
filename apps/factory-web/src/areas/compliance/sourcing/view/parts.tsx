'use client'

import { useMemo, type ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import { Card, EmptyState, ProgressBar } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import type { ClaimState } from '@nexus/factory-domain/compliance/claims/rules'
import { Modal, StepUpModal } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import type { StepUpState } from '../../../quality/_shared/hooks'
import type { ValidityRead } from '../api'
import { STATE_TONE } from '../model'

/**
 * View parts every SCR-215 view shares (B-W2b-264): the catalogues (`compliance-sourcing`, the list frame's `lists`, `quality`
 * for the step-up dialog's words), the words hook, a day in words, a section's loading (its shape, "Still loading…" after a
 * second) and failed states (our words + Try again, never an empty list), the state pill, the validity bar (a composition: the
 * DS has no ValidityBar yet), the step-up dialog and the keys list behind `?`.
 */

export const SOURCING_NAMESPACES = ['compliance-sourcing', 'lists', 'quality'] as const

/** The page's words (`compliance-sourcing`). */
export function useWords(): Translate {
  const t = useT('compliance-sourcing')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

/** A day (`YYYY-MM-DD`) in the page's language. */
export function useDay(): (day: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (day) => (day ? formatDate(`${day.slice(0, 10)}T12:00:00Z`, { locale }) : '—'), [locale])
}

/** A language's name in the page's language ("Italiano", "English", "Deutsch"), else its tag. */
export function languageName(tag: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(tag)
    return name ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : tag
  } catch {
    return tag
  }
}

/** A section loading in its own shape; "Still loading…" shows by itself after about a second (CSS, no timer). */
export function SectionLoading({ rows = 4, height = 30 }: { rows?: number; height?: number }) {
  const t = useWords()
  return (
    <div className="fw-sc-loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? height + 4 : height} />
      ))}
      <span className="fw-sc-slow" role="status">
        {t('common.stillLoading')}
      </span>
    </div>
  )
}

/** A failed read: said in our words with Try again (a missing right says so and offers nothing). */
export function SectionFailed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: (() => void) | undefined }) {
  const t = useWords()
  const forbidden = problem === 'problem.forbidden' || problem === 'problem.signedOut'
  return (
    <EmptyState
      title={title}
      description={t(problem)}
      action={
        forbidden ? undefined : (
          <Button size="sm" onClick={() => onRetry?.()}>
            {t('common.retry')}
          </Button>
        )
      }
    />
  )
}

/** No compliance.certificates.view: the page says so, names the right and who grants it, and reads nothing. */
export function NoSourcingAccess() {
  const t = useWords()
  return (
    <Card padded>
      <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('access.title')} description={t('access.body')} />
    </Card>
  )
}

/** A section's heading row: the title, a note, and its own controls. */
export function SectionHead({ id, title, note, children }: { id: string; title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="fw-sc-head">
      <span className="fw-sc-head-title">
        <h2 id={id} className="fw-sc-h" tabIndex={-1}>
          {title}
        </h2>
        {note ? <span className="fw-sc-muted">{note}</span> : null}
      </span>
      {children ? <span className="fw-sc-tools">{children}</span> : null}
    </div>
  )
}

/** A claim's state as a pill with its word (never colour alone). */
export function StatePill({ state }: { state: ClaimState }) {
  const t = useWords()
  return (
    <Pill tone={STATE_TONE[state]} dot>
      {t(`state.${state}`)}
    </Pill>
  )
}

const BAR_TONE = { NONE: 'unknown', OK: 'complete', SOON: 'partial', EXPIRED: 'missing' } as const

/**
 * ValidityBar (design part, not in the DS yet: composed here from the DS ProgressBar): until when the evidence holds, in words
 * ("312 days left", "Expired 9 days ago", "No end"), with the share of the span used up to today and the 180 / 90 / 30-day
 * thresholds as the bar's tone. `mini` for a grid cell: the words and a thin bar.
 */
export function ValidityBar({ validity, until, from, today, mini = false }: { validity: ValidityRead; until: string | null; from?: string | null; today: string; mini?: boolean }) {
  const t = useWords()
  const day = useDay()
  const words =
    validity.state === 'NONE'
      ? t('validity.none')
      : validity.state === 'EXPIRED'
        ? t('validity.expired', { count: Math.abs(validity.daysLeft ?? 0), date: day(until) })
        : t('validity.left', { count: validity.daysLeft ?? 0, date: day(until) })
  let value: number | null = null
  if (until && from) {
    const span = Date.parse(`${until}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)
    const used = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)
    value = span > 0 ? Math.max(0, Math.min(100, (used / span) * 100)) : 100
  } else if (validity.state === 'EXPIRED') value = 100
  return (
    <span className={mini ? 'fw-sc-validity fw-sc-validity-mini' : 'fw-sc-validity'}>
      <span className={validity.state === 'EXPIRED' ? 'fw-sc-danger-text' : undefined}>{words}</span>
      {validity.state !== 'NONE' && <ProgressBar ariaLabel={words} value={value} tone={BAR_TONE[validity.state]} height={mini ? 4 : 7} />}
      {!mini && validity.threshold !== null && <span className="fw-sc-muted">{t('validity.threshold', { days: validity.threshold })}</span>}
    </span>
  )
}

/** The page's own keys, then the list frame's. */
export const PAGE_KEYS = (t: Translate): ListKey[] => [
  { keys: ['c'], does: t('keys.add') },
  { keys: ['J', 'K'], does: t('keys.moves') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** `?` and the footer's "All shortcuts": every key of the page. */
export function KeysModal({ onClose }: { onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-sc-list">
        {listKeys(PAGE_KEYS(t)).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/** The DS step-up dialog: what the code allows (approving a claim), the shared quality words for the rest. */
export function SourcingStepUp({ state, onSubmit, onCancel }: { state: StepUpState; onSubmit?: ((code: string) => void) | undefined; onCancel?: (() => void) | undefined }) {
  const t = useWords()
  const q = useT('quality')
  if (!state.open) return null
  return (
    <StepUpModal
      open
      title={q('stepUp.title')}
      sentence={state.sentence ? t(state.sentence) : ''}
      busy={state.busy}
      error={state.problem ? q(state.problem) : null}
      onSubmit={(code) => onSubmit?.(code)}
      onClose={() => onCancel?.()}
      confirmLabel={t('approve.do')}
    />
  )
}
