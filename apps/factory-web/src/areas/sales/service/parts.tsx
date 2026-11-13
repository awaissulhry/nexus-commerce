'use client'

import { useCallback, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner } from '@nexus/ui/components'
import { Button, Pill, Tag, type Tone } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { QualityMessages } from '../../quality/_shared/parts'
import type { CasePriority, CaseRow, CaseStatus, CaseKind } from './api'
import { NS, type Notice, type Phrase } from './model'
import './service.css'

/** The page's catalogues: `sales-service`, the shared `quality` (the record frame's words), `lists`, `records` and `search` (a linked record's status). */
export function ServiceMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={[NS, 'search']}>{children}</QualityMessages>
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** Parameters that are themselves keys of the catalogue (said in words first). */
const KEY_PARAM = /^(view|kind|cover|status|decision|right|channel|wish|priority|purpose|linkType)\.[A-Za-z_]+$/

/**
 * `t` for a key, `say` for a phrase: a parameter that is itself a key (`status.OPEN`, `right.sales.service.manage`) is said in
 * words first; a day (`2026-11-12`) in the page's date format. `day` and `when` draw a business day and an instant.
 */
export function useWords() {
  const t = useT(NS)
  const locale = useLocale()
  const say = useCallback(
    (phrase: Phrase | null | undefined): string | null => {
      if (!phrase) return null
      const params: Record<string, string | number> = {}
      for (const [name, value] of Object.entries(phrase.params ?? {})) {
        if (typeof value === 'string' && (KEY_PARAM.test(value) || value.startsWith('right.'))) params[name] = t(value)
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

const STATUS_TONE: Readonly<Record<CaseStatus, Tone>> = { NEW: 'info', OPEN: 'info', WAITING_CUSTOMER: 'warning', WAITING_PART: 'warning', RESOLVED: 'success', CLOSED: 'neutral' }
export function StatusPill({ status }: { status: CaseStatus }) {
  const { t } = useWords()
  return <Pill tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Pill>
}

export function KindTag({ kind }: { kind: CaseKind }) {
  const { t } = useWords()
  return <Tag tone={kind === 'SAFETY' ? 'danger' : 'neutral'}>{t(`kind.${kind}`)}</Tag>
}

export function PriorityTag({ priority }: { priority: CasePriority }) {
  const { t } = useWords()
  if (priority === 'NORMAL' || priority === 'LOW') return <span className="fw-svc-hint">{t(`priority.${priority}`)}</span>
  return <Tag tone={priority === 'URGENT' ? 'danger' : 'warning'}>{t(`priority.${priority}`)}</Tag>
}

const COVER_TONE: Readonly<Record<CaseRow['cover']['state'], Tone>> = { LEGAL_GUARANTEE: 'success', FACTORY_GUARANTEE: 'info', OUT_OF_COVER: 'neutral', UNKNOWN: 'warning' }
/** The Cover column: the decided cover with its decision, else what the check points to ("suggested"), in words. */
export function CoverTag({ cover }: { cover: CaseRow['cover'] }) {
  const { t } = useWords()
  return (
    <span className="fw-svc-cell">
      <Tag tone={COVER_TONE[cover.state]}>{t(`cover.${cover.state}`)}</Tag>
      <span className="fw-svc-hint">{cover.decided && cover.decision ? t(`decision.${cover.decision}`) : cover.state === 'UNKNOWN' ? t('cover.noDelivery') : t('cover.suggested')}</span>
    </span>
  )
}

/** One notice (a receipt, a refusal, a page notice) with its link and the lines under it. */
export function NoticeLine({ notice, onDismiss }: { notice: Notice | null | undefined; onDismiss?: () => void }) {
  const { t, say } = useWords()
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={say(notice)}
      action={
        <span className="fw-svc-actions">
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
        <ul className="fw-svc-lines">
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
