'use client'

import { useMemo, type ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { ROLE_LAW, type SafetyRole } from '@nexus/factory-domain/safety/organisation/rules'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { CALENDAR_VIEW_NAMESPACES } from '../../_shared/calendar/CalendarView'
import { sayWords, type Problem, type Words } from '../model'

/**
 * View parts every SCR-267 view shares (B-W2b-120): the catalogues (`safety-calendar`, the list frame's `lists`, `shell`
 * for the site chip, the calendar part's own), the words hook, a section's loading (its shape, "Still loading…" after a
 * second) and failed states (our words + Try again, never an empty list), a role's law as a LawRef, a day in words, the
 * keys list behind `?`.
 */

export const SAFETY_NAMESPACES = ['safety-calendar', 'lists', 'shell', ...CALENDAR_VIEW_NAMESPACES] as const

/** The page's words (`safety-calendar`). */
export function useWords(): Translate {
  const t = useT('safety-calendar')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

export const say = (t: Translate, words: Words): string => sayWords(t, words)

/** A day (`YYYY-MM-DD`) in the page's language. */
export function useDay(): (day: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (day) => (day ? formatDate(`${day.slice(0, 10)}T12:00:00Z`, { locale }) : '—'), [locale])
}

/** A refusal's or a problem's words, with the days of a refusal filled in where it names one. */
export const problemText = (t: Translate, problem: Problem | null): string | null => (problem ? t(problem.key) : null)

/** A section loading in its own shape; "Still loading…" shows by itself after about a second (CSS, no timer). */
export function SectionLoading({ rows = 4, height = 30 }: { rows?: number; height?: number }) {
  const t = useWords()
  return (
    <div className="fw-hs-loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? height + 4 : height} />
      ))}
      <span className="fw-hs-slow" role="status">
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

/** No safety.view: the page says so and reads nothing. */
export function NoSafetyAccess() {
  const t = useWords()
  return (
    <Card padded>
      <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('access.title')} description={t('access.body')} />
    </Card>
  )
}

/** A role's law (D.Lgs. 81/2008), as the DS LawRef with the plain words of our catalogue. */
export function RoleLaw({ role, say: own }: { role: SafetyRole; say?: Translate }) {
  const fallback = useWords()
  const t = own ?? fallback
  const ds = useDsWords()
  return <LawRef law={ROLE_LAW[role]} plain={t(`roleLaw.${role}`)} labels={ds.lawRef} />
}

/** A section's heading row: the title, a count or note, and its own controls. */
export function SectionHead({ id, title, note, children }: { id: string; title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="fw-hs-head">
      <span className="fw-hs-head-title">
        <h2 id={id} className="fw-hs-h">
          {title}
        </h2>
        {note ? <span className="fw-hs-muted">{note}</span> : null}
      </span>
      {children ? <span className="fw-hs-tools">{children}</span> : null}
    </div>
  )
}

/** The page's own keys, then the list frame's. */
export const PAGE_KEYS = (t: Translate): ListKey[] => [
  { keys: ['c'], does: t('keys.add') },
  { keys: ['[', ']'], does: t('keys.months') },
  { keys: ['J', 'K'], does: t('keys.moves') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** `?` and the footer's "All shortcuts": every key of the page. */
export function KeysModal({ onClose }: { onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-hs-list">
        {listKeys(PAGE_KEYS(t)).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}
