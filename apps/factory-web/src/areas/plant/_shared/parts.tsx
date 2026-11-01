'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, FileX, Lock, ShieldOff, Wrench } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, StepUpModal } from '../../../lib/i18n/ds-parts'
import { listKeys, type ListKey } from '../../../list-frame/model'
import { formatNumber, formatTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { iconOf } from '../../../lib/plant/symptom-icons'
import type { JobStatus, MachineStatus, Priority, RequestStatus, Symptom } from './api'
import { JOB_TONE, labelOf, MACHINE_TONE, PRIORITY_TONE, REQUEST_TONE, TIME_ZONE, type Words } from './model'
import './plant.css'

/**
 * View parts every Plant maintenance page shares (B-W2a-53): the catalogue wrapper (`plant`, the list frame's `lists`,
 * the icon reason grid's `reason-kit`, the board's `boardview-kit`), the state pills in words, a symptom's icon and words
 * (the group's own words in the page's language), a cost amount (drawn only with the cost grain), a notice, the record
 * band with its states, the keys list behind `?` and the step-up dialog of a signing act. No colour carries a meaning
 * alone: each pill says its state.
 */

export const PLANT_NAMESPACES = ['plant', 'lists', 'reason-kit', 'boardview-kit', 'photo-kit'] as const

export function PlantMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={PLANT_NAMESPACES}>{children}</WithMessages>
}

