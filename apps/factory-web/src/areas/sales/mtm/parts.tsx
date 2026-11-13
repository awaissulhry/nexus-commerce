'use client'

import { useCallback, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import type { ReviewStatus } from '@nexus/factory-domain/sales/mtm/rules'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { QualityMessages } from '../../quality/_shared/parts'
import { NS, REVIEW_TONE, type Notice, type Phrase } from './model'
import './mtm.css'

/** The page's catalogues: `sales-mtm`, the shared `quality` (the record frame's words), `lists`, `records` and `ds-words`. */
export function MtmMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={[NS, 'ds-words']}>{children}</QualityMessages>
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** Parameters that are themselves keys of the catalogue (said in words first). */
const KEY_PARAM = /^(view|review|apptStatus|apptKind|verdict|right|zone|shape|proofState)\.[A-Za-z_]+$/

/**
 * `t` for a key, `say` for a phrase: a parameter that is itself a key (`review.WAITING`, `right.review`) is said in words
 * first; a day (`2026-11-12`) in the page's date format. `day` and `when` draw a business day and an instant.
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

export function ReviewPill({ status }: { status: ReviewStatus }) {
  const { t } = useWords()
  return <Pill tone={REVIEW_TONE[status]}>{t(`review.${status}`)}</Pill>
}

/** "On" / "Off" of a template's made-to-measure rules (GATE-MTM), with the word, never colour alone. */
export function StartedTag({ on }: { on: boolean }) {
  const { t } = useWords()
  return <Tag tone={on ? 'success' : 'neutral'}>{t(on ? 'off.on' : 'off.off')}</Tag>
}

/** One notice (a receipt, a refusal, the off state) with its link and the lines under it. */
export function NoticeLine({ notice, onDismiss }: { notice: Notice | null | undefined; onDismiss?: () => void }) {
  const { t, say } = useWords()
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={say(notice)}
      action={
        notice.link || onDismiss ? (
          <span className="fw-mtm-actions">
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
        ) : undefined
      }
    >
      {notice.lines && notice.lines.length > 0 ? (
        <ul className="fw-mtm-lines">
          {notice.lines.map((line, index) => (
            <li key={index}>{say(line)}</li>
          ))}
        </ul>
      ) : null}
    </Banner>
  )
}

/** Is a key press the page's (not typed into a field, not in a dialog or a menu, no modifier)? */
export function isPageKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return false
  const target = event.target as HTMLElement | null
  if (!target) return true
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"], [role="dialog"], .ag-cell-inline-editing')) return false
  return !target.isContentEditable
}

/** ⌘↵ / Ctrl+↵ inside a dialog runs its primary action (when not held). */
export function useSubmitKey(open: boolean, held: boolean, onSubmit: () => void) {
  return useCallback(
    (event: ReactKeyboardEvent) => {
      if (!open || held) return
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        onSubmit()
      }
    },
    [open, held, onSubmit],
  )
}
