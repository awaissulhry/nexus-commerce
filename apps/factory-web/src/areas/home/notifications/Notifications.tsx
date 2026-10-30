'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { useTodayLive } from '../today/live'
import {
  digestSaveProblem,
  fetchDigest,
  fetchNotifications,
  markDone,
  markRead,
  markTabRead,
  muteProblem,
  muteRecord,
  readProblem,
  saveDigest,
  snoozeNotifications,
  wakeNotifications,
  writeProblem,
} from './api'
import {
  freshCount,
  idsOf,
  LIVE_EVENTS,
  NOTIFICATIONS_CHANGED,
  rowsOf,
  stateOf,
  tabOf,
  type DigestDraft,
  type Loaded,
  type Notice,
  type NotificationList,
  type NotificationRow,
  type NotificationsDialog,
  type NotificationsViewModel,
  type NotificationState,
  type NotificationTab,
} from './model'
import { NotificationsView } from './view/NotificationsView'

interface ListState {
  readonly answer: NotificationList
  readonly items: NotificationList['items']
  readonly cursor: string | null
  readonly loadingMore: boolean
  /** A fresher first page a live change brought, shown when the person asks ("N new · Show"). */
  readonly pending: NotificationList | null
}

const ready = (answer: NotificationList): Loaded<ListState> => ({ status: 'ready', data: { answer, items: answer.items, cursor: answer.nextCursor, loadingMore: false, pending: null } })

/**
 * `/w/<company>/home/notifications` (SCR-005): my notifications by tab (`?tab=`) and state (`?state=OPEN|SNOOZED|DONE`)
 * through the API client, the unread counts on the tabs and in the band, read / done (with Undo) / snooze / wake / mute,
 * "Mark all read" for the tab, and my daily digest (off until I turn it on). A live `notification.created` reads the
 * first page again; new rows wait behind "N new · Show" and never move under the cursor or an open dialog. After every
 * change the bell is told to read its count again (`factory:notifications-changed`).
 */
