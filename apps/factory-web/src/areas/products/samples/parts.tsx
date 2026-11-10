'use client'

import { useCallback, type ReactNode } from 'react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import type { LiveState } from '../../../shell/live/use-live'
import { DECISION_TONE, NAMESPACES, NS, STAGE_TONE, type Notice, type Phrase, type SampleDecision, type SampleKind, type SampleStage } from './model'
import './samples.css'

/** The page's catalogues (`products-samples`, the list frame's `lists`) around a view. */
export function SamplesMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={[...NAMESPACES]}>{children}</WithMessages>
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * `t` for a key, `say` for a phrase: a parameter that is itself a key of the catalogue (`kind.FIT`, `stage.SENT`,
 * `right.sales.samples.decide`) is said in words first; a day (`2026-11-12`) in the page's date format.
 */
export function useWords() {
  const t = useT(NS)
  const locale = useLocale()
  const say = useCallback(
    (phrase: Phrase | null | undefined): string | null => {
      if (!phrase) return null
      const params: Record<string, string | number> = {}
      for (const [name, value] of Object.entries(phrase.params ?? {})) {
        if (typeof value === 'string' && /^(kind|stage|decision|right|field|via|tile)\./.test(value)) params[name] = t(value)
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

export function StagePill({ stage }: { stage: SampleStage }) {
  const { t } = useWords()
  return <Pill tone={STAGE_TONE[stage]}>{t(`stage.${stage}`)}</Pill>
}

export function DecisionTag({ decision }: { decision: SampleDecision }) {
  const { t } = useWords()
  return <Tag tone={DECISION_TONE[decision]}>{t(`decision.${decision}`)}</Tag>
}

export function KindTag({ kind }: { kind: SampleKind }) {
  const { t } = useWords()
  return <Tag tone={kind === 'CERTIFICATION' ? 'info' : 'neutral'}>{t(`kind.${kind}`)}</Tag>
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
        <ul className="fw-smp-lines">
          {lines.map((line, index) => (
            <li key={index}>{say(line)}</li>
          ))}
        </ul>
      ) : null}
    </Banner>
  )
}

/** When the rounds were read and whether changes arrive live. */
export function Freshness({ asOf, live }: { asOf: string | null; live: LiveState }) {
  const { t, locale } = useWords()
  return (
    <span className="fw-smp-asof" role="status">
      {asOf ? <time dateTime={asOf}>{t('common.updated', { time: formatTime(asOf, { locale }) })}</time> : t('common.notYet')}
      {' · '}
      {t(`live.${live}`)}
    </span>
  )
}

/** "You don't have access to sample rounds" + the roles that have it (design noPermission). */
export function NoAccess() {
  const { t } = useWords()
  return (
    <div className="fw-smp">
      <Card padded>
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </Card>
    </div>
  )
}

/** The head of a page under the shell's band: one plain sentence, the freshness, the actions with the primary last. */
export function PageHead({ intro, status, actions }: { intro?: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="fw-smp-head">
      <div className="fw-smp-head-text">
        {intro && <p className="fw-smp-intro">{intro}</p>}
        {status}
      </div>
      {actions && <div className="fw-smp-actions">{actions}</div>}
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

/** A day written for a reader (`12 nov 2026`), or a dash. */
export function DayText({ value }: { value: string | null | undefined }) {
  const { day } = useWords()
  return <span className="fw-smp-num">{day(value)}</span>
}
