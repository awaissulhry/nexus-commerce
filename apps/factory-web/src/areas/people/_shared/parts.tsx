'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Modal, Tabs, type TabItem } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { listKeys, type ListKey } from '../../../list-frame/model'
import { formatTime } from '../../../lib/i18n/format'
import { useDsLabels } from '../../../lib/i18n/ds-labels'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import type { EmployeeKind, Lifecycle, Sight } from './api'
import { KIND_TONE, LIFECYCLE_TONE, TIME_ZONE, type Words } from './model'
import './people.css'

/**
 * View parts every People page shares (B-W2b-55): the catalogue wrapper (`people`, the list frame's `lists`, the DS
 * words), the state pills in words, the privacy note said before a People page reads any person (B-W2b-27's "what you
 * see here"), a notice, the record's band with its states, the keys list behind `?`. No colour carries a meaning alone:
 * each pill says its state.
 */

export const PEOPLE_NAMESPACES = ['people', 'lists', 'ds-words'] as const

export function PeopleMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={PEOPLE_NAMESPACES}>{children}</WithMessages>
}

export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The People pages' words (`people`). */
export function useWords(): Translate {
  const t = useT('people')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

export const say = (t: Translate, words: Words | null | undefined): string | null => (words ? t(words.key, words.params) : null)

/** The languages People says by name (the floor and documents languages offered); any other code is shown as written. */
export const LANGUAGES = ['it', 'en', 'ro', 'sq', 'ar', 'zh', 'ur', 'bn', 'es', 'fr', 'uk', 'pa', 'hi', 'fil'] as const
export const languageText = (t: Translate, code: string): string => ((LANGUAGES as readonly string[]).includes(code) ? t(`language.${code}`) : code.toUpperCase())

// ---- pills -------------------------------------------------------------------------------------------------------------------

export function LifecyclePill({ lifecycle }: { lifecycle: Lifecycle }) {
  const t = useWords()
  return (
    <Pill tone={LIFECYCLE_TONE[lifecycle]} dot>
      {t(`lifecycle.${lifecycle}`)}
    </Pill>
  )
}

export function KindTag({ kind }: { kind: EmployeeKind }) {
  const t = useWords()
  return <Tag tone={KIND_TONE[kind]}>{t(`kind.${kind}`)}</Tag>
}

// ---- the privacy note --------------------------------------------------------------------------------------------------------

/** The privacy rules read for the site, or why there are none to say. */
export type SightState = { status: 'loading' } | { status: 'allSites' } | { status: 'failed' } | { status: 'ready'; sight: Sight }

/**
 * What this page shows, said before anything about a person is read (plan §10; B-W2b-27 `GET /people/privacy/what-you-see`):
 * the HR register — names, job and team, never pay, attendance, health or a figure about one person's work — and who
 * may see one person's work figures at this site (the PERFORMANCE gate: off, the worker and HR, on request). The DS
 * PrivacyNote with the law as a LawRef; every word ours.
 */
export function PeoplePrivacyNote({ sight, variant = 'pill', text }: { sight: SightState; variant?: 'pill' | 'panel'; text?: string }) {
  const t = useWords()
  const ds = useDsLabels()
  const whoMore =
    sight.status === 'loading'
      ? t('privacy.reading')
      : sight.status === 'allSites'
        ? t('privacy.pickSite')
        : sight.status === 'failed'
          ? t('privacy.unread')
          : !sight.sight.open
            ? t('privacy.gateOff')
            : sight.sight.level === 'ONE_PERSON_ON_REQUEST'
              ? t('privacy.onRequest')
              : sight.sight.leadsSeeFigures
                ? t('privacy.workerHrLead')
                : t('privacy.workerHr')
  return (
    <PrivacyNote
      level="individual"
      variant={variant}
      text={text ?? t('privacy.register')}
      whoMore={whoMore}
      law={<LawRef law={t('privacy.law')} plain={t('privacy.lawPlain')} labels={ds.lawRef} />}
      labels={ds.privacyNote}
    />
  )
}

// ---- states ------------------------------------------------------------------------------------------------------------------

export function NoPeopleAccess({ permission = 'people.view' }: { permission?: string }) {
  const t = useWords()
  return <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('problem.forbidden')} description={t('problem.noPermission', { permission })} />
}

