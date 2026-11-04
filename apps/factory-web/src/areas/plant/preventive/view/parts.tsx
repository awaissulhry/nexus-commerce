'use client'

import { useMemo, type ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import type { CheckIntervalUnit, CheckOutcome } from '@nexus/factory-domain/plant/statutory/rules'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { CALENDAR_VIEW_NAMESPACES } from '../../_shared/calendar/CalendarView'
import type { TypeBrief } from '../api'
import { intervalWords, OUTCOME_TONE, type Problem } from '../model'

/**
 * View parts every SCR-266 view shares (B-W2b-142): the catalogues (`plant-preventive`, the list frame's `lists`, `shell`
 * for the site chip, the calendar part's own), the words hook, a day in words, a section's loading (its shape, "Still
 * loading…" after a second) and failed states (our words + Try again, never an empty list), a check's law as the DS
 * LawRef, an outcome's pill, an interval in words, the keys list behind `?`.
 */

export const PREVENTIVE_NAMESPACES = ['plant-preventive', 'lists', 'shell', ...CALENDAR_VIEW_NAMESPACES] as const

/** The page's words (`plant-preventive`). */
export function useWords(): Translate {
  const t = useT('plant-preventive')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

/** A day (`YYYY-MM-DD`) in the page's language. */
export function useDay(): (day: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (day) => (day ? formatDate(`${day.slice(0, 10)}T12:00:00Z`, { locale }) : '—'), [locale])
}

/** A moment (an ISO time) in the page's language and the site's zone. */
export function useMoment(): (at: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (at) => (at ? formatDateTime(at, { locale }) : '—'), [locale])
}

/** A refusal's or a problem's words. */
export const problemText = (t: Translate, problem: Problem | null): string | null => (problem ? t(problem.key) : null)

/** An interval in words ("Every 3 months"). */
export const intervalText = (t: Translate, interval: number, unit: CheckIntervalUnit): string => {
  const words = intervalWords(interval, unit)
  return t(words.key, words.params)
}

/** A section loading in its own shape; "Still loading…" shows by itself after about a second (CSS, no timer). */
export function SectionLoading({ rows = 4, height = 30 }: { rows?: number; height?: number }) {
  const t = useWords()
  return (
    <div className="fw-pv-loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? height + 4 : height} />
      ))}
      <span className="fw-pv-slow" role="status">
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

/** No plant.view: the page says so and reads nothing. */
export function NoPlantView() {
  const t = useWords()
  return (
    <Card padded>
      <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('access.title')} description={t('access.body')} />
    </Card>
  )
}

/** A check's law (the type's legal basis, as Plant settings keeps it) as the DS LawRef, with how long results are kept. */
export function CheckLaw({ type, say: own }: { type: Pick<TypeBrief, 'legalBasis' | 'keptYears'>; say?: Translate }) {
  const fallback = useWords()
  const t = own ?? fallback
  const ds = useDsWords()
  return <LawRef law={type.legalBasis} plain={t('law.plain', { years: type.keptYears })} labels={ds.lawRef} />
}

/** An outcome as a pill (a tone AND its words). */
export function OutcomePill({ outcome, say: own }: { outcome: CheckOutcome; say?: Translate }) {
  const fallback = useWords()
  const t = own ?? fallback
  return <Pill tone={OUTCOME_TONE[outcome]}>{t(`outcome.${outcome}`)}</Pill>
}

/** A section's heading row: the title, a count or note, and its own controls. */
export function SectionHead({ id, title, note, children }: { id: string; title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="fw-pv-head">
      <span className="fw-pv-head-title">
        <h2 id={id} className="fw-pv-h" tabIndex={-1}>
          {title}
        </h2>
        {note ? <span className="fw-pv-muted">{note}</span> : null}
      </span>
      {children ? <span className="fw-pv-tools">{children}</span> : null}
    </div>
  )
}

/** The page's own keys, then the list frame's. */
export const PAGE_KEYS = (t: Translate): ListKey[] => [
  { keys: ['n'], does: t('keys.newPlan') },
  { keys: ['r'], does: t('keys.record') },
  { keys: ['[', ']'], does: t('keys.months') },
  { keys: ['Enter'], does: t('keys.open') },
  { keys: ['m'], does: t('keys.move') },
  { keys: ['J', 'K'], does: t('keys.moves') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** `?` and the footer's "All shortcuts": every key of the page. */
export function KeysModal({ onClose }: { onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-pv-list">
        {listKeys(PAGE_KEYS(t)).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}
