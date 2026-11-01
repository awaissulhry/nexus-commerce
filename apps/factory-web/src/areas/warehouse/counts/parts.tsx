'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, ShieldOff } from 'lucide-react'
import { Card, EmptyState, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { CheckList as DsCheckList, type CheckItem } from '@nexus/ui/patterns/checklist/index'
import { Modal, useDsWords } from '../../../lib/i18n/ds-parts'
import { listKeys, type ListKey } from '../../../list-frame/model'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { money } from '../../_shared/stock/model'
import type { CountKind, CountRow, CountStatus } from './api'
import { COUNTS_NAMESPACES, scopeParts, STATUS_TONE, type Phrase } from './model'
import type { Loaded } from './view-model'
import '../../_shared/stock/stock.css'
import './counts.css'

/**
 * View parts Warehouse › Counts (SCR-132) shares between the list, the count record and the dialogs: the catalogue
 * wrapper and its words (`warehouse-counts`, `stock:<key>` for the shared stock words), the state pill and kind tag in
 * words, the scope in words, a cost amount (absent without the grain: the caller draws nothing), the record band with its
 * states, the steps as the DS CheckList (the design's ReadinessChecklist) and the keys list behind `?`.
 */

export function CountsMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={COUNTS_NAMESPACES}>{children}</WithMessages>
}

export type Words = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The pages' words: keys of `warehouse-counts`, and `stock:<key>` for the shared stock words (units, problems, live). */
export function useWords(): Words {
  const own = useT('warehouse-counts')
  const stock = useT('stock')
  return useMemo<Words>(() => (key, params) => (key.startsWith('stock:') ? stock(key.slice(6), params) : own(key, params)), [own, stock])
}

export const say = (t: Words, phrase: Phrase | null | undefined): string | null => (phrase ? t(phrase.key, phrase.params) : null)

export function StatusPill({ status }: { status: CountStatus }) {
  const t = useWords()
  return <Pill tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Pill>
}

/** The kind in words; `short` in a list's narrow column ("Cycle", "Year-end"). */
export function KindTag({ kind, short = false }: { kind: CountKind; short?: boolean }) {
  const t = useWords()
  return <Tag tone={kind === 'YEAR_END' ? 'info' : 'neutral'}>{t(`${short ? 'kindShort' : 'kind'}.${kind}`)}</Tag>
}

/** What the count counts, in words ("N-MAG · Magazzino pelli and under it · Leather"). */
export function scopeText(t: Words, scope: CountRow['scope']): string {
  return scopeParts(scope)
    .map((part) => t(part.key, part.params))
    .join(' · ')
}

/** A cost amount with its currency; "—" when it is not known. The caller draws nothing without the cost grain. */
export function Money({ minor, currency, signed = false }: { minor: number | null | undefined; currency: string; signed?: boolean }) {
  const locale = useLocale()
  if (minor === null || minor === undefined) return <span className="fw-st-num">—</span>
  const text = money(Math.abs(minor), currency, locale)
  return <span className="fw-st-num">{signed && minor !== 0 ? `${minor > 0 ? '+' : '−'}${text}` : text}</span>
}

/** The page says which permission is missing (design: "no permission" names it), never an empty list. */
export function NoCountsAccess() {
  const t = useWords()
  return <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('stock:problem.forbidden')} description={t('stock:problem.noPermission', { permission: 'inventory.counts.view' })} />
}

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

/** The count's band and its states: loading skeleton, not found, no right, a failed read with Try again. */
export function RecordFrame({ backHref, loaded, title, meta, actions, status, tabs, tab, onRetry, children }: RecordFrameProps) {
  const t = useWords()
  const back = <Link href={backHref}>{t('record.back')}</Link>
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-cn">
        <div className="fw-cn-band">
          <DetailHeader backAsChild backLabel={back} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.name')} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-cn-hint" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
            <div className="fw-cn-stack tight">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} height={22} />
              ))}
            </div>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={t(loaded.status === 'error' ? 'record.failed' : loaded.status === 'forbidden' ? 'stock:problem.forbidden' : 'record.notFound')}
              description={
                loaded.status === 'error'
                  ? t(`stock:${loaded.problem}`)
                  : loaded.status === 'forbidden'
                    ? t('stock:problem.noPermission', { permission: 'inventory.counts.view' })
                    : t('record.notFoundBody')
              }
              action={
                loaded.status === 'error' ? (
                  <Button size="sm" onClick={onRetry}>
                    {t('stock:problem.retry')}
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
    <div className="fw-cn">
      <div className="fw-cn-band">
        <DetailHeader backAsChild backLabel={back} title={title} actions={actions} />
        <div className="fw-cn-meta">
          <span className="fw-cn-chips">{meta}</span>
          {status && (
            <span className="fw-cn-status" role="status">
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

/** A failed or loading part of the record (a tab's lines), in words. */
export function PartState({ problem, loading, label, onRetry }: { problem: string | null; loading: boolean; label: string; onRetry?: () => void }) {
  const t = useWords()
  if (problem) {
    return (
      <Card padded>
        <EmptyState
          title={t('record.partFailed', { part: label })}
          description={t(`stock:${problem}`)}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                {t('stock:problem.retry')}
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
      <p className="fw-cn-hint" role="status">
        <Spinner size={14} /> {t('record.partLoading', { part: label })}
      </p>
    </Card>
  )
}

export type CheckState = 'done' | 'open' | 'failed' | 'skipped'

/** The count's step states as the DS CheckList's: a step still to do is open; a stopped count is a warning to read. */
const STEP_STATE: Record<CheckState, CheckItem['state']> = { done: 'pass', open: 'fail', failed: 'warning', skipped: 'skipped' }

/**
 * The count's steps as the DS CheckList (B-W2b-18; the design's ReadinessChecklist, composed here until B-W2b-09): each
 * step with its icon AND its word — the DS's Done / Not needed, the count's own "To do" and "Stopped" — and what it says
 * now. A list of steps, not a gate: no summary line.
 */
export function CheckList({ items }: { items: ReadonlyArray<{ id: string; state: CheckState; title: string; detail?: ReactNode }> }) {
  const t = useWords()
  const ds = useDsWords()
  return (
    <DsCheckList
      label={t('approval.steps')}
      summary={false}
      labels={{ ...ds.checkList, states: { ...ds.checkList.states, fail: t('check.state.open'), warning: t('check.state.failed') } }}
      checks={items.map((item) => ({ id: item.id, state: STEP_STATE[item.state], name: item.title, ...(item.detail ? { detail: item.detail } : {}) }))}
    />
  )
}

/** `?` and the footer's "All shortcuts": every key of the screen (its own first, then the list frame's). */
export function KeysModal({ own, withSelection = true, onClose }: { own: readonly ListKey[]; withSelection?: boolean; onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-cn-list">
        {listKeys(own, withSelection).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}
