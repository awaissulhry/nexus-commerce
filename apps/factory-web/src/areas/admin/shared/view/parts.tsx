'use client'

import type { ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { Banner, Card, EmptyState, Pagination, SummaryTable } from '@nexus/ui/components'
import { StepUpModal } from '@nexus/ui/patterns'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { GRAINS, type Grain, type Notice, type StepUpModel } from '../model'
import '../admin.css'

/**
 * The parts every Admin screen draws (B-W0-27), from design-system parts only. GrainChips is the design's new DS part
 * (02 "New DS parts": four small chips saying what money a person or role sees, in words, not colour), built here from
 * `Tag` until the DS adds it (DS gap, logged in the step notes). Everything fetches nothing.
 */

/** The Admin text (`admin`) and the record panels' (`records`), in the page's language. */
export function AdminMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['admin', 'records']}>{children}</WithMessages>
}

/**
 * The head of a list page under the shell's band (the band holds the title and the crumbs; the shell has no slot for a
 * page's status and actions yet, so they sit here, at the top of the page): one plain sentence, the freshness, and at
 * most two actions with the primary last.
 */
export function PageHead({ intro, asOf, actions }: { intro?: ReactNode; asOf?: string | null; actions?: ReactNode }) {
  const t = useT('admin')
  const locale = useLocale()
  return (
    <div className="fw-adm-head">
      <div className="fw-adm-head-text">
        {intro && <p className="fw-adm-intro">{intro}</p>}
        {asOf !== undefined && (
          <span className="fw-adm-asof" role="status">
            {asOf ? <time dateTime={asOf}>{t('list.updated', { time: formatTime(asOf, { locale }) })}</time> : t('list.notYet')}
          </span>
        )}
      </div>
      {actions && <div className="fw-adm-actions">{actions}</div>}
    </div>
  )
}

/** One notice (a receipt or a refusal) with a way to put it away. */
export function NoticeBanner({ notice, onDismiss }: { notice: Notice | null | undefined; onDismiss?: () => void }) {
  const t = useT('admin')
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

/** A read's three states before its rows: loading (skeleton rows in the list's shape), failed (Try again), empty. */
export function ListState({
  problem,
  loading,
  empty,
  onRetry,
  rows = 5,
}: {
  problem?: string | null
  loading: boolean
  empty?: { title: string; body?: string; action?: ReactNode; icon?: ReactNode } | null
  onRetry?: () => void
  rows?: number
}) {
  const t = useT('admin')
  if (problem) {
    return (
      <Card padded>
        <EmptyState
          title={t('list.failedTitle')}
          description={t(problem)}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  if (loading) {
    return (
      <Card padded aria-busy="true">
        <p className="fw-adm-loading" role="status">
          <Spinner size={14} /> {t('list.loading')}
        </p>
        <div className="fw-adm-skeleton">
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

/** A list's table: the DS SummaryTable (stacked on a phone) and its pager of 50 rows. */
export function ListTable({
  label,
  columns,
  rows,
  page,
  pageCount,
  onPage,
  widths,
  count,
}: {
  label: string
  columns: readonly string[]
  rows: ReadonlyArray<{ id: string; cells: readonly ReactNode[] }>
  page: number
  pageCount: number
  onPage?: (page: number) => void
  widths?: ReadonlyArray<string | undefined>
  /** The rows shown and how many match ("12 of 48"). */
  count?: string
}) {
  return (
    <Card className="fw-adm-tablecard">
      {count && (
        <p className="fw-adm-count" role="status">
          {count}
        </p>
      )}
      <div className="fw-adm-table">
        <SummaryTable label={label} columns={columns} rows={rows} density="roomy" stackOnPhone widths={widths} align={columns.map(() => 'left')} />
      </div>
      {pageCount > 1 && (
        <div className="fw-adm-pager">
          <Pagination page={page} pageCount={pageCount} onPage={(next) => onPage?.(next)} />
        </div>
      )}
    </Card>
  )
}

/** What money a person or a role sees: price · cost · margin · wages, each ticked or crossed, in words. */
export function GrainChips({ grains, label }: { grains: readonly string[]; label?: string }) {
  const t = useT('admin')
  const held = new Set(grains)
  return (
    <span className="fw-adm-grains" role="list" aria-label={label ?? t('grains.label')}>
      {GRAINS.map((grain: Grain) => {
        const sees = held.has(grain)
        return (
          <span key={grain} role="listitem">
            <Tag tone={sees ? 'success' : 'neutral'}>
              {sees ? <Check size={11} aria-hidden className="fw-adm-grain-icon" /> : <X size={11} aria-hidden className="fw-adm-grain-icon" />}
              <span className="fw-adm-sr">{t(sees ? 'grains.sees' : 'grains.doesNotSee')} </span>
              {t(`grains.short.${grain}`)}
            </Tag>
          </span>
        )
      })}
    </span>
  )
}

/** The step-up dialog in the page's words (DS StepUpModal). */
export function StepUp({ model, onSubmit, onClose, confirmLabel }: { model: StepUpModel | undefined; onSubmit?: (code: string) => void; onClose?: () => void; confirmLabel?: string }) {
  const t = useT('admin')
  if (!model) return null
  return (
    <StepUpModal
      open={model.open}
      title={t('stepUp.title')}
      sentence={t(model.sentence)}
      busy={model.busy}
      error={model.problem ? t(model.problem) : null}
      confirmLabel={confirmLabel ?? t('stepUp.confirm')}
      onSubmit={(code) => onSubmit?.(code)}
      onClose={() => onClose?.()}
    />
  )
}

/** A record page whose record is missing, or whose read failed, or which the person may not open. */
export function RecordProblem({ problem, back, onRetry }: { problem: string; back: ReactNode; onRetry?: () => void }) {
  const t = useT('admin')
  return (
    <Card padded>
      <EmptyState
        title={t(problem === 'problem.notFound' ? 'record.notFoundTitle' : problem === 'problem.forbidden' ? 'record.forbiddenTitle' : 'record.failedTitle')}
        description={t(problem)}
        action={
          <span className="fw-adm-actions">
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
  )
}

/** A page the person may not open: what they would need, in words (never a locked box). */
export function NoAccess({ need }: { need: string }) {
  const t = useT('admin')
  return (
    <Card padded>
      <EmptyState title={t('record.forbiddenTitle')} description={t('noAccess.body', { need: t(need) })} />
    </Card>
  )
}

/** "—" for an unknown value (never 0, never empty). */
export const dash = (value: ReactNode | null | undefined): ReactNode => (value === null || value === undefined || value === '' ? '—' : value)

/**
 * A role's name and plain line in the page's language: a ready-made role's from this web's words (its template is
 * written in English in factory-domain), a custom role's as the tenant wrote it.
 */
export function useRoleWords() {
  const t = useT('admin')
  const custom = (key: string) => key.startsWith('custom.')
  const word = (key: string, field: 'name' | 'description'): string | null => {
    const id = `roles.system.${key}.${field}`
    const text = t(id)
    return text === id ? null : text
  }
  return {
    name: (role: { key: string; name: string }) => (custom(role.key) ? role.name : (word(role.key, 'name') ?? role.name)),
    description: (role: { key: string; description: string | null }) => (custom(role.key) ? role.description : (word(role.key, 'description') ?? role.description)),
  }
}
