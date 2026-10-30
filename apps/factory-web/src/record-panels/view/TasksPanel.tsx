'use client'

import { AlarmClock, CalendarClock, ListChecks, ListTodo, Plus, UserRound } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Checkbox, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../lib/i18n/format'
import { useLocale, useT } from '../../lib/i18n/provider'
import type { PanelTask, RecordPanelsViewModel } from '../model'
import { taskDueWords } from '../tasks/model'
import type { RecordPanelsActions } from './actions'
import { TaskNewDialog } from './TaskNewDialog'

/**
 * Tasks on this record (design shell.panels side panel, W2a: "open ones with due date, '+ Add task'"; COL-037): the
 * record's open tasks, each with its due day in words (an icon and the word, never a colour alone), whose it is and its
 * checklist; ticking one marks it done (at once, with Undo); "+ Add task" opens New task on this record. A task opens in
 * My tasks (its popup). Held with the reason for a person who may not make tasks here.
 */
export function TasksPanel({ model, actions }: { model: RecordPanelsViewModel; actions?: RecordPanelsActions }) {
  const t = useT('records')
  const tasks = model.tasks
  if (!tasks) return null
  const addHeld = tasks.addHeld ? t(tasks.addHeld) : tasks.busy ? t('tasks.held.busy') : null
  const add = (
    <Button size="sm" variant="secondary" heldReason={addHeld} onClick={() => actions?.onTaskDialog?.(true)}>
      <Plus size={14} aria-hidden /> {t('tasks.add')}
    </Button>
  )
  return (
    <div className="fw-rp-tasks">
      <div className="fw-rp-tasks-head">
        <p className="fw-rp-muted fw-rp-small">{t('tasks.intro')}</p>
        {add}
      </div>
      {tasks.undo && (
        <Banner
          tone="success"
          title={t('tasks.done', { title: tasks.undo.title })}
          action={
            <Button size="sm" variant="secondary" onClick={() => actions?.onUndoTask?.()}>
              {t('tasks.undo')}
            </Button>
          }
        />
      )}
      {tasks.problem ? (
        <Banner tone="danger" title={t(tasks.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('tasks')}>{t('panels.retry')}</Button>} />
      ) : tasks.items === null ? (
        <p className="fw-rp-loading" role="status">
          <Spinner size={14} /> {t('tasks.loading')}
        </p>
      ) : tasks.items.length === 0 ? (
        <EmptyState icon={<ListTodo size={22} aria-hidden />} title={t('tasks.empty.title')} description={t('tasks.empty.body')} />
      ) : (
        <ul className="fw-rp-task-list" aria-label={t('tasks.listLabel', { title: model.title })}>
          {tasks.items.map((task) => (
            <TaskRow key={task.id} task={task} busy={tasks.busy ?? false} onComplete={() => actions?.onCompleteTask?.(task.id)} />
          ))}
        </ul>
      )}
      {tasks.dialog && (
        <TaskNewDialog
          recordLabel={model.title}
          people={tasks.dialog.people}
          me={model.me ?? null}
          held={tasks.addHeld ? t(tasks.addHeld) : null}
          busy={tasks.busy}
          onCreate={actions?.onCreateTask}
          onRetryPeople={actions?.onRetryAssignees}
          onClose={() => actions?.onTaskDialog?.(false)}
        />
      )}
    </div>
  )
}

function TaskRow({ task, busy, onComplete }: { task: PanelTask; busy: boolean; onComplete: () => void }) {
  const t = useT('records')
  const locale = useLocale()
  const due = taskDueWords(task.due)
  const held = !task.canChange ? t('tasks.held.readOnly') : busy ? t('tasks.held.busy') : null
  return (
    <li className="fw-rp-task">
      <Checkbox
        checked={false}
        disabled={held !== null}
        title={held ?? t('tasks.complete', { title: task.title })}
        aria-label={t('tasks.complete', { title: task.title })}
        onChange={() => held === null && onComplete()}
      />
      <span className="fw-rp-task-body">
        <a className="fw-rp-task-title" href={task.href}>
          {task.title}
        </a>
        <span className="fw-rp-task-meta">
          {due ? (
            <Tag tone={due.late ? 'danger' : due.key === 'tasks.due.today' ? 'warning' : 'neutral'}>
              {due.late ? <AlarmClock size={12} aria-hidden /> : <CalendarClock size={12} aria-hidden />} {t(due.key, { count: due.count, date: formatDate(due.date, { locale }) })}
            </Tag>
          ) : (
            <span className="fw-rp-muted fw-rp-small">{t('tasks.due.none')}</span>
          )}
          <span className="fw-rp-muted fw-rp-small">
            <UserRound size={12} aria-hidden /> {task.assignee ? (task.assignee.me ? t('tasks.assignee.you') : task.assignee.name) : t('tasks.assignee.nobody')}
          </span>
          {task.progress && (
            <span className="fw-rp-muted fw-rp-small">
              <ListChecks size={12} aria-hidden /> {t('tasks.progress', { done: task.progress.done, total: task.progress.total })}
            </span>
          )}
        </span>
      </span>
    </li>
  )
}
