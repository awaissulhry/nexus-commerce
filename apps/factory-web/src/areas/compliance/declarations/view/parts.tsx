'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, SourceIndicator } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import type { CoverageState } from '@nexus/factory-domain/compliance/declarations/coverage'
import { SECTION_KEYS } from '@nexus/factory-domain/compliance/user-information/template'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { WithMessages } from '../../../../record-panels/i18n'
import type { ApiProblem, DocStatus, Source } from '../api'
import { CELL_TONE, indicatorKind, LAW, languageName, problemCodeKey, sourceHref, sourceKey, STATUS_TONE, BLOCKING } from '../model'
import '../declarations.css'

/**
 * View parts every SCR-052 view shares (B-W2b-268): the catalogues (`compliance-declarations`, the list frame's `lists`, `quality`
 * for the record frame's words), the words hook, a day and a language in words, the status and coverage pills (a word, never
 * colour alone), where a value came from (the DS SourceIndicator, with its record one click away), a part's problems by code in
 * our words, a section's loading and failed states, the GATE-PPE-TEXTS banner, and the keys behind `?`.
 */

export const DECLARATIONS_NAMESPACES = ['compliance-declarations', 'lists', 'quality'] as const

export function DeclarationsMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={DECLARATIONS_NAMESPACES}>{children}</WithMessages>
}

/** The page's words (`compliance-declarations`). */
export function useWords(): Translate {
  const t = useT('compliance-declarations')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

/** A day (`YYYY-MM-DD` or an instant) in the page's language. */
export function useDay(): (day: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (day) => (day ? formatDate(day.length === 10 ? `${day}T12:00:00Z` : day, { locale }) : '—'), [locale])
}

/** A language's name in the page's language. */
export function useLanguage(): (tag: string) => string {
  const locale = useLocale()
  return useMemo(() => (tag) => languageName(tag, locale), [locale])
}

export function StatusPill({ status }: { status: DocStatus }) {
  const t = useWords()
  return (
    <Pill tone={STATUS_TONE[status]} dot>
      {t(`status.${status}`)}
    </Pill>
  )
}

/** A coverage cell's state: Issued r3 / Draft / In translation / Checked (still a draft) / Missing / Not needed. */
export function CellPill({ state, revision }: { state: CoverageState; revision: number | null }) {
  const t = useWords()
  return (
    <Pill tone={CELL_TONE[state]} dot={state !== 'NOT_NEEDED'}>
      {state === 'ISSUED' && revision !== null ? t('cell.ISSUED_rev', { revision }) : t(`cell.${state}`)}
    </Pill>
  )
}

/** Where a value came from (design SourceIndicator): its kind in words, the value it filled, and its record one click away. */
export function SourceTag({ source, value, prefix, showLabel = false }: { source: Source; value?: string; prefix: string; showLabel?: boolean }) {
  const t = useWords()
  const href = sourceHref(prefix, source)
  const label = t(sourceKey(source))
  return (
    <SourceIndicator
      kind={indicatorKind(source)}
      label={label}
      description={value ? t('source.filled', { what: label, value }) : label}
      showLabel={showLabel}
      quiet={source.kind !== 'TYPED' && source.kind !== 'UNTRANSLATED' && source.kind !== 'TO_TYPE'}
      {...(href ? { actionLabel: t('source.open'), onAction: () => window.open(href, '_blank', 'noopener') } : {})}
    />
  )
}

/** The composition's problems in our words: what refuses a draft first (danger), then the warnings. */
export function ProblemList({ problems, kind }: { problems: readonly ApiProblem[]; kind: 'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION' }) {
  const t = useWords()
  if (problems.length === 0) return null
  const blocking = problems.filter((problem) => BLOCKING.has(problem.code))
  const warnings = problems.filter((problem) => !BLOCKING.has(problem.code))
  const line = (problem: ApiProblem, index: number) => (
    <li key={`${problem.code}-${problem.point ?? ''}-${index}`}>
      {problem.point ? <b>{kind === 'USER_INFORMATION' ? ((SECTION_KEYS as readonly string[]).includes(problem.point) ? t(`section.${problem.point}`) : t('part.sectionShort', { id: problem.point })) : t('part.pointShort', { id: problem.point })} · </b> : null}
      {t(problemCodeKey(problem.code), { code: problem.code })}
    </li>
  )
  return (
    <div className="fw-dc-stack">
      {blocking.length > 0 && (
        <Banner tone="danger" title={t('problems.blocking', { count: blocking.length })}>
          <ul className="fw-dc-list">{blocking.map(line)}</ul>
        </Banner>
      )}
      {warnings.length > 0 && (
        <Banner tone="warning" title={t('problems.warnings', { count: warnings.length })}>
          <ul className="fw-dc-list">{warnings.map(line)}</ul>
        </Banner>
      )}
    </div>
  )
}

