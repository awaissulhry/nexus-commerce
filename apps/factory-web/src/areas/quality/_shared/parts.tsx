'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { CircleAlert, CircleCheck, CircleDashed, CircleMinus, MessageSquare } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader, StepUpModal } from '@nexus/ui/patterns'
import { Button, Kbd, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import type { StepUpState } from './hooks'
import type { LiveState, Notice } from './model'
import './quality.css'

/**
 * The parts every quality screen of this step draws (Inspections, the inspection record, the evidence trail, Tests &
 * substances, the PPE register), from design-system parts only; nothing here fetches. Where the design names a DS part
 * that does not exist yet it is composed here and named in the step notes: the page band (`usePageBand`: a head row
 * here), LiveUpdates (a Button), GateExplainer (the check list below), SignOffPanel, TraceTree, EvidenceChain.
 */

/** The screen's catalogues plus the shared `quality` words, the list frame's (`lists`) and the record panels' (`records`). */
export function QualityMessages({ namespaces = [], children }: { namespaces?: readonly string[]; children?: ReactNode }) {
  return <WithMessages namespaces={['quality', 'lists', 'records', ...namespaces]}>{children}</WithMessages>
}

/** "—" for an unknown value (never 0, never empty). */
export const dash = (value: ReactNode | null | undefined): ReactNode => (value === null || value === undefined || value === '' ? '—' : value)

/** The freshness and the live state, in words ("Updated 10:42 · Live"). */
export function Freshness({ asOf, live }: { asOf: string | null; live: LiveState }) {
  const t = useT('quality')
  const locale = useLocale()
  return (
    <span className="fw-q-asof" role="status">
      {asOf ? <time dateTime={asOf}>{t('common.updated', { time: formatTime(asOf, { locale }) })}</time> : t('common.notYet')}
      {' · '}
      {t(`live.${live}`)}
    </span>
  )
}

/**
 * The head of a page under the shell's band (the band holds the title and the crumbs; the shell has no slot for a
 * page's status and actions yet — `usePageBand`, design 00 §6.3 — so they sit here): one plain sentence, the
 * freshness, and at most two actions with the primary last.
 */
export function PageHead({ intro, status, actions }: { intro?: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="fw-q-head">
      <div className="fw-q-head-text">
        {intro && <p className="fw-q-intro">{intro}</p>}
        {status}
      </div>
      {actions && <div className="fw-q-actions">{actions}</div>}
    </div>
  )
}

/** One notice (a receipt or a refusal) in the screen's catalogue, with the API's sentences under it when it sent facts. */
export function NoticeBanner({ notice, namespace = 'quality', onDismiss }: { notice: Notice | null | undefined; namespace?: string; onDismiss?: () => void }) {
  const t = useT(namespace)
  const q = useT('quality')
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={t(notice.key, notice.params)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {q('common.dismiss')}
          </Button>
        ) : undefined
      }
    >
      {notice.detail && notice.detail.length > 0 && (
        <ul className="fw-q-lines">
          {notice.detail.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

/** A read's states before its content: loading (skeleton), failed (the problem in words + Try again), empty. */
export function ReadState({
  problem,
  loading,
  empty,
  onRetry,
  rows = 4,
  failedTitle,
}: {
  problem?: string | null
  loading: boolean
  empty?: { title: string; body?: string; action?: ReactNode; icon?: ReactNode } | null
  onRetry?: () => void
  rows?: number
  failedTitle?: string
}) {
  const t = useT('quality')
  if (problem) {
    return (
      <Card padded>
        <EmptyState
          title={failedTitle ?? t('common.failedTitle')}
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
  if (loading) {
    return (
      <Card padded aria-busy="true">
        <p className="fw-q-loading" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
        <div className="fw-q-skeleton">
          {Array.from({ length: rows }, (_, index) => (
            <Skeleton key={index} height={20} />
          ))}
        </div>
      </Card>
    )
  }
  if (empty) {
    return (
      <Card padded>
        <EmptyState icon={empty.icon} title={empty.title} description={empty.body} action={empty.action} />
      </Card>
    )
  }
  return null
}

/** A page the person may not open: which permission it needs and who grants it, in words (never a locked box). */
export function NoAccess({ title, body }: { title: string; body: string }) {
  return (
    <div className="fw-q">
      <Card padded>
        <EmptyState title={title} description={body} />
      </Card>
    </div>
  )
}

export interface RecordTabItem {
  id: string
  label: string
  /** Null draws nothing (unknown), 0 is an answer. */
  count?: number | null
}

/**
 * The record frame (design 00 §2.2; Owner L1: the record's tabs always in view): ‹ back (a real link to the list), the
 * record's name, its identity, its state, at most two actions and ⋯; then the record's sections as link tabs (`?tab=`)
 * with counts. The shell has no slot for a record's band yet (`usePageBand`, 00 §6.3): the record draws its head at the
 * top of the page with the DS DetailHeader. Owner O1: on a wide screen (1280 px and wider) the thread can stay beside
 * any tab (⌘J) when the record has one; narrower the same button opens Activity.
 */
export function RecordFrame({
  back,
  title,
  meta,
  status,
  actions,
  tabs,
  active,
  tabHref,
  dock,
  dockOpen,
  onDock,
  children,
}: {
  back: { href: string; label: string }
  title: ReactNode
  meta?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  tabs: readonly RecordTabItem[]
  active: string
  tabHref: (tab: string) => string
  dock?: ReactNode
  dockOpen?: boolean
  onDock?: () => void
  children?: ReactNode
}) {
  const t = useT('quality')
  useEffect(() => {
    if (!dock || !onDock) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        onDock()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dock, onDock])

  const items: TabItem[] = tabs.map((tab) => ({ id: tab.id, label: tab.label, count: tab.count, href: tabHref(tab.id) }))
  const showDock = !!dock && !!dockOpen
  return (
    <div className="fw-q-record">
      <div className="fw-q-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={back.href}>{back.label}</Link>}
          title={title}
          meta={meta}
          status={status}
          actions={
            <>
              {actions}
              {dock && (
                <Button size="sm" variant={dockOpen ? 'tonal' : 'secondary'} active={!!dockOpen} aria-pressed={!!dockOpen} onClick={() => onDock?.()} title={t('record.dockHint')}>
                  <MessageSquare size={14} aria-hidden /> {t('record.dock')}
                  <span className="fw-q-keys" aria-hidden>
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </span>
                </Button>
              )}
            </>
          }
        />
        {items.length > 1 && <Tabs ariaLabel={t('record.tabsLabel')} tabs={items} active={active} size="sm" overflow="scroll" />}
      </div>
      <div className={showDock ? 'fw-q-record-body has-dock' : 'fw-q-record-body'}>
        <div className="fw-q-record-main">{children}</div>
        {showDock && (
          <aside className="fw-q-record-dock" aria-label={t('record.dockLabel')}>
            {dock}
          </aside>
        )}
      </div>
    </div>
  )
}

/** A record page whose record is missing, whose read failed, or which the person may not open. */
export function RecordProblem({ problem, back, onRetry }: { problem: string; back: ReactNode; onRetry?: () => void }) {
  const t = useT('quality')
  const title = problem === 'problem.notFound' ? 'record.notFoundTitle' : problem === 'problem.forbidden' ? 'record.forbiddenTitle' : 'record.failedTitle'
  return (
    <div className="fw-q">
      <Card padded>
        <EmptyState
          title={t(title)}
          description={t(problem === 'problem.notFound' ? 'record.notFoundBody' : problem)}
          action={
            <span className="fw-q-actions">
              {back}
              {onRetry && problem !== 'problem.notFound' && problem !== 'problem.forbidden' && (
                <Button size="sm" onClick={onRetry}>
                  {t('common.retry')}
                </Button>
              )}
            </span>
          }
        />
      </Card>
    </div>
  )
}

/** The skeleton of a record: band, tabs and body in their places. */
export function RecordSkeleton() {
  const t = useT('quality')
  return (
    <div className="fw-q" aria-busy="true">
      <p className="fw-q-loading" role="status">
        <Spinner size={14} /> {t('record.loading')}
      </p>
      <Skeleton height={36} width="40%" />
      <Skeleton height={28} width="60%" />
      <div className="fw-q-two">
        <Skeleton height={220} />
        <Skeleton height={220} />
      </div>
    </div>
  )
}

/** A check's state (a gate, a release checklist, a duty): done, open, not needed, or unknown. */
export type CheckState = 'OK' | 'OPEN' | 'NOT_NEEDED' | 'UNKNOWN'

export interface CheckLine {
  id: string
  state: CheckState
  /** What the check says (the API's sentence for a gate; our words for a duty). */
  text: ReactNode
  /** How to clear it, when it is open. */
  fix?: ReactNode | null
  /** A short name of the check ("Certificate", "Labels"), read before the sentence. */
  name?: ReactNode
  /** Another word for the state, a `quality` key (`check.NOT_YET` for a step that comes later). */
  word?: string
}

const CHECK_ICON: Record<CheckState, ReactNode> = {
  OK: <CircleCheck size={16} aria-hidden />,
  OPEN: <CircleAlert size={16} aria-hidden />,
  NOT_NEEDED: <CircleMinus size={16} aria-hidden />,
  UNKNOWN: <CircleDashed size={16} aria-hidden />,
}

/**
 * The gate in words (design GateExplainer, a DS part not built yet: composed here): each check as a line with its mark
 * AND a word (✓ Done / ! Open / – Not needed / ? Unknown — never colour alone), its sentence and, when open, how to fix it.
 */
export function CheckList({ checks, label }: { checks: readonly CheckLine[]; label: string }) {
  const t = useT('quality')
  return (
    <ul className="fw-q-checks" aria-label={label}>
      {checks.map((check) => (
        <li key={check.id} className="fw-q-check" data-state={check.state}>
          <span className="fw-q-check-mark">
            {CHECK_ICON[check.state]}
            <span className="fw-q-check-word">{t(check.word ?? `check.${check.state}`)}</span>
          </span>
          <span className="fw-q-check-text">
            {check.name && <span className="fw-q-check-name">{check.name}</span>}
            <span>{check.text}</span>
            {check.state === 'OPEN' && check.fix && <span className="fw-q-hint">{check.fix}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The DS step-up dialog in this screen's words (what the code allows; the refusal of a code). */
export function StepUpDialog({ state, onSubmit, onCancel, confirmLabel }: { state: StepUpState; onSubmit: (code: string) => void; onCancel: () => void; confirmLabel?: string }) {
  const t = useT('quality')
  return (
    <StepUpModal
      open={state.open}
      title={t('stepUp.title')}
      sentence={state.sentence ? t(state.sentence) : ''}
      busy={state.busy}
      error={state.problem ? t(state.problem) : null}
      onSubmit={onSubmit}
      onClose={onCancel}
      confirmLabel={confirmLabel ?? t('stepUp.confirm')}
    />
  )
}

/** A short label: value pair inside a sentence row ("Lot size 48 · Sample 13"). */
export function Facts({ items }: { items: readonly { label: string; value: ReactNode }[] }) {
  return (
    <dl className="fw-q-facts">
      {items.map((item) => (
        <div key={item.label} className="fw-q-fact">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A section card with a heading row (title, a sentence, actions on the right). */
export function Section({ title, sub, actions, children, id }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <Card padded>
      <section className="fw-q-section" aria-labelledby={id}>
        <div className="fw-q-section-head">
          <div className="fw-q-section-title">
            <h2 id={id}>{title}</h2>
            {sub && <p className="fw-q-hint">{sub}</p>}
          </div>
          {actions && <div className="fw-q-actions">{actions}</div>}
        </div>
        {children}
      </section>
    </Card>
  )
}
