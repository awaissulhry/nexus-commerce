'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { recordAddress } from '../../../lib/records/record-links'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import type { PanelRead } from '../../../record-panels/model'
import { assignTask, bulkTasks, createTask, getTask, listAssignees, listTasks, setTaskStatus, snoozeTask, taskReadProblem, taskWriteProblem, updateTask } from '../../../record-panels/tasks/api'
import { createBody, doneLocally, TASK_EVENTS, type Assignable, type BulkAction, type TaskItem, type TaskList, type TaskStatus } from '../../../record-panels/tasks/model'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { useTodayLive } from '../today/live'
import { bulkRows, scopeOf, tasksAddress, tileOf, updatesBetween, type TaskRow, type TasksDialog, type TasksNotice, type TasksViewModel } from './model'
import { TasksView, type TasksDialogRequest } from './view/TasksView'

interface ListState {
  readonly answer: TaskList
  readonly items: readonly TaskItem[]
  readonly cursor: string | null
  readonly loadingMore: boolean
  /** A fresher first page a live change brought, shown when the person asks ("N updates · Show"). */
  readonly pending: TaskList | null
}

/**
 * `/w/<company>/home/tasks` (SCR-233): My tasks through the API client — GET /tasks (`?scope=MINE|CREATED`, `?tile=`,
 * `?q=`; the tiles over the whole scope), the popup's task (`?open=<id>`: its row, else GET /tasks/:id), who a task may be
 * given to (GET /tasks/assignees), and every change with the task's version as read and an Idempotency-Key: the Done box
 * and Mark done (at once, then the API; Undo reopens), Reopen, the popup's assignee, due day and checklist, Snooze, the
 * bulk actions (POST /tasks/bulk, all or none) and New task (`c`, `?new=1`). A refusal says why and the list is read
 * again. Live: task.created / assigned / completed / changed → "N updates · Show" (rows never move under the cursor).
 */
