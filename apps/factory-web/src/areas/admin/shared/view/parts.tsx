'use client'

import { Fragment, useMemo, type ReactNode } from 'react'
import { Check, Search, X } from 'lucide-react'
import { Banner, Card, EmptyState, Modal } from '@nexus/ui/components'
import { SelectionLabel } from '@nexus/ui/grid'
import { StepUpModal } from '@nexus/ui/patterns'
import { Button, Input, Kbd, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
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

/**
 * One notice (a receipt or a refusal) with a way to put it away. A bulk run's notice says how many were done and how
 * many refused ("2 suspended · 1 refused"), then names each refused row with its problem.
 */
export function NoticeBanner({ notice, onDismiss }: { notice: Notice | null | undefined; onDismiss?: () => void }) {
  const t = useT('admin')
  if (!notice) return null
  const refused = notice.refused ?? []
  const done = Number(notice.params?.count ?? 0)
  const title =
    refused.length === 0 ? t(notice.key, notice.params) : done === 0 ? t('common.bulk.none', { count: refused.length }) : `${t(notice.key, notice.params)} · ${t('common.bulk.refused', { count: refused.length })}`
  return (
    <Banner
      tone={notice.tone}
      title={title}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.dismiss')}
          </Button>
        ) : undefined
      }
    >
      {refused.length > 0 && (
        <ul className="fw-adm-guards">
          {refused.map((row, index) => (
            <li key={`${row.name}-${index}`}>
              {row.name} — {t(row.problem)}
            </li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

/** A held reason in words: a right the person lacks (`right.…` → "Needs the right: …"), or the rule's own sentence. */
export function heldText(t: (key: string, params?: Record<string, string | number>) => string, reason: string | null | undefined): string | null {
  if (!reason) return null
  return reason.startsWith('right.') ? t('held.needs', { right: t(reason) }) : t(reason)
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

/**
 * What a list frame draws in place of its grid (the toolbar stays): the read failed (Try again; never drawn as empty),
 * nothing yet (with the list's create), or nothing matches the search and filters (Clear).
 */
export function FrameState({
  problem,
  onRetry,
  empty,
  noMatch,
}: {
  problem?: string | null
  onRetry?: () => void
  empty?: { title: string; body?: string; action?: ReactNode; icon?: ReactNode } | null
  noMatch?: { onClear?: () => void; clearLabel?: string } | null
}) {
  const t = useT('admin')
  if (problem)
    return (
      <EmptyState
        title={t('list.failedTitle')}
        description={t(problem)}
        action={
          <Button size="sm" onClick={() => onRetry?.()}>
            {t('common.retry')}
          </Button>
        }
      />
    )
  if (empty) return <EmptyState icon={empty.icon} title={empty.title} description={empty.body} action={empty.action} />
  if (noMatch)
    return (
      <EmptyState
        title={t('list.noMatch')}
        action={
          noMatch.onClear ? (
            <Button size="sm" onClick={noMatch.onClear}>
              {noMatch.clearLabel ?? t('list.clearFilters')}
            </Button>
          ) : undefined
        }
      />
    )
  return null
}

/** A list frame's search field (the frame puts it left in its toolbar; `/` focuses it). */
export function ListSearch({ label, value, onChange }: { label: string; value: string; onChange?: (value: string) => void }) {
  return <Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} placeholder={label} aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} />
}

/**
 * One bulk action in a list frame's selection bar: its icon and its words with the reach ("Suspend 2"; the words hide
 * first on a narrow card), held with its reason when it applies to none of the selected rows.
 */
export function BulkButton({ icon, label, held, tone = 'secondary', onClick }: { icon: ReactNode; label: string; held?: string | null; tone?: 'secondary' | 'primary' | 'danger-outline'; onClick?: () => void }) {
  return (
    <Button size="sm" variant={tone} aria-label={label} heldReason={held ?? null} onClick={onClick}>
      {icon} <SelectionLabel>{label}</SelectionLabel>
    </Button>
  )
}

/** The full key list of an Admin list (`?`, or "All shortcuts" in the frame's footer): the list's own keys, then the frame's. */
export function ListKeysHelp({ open, onClose, keys, selection }: { open: boolean; onClose: () => void; keys: readonly ListKey[]; selection: boolean }) {
  return (
    <WithMessages namespaces={['lists']}>
      <KeysHelp open={open} onClose={onClose} keys={keys} selection={selection} />
    </WithMessages>
  )
}

function KeysHelp({ open, onClose, keys, selection }: { open: boolean; onClose: () => void; keys: readonly ListKey[]; selection: boolean }) {
  const t = useT('lists')
  if (!open) return null
  const words = (does: string) => (t(does) === does ? does : t(does))
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-list-keymap">
        {listKeys(keys, selection).map((entry) => (
          <Fragment key={`${entry.keys.join('+')}-${entry.does}`}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key === 'click' ? t('keys.click') : key}</Kbd>
              ))}
            </dt>
            <dd>{words(entry.does)}</dd>
          </Fragment>
        ))}
      </dl>
    </Modal>
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
  // The same object while the language stays: list columns are built from it once.
  return useMemo(() => {
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
  }, [t])
}