export function Notifications() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const search = useSearchParams()
  const allowed = useMemo(() => session.permissions.includes('home.view'), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = tabOf(search.get('tab'))
  const state = stateOf(search.get('state'))

  const [list, setList] = useState<Loaded<ListState>>({ status: 'loading' })
  const [selected, setSelected] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<NotificationsDialog | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const seq = useRef(0)
  const where = useRef({ tab, state })
  where.current = { tab, state }
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog

  const setParams = useCallback(
    (changes: Readonly<Record<string, string | null>>) => {
      const params = new URLSearchParams(search.toString())
      for (const [name, value] of Object.entries(changes)) {
        if (value === null) params.delete(name)
        else params.set(name, value)
      }
      const qs = params.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname, search],
  )

  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const answer = await fetchNotifications(api, where.current)
      if (mine !== seq.current) return
      setNow(Date.now())
      setList(ready(answer))
    } catch (error) {
      if (mine === seq.current) setList({ status: 'error', problem: readProblem(error) })
    }
  }, [api])

  /** A live change: a fresher first page; new rows wait behind "N new · Show" (never while a dialog is open). */
  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const answer = await fetchNotifications(api, where.current)
      if (mine !== seq.current) return
      setNow(Date.now())
      setList((current) => {
        if (current.status !== 'ready') return ready(answer)
        if (freshCount(current.data.items, answer.items) > 0 || dialogRef.current !== null) return { status: 'ready', data: { ...current.data, pending: answer } }
        return ready(answer)
      })
    } catch {
      // A failed refresh keeps what is shown; the next change or a reconnect reads again.
    }
  }, [api])

  const loadMore = useCallback(async () => {
    if (list.status !== 'ready' || list.data.cursor === null) return
    const cursor = list.data.cursor
    setList({ status: 'ready', data: { ...list.data, loadingMore: true } })
    try {
      const page = await fetchNotifications(api, { ...where.current, cursor })
      setList((current) => (current.status === 'ready' ? { status: 'ready', data: { ...current.data, items: [...current.data.items, ...page.items], cursor: page.nextCursor, loadingMore: false } } : current))
    } catch (error) {
      setList((current) => (current.status === 'ready' ? { status: 'ready', data: { ...current.data, loadingMore: false } } : current))
      setNotice({ key: readProblem(error), tone: 'danger' })
    }
  }, [api, list])

  useEffect(() => {
    if (!allowed) return
    setList({ status: 'loading' })
    setSelected([])
    void load()
  }, [allowed, tab, state, load])

  const pendingRead = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readAgain = useCallback(() => {
    if (pendingRead.current) clearTimeout(pendingRead.current)
    pendingRead.current = setTimeout(() => {
      pendingRead.current = null
      void refresh()
    }, 500)
  }, [refresh])
  useEffect(() => () => (pendingRead.current ? clearTimeout(pendingRead.current) : undefined), [])
  const live = useTodayLive({ onChange: (type) => LIVE_EVENTS.includes(type) && readAgain(), onReconnect: readAgain }, allowed)

  const items = list.status === 'ready' ? list.data.items : []
  const rows = useMemo(() => rowsOf(items, prefix, OFFICE_PAGES), [items, prefix])
  const changed = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED))

  /** One write over the person's own rows: a notice, the list and the bell read again, the selection cleared. */
  const write = async (run: () => Promise<unknown>, done: Notice | null): Promise<boolean> => {
    setBusy(true)
    setNotice(null)
    try {
      await run()
      setNotice(done)
      setSelected([])
      changed()
      await load()
      return true
    } catch (error) {
      const problem = writeProblem(error)
      setNotice({ key: problem.key, tone: problem.tone })
      if (problem.reload) void load()
      return false
    } finally {
      setBusy(false)
    }
  }

  const open = (row: NotificationRow) => {
    // Read on the way: the bell and the list follow; a failure never stops the opening.
    if (!row.read) void markRead(api, row.group.ids.length > 0 ? row.group.ids : [row.id]).then(changed, () => undefined)
    router.push(row.href)
  }

  const loadDigest = useCallback(async () => {
    setDialog({ kind: 'digest', digest: { status: 'loading' }, saving: false, problem: null })
    try {
      const digest = await fetchDigest(api)
      setDialog((current) => (current?.kind === 'digest' ? { ...current, digest: { status: 'ready', data: digest } } : current))
    } catch (error) {
      setDialog((current) => (current?.kind === 'digest' ? { ...current, digest: { status: 'error', problem: readProblem(error) } } : current))
    }
  }, [api])

  const save = async (draft: DigestDraft) => {
    if (dialog?.kind !== 'digest' || dialog.digest.status !== 'ready') return
    const version = dialog.digest.data.version
    setDialog({ ...dialog, saving: true, problem: null })
    try {
      const digest = await saveDigest(api, draft, version)
      setDialog(null)
      setNotice({ key: digest.on ? 'digest.saved.on' : 'digest.saved.off', tone: 'success', params: { time: digest.sendTime } })
    } catch (error) {
      const problem = digestSaveProblem(error)
      setDialog((current) => (current?.kind === 'digest' ? { ...current, saving: false, problem } : current))
      // Changed meanwhile: read it again, so the next save carries the version that is there now.
      if (problem === 'digest.problem.changed') {
        try {
          const digest = await fetchDigest(api)
          setDialog((current) => (current?.kind === 'digest' ? { ...current, digest: { status: 'ready', data: digest } } : current))
        } catch {
          // The dialog keeps the problem; a retry reads again.
        }
      }
    }
  }

  const counts = list.status === 'ready' ? list.data.answer.counts : null
  const model: NotificationsViewModel = {
    access: allowed ? 'open' : 'refused',
    now,
    live,
    prefix,
    tab,
    state,
    counts,
    list:
      list.status === 'ready'
        ? {
            status: 'ready',
            data: {
              asOf: list.data.answer.asOf,
              items: rows,
              more: list.data.cursor !== null,
              loadingMore: list.data.loadingMore,
              fresh: list.data.pending ? Math.max(1, freshCount(list.data.items, list.data.pending.items)) : 0,
            },
          }
        : list,
    selected,
    busy,
    notice,
    dialog,
  }

  const ids = (picked: readonly string[]) => idsOf(items, picked)

  return (
    <NotificationsView
      model={model}
      actions={{
        onTab: (next: NotificationTab) => {
          setNotice(null)
          setParams({ tab: next === 'ALL' ? null : next })
        },
        onState: (next: NotificationState) => {
          setNotice(null)
          setParams({ state: next === 'OPEN' ? null : next })
        },
        onSelect: setSelected,
        onOpen: open,
        onRetry: () => {
          setList({ status: 'loading' })
          void load()
        },
        onMore: () => void loadMore(),
        onShowFresh: () => {
          if (list.status === 'ready' && list.data.pending) setList(ready(list.data.pending))
        },
        onRead: (picked, read) => write(() => markRead(api, ids(picked), read), { key: read ? 'notice.read' : 'notice.unread', tone: 'success', params: { count: picked.length } }),
        onDone: (picked) => {
          const all = ids(picked)
          return write(() => markDone(api, all, true), { key: 'notice.done', tone: 'success', params: { count: picked.length }, undo: { ids: all } })
        },
        onUndoDone: (all) => write(() => markDone(api, all, false), { key: 'notice.undone', tone: 'success' }),
        onBack: (picked) => write(() => markDone(api, ids(picked), false), { key: 'notice.back', tone: 'success', params: { count: picked.length } }),
        onWake: (picked) => write(() => wakeNotifications(api, ids(picked)), { key: 'notice.woken', tone: 'success', params: { count: picked.length } }),
        onSnoozeAsk: (picked, what) => setDialog({ kind: 'snooze', ids: ids(picked), what }),
        onSnooze: async (all, until) => {
          const done = await write(() => snoozeNotifications(api, all, until), { key: until ? 'notice.snoozed' : 'notice.snoozedChange', tone: 'success', params: { count: all.length } })
          if (done) setDialog(null)
          return done
        },
        onMute: async (row) => {
          setBusy(true)
          setNotice(null)
          try {
            await muteRecord(api, row.record)
            setNotice({ key: 'notice.muted', tone: 'success', params: { record: row.record.label } })
          } catch (error) {
            setNotice({ key: muteProblem(error), tone: 'warning', params: { record: row.record.label } })
          } finally {
            setBusy(false)
          }
        },
        onAllRead: () => write(() => markTabRead(api, tab), { key: 'notice.allRead', tone: 'success' }),
        onDigest: () => void loadDigest(),
        onRetryDigest: () => void loadDigest(),
        onSaveDigest: (draft) => void save(draft),
        onCloseDialog: () => setDialog(null),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
