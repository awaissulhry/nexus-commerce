'use client'

import { AlertCircle } from 'lucide-react'
import { ActionList, type ActionGroup } from '@nexus/ui/patterns/ActionList/index'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import type { TaskGroup, TaskRow } from '../model'

/**
 * "What waits for you" (design portal.frame › action-needed; COL-043): every request we make of the partner, in ONE model,
 * wherever it shows — Home here, the rail's badges and the reminder e-mails read the same rows. A task: what to do, on
 * which record, the due (a Countdown when it is today or soon, overdue in words), who at the company asked; ONE verb in the
 * row: a request with no answer of its own is marked done in place with Undo; every other verb opens its record at the
 * request (a real link). A failed read is never drawn as an empty list.
 */

export interface TaskRowState extends TaskRow {
  /** Marked done here just now: the done words and, while the API offers it, Undo. */
  done?: { canUndo: boolean } | null
  /** Its verb or Undo runs now. */
  busy?: boolean
  /** Why its verb cannot act (a preview reads only), in words. */
  held?: string | null
}

export interface TasksViewModel {
  state: 'loading' | 'error' | 'ready'
  groups: readonly (Omit<TaskGroup, 'rows'> & { rows: readonly TaskRowState[] })[]
  /** The read's clock (the countdowns of a design case). */
  now?: number
}

export interface TasksViewProps {
  model: TasksViewModel
  onDone?: (row: TaskRowState) => void
  onUndo?: (row: TaskRowState) => void
  onRetry?: () => void
  /** The heading's level (Home: 2). */
  headingLevel?: 2 | 3
}

export function TasksView({ model, onDone, onUndo, onRetry, headingLevel = 2 }: TasksViewProps) {
  const t = useT('portal')
  const ds = useDsWords()
  const H = `h${headingLevel}` as 'h2'
  if (model.state === 'loading') {
    return (
      <section className="fw-ptasks" aria-busy="true" aria-label={t('tasks.title')}>
        <H className="fw-ptasks-title">{t('tasks.title')}</H>
        <div className="fw-ptasks-loading" role="status" aria-label={t('state.loading')}>
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} height={64} />
          ))}
        </div>
      </section>
    )
  }
  if (model.state === 'error') {
    return (
      <section className="fw-ptasks" aria-label={t('tasks.title')}>
        <H className="fw-ptasks-title">{t('tasks.title')}</H>
        <div className="fw-pstate" role="alert">
          <AlertCircle size={18} aria-hidden />
          <span>{t('tasks.failed')}</span>
          {onRetry ? <Button onClick={onRetry}>{t('state.retry')}</Button> : null}
        </div>
      </section>
    )
  }
  const groups: ActionGroup[] = model.groups.map((group) => ({
    id: group.kind,
    label: t(`tasks.kind.${group.kind}`),
    items: group.rows.map((row) => ({
      id: row.id,
      title: row.title,
      // The request's words already name the record ("Confirm order PO-…"): it is not said twice.
      record: row.title.includes(row.record) ? undefined : <span className="fw-ptask-record">{row.record}</span>,
      meta: row.askedBy ? t('tasks.askedBy', { name: row.askedBy }) : t('tasks.askedBySystem'),
      due: row.due,
      verb:
        row.act === 'inline'
          ? { label: row.verb, kind: 'inline' as const, onRun: () => onDone?.(row), busy: row.busy && !row.done, heldReason: row.held ?? null }
          : { label: row.verb, kind: 'link' as const, href: row.href, heldReason: row.held ?? null },
      done: row.done ? { words: t('tasks.done'), ...(row.done.canUndo ? { onUndo: () => onUndo?.(row) } : {}), undoHeldReason: row.busy ? t('tasks.undoing') : null } : null,
    })),
  }))
  return (
    <section className="fw-ptasks" aria-label={t('tasks.title')}>
      <H className="fw-ptasks-title">{t('tasks.title')}</H>
      <ActionList groups={groups} headingLevel={headingLevel === 2 ? 3 : 4} empty={t('tasks.empty')} labels={ds.actionList} countdownLabels={ds.countdown} now={model.now} />
    </section>
  )
}