export function Tasks() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const search = useSearchParams()
  const permissions = useMemo(() => new Set(session.permissions), [session.permissions])
  const allowed = permissions.has('home.view')
  const canManage = permissions.has('tasks.manage')
  const prefix = companyPrefix(session.company?.code ?? '')
  const scope = scopeOf(search.get('scope'))
  const tile = tileOf(search.get('tile'))
  const addressQ = search.get('q') ?? ''
  const openId = search.get('open')
  const wantsNew = search.get('new') === '1'

  const [list, setList] = useState<PanelRead<ListState>>({ status: 'loading' })
  const [q, setQ] = useState(addressQ)
  const [selected, setSelected] = useState<string[]>([])
  const [openTask, setOpenTask] = useState<{ readonly id: string; readonly read: PanelRead<TaskItem> } | null>(null)
  const [openPeople, setOpenPeople] = useState<PanelRead<readonly Assignable[]> | null>(null)
  const [dialog, setDialog] = useState<TasksDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<TasksNotice | null>(null)
  const [undoTask, setUndoTask] = useState<TaskItem | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const seq = useRef(0)
  const query = useRef({ scope, tile, q: addressQ })
  query.current = { scope, tile, q: addressQ }
  const openRef = useRef(openId)
  openRef.current = openId

  const go = useCallback(
    (next: { scope?: typeof scope; tile?: typeof tile; q?: string; open?: string | null; newTask?: boolean }) => {
      const state = { scope: next.scope ?? query.current.scope, tile: next.tile === undefined ? query.current.tile : next.tile, q: next.q ?? query.current.q, open: next.open === undefined ? openRef.current : next.open, newTask: next.newTask ?? false }
      router.replace(`${pathname}${tasksAddress(state)}`, { scroll: false })
    },
    [router, pathname],
  )

  // ---- reads -------------------------------------------------------------------------------------------------------
  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const answer = await listTasks(api, { scope: query.current.scope, tile: query.current.tile, q: query.current.q })
      if (mine !== seq.current) return
      setNow(Date.now())
      setList({ status: 'ready', data: { answer, items: answer.items, cursor: answer.nextCursor, loadingMore: false, pending: null } })
    } catch (error) {
      if (mine === seq.current) setList({ status: 'error', problem: taskReadProblem(error) })
    }
  }, [api])

  /** A live change: a fresher first page; rows that changed wait behind "N updates · Show". */
  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const answer = await listTasks(api, { scope: query.current.scope, tile: query.current.tile, q: query.current.q })
      if (mine !== seq.current) return
      setList((current) => {
        if (current.status !== 'ready') return { status: 'ready', data: { answer, items: answer.items, cursor: answer.nextCursor, loadingMore: false, pending: null } }
        const changed = updatesBetween(current.data.items.slice(0, answer.items.length), answer.items)
        if (changed === 0) return { status: 'ready', data: { ...current.data, answer: { ...current.data.answer, tiles: answer.tiles, total: answer.total, asOf: answer.asOf }, pending: null } }
        return { status: 'ready', data: { ...current.data, pending: answer } }
      })
    } catch {
      // A failed refresh keeps what is shown; the next change or a reconnect reads again.
    }
  }, [api])

  useEffect(() => {
    if (!allowed) return
    setList({ status: 'loading' })
    setSelected([])
    void load()
  }, [allowed, scope, tile, addressQ, load])

  // The search field writes the address after a short pause (the list reads it from there).
  useEffect(() => setQ(addressQ), [addressQ])
  useEffect(() => {
    if (q === addressQ) return
    const timer = setTimeout(() => go({ q, open: null }), 300)
    return () => clearTimeout(timer)
  }, [q, addressQ, go])

  const items = list.status === 'ready' ? list.data.items : []
  const itemsRef = useRef(items)
  itemsRef.current = items
  const inList = openId ? (items.find((item) => item.id === openId) ?? null) : null

  // The popup: its row from the list, else the task read alone (a link from a notification, Today or a record).
  const readOpen = useCallback(async (id: string) => {
    setOpenTask({ id, read: { status: 'loading' } })
    try {
      const task = await getTask(api, id)
      setOpenTask((current) => (current?.id === id ? { id, read: { status: 'ready', data: task } } : current))
    } catch (error) {
      setOpenTask((current) => (current?.id === id ? { id, read: { status: 'error', problem: taskReadProblem(error) } } : current))
    }
  }, [api])
  useEffect(() => {
    if (!openId) {
      setOpenTask(null)
      return
    }
    if (list.status === 'ready' && !inList && openTask?.id !== openId) void readOpen(openId)
  }, [openId, list.status, inList, openTask, readOpen])
  const shownOpen: TaskItem | null = inList ?? (openTask?.id === openId && openTask.read.status === 'ready' ? openTask.read.data : null)

  // Who the open task may be given to (only when the person may change it).
  const openRecord = shownOpen?.record ?? null
  const openChangeable = shownOpen ? shownOpen.canChange && shownOpen.status === 'OPEN' : false
  const openKey = shownOpen ? `${shownOpen.id}:${openRecord?.type ?? ''}:${openRecord?.id ?? ''}` : null
  useEffect(() => {
    if (!openKey || !openChangeable || !canManage) {
      setOpenPeople(null)
      return
    }
    let gone = false
    setOpenPeople({ status: 'loading' })
    listAssignees(api, openRecord ? { type: openRecord.type, id: openRecord.id } : null)
      .then((people) => !gone && setOpenPeople({ status: 'ready', data: people }))
      .catch((error: unknown) => !gone && setOpenPeople({ status: 'error', problem: taskReadProblem(error) }))
    return () => {
      gone = true
    }
    // The record is part of openKey: it is read again only when the task or its record changes.
  }, [api, openKey, openChangeable, canManage])

  // ---- live ----------------------------------------------------------------------------------------------------------
  const pendingRead = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readSoon = useCallback(() => {
    if (pendingRead.current) clearTimeout(pendingRead.current)
    pendingRead.current = setTimeout(() => {
      pendingRead.current = null
      void refresh()
    }, 500)
  }, [refresh])
  useEffect(() => () => (pendingRead.current ? clearTimeout(pendingRead.current) : undefined), [])
  const live = useTodayLive({ onChange: (type) => TASK_EVENTS.includes(type) && readSoon(), onReconnect: readSoon }, allowed)

  // ---- dialogs -------------------------------------------------------------------------------------------------------
  const peopleFor = useCallback(
    async (kind: 'new' | 'reassign', ids: readonly string[]) => {
      const rows = itemsRef.current.filter((item) => ids.includes(item.id))
      // One record for every task chosen: who may keep tasks there; else who keeps tasks at all (the API checks each).
      const records = [...new Set(rows.map((row) => (row.record ? `${row.record.type}|${row.record.id}` : '')))]
      const record = kind === 'reassign' && records.length === 1 && records[0] ? { type: records[0].split('|')[0]!, id: records[0].split('|')[1]! } : null
      try {
        const people = await listAssignees(api, record)
        setDialog((current) => (current && current.kind === kind ? { ...current, people: { status: 'ready', data: people } } : current))
      } catch (error) {
        setDialog((current) => (current && current.kind === kind ? { ...current, people: { status: 'error', problem: taskReadProblem(error) } } : current))
      }
    },
    [api],
  )
  const openDialog = useCallback(
    (request: TasksDialogRequest | null) => {
      // Closing keeps the notice the dialog's action just set (Snooze and New task close themselves after it).
      if (request === null) return setDialog(null)
      setNotice(null)
      if (request.kind === 'new') {
        setDialog({ kind: 'new', people: { status: 'loading' } })
        void peopleFor('new', [])
      } else if (request.kind === 'reassign') {
        const ids = bulkRows(itemsRef.current, selected).map((row) => row.id)
        setDialog({ kind: 'reassign', ids, people: { status: 'loading' } })
        void peopleFor('reassign', ids)
      } else if (request.kind === 'due') setDialog({ kind: 'due', ids: bulkRows(itemsRef.current, selected).map((row) => row.id) })
      else setDialog(request)
    },
    [peopleFor, selected],
  )
  // `?new=1` (Today's New ▾, a link): New task opens once, and the address forgets it.
  useEffect(() => {
    if (!wantsNew || !allowed) return
    if (canManage) openDialog({ kind: 'new' })
    go({ newTask: false })
  }, [wantsNew, allowed, canManage, openDialog, go])

  // ---- writes --------------------------------------------------------------------------------------------------------
  const taskOf = (id: string): TaskItem | null => items.find((item) => item.id === id) ?? (shownOpen?.id === id ? shownOpen : null)
  const failed = (error: unknown) => {
    const problem = taskWriteProblem(error)
    setNotice({ key: problem.key, tone: problem.tone })
    if (problem.reload) {
      void load()
      if (openRef.current) void readOpen(openRef.current)
    }
  }
  /** One change: busy, the API, the answer kept for the popup, the list read again. */
  const change = async (run: () => Promise<TaskItem | TaskItem[]>, done: TasksNotice | null): Promise<boolean> => {
    setBusy(true)
    setNotice(null)
    try {
      const answer = await run()
      const one = Array.isArray(answer) ? null : answer
      if (one && one.id === openRef.current) setOpenTask({ id: one.id, read: { status: 'ready', data: one } })
      if (done) setNotice(done)
      await load()
      return true
    } catch (error) {
      failed(error)
      return false
    } finally {
      setBusy(false)
    }
  }
  const complete = async (id: string) => {
    const task = taskOf(id)
    if (!task || task.status !== 'OPEN') return
    // At once (the one optimistic toggle of the design), then the API; Undo reopens it.
    setList((current) => (current.status === 'ready' ? { status: 'ready', data: { ...current.data, items: current.data.items.map((item) => (item.id === id ? doneLocally(item) : item)) } } : current))
    const ok = await change(async () => {
      const answer = await setTaskStatus(api, task, 'DONE')
      setUndoTask(answer)
      return answer
    }, { key: 'notice.done', tone: 'success', params: { title: task.title }, undo: true })
    if (!ok) setUndoTask(null)
  }
  const setStatus = (id: string, status: TaskStatus, done: TasksNotice) => {
    const task = taskOf(id)
    if (task) void change(() => setTaskStatus(api, task, status), done)
  }
  const bulk = async (action: BulkAction, extra: { assigneeId?: string | null; dueDate?: string | null }, done: (count: number) => TasksNotice): Promise<boolean> => {
    const rows = bulkRows(items, selected)
    if (rows.length === 0) return false
    const ok = await change(() => bulkTasks(api, action, rows, extra), done(rows.length))
    if (ok) setSelected([])
    return ok
  }

  // ---- the view model ------------------------------------------------------------------------------------------------
  const rowOf = useCallback(
    (task: TaskItem): TaskRow => ({
      ...task,
      href: `${prefix}/home/tasks${tasksAddress({ scope, tile, q: addressQ, open: task.id })}`,
      recordHref: task.record ? `${prefix}${recordAddress({ type: task.record.type, id: task.record.id, label: task.record.label, companyId: task.companyId, siteId: task.siteId }, OFFICE_PAGES)}` : null,
    }),
    [prefix, scope, tile, addressQ],
  )
  const model: TasksViewModel = {
    access: allowed ? 'open' : 'refused',
    now,
    prefix,
    me: session.user.id,
    canManage,
    live,
    scope,
    tile,
    q,
    list:
      list.status === 'ready'
        ? {
            status: 'ready',
            data: {
              asOf: list.data.answer.asOf,
              tiles: list.data.answer.tiles,
              total: list.data.answer.total,
              complete: list.data.answer.complete,
              rows: list.data.items.map(rowOf),
              more: list.data.cursor !== null,
              loadingMore: list.data.loadingMore,
            },
          }
        : list,
    updates: list.status === 'ready' && list.data.pending ? Math.max(1, updatesBetween(list.data.items, list.data.pending.items)) : 0,
    selected,
    open: openId ? { id: openId, task: shownOpen ? { status: 'ready', data: rowOf(shownOpen) } : openTask?.id === openId && openTask.read.status === 'error' ? openTask.read : { status: 'loading' }, people: openPeople } : null,
    dialog,
    busy,
    notice,
  }

  return (
    <TasksView
      model={model}
      actions={{
        onScope: (next) => go({ scope: next, open: null }),
        onTile: (next) => go({ tile: next, open: null }),
        onSearch: setQ,
        onMore: async () => {
          if (list.status !== 'ready' || list.data.cursor === null) return
          const cursor = list.data.cursor
          setList({ status: 'ready', data: { ...list.data, loadingMore: true } })
          try {
            const page = await listTasks(api, { scope, tile, q: addressQ, cursor })
            setList((current) => (current.status === 'ready' ? { status: 'ready', data: { ...current.data, items: [...current.data.items, ...page.items], cursor: page.nextCursor, loadingMore: false } } : current))
          } catch (error) {
            setList((current) => (current.status === 'ready' ? { status: 'ready', data: { ...current.data, loadingMore: false } } : current))
            setNotice({ key: taskReadProblem(error), tone: 'danger' })
          }
        },
        onShowUpdates: () => {
          if (list.status !== 'ready' || !list.data.pending) return
          const answer = list.data.pending
          setList({ status: 'ready', data: { answer, items: answer.items, cursor: answer.nextCursor, loadingMore: false, pending: null } })
        },
        onSelect: setSelected,
        onOpen: (id) => {
          setNotice(null)
          go({ open: id })
        },
        onRetry: () => {
          setList({ status: 'loading' })
          void load()
        },
        onRetryOpen: () => openId && void readOpen(openId),
        onRetryPeople: () => {
          if (dialog?.kind === 'new' || dialog?.kind === 'reassign') {
            setDialog({ ...dialog, people: { status: 'loading' } })
            void peopleFor(dialog.kind, dialog.kind === 'reassign' ? dialog.ids : [])
          }
        },
        onDialog: openDialog,
        onDismissNotice: () => setNotice(null),
        onComplete: (id) => void complete(id),
        onReopen: (id) => setStatus(id, 'OPEN', { key: 'notice.reopened', tone: 'success', params: { title: taskOf(id)?.title ?? '' } }),
        onUndo: () => {
          const task = undoTask
          if (!task) return
          setUndoTask(null)
          void change(() => setTaskStatus(api, task, 'OPEN'), { key: 'notice.undone', tone: 'success', params: { title: task.title } })
        },
        onCreate: async (draft) => {
          const ok = await change(() => createTask(api, createBody(draft, null)), { key: 'notice.created', tone: 'success', params: { title: draft.title.trim() } })
          if (ok) setDialog(null)
          return ok
        },
        onBulkDone: () => void bulk('DONE', {}, (count) => ({ key: 'notice.bulkDone', tone: 'success', params: { count } })),
        onReassign: async (assigneeId) => {
          const ok = await bulk('REASSIGN', { assigneeId }, (count) => ({ key: 'notice.reassigned', tone: 'success', params: { count } }))
          if (ok) setDialog(null)
          return ok
        },
        onSetDue: async (dueDate) => {
          const ok = await bulk('SET_DUE', { dueDate }, (count) => ({ key: 'notice.dueSet', tone: 'success', params: { count } }))
          if (ok) setDialog(null)
          return ok
        },
        onAssign: (id, assigneeId) => {
          const task = taskOf(id)
          if (task) void change(() => assignTask(api, task, assigneeId), { key: assigneeId === null ? 'notice.unassigned' : 'notice.assigned', tone: 'success', params: { title: task.title } })
        },
        onDue: (id, dueDate) => {
          const task = taskOf(id)
          if (task && dueDate !== task.dueDate) void change(() => updateTask(api, task, { dueDate, dueTime: dueDate ? task.dueTime : null }), { key: 'notice.dueChanged', tone: 'success', params: { title: task.title } })
        },
        onChecklist: (id, itemId, done) => {
          const task = taskOf(id)
          if (task) void change(() => updateTask(api, task, { checklist: task.checklist.map((item) => ({ id: item.id, text: item.text, done: item.id === itemId ? done : item.done })) }), null)
        },
        onSnooze: async (id, until) => {
          const task = taskOf(id)
          if (!task) return false
          const ok = await change(() => snoozeTask(api, task, until), { key: 'notice.snoozed', tone: 'success', params: { title: task.title } })
          // A snoozed task leaves Today until then, not My tasks: the popup stays on it.
          if (ok) setDialog(null)
          return ok
        },
      }}
    />
  )
}
