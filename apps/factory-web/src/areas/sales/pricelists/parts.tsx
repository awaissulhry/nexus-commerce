'use client'

import { type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, ShieldOff } from 'lucide-react'
import { Card, EmptyState, Modal, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { listKeys, type ListKey } from '../../../list-frame/model'
import { formatDate } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { Translate } from '../../../lib/i18n/messages'
import { WithMessages } from '../../../record-panels/i18n'
import type { PriceListKind, PriceListState, PriceVersion } from './api'
import { STATE_TONE, VERSION_TONE, type Phrase } from './model'
import './pricelists.css'

/**
 * View parts Sales › Price lists & contracts (SCR-106) shares between the list, the record and the dialogs: the
 * catalogue wrapper (`pricelists`, the list frame's `lists`), the state pill and kind tag in words, a version's days in
 * words, the record band with its states (loading, not found, no right, a failed read) and the keys list behind `?`.
 */

export const PRICELISTS_NAMESPACES = ['pricelists', 'lists'] as const

export function PriceListsMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={PRICELISTS_NAMESPACES}>{children}</WithMessages>
}

export const useWords = (): Translate => useT('pricelists')

export const say = (t: Translate, phrase: Phrase | null | undefined): string | null => (phrase ? t(phrase.key, phrase.params) : null)

export function StatePill({ state }: { state: PriceListState }) {
  const t = useWords()
  return <Pill tone={STATE_TONE[state]}>{t(`state.${state}`)}</Pill>
}

export function KindTag({ kind }: { kind: PriceListKind }) {
  const t = useWords()
  return <Tag tone={kind === 'BASE' ? 'info' : 'neutral'}>{t(`kind.${kind}`)}</Tag>
}

export function VersionPill({ version, today }: { version: Pick<PriceVersion, 'status' | 'validFrom' | 'validTo'>; today: string }) {
  const t = useWords()
  if (version.status === 'DRAFT') return <Pill tone={VERSION_TONE.DRAFT}>{t('versionState.DRAFT')}</Pill>
  const phase = version.validFrom && version.validFrom > today ? 'STARTS' : version.validTo && version.validTo < today ? 'ENDED' : 'IN_FORCE'
  return <Pill tone={phase === 'IN_FORCE' ? 'success' : phase === 'STARTS' ? 'info' : 'neutral'}>{t(`versionState.${phase}`)}</Pill>
}

/** A business day (YYYY-MM-DD) in the person's language. */
export function useDay(): (day: string | null | undefined) => string {
  const locale = useLocale()
  return (day) => (day ? formatDate(`${day}T12:00:00Z`, { locale }) : '—')
}

/** A version's days in words: "From 1 Nov 2026", "1 Nov 2026 – 31 Dec 2026", "Not planned". */
export function useValidity(): (from: string | null | undefined, to: string | null | undefined) => string {
  const t = useWords()
  const day = useDay()
  return (from, to) => (from && to ? t('validity.range', { from: day(from), to: day(to) }) : from ? t('validity.from', { from: day(from) }) : to ? t('validity.until', { to: day(to) }) : t('validity.none'))
}

/** The page says which permission is missing (design: "no permission" names it and the role that has it). */
export function NoListsAccess() {
  const t = useWords()
  return <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
}

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'not_found' } | { status: 'forbidden' }

export interface RecordFrameProps {
  backHref: string
  loaded: Loaded<unknown>
  title?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  status?: ReactNode
  tabs?: TabItem[]
  tab?: string
  onRetry?: () => void
  children?: ReactNode
}

/** The price list's band and its states: loading skeleton, not found, no right, a failed read with Try again. */
export function RecordFrame({ backHref, loaded, title, meta, actions, status, tabs, tab, onRetry, children }: RecordFrameProps) {
  const t = useWords()
  const back = <Link href={backHref}>{t('record.back')}</Link>
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-pl">
        <div className="fw-pl-band">
          <DetailHeader backAsChild backLabel={back} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.name')} />
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
              title={t(loaded.status === 'error' ? 'record.failed' : loaded.status === 'forbidden' ? 'noAccess.title' : 'record.notFound')}
              description={loaded.status === 'error' ? t(loaded.problem) : loaded.status === 'forbidden' ? t('noAccess.body') : t('record.notFoundBody')}
              action={
                loaded.status === 'error' ? (
                  <Button size="sm" onClick={onRetry}>
                    {t('common.retry')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={backHref}>{t('record.backToList')}</Link>
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

/** A failed or loading part of the record (a tab's rows), in words; the rest of the record stays usable. */
export function PartState({ problem, loading, label, onRetry }: { problem: string | null; loading: boolean; label: string; onRetry?: () => void }) {
  const t = useWords()
  if (problem) {
    return (
      <Card padded>
        <EmptyState
          title={t('record.partFailed', { part: label })}
          description={t(problem)}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        />
      </Card>
    )
  }
  if (!loading) return null
  return (
    <Card padded aria-busy="true">
      <p className="fw-pl-hint" role="status">
        <Spinner size={14} /> {t('record.partLoading', { part: label })}
      </p>
    </Card>
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

/** The band's live line: "Updated 09:42 · Live". */
export function Freshness({ asOf, live, time }: { asOf: string | null; live: 'connecting' | 'live' | 'offline'; time: (iso: string) => string }) {
  const t = useWords()
  return (
    <span className="fw-pl-hint" role="status">
      {asOf ? t('live.updated', { time: time(asOf) }) : t('live.notYet')} · {t(`live.${live}`)}
    </span>
  )
}