export interface Notice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly words: Words
  /** A second line (the fix of a refusal, a count). */
  readonly detail?: Words | null
}

export function NoticeBanner({ notice, onDismiss }: { notice: Notice | null; onDismiss?: () => void }) {
  const t = useWords()
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={say(t, notice.words) ?? ''}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.close')}
          </Button>
        ) : undefined
      }
    >
      {notice.detail ? say(t, notice.detail) : null}
    </Banner>
  )
}

/** A loaded thing: still reading, ready, not found, not allowed, or a failed read (a message key). */
export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'notFound' } | { status: 'forbidden' } | { status: 'error'; problem: string }

/** "Updated 10:42 · Live" — the page's freshness and the live stream's state, always in words. */
export function LiveLine({ asOf, live }: { asOf: string | null; live: 'connecting' | 'live' | 'offline' }) {
  const t = useWords()
  const locale = useLocale()
  return (
    <span className="fw-pp-status" role="status">
      {asOf ? t('list.updated', { time: formatTime(asOf, { locale, timeZone: TIME_ZONE }) }) : t('list.notYet')}
      {' · '}
      {t(`live.${live}`)}
    </span>
  )
}

export interface RecordFrameProps {
  backHref: string
  backLabel: string
  loaded: Loaded<unknown>
  /** The record's kind in words ("Employee"): the title while it loads or fails. */
  noun: string
  title?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  status?: ReactNode
  /** Under the chips: the privacy note of the record. */
  note?: ReactNode
  tabs?: TabItem[]
  tab?: string
  onRetry?: () => void
  children?: ReactNode
}

/** A record's band (‹ back, title, actions, chips, the live state, the privacy note, the tabs) and its states. */
export function RecordFrame({ backHref, backLabel, loaded, noun, title, meta, actions, status, note, tabs, tab, onRetry, children }: RecordFrameProps) {
  const t = useWords()
  const back = <Link href={backHref}>{backLabel}</Link>
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-pp">
        <div className="fw-pp-band">
          <DetailHeader backAsChild backLabel={back} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : noun} />
          {note}
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-pp-hint" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
            <div className="fw-pp-stack tight">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} height={22} />
              ))}
            </div>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={t(loaded.status === 'error' ? 'record.failed' : loaded.status === 'forbidden' ? 'problem.forbidden' : 'record.notFound')}
              description={loaded.status === 'error' ? t(loaded.problem) : loaded.status === 'forbidden' ? t('record.forbiddenBody') : t('record.notFoundBody')}
              action={
                loaded.status === 'error' ? (
                  <Button size="sm" onClick={onRetry}>
                    {t('common.retry')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={backHref}>{backLabel}</Link>
                  </Button>
                )
              }
            />
          </Card>
        )}
      </div>
    )
  }
  return (
    <div className="fw-pp">
      <div className="fw-pp-band">
        <DetailHeader backAsChild backLabel={back} title={title} actions={actions} />
        <div className="fw-pp-meta">
          <span className="fw-pp-chips">{meta}</span>
          {status && <span className="fw-pp-status">{status}</span>}
        </div>
        {note}
        {tabs && tab && <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={tab} size="sm" overflow="scroll" />}
      </div>
      {children}
    </div>
  )
}

/** `?` and the footer's "All shortcuts": every key of the screen (its own first, then the list frame's). */
export function KeysModal({ own, withSelection = true, onClose }: { own: readonly ListKey[]; withSelection?: boolean; onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-pp-list">
        {listKeys(own, withSelection).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}
