'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { FileX, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd, Skeleton, Spinner } from '@nexus/ui/primitives'
import { EditModeBar, Modal } from '../../../lib/i18n/ds-parts'
import { formatTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import type { Notice } from './model'
import './library.css'

/**
 * The parts the product libraries draw (Materials & trims, Operations, Sizes & measurements), from design-system parts
 * only; nothing here fetches. The shell has no slot for a page's status and actions yet (`usePageBand`, design 00 §6.3:
 * a DS gap), so a list draws a head row and a record its band with the DS DetailHeader.
 */

/** The libraries' catalogue plus the list frame's words (`lists`). */
export function LibraryMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['library', 'lists']}>{children}</WithMessages>
}

/** "Updated 10:42" (or "Not read yet"), announced politely. */
export function Freshness({ asOf }: { asOf: string | null }) {
  const t = useT('library')
  const locale = useLocale()
  return (
    <span className="fw-lib-hint" role="status">
      {asOf ? t('common.updated', { time: formatTime(asOf, { locale }) }) : t('common.notYet')}
    </span>
  )
}

/** A list page's head: one plain sentence, the freshness, the actions (primary last). */
export function PageHead({ intro, status, actions }: { intro: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="fw-lib-head">
      <div className="fw-lib-head-text">
        <p className="fw-lib-hint">{intro}</p>
        {status}
      </div>
      {actions && <div className="fw-lib-actions">{actions}</div>}
    </div>
  )
}

/** One notice at a time (the most serious first), with Dismiss when the page offers it. */
export function NoticeBanner({ notice, onDismiss }: { notice: Notice | null | undefined; onDismiss?: () => void }) {
  const t = useT('library')
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={t(notice.key, notice.params)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}

/**
 * What a list draws in place of its rows: no access (with the role that has it), a failed read (never drawn as an empty
 * list), nothing matching the filters, nothing yet (with the first action).
 */
export function listState({
  problem,
  rows,
  filtered,
  forbidden,
  empty,
  onRetry,
  onClear,
}: {
  problem: string | null
  rows: readonly unknown[] | null
  filtered: boolean
  forbidden: { title: string; body: string }
  empty: { title: string; body: string; action?: ReactNode }
  onRetry?: () => void
  onClear?: () => void
}): ReactNode | undefined {
  return <ListState problem={problem} rows={rows} filtered={filtered} forbidden={forbidden} empty={empty} onRetry={onRetry} onClear={onClear} />
}

function ListState({ problem, rows, filtered, forbidden, empty, onRetry, onClear }: Parameters<typeof listState>[0]) {
  const t = useT('library')
  if (problem === 'problem.read.forbidden') return <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={forbidden.title} description={forbidden.body} />
  if (problem)
    return (
      <EmptyState
        title={t('list.failed')}
        description={t(problem)}
        action={
          <Button size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        }
      />
    )
  if (rows && rows.length === 0)
    return filtered ? (
      <EmptyState
        title={t('list.noMatch.title')}
        description={t('list.noMatch.body')}
        action={
          <Button size="sm" onClick={onClear}>
            {t('list.clearAll')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={empty.title} description={empty.body} action={empty.action} />
    )
  return null
}

/** Whether a list draws a state instead of rows (the same rule as ListState). */
export const showsState = (problem: string | null, rows: readonly unknown[] | null): boolean => problem !== null || (rows !== null && rows.length === 0)

export interface RecordTab {
  id: string
  label: ReactNode
  count?: number | null
}

/**
 * A record's band (design 00 §2.2; Owner L1: the tabs always in view): ‹ back (a real link), the record's name, its
 * meta, its state, the actions (primary first, ⋯ last), a status row and the link tabs (`?tab=`).
 */
export function RecordFrame({
  back,
  title,
  meta,
  status,
  actions,
  facts,
  tabs,
  active,
  tabHref,
  children,
}: {
  back: { href: string; label: string }
  title: ReactNode
  meta?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  /** The row under the title: pills and tags, the save words. */
  facts?: ReactNode
  tabs: readonly RecordTab[]
  active: string
  tabHref: (tab: string) => string
  children?: ReactNode
}) {
  const t = useT('library')
  const items: TabItem[] = tabs.map((tab) => ({ id: tab.id, label: tab.label, count: tab.count ?? null, href: tabHref(tab.id) }))
  return (
    <div className="fw-lib">
      <div className="fw-lib-band">
        <DetailHeader backAsChild backLabel={<Link href={back.href}>{back.label}</Link>} title={title} meta={meta} status={status} actions={actions ? <span className="fw-lib-actions">{actions}</span> : undefined} />
        {facts && <div className="fw-lib-facts">{facts}</div>}
        {items.length > 1 && <Tabs ariaLabel={t('record.tabsLabel')} tabs={items} active={active} size="sm" overflow="scroll" />}
      </div>
      {children}
    </div>
  )
}

/** A record that is loading, missing, refused or failed: the band with ‹ back, then the state in words. */
export function RecordState({ back, state, problem, onRetry }: { back: { href: string; label: string }; state: 'loading' | 'error' | 'notFound' | 'forbidden'; problem?: string | null; onRetry?: () => void }) {
  const t = useT('library')
  return (
    <div className="fw-lib">
      <div className="fw-lib-band">
        <DetailHeader backAsChild backLabel={<Link href={back.href}>{back.label}</Link>} title={state === 'loading' ? <Skeleton width={240} height={22} /> : t(`record.state.${state}.title`)} />
      </div>
      {state === 'loading' ? (
        <Card padded aria-busy="true">
          <p className="fw-lib-hint fw-lib-inline" role="status">
            <Spinner size={14} /> {t('record.loading')}
          </p>
          <div className="fw-lib-skeleton">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} height={22} />
            ))}
          </div>
        </Card>
      ) : (
        <Card padded>
          <EmptyState
            icon={state === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
            title={t(`record.state.${state}.title`)}
            description={state === 'error' && problem ? t(problem) : t(`record.state.${state}.body`)}
            action={
              state === 'error' ? (
                <Button size="sm" onClick={onRetry}>
                  {t('common.retry')}
                </Button>
              ) : (
                <Button size="sm" asChild>
                  <Link href={back.href}>{t('record.backToList')}</Link>
                </Button>
              )
            }
          />
        </Card>
      )}
    </div>
  )
}