/** GATE-PPE-TEXTS (Owner 11-09, B) in plain words: a generated document is a draft until a PPE consultant checks its template. */
export function GateBanner({ prefix, styleId, kind = 'DECLARATION_OF_CONFORMITY', compact = false }: { prefix: string; styleId?: string | null; kind?: 'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION'; compact?: boolean }) {
  const t = useWords()
  const ds = useDsWords()
  return (
    <Banner tone="info" title={t('gate.title')}>
      {!compact && <p className="fw-dc-p">{t('gate.body')}</p>}
      <span className="fw-dc-row">
        <LawRef law={kind === 'USER_INFORMATION' ? LAW.userInformation : LAW.doc} plain={t(kind === 'USER_INFORMATION' ? 'law.userInformation' : 'law.doc')} href={LAW.href} labels={ds.lawRef} />
        {styleId ? (
          <Link className="fw-dc-link" href={`${prefix}/products/styles/${encodeURIComponent(styleId)}?tab=compliance`}>
            {t('gate.signedRoute')}
          </Link>
        ) : (
          <span className="fw-dc-muted">{t('gate.signedRouteWhere')}</span>
        )}
      </span>
    </Banner>
  )
}

/** A part loading in its own shape; "Still loading…" shows by itself after about a second (CSS, no timer). */
export function PartLoading({ rows = 4, height = 30 }: { rows?: number; height?: number }) {
  const t = useWords()
  return (
    <div className="fw-dc-loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? height + 4 : height} />
      ))}
      <span className="fw-dc-slow" role="status">
        {t('common.stillLoading')}
      </span>
    </div>
  )
}

/** A failed read: said in our words with Try again (a missing right says so and offers nothing). */
export function PartFailed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: (() => void) | undefined }) {
  const t = useWords()
  const forbidden = problem === 'problem.forbidden' || problem === 'problem.signedOut'
  return (
    <EmptyState
      title={title}
      description={t(problem)}
      action={
        forbidden || !onRetry ? undefined : (
          <Button size="sm" onClick={() => onRetry()}>
            {t('common.retry')}
          </Button>
        )
      }
    />
  )
}

/** No compliance.certificates.view: the page says so, names the right and who grants it, and reads nothing. */
export function NoAccess() {
  const t = useWords()
  return (
    <Card padded>
      <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('access.title')} description={t('access.body')} />
    </Card>
  )
}

/** A section's heading row: the title, a note, its own controls. */
export function SectionHead({ id, title, note, children }: { id: string; title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="fw-dc-head">
      <span className="fw-dc-head-title">
        <h2 id={id} className="fw-dc-h" tabIndex={-1}>
          {title}
        </h2>
        {note ? <span className="fw-dc-muted">{note}</span> : null}
      </span>
      {children ? <span className="fw-dc-tools">{children}</span> : null}
    </div>
  )
}

/** The page's own keys, then the list frame's. */
export const PAGE_KEYS = (t: Translate): ListKey[] => [
  { keys: ['c'], does: t('keys.new') },
  { keys: ['l'], does: t('keys.check') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** `?` and the footer's "All shortcuts": every key of the page. */
export function KeysModal({ onClose }: { onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-dc-list">
        {listKeys(PAGE_KEYS(t)).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/** A language as a short chip: its tag and, for a screen reader and on hover, its name. */
export function LanguageTag({ tag }: { tag: string }) {
  const name = useLanguage()
  return (
    <abbr className="fw-dc-lang" title={name(tag)}>
      {tag.toUpperCase()}
    </abbr>
  )
}
