'use client'

import { useMemo, type ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime, formatNumber } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import type { Problem } from '../model'

/**
 * View parts every SCR-211 view shares (B-W2b-147): the catalogues (`plant-ppe`, the list frame's `lists`, `shell` for the site
 * chip and the PDF viewer's words), the words hook, a day and an instant in words, money in words (the cost grain only), a
 * section's loading (its shape, "Still loading…" after a second) and failed states (our words + Try again, never an empty
 * list), the no-access card, a section's heading row and the keys list behind `?`.
 */

export const PPE_NAMESPACES = ['plant-ppe', 'lists', 'shell'] as const

/** The page's words (`plant-ppe`). */
export function useWords(): Translate {
  const t = useT('plant-ppe')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

/** A day (`YYYY-MM-DD`) in the page's language. */
export function useDay(): (day: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (day) => (day ? formatDate(`${day.slice(0, 10)}T12:00:00Z`, { locale }) : '—'), [locale])
}

/** An instant in the site's zone. */
export function useWhen(): (at: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (at) => (at ? formatDateTime(at, { locale }) : '—'), [locale])
}

/** A unit cost in cents as money (only ever drawn with the cost grain). */
export const moneyOf = (minor: number | null | undefined, locale: Locale): string => (minor === null || minor === undefined ? '—' : formatNumber(minor / 100, locale, { style: 'currency', currency: 'EUR' }))

/** A problem in words: a refusal with the line it names. */
export function problemText(t: Translate, problem: Problem): string {
  const words = t(problem.key)
  return problem.line === null ? words : t('problem.atLine', { line: problem.line + 1, words })
}

/** A section loading in its own shape; "Still loading…" shows by itself after about a second (CSS, no timer). */
export function SectionLoading({ rows = 4, height = 30 }: { rows?: number; height?: number }) {
  const t = useWords()
  return (
    <div className="fw-ppe-loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? height + 4 : height} />
      ))}
      <span className="fw-ppe-slow" role="status">
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
export function NoPpeAccess() {
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
    <div className="fw-ppe-head">
      <span className="fw-ppe-head-title">
        <h2 id={id} className="fw-ppe-h" tabIndex={-1}>
          {title}
        </h2>
        {note ? <span className="fw-ppe-muted">{note}</span> : null}
      </span>
      {children ? <span className="fw-ppe-tools">{children}</span> : null}
    </div>
  )
}

/** The page's own keys, then the list frame's. */
export const PAGE_KEYS = (t: Translate): ListKey[] => [
  { keys: ['i'], does: t('keys.issue') },
  { keys: ['c'], does: t('keys.item') },
  { keys: ['1', '4'], does: t('keys.lenses') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** `?` and the footer's "All shortcuts": every key of the page. */
export function KeysModal({ onClose }: { onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-ppe-list">
        {listKeys(PAGE_KEYS(t)).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(entry.keys[0] === '1' ? '–' : ' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/** The new tabs' addresses (company-free; the prefix adds `/w/<company>`). */
export const receiptHref = (prefix: string, receiptIds: readonly string[]): string => `${prefix}/plant/ppe/receipt?${receiptIds.map((id) => `receipt=${encodeURIComponent(id)}`).join('&')}`
export const cardHref = (prefix: string, employeeIds: readonly string[]): string => `${prefix}/plant/ppe/card?${employeeIds.map((id) => `person=${encodeURIComponent(id)}`).join('&')}`
