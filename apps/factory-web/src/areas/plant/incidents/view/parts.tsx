'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import type { FilingState, IncidentKind, IncidentSeverity, IncidentStatus } from '@nexus/factory-domain/safety/incidents/rules'
import { Countdown, Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { PHOTO_KIT_NAMESPACE } from '../../../../lib/ds-words/photo-capture'
import type { Countdown as CountdownValue } from '../api'
import { deadlineTone, FILING_TONE, KIND_TONE, SEVERITY_TONE, spanWords, STATUS_TONE } from '../model'

/**
 * The parts every SCR-210 view shares (B-W2b-149): the catalogues (`plant-incidents`; `lists` for the list frame; `shell` for
 * the site chip; `photo-kit` for the photo capture; `plant` for the plant's record frame), the words hook, a section's loading
 * and failed states, the kind / status / severity / filing state as tags, the deadline in words (live), the law as a LawRef,
 * and the keys list behind `?`.
 */

export const INCIDENT_NAMESPACES = ['plant-incidents', 'lists', 'shell', PHOTO_KIT_NAMESPACE, 'plant'] as const
export const INCIDENT_LAW = 'D.Lgs. 81/2008 art. 18 c.1 r'
export const PEOPLE_LAW = 'GDPR art. 9'

/** The page's words (`plant-incidents`). */
export function useWords(): Translate {
  const t = useT('plant-incidents')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

/** A moment in the site's zone, in the page's language. */
export function useWhen(): { at: (iso: string | null | undefined) => string; day: (iso: string | null | undefined) => string } {
  const locale = useLocale()
  return useMemo(() => ({ at: (iso) => (iso ? formatDateTime(iso, { locale }) : '—'), day: (iso) => (iso ? formatDate(iso.length === 10 ? `${iso}T12:00:00Z` : iso, { locale }) : '—') }), [locale])
}

export function KindTag({ kind }: { kind: IncidentKind }) {
  const t = useWords()
  return <Tag tone={KIND_TONE[kind]}>{t(`kind.${kind}`)}</Tag>
}

export function StatusTag({ status }: { status: IncidentStatus }) {
  const t = useWords()
  return <Tag tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Tag>
}

export function SeverityTag({ severity }: { severity: IncidentSeverity | null }) {
  const t = useWords()
  if (!severity) return <span className="fw-inc-muted">{t('severity.UNKNOWN')}</span>
  return <Tag tone={SEVERITY_TONE[severity]}>{t(`severity.${severity}`)}</Tag>
}

export function FilingStateTag({ state }: { state: FilingState }) {
  const t = useWords()
  return <Tag tone={FILING_TONE[state]}>{t(`filingState.${state}`)}</Tag>
}

/** Design cases only: the deadlines say the read's minutes instead of ticking from the browser's clock (made-up data is fixed). */
const FrozenClock = createContext(false)
export function DesignClock({ children }: { children?: ReactNode }) {
  return <FrozenClock.Provider value>{children}</FrozenClock.Provider>
}

/**
 * A deadline in words: "due in 9 h" counting down live (the DS Countdown from its dueAt), "late by 3 h" once past (from the
 * read's minutes, then "now" from the countdown when it passes on screen). Never colour alone: the words carry it.
 */
export function DeadlineText({ countdown, onDone, prefix }: { countdown: CountdownValue; onDone?: () => void; prefix?: string }) {
  const t = useWords()
  const frozen = useContext(FrozenClock)
  const lead = prefix ? `${prefix} ` : ''
  if (frozen && !countdown.late) {
    const span = spanWords(countdown.minutesLeft * 60_000)
    return <span className={deadlineTone(countdown) === 'danger' ? 'fw-inc-late' : 'fw-inc-due'}>{lead + t('deadline.dueIn', { left: t(span.key, span.params) })}</span>
  }
  if (countdown.late) {
    const span = spanWords(countdown.minutesLeft * 60_000)
    return <span className="fw-inc-late">{lead + t('deadline.lateBy', { span: t(span.key, span.params) })}</span>
  }
  return (
    <span className={deadlineTone(countdown) === 'danger' ? 'fw-inc-late' : 'fw-inc-due'}>
      {lead}
      <Countdown to={countdown.dueAt} label={(left) => t('deadline.dueIn', { left })} doneLabel={t('deadline.dueNow')} onDone={onDone} />
    </span>
  )
}

/** The INAIL rule's law (D.Lgs. 81/2008 art. 18 c.1 r) as the DS LawRef with our plain words. */
export function InailLaw() {
  const t = useWords()
  const ds = useDsWords()
  return <LawRef law={INCIDENT_LAW} plain={t('law.inailPlain')} labels={ds.lawRef} />
}

/** GDPR art. 9 for the people involved. */
export function PeopleLaw() {
  const t = useWords()
  const ds = useDsWords()
  return <LawRef law={PEOPLE_LAW} plain={t('law.peoplePlain')} labels={ds.lawRef} />
}

/** A section loading in its own shape; "Still loading…" shows by itself after about a second (CSS, no timer). */
export function SectionLoading({ rows = 4, height = 30 }: { rows?: number; height?: number }) {
  const t = useWords()
  return (
    <div className="fw-inc-loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? height + 4 : height} />
      ))}
      <span className="fw-inc-slow" role="status">
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

/** No safety.incidents.view: the page says so and reads nothing. */
export function NoIncidentsAccess() {
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
    <div className="fw-inc-head">
      <span className="fw-inc-head-title">
        <h2 id={id} className="fw-inc-h">
          {title}
        </h2>
        {note ? <span className="fw-inc-muted">{note}</span> : null}
      </span>
      {children ? <span className="fw-inc-tools">{children}</span> : null}
    </div>
  )
}

/** The list page's own keys, then the list frame's. */
export const LIST_KEYS = (t: Translate): ListKey[] => [
  { keys: ['c'], does: t('keys.report') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** The record's own keys. */
export const RECORD_KEYS = (t: Translate): ListKey[] => [
  { keys: ['f'], does: t('keys.filing') },
  { keys: ['?'], does: t('keys.all') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** `?` and the footer's "All shortcuts": every key of the page. */
export function KeysModal({ keys, onClose, withList = true }: { keys: readonly ListKey[]; onClose: () => void; withList?: boolean }) {
  const t = useWords()
  const lists = useT('lists')
  const entries = withList ? listKeys(keys) : keys
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-inc-list">
        {entries.map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}
