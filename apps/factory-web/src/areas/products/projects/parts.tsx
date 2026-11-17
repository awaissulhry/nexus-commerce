'use client'

import { useCallback, type ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { NAMESPACES, NS, STATUS_TONE, statusKey, targetPhrase, type Notice, type Phrase, type ProjectStatus } from './model'
import './parts.css'

/**
 * The parts every project screen shares (threads plan TH-5): the catalogues around a view (the shared `products-projects` and
 * `lists`, plus the part's own), `useWords` (a key or a phrase in the page's language), the status pill, the target date with its
 * words, one notice. No reads here.
 */
export function ProjectsMessages({ also = [], children }: { also?: readonly string[]; children?: ReactNode }) {
  return <WithMessages namespaces={[...NAMESPACES, ...also]}>{children}</WithMessages>
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T/

/**
 * `t` for a key of a catalogue (the shared one by default), `say` for a phrase: a parameter that is itself a key of the shared
 * catalogue (`status.ACTIVE`, `outcome.DONE`, `field.name`) is said in words first; a day in the page's date format.
 */
export function useWords(ns: string = NS) {
  const t = useT(ns)
  const shared = useT(NS)
  const locale = useLocale()
  const say = useCallback(
    (phrase: Phrase | null | undefined): string | null => {
      if (!phrase) return null
      const params: Record<string, string | number> = {}
      for (const [name, value] of Object.entries(phrase.params ?? {})) {
        if (typeof value === 'string' && /^(status|outcome|field|group|target)\./.test(value)) params[name] = shared(value)
        else if (typeof value === 'string' && DATE.test(value)) params[name] = formatDate(`${value}T12:00:00Z`, { locale })
        else params[name] = value
      }
      // A phrase of the shared catalogue (a refusal, a problem, a held reason) is said from it; the part's own keys from its own.
      return /^(refusal|problem|held|status|outcome|target|field|common)\./.test(phrase.key) ? shared(phrase.key, params) : t(phrase.key, params)
    },
    [t, shared, locale],
  )
  const day = useCallback((value: string | null | undefined) => (value ? formatDate(DATE.test(value) ? `${value}T12:00:00Z` : value, { locale }) : '—'), [locale])
  const when = useCallback((value: string | null | undefined) => (value && INSTANT.test(value) ? formatDateTime(value, { locale }) : '—'), [locale])
  return { t, shared, say, locale, day, when }
}

/** Active · On hold · Closed, in one word (the same in the list, the band and the portal). */
export function StatusPill({ status }: { status: ProjectStatus }) {
  const shared = useT(NS)
  return <Pill tone={STATUS_TONE[status]}>{shared(statusKey(status))}</Pill>
}

/** The target date, and beside it its state in words when overdue (red) or near (amber): never colour alone. */
export function TargetDate({ targetDate, target }: { targetDate: string; target: { state: string; days: number } }) {
  const { say, day } = useWords()
  const { tone, phrase } = targetPhrase(target)
  return (
    <span className="fw-prj-target">
      <span className="fw-prj-num">{day(targetDate)}</span>
      {phrase && <Tag tone={tone}>{say(phrase)}</Tag>}
    </span>
  )
}

/** One notice (a receipt or a refusal), dismissable. */
export function NoticeLine({ notice, onDismiss, ns }: { notice: Notice | null | undefined; onDismiss?: () => void; ns?: string }) {
  const { say, shared } = useWords(ns)
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={say(notice)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {shared('common.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}
