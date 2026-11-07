'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Eye, ShieldOff } from 'lucide-react'
import { Card, DetailPopover, EmptyState } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { HEALTH_LAW, PROTECTED_HEALTH_LAW, type FitnessOutcome, type JudgementState, type VisitState } from '@nexus/factory-domain/safety/health/rules'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import type { HealthPerson, ViewsOf } from '../api'
import { JUDGEMENT_STATE_TONE, OUTCOME_TONE, VISIT_STATE_TONE, type Words } from '../model'
import type { WhoLookedState } from '../view-model'

/**
 * The parts every SCR-212 view shares (B-W2b-148): the catalogues (`plant-health`; `lists` for the list frame; `shell` for the
 * site chip and the PDF viewer's words), the words hook, a day in words, the laws as the DS LawRef, the states as tags, a
 * section's loading and failed states, a person in words (only what a recorded read handed the page), "Who looked" (the DS
 * DetailPopover over the view log), and the keys list behind `?`.
 */

export const HEALTH_NAMESPACES = ['plant-health', 'lists', 'shell'] as const

/** The page's words (`plant-health`). */
export function useWords(): Translate {
  const t = useT('plant-health')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

/** A held reason or a problem in words. */
export const say = (t: Translate, words: Words | null | undefined): string | null => (words ? t(words.key, words.params) : null)

/** A day (`YYYY-MM-DD`) and a moment in the page's language. */
export function useWhen(): { day: (day: string | null | undefined) => string; at: (iso: string | null | undefined) => string } {
  const locale = useLocale()
  return useMemo(() => ({ day: (day) => (day ? formatDate(`${day.slice(0, 10)}T12:00:00Z`, { locale }) : '—'), at: (iso) => (iso ? formatDateTime(iso, { locale }) : '—') }), [locale])
}

/** D.Lgs. 81/2008 art. 41 (the visits and the judgement) with our plain words. */
export function HealthLaw() {
  const t = useWords()
  const ds = useDsWords()
  return <LawRef law={HEALTH_LAW} plain={t('law.healthPlain')} labels={ds.lawRef} />
}

/** GDPR art. 9 (health data is special) as the API names it. */
export function ProtectedLaw({ law = PROTECTED_HEALTH_LAW }: { law?: string }) {
  const t = useWords()
  const ds = useDsWords()
  return <LawRef law={law} plain={t('law.protectedPlain')} labels={ds.lawRef} />
}

export function VisitStateTag({ state }: { state: VisitState }) {
  const t = useWords()
  return <Tag tone={VISIT_STATE_TONE[state]}>{t(`visitState.${state}`)}</Tag>
}

export function JudgementStateTag({ state }: { state: JudgementState }) {
  const t = useWords()
  return <Tag tone={JUDGEMENT_STATE_TONE[state]}>{t(`judgementState.${state}`)}</Tag>
}

export function OutcomeTag({ outcome }: { outcome: FitnessOutcome }) {
  const t = useWords()
  return <Tag tone={OUTCOME_TONE[outcome]}>{t(`outcome.${outcome}`)}</Tag>
}

/** A person as a recorded read named them: name · employee code. */
export const personText = (person: Pick<HealthPerson, 'name' | 'employeeCode'>): string => (person.employeeCode ? `${person.name} · ${person.employeeCode}` : person.name)

/** A section loading in its own shape; "Still loading…" shows by itself after about a second (CSS, no timer). */
export function SectionLoading({ rows = 4, height = 30 }: { rows?: number; height?: number }) {
  const t = useWords()
  return (
    <div className="fw-hv-loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? height + 4 : height} />
      ))}
      <span className="fw-hv-slow" role="status">
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

/** Neither the protected page nor its plans: the page says so and reads nothing. */
export function NoHealthAccess() {
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
    <div className="fw-hv-head">
      <span className="fw-hv-head-title">
        <h2 id={id} className="fw-hv-h" tabIndex={-1}>
          {title}
        </h2>
        {note ? <span className="fw-hv-muted">{note}</span> : null}
      </span>
      {children ? <span className="fw-hv-tools">{children}</span> : null}
    </div>
  )
}

/**
 * design pop:viewlog "Who looked" (Row ⋯, HR and the DPO): viewer · time · what, newest first, in the DS DetailPopover. The log
 * is read when it opens (the container: GET /safety/health/views; reading it records nothing) and forgotten when it closes.
 */
export function WhoLooked({ of, state, onOpen, label, compact = false }: { of: ViewsOf; state: WhoLookedState | null; onOpen?: ((of: ViewsOf | null) => void) | undefined; label: string; compact?: boolean }) {
  const t = useWords()
  const when = useWhen()
  // The panel is portaled to <body>: it opens only once the page is on screen (a log opened before would not hydrate).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const key = (value: ViewsOf) => ('recordId' in value ? `${value.recordType}:${value.recordId}` : `lists:${value.companyId}`)
  const open = mounted && state !== null && key(state.of) === key(of)
  const read = open ? state.read : null
  return (
    <DetailPopover
      trigger={
        <span className="fw-hv-who">
          <Eye size={14} aria-hidden />
          {compact ? null : <span>{t('who.button')}</span>}
        </span>
      }
      triggerLabel={label}
      triggerClassName="fw-hv-who-trigger"
      panelClassName="nds-detailpop-scroll"
      label={t('who.title')}
      hoverDelay={0}
      open={open}
      onOpenChange={(next) => onOpen?.(next ? of : null)}
    >
      <div className="fw-hv-who-panel">
        <strong>{t('who.title')}</strong>
        <p className="fw-hv-muted">{t('who.note')}</p>
        {!read || read.status === 'loading' ? (
          <p className="fw-hv-muted" role="status">
            <Spinner size={12} /> {t('common.reading')}
          </p>
        ) : read.status === 'error' ? (
          <p className="fw-hv-warn">{t(read.problem)}</p>
        ) : read.value.views.length === 0 && read.value.fitnessChecks.length === 0 ? (
          <p className="fw-hv-muted">{t('who.none')}</p>
        ) : (
          <ul className="fw-hv-list">
            {read.value.views.map((view) => (
              <li key={view.id}>
                <b>{view.viewer.name || t('who.someone')}</b> · {when.at(view.viewedAt)} · {t(`who.what.${view.what}`)}
              </li>
            ))}
            {read.value.fitnessChecks.map((check, index) => (
              <li key={`check-${index}`}>
                <b>{check.viewer.name || t('who.someone')}</b> · {when.at(check.at)} · {t('who.fitCheck')}
              </li>
            ))}
          </ul>
        )}
      </div>
    </DetailPopover>
  )
}

/** The page's own keys, then the list frame's. */
export const PAGE_KEYS = (t: Translate): ListKey[] => [
  { keys: ['j'], does: t('keys.judge') },
  { keys: ['p'], does: t('keys.plan') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** `?` and the footer's "All shortcuts": every key of the page. */
export function KeysModal({ onClose }: { onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-hv-list">
        {listKeys(PAGE_KEYS(t)).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}
