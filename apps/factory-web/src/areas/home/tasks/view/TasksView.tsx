'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlarmClock, CalendarClock, CalendarDays, Check, ExternalLink, ListChecks, ListTodo, MoreHorizontal, Plus, RotateCcw, UserRound } from 'lucide-react'
import { AsOf, Banner, DateField, EmptyState, Field, Menu, MetricStrip, Modal, type Metric } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { DetailModal } from '@nexus/ui/patterns'
import { Button, Checkbox, InfoTip, Input, SegmentedControl, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { isListKey, listKeys } from '../../../../list-frame/model'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { TASK_TILES, taskDueWords, type TaskDraft, type TaskTile } from '../../../../record-panels/tasks/model'
import { TaskNewDialog } from '../../../../record-panels/view/TaskNewDialog'
import { SnoozeDialog } from '../../today/view/SnoozeDialog'
import { actionHeld, bulkRows, pageKey, popupIds, reassignChanges, selectHeld, tasksKeys, tileValue, type TaskRow, type TasksDialog, type TasksScope, type TasksViewModel } from '../model'
import '../tasks.css'

export type { TasksViewModel } from '../model'

/** What a control asks to open (the container turns it into a TasksDialog with its data). */
export type TasksDialogRequest = { readonly kind: 'new' } | { readonly kind: 'reassign' } | { readonly kind: 'due' } | { readonly kind: 'snooze'; readonly id: string } | { readonly kind: 'help' }

/** What the page asks of its container (Tasks.tsx). Absent in the design index: the view keeps its own state. */
export interface TasksActions {
  onScope?: (scope: TasksScope) => void
  onTile?: (tile: TaskTile | null) => void
  onSearch?: (q: string) => void
  onMore?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: string[]) => void
  onOpen?: (id: string | null) => void
  onRetry?: () => void
  onRetryOpen?: () => void
  onRetryPeople?: () => void
  onDialog?: (request: TasksDialogRequest | null) => void
  onDismissNotice?: () => void
  /** Tick done (at once; Undo puts it back) or reopen. */
  onComplete?: (id: string) => void
  onReopen?: (id: string) => void
  onUndo?: () => void
  onCreate?: (draft: TaskDraft) => Promise<boolean>
  onBulkDone?: () => void
  onReassign?: (assigneeId: string | null) => Promise<boolean>
  onSetDue?: (dueDate: string | null) => Promise<boolean>
  /** The popup's own changes (autosaved, the task's version as read). */
  onAssign?: (id: string, assigneeId: string | null) => void
  onDue?: (id: string, dueDate: string | null) => void
  onChecklist?: (id: string, itemId: string, done: boolean) => void
  onSnooze?: (id: string, until: string | null) => Promise<boolean>
}

const NOBODY = '__nobody__'

/**
 * SCR-233 — Home › My tasks (design home.tasks, W2a; COL-037): the tiles Overdue · Today · This week · No date · Done in
 * 7 days (each a filter of the list, pressed again it clears), Mine · My team's (held: teams come with People) · Created
 * by me, and the tasks in the ONE list frame — a Done box that ticks the task done at once (Undo), the task (its popup),
 * its record, whose it is, the due day in words, the checklist, who made it; select several for Mark done N · Reassign
 * N · Set due N (all or none). The popup (`?open=`): whose, when, the checklist to tick, the description, Mark done or
 * Reopen, Snooze; J / K step through the list, E done. New task (`c`). It draws ONE view model and fetches nothing.
 */
export function TasksView({ model, actions }: { model: TasksViewModel; actions?: TasksActions }) {
  return (
    <WithMessages namespaces={['home-tasks', 'records', 'lists']}>
      <Tasks model={model} actions={actions} />
    </WithMessages>
  )
}

