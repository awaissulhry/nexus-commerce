'use client'

import { useCallback, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import type { LiveState } from '../../../shell/live/use-live'
import { NAMESPACES, NS, STATUS_TONE, waitingOf, type InquirySource, type InquiryStatus, type Notice, type Phrase } from './model'
import type { InquiryRow } from './api'
import './inquiries.css'

/** The page's catalogues (`sales-inquiries`, the list frame's `lists`) around a view. */
export function InquiriesMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={[...NAMESPACES]}>{children}</WithMessages>
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** Parameters that are themselves keys of the catalogue (said in words first). */
const KEY_PARAM = /^(tile|source|status|decline|right|field|line\.problem|time|leftOut|refusal|prospect\.problem|request\.problem)\./

/**
 * `t` for a key, `say` for a phrase: a parameter that is itself a key of the catalogue (`tile.NEW`, `source.PHONE`,
 * `right.quotes.manage`) is said in words first; a day (`2026-11-12`) in the page's date format.
 */
export function useWords() {
  const t = useT(NS)
  const locale = useLocale()
  const say = useCallback(
    (phrase: Phrase | null | undefined): string | null => {
      if (!phrase) return null
      const params: Record<string, string | number> = {}
      for (const [name, value] of Object.entries(phrase.params ?? {})) {
        if (typeof value === 'string' && KEY_PARAM.test(value)) params[name] = t(value)
        else if (typeof value === 'string' && DATE.test(value)) params[name] = formatDate(`${value}T12:00:00Z`, { locale })
        else params[name] = value
      }
      return t(phrase.key, params)
    },
    [t, locale],
  )
  const day = useCallback((value: string | null | undefined) => (value ? formatDate(DATE.test(value) ? `${value}T12:00:00Z` : value, { locale }) : '—'), [locale])
  const when = useCallback((value: string | null | undefined) => (value ? formatDateTime(value, { locale }) : '—'), [locale])
  return { t, say, locale, day, when }
}

export function StatusPill({ status }: { status: InquiryStatus }) {
  const { t } = useWords()
  return <Pill tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Pill>
}

export function SourceTag({ source }: { source: InquirySource }) {
  const { t } = useWords()
  return <Tag tone="neutral">{t(`source.${source}`)}</Tag>
}

/** Waiting in working time, overdue in the danger tone; nothing once closed. */
export function WaitingTag({ row }: { row: Pick<InquiryRow, 'waiting'> }) {
  const { say } = useWords()
  const waiting = waitingOf(row)
  if (!waiting) return <span className="fw-inq-hint">—</span>
  const words = waiting.time ? `${say(waiting.phrase)} · ${say(waiting.time)}` : say(waiting.phrase)
  return <Tag tone={waiting.tone}>{words}</Tag>
}

/** One notice (a receipt or a refusal) with its link and the lines under it. */
export function NoticeLine({ notice, onDismiss }: { notice: Notice | null | undefined; onDismiss?: () => void }) {
  const { t, say } = useWords()
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={say(notice)}
      action={
        <span className="fw-inq-actions">
          {notice.link && (
            <Button size="sm" variant="quiet" asChild>
              <Link href={notice.link.href}>{say(notice.link.label)}</Link>
            </Button>
          )}
          {onDismiss && (
            <Button size="sm" variant="quiet" onClick={onDismiss}>
              {t('common.dismiss')}
            </Button>
          )}
        </span>
      }
    >
      {notice.lines && notice.lines.length > 0 ? (
        <ul className="fw-inq-lines">
          {notice.lines.map((line, index) => (
            <li key={index}>{say(line)}</li>
          ))}
        </ul>
      ) : null}
    </Banner>
  )
}

/** When the inquiries were read and whether changes arrive live. */
export function Freshness({ asOf, live }: { asOf: string | null; live: LiveState }) {
  const { t, locale } = useWords()
  return (
    <span className="fw-inq-asof" role="status">
      {asOf ? <time dateTime={asOf}>{t('common.updated', { time: formatTime(asOf, { locale }) })}</time> : t('common.notYet')}
      {' · '}
      {t(`live.${live}`)}
    </span>
  )
}

/** "You don't have access to inquiries" + the role that has it (design noPermission). */
export function NoAccess() {
  const { t } = useWords()
  return (
    <div className="fw-inq">
      <Card padded>
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </Card>
    </div>
  )
}

/** The head of a page under the shell's band: one plain sentence, the freshness, the actions with the primary last. */
export function PageHead({ intro, status, actions }: { intro?: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="fw-inq-head">
      <div className="fw-inq-head-text">
        {intro && <p className="fw-inq-intro">{intro}</p>}
        {status}
      </div>
      {actions && <div className="fw-inq-actions">{actions}</div>}
    </div>
  )
}

/** Is a key press the page's (not typed into a field, not in a dialog or a menu, no modifier)? */
export function isPageKey(event: KeyboardEvent, insideDialog = false): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return false
  const target = event.target as HTMLElement | null
  if (!target) return true
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"], .ag-cell-inline-editing')) return false
  if (!insideDialog && target.closest('[role="dialog"]')) return false
  return !target.isContentEditable
}