/** The page's keys in one dialog (`?` and ⋯ › Keyboard shortcuts): a `lists` key (`keys.open`) or the page's own words. */
export function KeysDialog({ keys, onClose }: { keys: ReadonlyArray<{ keys: readonly string[]; does: string }>; onClose: () => void }) {
  const t = useT('library')
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-lib-keymap">
        {keys.map((entry) => (
          <div key={entry.does} className="fw-lib-keymap-row">
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}

/** Save words in the band: saving…, saved at, could not save. */
export function SaveWords({ state, at }: { state: 'idle' | 'saving' | 'failed'; at: string | null }) {
  const t = useT('library')
  const locale = useLocale()
  if (state === 'saving')
    return (
      <span className="fw-lib-hint fw-lib-inline" role="status">
        <Spinner size={12} /> {t('save.saving')}
      </span>
    )
  if (state === 'failed')
    return (
      <span className="fw-lib-hint fw-lib-warn" role="status">
        {t('save.failed')}
      </span>
    )
  return (
    <span className="fw-lib-hint" role="status">
      {at ? t('save.saved', { time: formatTime(at, { locale }) }) : ''}
    </span>
  )
}

/**
 * The bar of a form with unsaved changes (explicit save) = the DS EditModeBar (B-W2b-18; composed here while its words
 * were English only): how many changes, Discard, Save; ⌘S / Ctrl+S saves (not while held or busy); leaving the page
 * asks first while changes wait.
 */
export function SaveBar({ count, onDiscard, onSave, held, busy, saveLabel }: { count: number; onDiscard: () => void; onSave: () => void; held: string | null; busy: boolean; saveLabel: string }) {
  const t = useT('library')
  return <EditModeBar count={count} onDiscard={onDiscard} onApply={onSave} applyLabel={saveLabel} busy={busy} applyHeldReason={held ?? (busy ? t('held.busy') : null)} saveShortcut />
}

/** A form's field that the person may read but not change: the value as text (never a greyed input). */
export function ReadField({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="fw-lib-readfield">
      <span className="fw-lib-readfield-label">{label}</span>
      <span className="fw-lib-readfield-value">{value === null || value === undefined || value === '' ? '—' : value}</span>
      {hint && <span className="fw-lib-sub">{hint}</span>}
    </div>
  )
}