function Tasks({ model, actions }: { model: TasksViewModel; actions?: TasksActions }) {
  const t = useT('home-tasks')
  const r = useT('records')
  const locale = useLocale()
  // Without a container (the design index) the view keeps its own selection, open row and dialog.
  const [ownSelected, setOwnSelected] = useState<readonly string[]>(model.selected)
  const [ownOpen, setOwnOpen] = useState<string | null>(model.open?.id ?? null)
  const [ownDialog, setOwnDialog] = useState<TasksDialog | null>(model.dialog)
  useEffect(() => setOwnSelected(model.selected), [model.selected])
  useEffect(() => setOwnOpen(model.open?.id ?? null), [model.open?.id])
  useEffect(() => setOwnDialog(model.dialog), [model.dialog])
  const selected = actions?.onSelect ? model.selected : ownSelected
  const setSelected = (ids: string[]) => (actions?.onSelect ? actions.onSelect(ids) : setOwnSelected(ids))
  const openId = actions?.onOpen ? (model.open?.id ?? null) : ownOpen
  const setOpen = (id: string | null) => (actions?.onOpen ? actions.onOpen(id) : setOwnOpen(id))
  // The grid keeps its cell renderers (columns are rebuilt only when the words change): the cells reach the page's
  // actions and setOpen through refs, so a click always acts on the rows as they are now (never the first render's).
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const setOpenRef = useRef(setOpen)
  setOpenRef.current = setOpen
  const dialog = actions?.onDialog ? model.dialog : ownDialog
  const openDialog = (request: TasksDialogRequest | null) => {
    if (actions?.onDialog) return actions.onDialog(request)
    if (request === null) return setOwnDialog(null)
    const people = model.dialog && 'people' in model.dialog ? model.dialog.people : ({ status: 'loading' } as const)
    setOwnDialog(request.kind === 'new' ? { kind: 'new', people } : request.kind === 'reassign' ? { kind: 'reassign', ids: selected, people } : request.kind === 'due' ? { kind: 'due', ids: selected } : request)
  }

  const list = model.list.status === 'ready' ? model.list.data : null
  const rows = useMemo(() => list?.rows ?? [], [list])
  const held = actionHeld(model)
  const heldText = held ? t(held) : null
  const picked = bulkRows(rows, selected)

  // c opens New task, e ticks the focused row done (not in a field, a menu or a dialog).
  const rowsRef = useMemo(() => ({ rows }), [rows])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialog !== null || openId !== null || !isListKey(event, event.target as HTMLElement | null)) return
      const wanted = pageKey(event.key)
      if (wanted === 'new' && held === null) {
        event.preventDefault()
        openDialog({ kind: 'new' })
      } else if (wanted === 'done') {
        const id = (document.activeElement as HTMLElement | null)?.closest('[row-id]')?.getAttribute('row-id')
        const row = id ? rowsRef.rows.find((entry) => entry.id === id) : undefined
        if (row && row.status === 'OPEN' && row.canChange && held === null) {
          event.preventDefault()
          actions?.onComplete?.(row.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const columns = useMemo<ColDef<TaskRow>[]>(() => {
    const DoneCell = ({ data }: ICellRendererParams<TaskRow>) => {
      if (!data) return null
      const done = data.status === 'DONE'
      const reason = !data.canChange ? r('tasks.held.readOnly') : heldText
      return (
        <span className="fw-tasks-done">
          <Checkbox
            checked={done}
            disabled={reason !== null || data.status === 'CANCELLED'}
            title={reason ?? undefined}
            aria-label={done ? t('row.reopen', { title: data.title }) : t('row.complete', { title: data.title })}
            onChange={() => (done ? actionsRef.current?.onReopen?.(data.id) : actionsRef.current?.onComplete?.(data.id))}
          />
        </span>
      )
    }
    const TaskCell = ({ data }: ICellRendererParams<TaskRow>) =>
      data ? (
        <span className="fw-tasks-cell">
          <Link
            className={data.status === 'DONE' ? 'fw-tasks-title is-done' : 'fw-tasks-title'}
            href={data.href}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
              event.preventDefault()
              setOpenRef.current(data.id)
            }}
          >
            {data.title}
          </Link>
          {(data.status !== 'OPEN' || data.snoozed) && (
            <span className="fw-tasks-sub">{data.status === 'OPEN' ? t('row.snoozed', { date: formatDateTime(data.snoozedUntil ?? '', { locale }) }) : t(`status.${data.status}`)}</span>
          )}
        </span>
      ) : null
    const RecordCell = ({ data }: ICellRendererParams<TaskRow>) =>
      data ? (
        data.record && data.recordHref ? (
          <a className="fw-tasks-record" href={data.recordHref} title={t('row.openRecord', { record: data.record.label })}>
            {data.record.label} <ExternalLink size={12} aria-hidden />
          </a>
        ) : (
          <span className="fw-tasks-muted">{t('row.ownTask')}</span>
        )
      ) : null
    const DueCell = ({ data }: ICellRendererParams<TaskRow>) => {
      const due = data ? taskDueWords(data.due) : null
      if (!data) return null
      if (!due) return <span className="fw-tasks-muted">{r('tasks.due.none')}</span>
      return (
        <span className={due.late && data.status === 'OPEN' ? 'fw-tasks-due is-late' : 'fw-tasks-due'}>
          {due.late ? <AlarmClock size={13} aria-hidden /> : <CalendarClock size={13} aria-hidden />} {r(due.key, { count: due.count, date: formatDate(due.date, { locale }) })}
          {data.dueTime ? ` · ${data.dueTime}` : ''}
        </span>
      )
    }
    const person = (value: TaskRow['assignee']) => (value ? (value.me ? r('tasks.assignee.you') : value.name) : r('tasks.assignee.nobody'))
    return [
      { colId: 'done', headerName: t('col.done'), width: 84, maxWidth: 96, sortable: false, cellRenderer: DoneCell },
      { colId: 'task', headerName: t('col.task'), field: 'title', flex: 3, minWidth: 260, cellRenderer: TaskCell },
      { colId: 'record', headerName: t('col.record'), flex: 1, minWidth: 150, valueGetter: (params) => params.data?.record?.label ?? '', cellRenderer: RecordCell },
      { colId: 'assignee', headerName: t('col.assignee'), flex: 1, minWidth: 140, valueGetter: (params) => (params.data ? person(params.data.assignee) : '') },
      { colId: 'due', headerName: t('col.due'), flex: 1, minWidth: 160, valueGetter: (params) => params.data?.dueDate ?? '', cellRenderer: DueCell },
      { colId: 'checklist', headerName: t('col.checklist'), width: 120, valueGetter: (params) => (params.data?.progress ? r('tasks.progress', { done: params.data.progress.done, total: params.data.progress.total }) : '—') },
      { colId: 'createdBy', headerName: t('col.createdBy'), flex: 1, minWidth: 140, valueGetter: (params) => (params.data?.createdBy ? person(params.data.createdBy) : '—') },
    ]
    // The cells read the words, the language and the hold through the closure: a change rebuilds them.
  }, [t, r, locale, heldText])

  if (model.access === 'refused') {
    return (
      <div className="fw-tasks">
        <EmptyState icon={<ListTodo size={24} aria-hidden />} title={t('refused.title')} description={t('refused.body')} />
      </div>
    )
  }

  // ---- the band: when it was read, the live channel, New task ----------------------------------------------------------
  const band = (
    <div className="fw-tasks-band" role="group" aria-label={t('band.label')}>
      <div className="fw-tasks-status">
        {list ? <AsOf at={list.asOf} now={model.now} /> : <span className="fw-tasks-muted">{t('band.reading')}</span>}
        <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
      </div>
      <div className="fw-tasks-actions">
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('band.more') }}
          items={[{ id: 'keys', label: t('band.keys'), onSelect: () => openDialog({ kind: 'help' }) }]}
        />
        <Button variant="primary" heldReason={heldText} onClick={() => openDialog({ kind: 'new' })} aria-keyshortcuts="c">
          <Plus size={14} aria-hidden /> {t('band.new')}
        </Button>
      </div>
    </div>
  )

  // ---- tiles: saved filters of the list --------------------------------------------------------------------------------
  const tiles: Metric[] = TASK_TILES.map((tile): Metric => {
    const counted = list?.tiles.find((entry) => entry.tile === tile)
    const label = t(`tile.${tile}.label`)
    if (!counted) return { label, value: model.list.status === 'error' ? <span className="fw-tasks-unknown">—<InfoTip tip={t('tile.unknown')} /></span> : '—' }
    const words = tileValue(counted.count, list?.complete ?? true)
    return {
      label,
      value: list?.complete === false ? <span className="fw-tasks-unknown">{t(words.key, { count: words.count })}<InfoTip tip={t('tile.partial')} /></span> : t(words.key, { count: words.count }),
      hint: t(`tile.${tile}.hint`),
      onClick: () => actions?.onTile?.(model.tile === tile ? null : tile),
      active: model.tile === tile,
    }
  })

  const scope = (
    <div className="fw-tasks-scope">
      <SegmentedControl
        ariaLabel={t('scope.label')}
        size="sm"
        wrap
        value={model.scope}
        onChange={(value) => value !== 'TEAM' && actions?.onScope?.(value as TasksScope)}
        options={[
          { value: 'MINE', label: t('scope.MINE') },
          { value: 'TEAM', label: t('scope.TEAM'), disabled: true, title: t('scope.teamHeld') },
          { value: 'CREATED', label: t('scope.CREATED') },
        ]}
      />
      <InfoTip tip={t('scope.teamHeld')} />
    </div>
  )

  const state: ReactNode =
    model.list.status === 'error' ? (
      <EmptyState title={t('error.title')} description={r(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
    ) : list && rows.length === 0 ? (
      <EmptyState
        icon={<ListTodo size={24} aria-hidden />}
        title={t(model.tile || model.q ? 'empty.filtered.title' : 'empty.title')}
        description={t(model.tile || model.q ? 'empty.filtered.body' : 'empty.body')}
        action={
          model.tile || model.q ? (
            <Button size="sm" onClick={() => (model.q ? actions?.onSearch?.('') : actions?.onTile?.(null))}>
              {t('empty.clear')}
            </Button>
          ) : model.canManage ? (
            <Button size="sm" variant="primary" heldReason={heldText} onClick={() => openDialog({ kind: 'new' })}>
              <Plus size={14} aria-hidden /> {t('band.new')}
            </Button>
          ) : undefined
        }
      />
    ) : undefined

  const reassignRows = dialog?.kind === 'reassign' ? rows.filter((row) => dialog.ids.includes(row.id)) : []
  const dueRows = dialog?.kind === 'due' ? rows.filter((row) => dialog.ids.includes(row.id)) : []
  const snoozeRow = dialog?.kind === 'snooze' ? (rows.find((row) => row.id === dialog.id) ?? (model.open?.task.status === 'ready' ? model.open.task.data : null)) : null

  return (
    <div className="fw-tasks">
      {band}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={model.notice.key.startsWith('tasks.') ? r(model.notice.key, model.notice.params) : t(model.notice.key, model.notice.params)}
          action={
            <span className="fw-tasks-notice-actions">
              {model.notice.undo && (
                <Button size="sm" variant="secondary" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onUndo?.()}>
                  <RotateCcw size={13} aria-hidden /> {t('notice.undo')}
                </Button>
              )}
              {actions?.onDismissNotice && (
                <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                  {t('dismiss')}
                </Button>
              )}
            </span>
          }
        />
      )}

      <section className="fw-tasks-section" aria-labelledby="fw-tasks-tiles">
        <h2 id="fw-tasks-tiles" className="fw-tasks-h">
          {t('tile.title')}
        </h2>
        <MetricStrip metrics={tiles} minTileWidth={170} />
      </section>

      {scope}

      <ListFrame<TaskRow>
        label={t('table.label')}
        title={t('table.title')}
        rows={model.list.status === 'loading' ? null : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={list ? t('count', { count: list.total }) : '—'}
        search={<Input type="search" size="sm" value={model.q} onChange={(event) => actions?.onSearch?.(event.target.value)} placeholder={t('search')} aria-label={t('search')} />}
        selection={
          model.canManage
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <>
                    <Button size="sm" variant="primary" aria-label={t('bulk.done', { count: picked.length })} heldReason={heldText ?? (picked.length === 0 ? t('held.noneOpen') : null)} onClick={() => actions?.onBulkDone?.()}>
                      <Check size={13} aria-hidden /> <SelectionLabel>{t('bulk.done', { count: picked.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" aria-label={t('bulk.reassign', { count: picked.length })} heldReason={heldText ?? (picked.length === 0 ? t('held.noneOpen') : null)} onClick={() => openDialog({ kind: 'reassign' })}>
                      <UserRound size={13} aria-hidden /> <SelectionLabel>{t('bulk.reassign', { count: picked.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" aria-label={t('bulk.due', { count: picked.length })} heldReason={heldText ?? (picked.length === 0 ? t('held.noneOpen') : null)} onClick={() => openDialog({ kind: 'due' })}>
                      <CalendarDays size={13} aria-hidden /> <SelectionLabel>{t('bulk.due', { count: picked.length })}</SelectionLabel>
                    </Button>
                  </>
                ),
              }
            : undefined
        }
        isRowSelectable={model.canManage ? (row) => (selectHeld(row) ? t(selectHeld(row)!) : null) : undefined}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={list?.more ? { label: t(list.loadingMore ? 'more.loading' : 'more.label'), onMore: () => actions?.onMore?.(), held: list.loadingMore ? t('more.loading') : null } : null}
        keys={tasksKeys(t)}
        onHelp={() => openDialog({ kind: 'help' })}
        onOpen={(row) => setOpen(row.id)}
        state={state}
        focusRow={model.focusRow}
      />

      <TaskPopup model={model} openId={openId} rows={rows} held={held} onGo={setOpen} onDialog={openDialog} actions={actions} />

      {dialog?.kind === 'new' && (
        <TaskNewDialog recordLabel={null} people={dialog.people} me={model.me} held={heldText} busy={model.busy} onCreate={actions?.onCreate} onRetryPeople={actions?.onRetryPeople} onClose={() => openDialog(null)} />
      )}
      {dialog?.kind === 'reassign' && <ReassignDialog rows={reassignRows} people={dialog.people} busy={model.busy} held={heldText} onReassign={actions?.onReassign} onRetry={actions?.onRetryPeople} onClose={() => openDialog(null)} />}
      {dialog?.kind === 'due' && <SetDueDialog rows={dueRows} busy={model.busy} held={heldText} onSetDue={actions?.onSetDue} onClose={() => openDialog(null)} />}
      {dialog?.kind === 'snooze' && snoozeRow && (
        <SnoozeDialog what={snoozeRow.title} now={model.now} untilChange={false} maxDays={90} held={heldText} onSnooze={(until) => actions?.onSnooze?.(snoozeRow.id, until)} onClose={() => openDialog(null)} />
      )}
      {dialog?.kind === 'help' && (
        <Modal open onClose={() => openDialog(null)} title={t('keysTitle')} size="sm">
          <ul className="fw-tasks-keys">
            {[...listKeys(tasksKeys(t), model.canManage), { keys: ['J', 'K'], does: t('keys.walk') }, { keys: ['Esc'], does: t('keys.close') }].map((entry) => (
              <li key={entry.keys.join('+')}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? <ListWords id={entry.does} /> : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}

/** A key's words of the list frame's own catalogue. */
function ListWords({ id }: { id: string }) {
  const lists = useT('lists')
  return <>{lists(id)}</>
}

/**
 * The task's popup (design home.tasks popup task: "Title, record chip, assignee, due, checklist (tick items), description,
 * comments, history"): DetailModal over the list (`?open=<id>`), J / K through the list as shown, E done, Esc. Whose it is
 * and its due day save at once (the task's version as read); a task has no thread yet (comments and history: a gap).
 */
function TaskPopup({
  model,
  openId,
  rows,
  held,
  onGo,
  onDialog,
  actions,
}: {
  model: TasksViewModel
  openId: string | null
  rows: readonly TaskRow[]
  held: string | null
  onGo: (id: string | null) => void
  onDialog: (request: TasksDialogRequest | null) => void
  actions?: TasksActions
}) {
  const t = useT('home-tasks')
  const r = useT('records')
  const locale = useLocale()
  const open = model.open && model.open.id === openId ? model.open : null
  const task = open?.task.status === 'ready' ? open.task.data : openId ? (rows.find((row) => row.id === openId) ?? null) : null
  const ids = popupIds(rows)
  const changeHeld = task && !task.canChange ? r('tasks.held.readOnly') : held ? t(held) : null
  const closed = task ? task.status !== 'OPEN' : false
  // E ticks it done while the popup is open (not in a field).
  useEffect(() => {
    if (!task) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'e' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (changeHeld || task.status !== 'OPEN') return
      event.preventDefault()
      actions?.onComplete?.(task.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [task, changeHeld, actions])
  if (!openId) return null
  const people = open?.people ?? null
  const due = task ? taskDueWords(task.due) : null
  return (
    <DetailModal
      open
      onClose={() => onGo(null)}
      title={task?.title ?? t('popup.reading')}
      subtitle={task ? task.record && task.recordHref ? <a href={task.recordHref}>{t('popup.on', { record: task.record.label })}</a> : t('row.ownTask') : undefined}
      meta={
        task ? (
          <span className="fw-tasks-meta">
            <Tag tone={task.status === 'OPEN' ? 'info' : 'neutral'}>{t(`status.${task.status}`)}</Tag>
            {due && (
              <Tag tone={due.late && task.status === 'OPEN' ? 'danger' : 'neutral'}>
                {due.late ? <AlarmClock size={12} aria-hidden /> : <CalendarClock size={12} aria-hidden />} {r(due.key, { count: due.count, date: formatDate(due.date, { locale }) })}
              </Tag>
            )}
            {task.snoozed && task.snoozedUntil && <Tag tone="neutral">{t('row.snoozed', { date: formatDateTime(task.snoozedUntil, { locale }) })}</Tag>}
          </span>
        ) : undefined
      }
      nav={ids.includes(openId) ? { ids, current: openId, onGo: (id) => onGo(id), noun: t('popup.noun') } : undefined}
      loading={!task && open?.task.status !== 'error'}
      error={open?.task.status === 'error' ? r(open.task.problem) : undefined}
      onRetry={() => actions?.onRetryOpen?.()}
      footer={
        task ? (
          <span className="fw-tasks-buttons">
            {task.status === 'OPEN' && (
              <Button variant="secondary" heldReason={changeHeld} onClick={() => onDialog({ kind: 'snooze', id: task.id })}>
                <AlarmClock size={14} aria-hidden /> {t('popup.snooze')}
              </Button>
            )}
            {closed ? (
              <Button variant="secondary" heldReason={changeHeld} onClick={() => actions?.onReopen?.(task.id)}>
                <RotateCcw size={14} aria-hidden /> {t('popup.reopen')}
              </Button>
            ) : (
              <Button variant="primary" heldReason={changeHeld} onClick={() => actions?.onComplete?.(task.id)} aria-keyshortcuts="e">
                <Check size={14} aria-hidden /> {t('popup.done')}
              </Button>
            )}
          </span>
        ) : undefined
      }
    >
      {task && (
        <div className="fw-tasks-popup">
          <div className="fw-tasks-popup-grid">
            <Field label={t('popup.assignee')} hint={task.assignedBy && task.assignedAt ? t('popup.assignedBy', { name: task.assignedBy.me ? r('tasks.assignee.you') : task.assignedBy.name, date: formatDate(task.assignedAt, { locale }) }) : undefined}>
              {task.canChange && !closed && people?.status === 'ready' ? (
                <Select value={task.assignee?.id ?? NOBODY} disabled={changeHeld !== null} onChange={(event) => actions?.onAssign?.(task.id, event.target.value === NOBODY ? null : event.target.value)}>
                  {task.assignee && !people.data.some((person) => person.id === task.assignee!.id) && <option value={task.assignee.id}>{task.assignee.name}</option>}
                  {people.data.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.me ? r('tasks.new.field.me', { name: person.name }) : person.name}
                    </option>
                  ))}
                  <option value={NOBODY}>{r('tasks.assignee.nobody')}</option>
                </Select>
              ) : task.canChange && !closed && people?.status === 'loading' ? (
                <Skeleton height={32} />
              ) : (
                <p className="fw-tasks-value">
                  <UserRound size={13} aria-hidden /> {task.assignee ? (task.assignee.me ? r('tasks.assignee.you') : task.assignee.name) : r('tasks.assignee.nobody')}
                </p>
              )}
            </Field>
            <Field label={t('popup.due')}>
              {task.canChange && !closed ? (
                <DateField value={task.dueDate ?? ''} onChange={(value) => actions?.onDue?.(task.id, value || null)} locale={INTL_LOCALE[locale]} clearable clearLabel={r('tasks.new.field.dueClear')} ariaLabel={t('popup.due')} disabled={changeHeld !== null} />
              ) : (
                <p className="fw-tasks-value">{task.dueDate ? formatDate(task.dueDate, { locale }) : r('tasks.due.none')}</p>
              )}
            </Field>
            <Field label={t('popup.createdBy')}>
              <p className="fw-tasks-value">{t('popup.created', { name: task.createdBy ? (task.createdBy.me ? r('tasks.assignee.you') : task.createdBy.name) : '—', date: formatDate(task.createdAt, { locale }) })}</p>
            </Field>
          </div>

          <section className="fw-tasks-popup-part" aria-labelledby="fw-tasks-checklist">
            <h3 id="fw-tasks-checklist" className="fw-tasks-h3">
              <ListChecks size={14} aria-hidden /> {task.progress ? t('popup.checklistCount', { done: task.progress.done, total: task.progress.total }) : t('popup.checklist')}
            </h3>
            {task.checklist.length === 0 ? (
              <p className="fw-tasks-muted">{t('popup.noChecklist')}</p>
            ) : (
              <ul className="fw-tasks-checklist">
                {task.checklist.map((item) => (
                  <li key={item.id}>
                    <Checkbox
                      checked={item.done}
                      disabled={changeHeld !== null || closed}
                      label={
                        <span>
                          {item.text}
                          {item.done && item.doneBy && <span className="fw-tasks-muted"> · {t('popup.ticked', { name: item.doneBy.name, date: formatDate(item.doneAt ?? '', { locale }) })}</span>}
                        </span>
                      }
                      onChange={(event) => actions?.onChecklist?.(task.id, item.id, event.target.checked)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="fw-tasks-popup-part" aria-labelledby="fw-tasks-description">
            <h3 id="fw-tasks-description" className="fw-tasks-h3">
              {t('popup.description')}
            </h3>
            <p className={task.description ? 'fw-tasks-text' : 'fw-tasks-muted'}>{task.description ?? t('popup.noDescription')}</p>
          </section>

          <p className="fw-tasks-muted">{t('popup.noThread')}</p>
        </div>
      )}
    </DetailModal>
  )
}

/** Reassign N tasks: whom to, then each task with whose it is now and whose it becomes; all or none. */
function ReassignDialog({
  rows,
  people,
  busy,
  held,
  onReassign,
  onRetry,
  onClose,
}: {
  rows: readonly TaskRow[]
  people: NonNullable<Extract<TasksDialog, { kind: 'reassign' }>['people']>
  busy: boolean
  held: string | null
  onReassign?: (assigneeId: string | null) => Promise<boolean>
  onRetry?: () => void
  onClose: () => void
}) {
  const t = useT('home-tasks')
  const r = useT('records')
  const [to, setTo] = useState('')
  const list = people.status === 'ready' ? people.data : []
  const chosen = to === NOBODY ? { id: null, name: r('tasks.assignee.nobody') } : list.find((person) => person.id === to) ?? null
  const changes = chosen ? reassignChanges(rows, { id: chosen.id, name: 'me' in chosen && chosen.me ? r('tasks.assignee.you') : chosen.name }, r('tasks.assignee.nobody')) : []
  const go = () => {
    if (!chosen || !onReassign) return
    void onReassign(chosen.id).then((done) => done && onClose())
  }
  const heldText = held ?? (busy ? t('held.busy') : !chosen ? t('reassign.pickFirst') : changes.every((change) => change.same) ? t('reassign.same') : null)
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('reassign.title', { count: rows.length })}
      footer={
        <span className="fw-tasks-buttons">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" heldReason={heldText} onClick={go}>
            <UserRound size={14} aria-hidden /> {t('reassign.go', { count: rows.length })}
          </Button>
        </span>
      }
    >
      <div className="fw-tasks-dialog">
        <p className="fw-tasks-muted">{t('reassign.body')}</p>
        <Field label={t('reassign.to')} hint={t('reassign.toHint')}>
          {people.status === 'loading' ? (
            <Skeleton height={32} />
          ) : people.status === 'error' ? (
            <Banner tone="danger" title={r(people.problem)} action={onRetry ? <Button size="sm" onClick={onRetry}>{t('retry')}</Button> : undefined} />
          ) : (
            <Select value={to} onChange={(event) => setTo(event.target.value)}>
              <option value="">{t('reassign.pick')}</option>
              {list.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.me ? r('tasks.new.field.me', { name: person.name }) : person.name}
                </option>
              ))}
              <option value={NOBODY}>{r('tasks.assignee.nobody')}</option>
            </Select>
          )}
        </Field>
        <ul className="fw-tasks-changes" aria-label={t('reassign.listLabel')}>
          {(changes.length > 0 ? changes : rows.map((row) => ({ id: row.id, title: row.title, from: row.assignee?.name ?? r('tasks.assignee.nobody'), to: '…', same: false }))).map((change) => (
            <li key={change.id}>
              <span className="fw-tasks-change-title">{change.title}</span>
              <span className="fw-tasks-muted">{change.same ? t('reassign.unchanged', { name: change.from }) : t('reassign.change', { from: change.from, to: change.to })}</span>
            </li>
          ))}
        </ul>
        <p className="fw-tasks-muted">{t('reassign.allOrNone')}</p>
      </div>
    </Modal>
  )
}

/** Set due for N tasks: one day for all (or none), each task listed; all or none. */
function SetDueDialog({ rows, busy, held, onSetDue, onClose }: { rows: readonly TaskRow[]; busy: boolean; held: string | null; onSetDue?: (dueDate: string | null) => Promise<boolean>; onClose: () => void }) {
  const t = useT('home-tasks')
  const r = useT('records')
  const locale = useLocale()
  const [day, setDay] = useState('')
  const [none, setNone] = useState(false)
  const heldText = held ?? (busy ? t('held.busy') : !day && !none ? t('due.pickFirst') : null)
  const go = () => {
    if (heldText || !onSetDue) return
    void onSetDue(none ? null : day).then((done) => done && onClose())
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('due.title', { count: rows.length })}
      footer={
        <span className="fw-tasks-buttons">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" heldReason={heldText} onClick={go}>
            <CalendarDays size={14} aria-hidden /> {t('due.go', { count: rows.length })}
          </Button>
        </span>
      }
    >
      <div className="fw-tasks-dialog">
        <Field label={t('due.day')}>
          <DateField value={none ? '' : day} onChange={(value) => { setDay(value); setNone(false) }} locale={INTL_LOCALE[locale]} ariaLabel={t('due.day')} disabled={none} />
        </Field>
        <Checkbox checked={none} label={t('due.none')} onChange={(event) => setNone(event.target.checked)} />
        <ul className="fw-tasks-changes" aria-label={t('due.listLabel')}>
          {rows.map((row) => (
            <li key={row.id}>
              <span className="fw-tasks-change-title">{row.title}</span>
              <span className="fw-tasks-muted">
                {t('due.change', { from: row.dueDate ? formatDate(row.dueDate, { locale }) : r('tasks.due.none'), to: none ? r('tasks.due.none') : day ? formatDate(day, { locale }) : '…' })}
              </span>
            </li>
          ))}
        </ul>
        <p className="fw-tasks-muted">{t('reassign.allOrNone')}</p>
      </div>
    </Modal>
  )
}