export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The Plant pages' words (`plant`). */
export function useWords(): Translate {
  const t = useT('plant')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

export const say = (t: Translate, words: Words | null | undefined): string | null => (words ? t(words.key, words.params) : null)

// ---- pills -------------------------------------------------------------------------------------------------------------------

export function MachinePill({ status, locked = false }: { status: MachineStatus; locked?: boolean }) {
  const t = useWords()
  return (
    <Pill tone={MACHINE_TONE[status]} dot>
      {locked ? (
        <>
          <Lock size={11} aria-hidden /> {t('machineStatus.LOCKED')}
        </>
      ) : (
        t(`machineStatus.${status}`)
      )}
    </Pill>
  )
}

export function RequestPill({ status }: { status: RequestStatus }) {
  const t = useWords()
  return <Pill tone={REQUEST_TONE[status]}>{t(`requestStatus.${status}`)}</Pill>
}

export function JobPill({ status }: { status: JobStatus }) {
  const t = useWords()
  return <Pill tone={JOB_TONE[status]}>{t(`jobStatus.${status}`)}</Pill>
}

export function PriorityTag({ priority }: { priority: Priority }) {
  const t = useWords()
  return (
    <Tag tone={PRIORITY_TONE[priority]} title={t(`priorityHint.${priority}`)}>
      {t(`priority.${priority}`)}
    </Tag>
  )
}

export function UnsafeTag({ signed = false }: { signed?: boolean }) {
  const t = useWords()
  return signed ? (
    <Tag tone="neutral">{t('unsafe.signed')}</Tag>
  ) : (
    <Tag tone="danger">
      <AlertTriangle size={11} aria-hidden /> {t('unsafe.tag')}
    </Tag>
  )
}


// ---- symptoms ----------------------------------------------------------------------------------------------------------------

/** The icons of the group's lists (factory-domain plant/starter ids → lucide): one map in src/lib, shared with the floor. */
export { iconOf }

/** A symptom as the queue shows it: its icon and its words (the group's own, in the page's language); none: the words typed. */
export function SymptomText({ symptom, description }: { symptom: Symptom | null; description?: string | null }) {
  const t = useWords()
  const locale = useLocale()
  if (!symptom) {
    return (
      <span className="fw-pl-symptom">
        <Wrench size={14} aria-hidden />
        <span className="fw-pl-ellipsis">{description || t('symptom.none')}</span>
      </span>
    )
  }
  const Icon = iconOf(symptom.icon)
  return (
    <span className="fw-pl-symptom">
      <Icon size={14} aria-hidden />
      <span className="fw-pl-ellipsis">{labelOf(symptom, locale)}</span>
    </span>
  )
}

// ---- money -------------------------------------------------------------------------------------------------------------------

/**
 * A machine's purchase cost (minor units of the company's currency; the API gives no currency on the machine, so the
 * company's euro is assumed — named in the step's notes). The caller draws nothing without the cost grain.
 */
export function Cost({ minor }: { minor: number | null | undefined }) {
  const locale = useLocale()
  if (minor === null || minor === undefined) return <span className="fw-pl-num">—</span>
  return <span className="fw-pl-num">{formatNumber(minor / 100, locale, { style: 'currency', currency: 'EUR' })}</span>
}

// ---- states ------------------------------------------------------------------------------------------------------------------

export function NoPlantAccess({ permission = 'plant.view' }: { permission?: string }) {
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

export interface RecordFrameProps {
  backHref: string
  backLabel: string
  loaded: Loaded<unknown>
  /** The record's kind in words ("Maintenance job"): the title while it loads or fails. */
  noun: string
  title?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  status?: ReactNode
  tabs?: TabItem[]
  tab?: string
  permission?: string
  onRetry?: () => void
  children?: ReactNode
}

/** A record's band (‹ back, title, actions, chips, the live state, the tabs) and its states. */
export function RecordFrame({ backHref, backLabel, loaded, noun, title, meta, actions, status, tabs, tab, permission = 'plant.view', onRetry, children }: RecordFrameProps) {
  const t = useWords()
  const back = <Link href={backHref}>{backLabel}</Link>
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-pl">
        <div className="fw-pl-band">
          <DetailHeader backAsChild backLabel={back} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : noun} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-pl-hint" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
            <div className="fw-pl-stack tight">
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
              description={loaded.status === 'error' ? t(loaded.problem) : loaded.status === 'forbidden' ? t('problem.noPermission', { permission }) : t('record.notFoundBody')}
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
    <div className="fw-pl">
      <div className="fw-pl-band">
        <DetailHeader backAsChild backLabel={back} title={title} actions={actions} />
        <div className="fw-pl-meta">
          <span className="fw-pl-chips">{meta}</span>
          {status && (
            <span className="fw-pl-status" role="status">
              {status}
            </span>
          )}
        </div>
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
      <ul className="fw-pl-list">
        {listKeys(own, withSelection).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/** The step-up of a signing act, open while the API waits for a fresh code (`StepUpState` of hooks.ts). */
export interface StepUpState {
  readonly open: boolean
  readonly busy: boolean
  /** A message key of what the code allows. */
  readonly sentence: string
  /** A message key of the last refusal of a code. */
  readonly problem: string | null
}

export const STEP_UP_CLOSED: StepUpState = Object.freeze({ open: false, busy: false, sentence: '', problem: null })

/**
 * The fresh authenticator code of a signing act (design 00 §3.8: asked at the moment of the act): the DS StepUpModal
 * (B-W2b-18; it was composed here while the DS part spoke English only) with this screen's title, sentence, verb and
 * refusal — six digits arm the verb, Enter signs, the field comes back focused after a refused code.
 */
export function StepUpDialog({ state, onSubmit, onCancel }: { state: StepUpState; onSubmit?: (code: string) => void; onCancel?: () => void }) {
  const t = useWords()
  return (
    <StepUpModal
      open={state.open}
      title={t('stepUp.title')}
      sentence={state.sentence ? t(state.sentence) : ''}
      busy={state.busy}
      error={state.problem ? t(state.problem) : null}
      onSubmit={(code) => onSubmit?.(code)}
      onClose={() => onCancel?.()}
      confirmLabel={t('stepUp.confirm')}
    />
  )
}

/** "Updated 10:42 · Live" — the list's freshness and the live stream's state, always in words. */
export function LiveLine({ asOf, live }: { asOf: string | null; live: 'connecting' | 'live' | 'offline' }) {
  const t = useWords()
  const locale = useLocale()
  return (
    <span className="fw-pl-status" role="status">
      {asOf ? t('list.updated', { time: formatTime(asOf, { locale, timeZone: TIME_ZONE }) }) : t('list.notYet')}
      {' · '}
      {t(`live.${live}`)}
    </span>
  )
}
