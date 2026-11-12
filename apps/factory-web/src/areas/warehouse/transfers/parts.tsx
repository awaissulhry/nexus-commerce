'use client'

import { useCallback, type ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import type { LiveState } from '../../../shell/live/use-live'
import { LIFECYCLE_TONE, LINE_STATE_TONE, NAMESPACES, NS, type Lifecycle, type LineState, type Notice, type Phrase } from './model'
import './transfers.css'

/** The page's catalogues (`warehouse-transfers`, the list frame's `lists`, the units of `stock`) around a view. */
export function TransfersMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={[...NAMESPACES]}>{children}</WithMessages>
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * `t` for a key, `say` for a phrase: a parameter that is itself a key of the catalogue (`status.SHIPPED`, `refusal.…`) is
 * said in words first; a day (`2026-11-12`) in the page's date format.
 */
export function useWords() {
  const t = useT(NS)
  const locale = useLocale()
  const say = useCallback(
    (phrase: Phrase | null | undefined): string | null => {
      if (!phrase) return null
      const params: Record<string, string | number> = {}
      for (const [name, value] of Object.entries(phrase.params ?? {})) {
        if (typeof value === 'string' && /^(status|lifecycle|refusal|field|tile|state|resolution|transport|reason)\./.test(value)) params[name] = t(value)
        else if (typeof value === 'string' && DATE.test(value)) params[name] = formatDate(`${value}T12:00:00Z`, { locale })
        else params[name] = value
      }
      return t(phrase.key, params)
    },
    [t, locale],
  )
  const day = useCallback((value: string | null | undefined) => (value ? formatDate(DATE.test(value) ? `${value}T12:00:00Z` : value, { locale }) : '—'), [locale])
  return { t, say, locale, day }
}

export function LifecyclePill({ lifecycle }: { lifecycle: Lifecycle }) {
  const { t } = useWords()
  return (
    <Pill tone={LIFECYCLE_TONE[lifecycle]} dot>
      {t(`lifecycle.${lifecycle}`)}
    </Pill>
  )
}

export function LineStatePill({ state }: { state: LineState }) {
  const { t } = useWords()
  return <Pill tone={LINE_STATE_TONE[state]}>{t(`state.${state}`)}</Pill>
}

/** One notice (a receipt or a refusal) with the places the API named under it. */
export function NoticeLine({ notice, lines, onDismiss }: { notice: Notice | null | undefined; lines?: readonly Phrase[]; onDismiss?: () => void }) {
  const { t, say } = useWords()
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={say(notice)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.dismiss')}
          </Button>
        ) : undefined
      }
    >
      {lines && lines.length > 0 ? (
        <ul className="fw-trf-lines">
          {lines.map((line, index) => (
            <li key={index}>{say(line)}</li>
          ))}
        </ul>
      ) : null}
    </Banner>
  )
}

/** When it was read and whether changes arrive live. */
export function Freshness({ asOf, live }: { asOf: string | null; live: LiveState }) {
  const { t, locale } = useWords()
  return (
    <span className="fw-trf-asof" role="status">
      {asOf ? <time dateTime={asOf}>{t('common.updated', { time: formatTime(asOf, { locale }) })}</time> : t('common.notYet')}
      {' · '}
      {t(`live.${live}`)}
    </span>
  )
}

/** The page says which permission is missing (design: inventory.stock.view to see transfers). */
export function NoAccess() {
  const { t } = useWords()
  return (
    <div className="fw-trf">
      <Card padded>
        <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
      </Card>
    </div>
  )
}

/** The head of a page under the shell's band: one plain sentence, the freshness, the actions with the primary last. */
export function PageHead({ intro, status, actions }: { intro?: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="fw-trf-head">
      <div className="fw-trf-head-text">
        {intro && <p className="fw-trf-intro">{intro}</p>}
        {status}
      </div>
      {actions && <div className="fw-trf-actions">{actions}</div>}
    </div>
  )
}

/** Is a key press the page's (not typed into a field, not in a dialog or a menu, no modifier)? */
export function isPageKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return false
  const target = event.target as HTMLElement | null
  if (!target) return true
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], .ag-cell-inline-editing')) return false
  return !target.isContentEditable
}

/** A site in short: "A1 · Plant A", with its company when the transfer is between two companies. */
export function SiteText({ site, withCompany }: { site: { code: string; name: string; companyName: string }; withCompany?: boolean }) {
  return (
    <span className="fw-trf-cell">
      <span className="fw-trf-code">
        {site.code}
        {site.name && site.name !== site.code ? ` · ${site.name}` : ''}
      </span>
      {withCompany && <span className="fw-trf-hint">{site.companyName}</span>}
    </span>
  )
}
