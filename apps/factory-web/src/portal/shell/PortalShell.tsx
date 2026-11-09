'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { PublicBranding } from '@nexus/factory-domain/branding/contracts'
import { brandPortals } from '@nexus/ui/tokens/branding'
import { brandingTokensOf } from '../../lib/api/branding'
import { isApiError } from '../../lib/api/errors'
import { formatDate, formatTime } from '../../lib/i18n/format'
import { useLocale, useT } from '../../lib/i18n/provider'
import { useTheme } from '../../lib/theme/use-theme'
import {
  changeLocale,
  fetchEmailSettings,
  fetchMyAccess,
  fetchNotifications,
  fetchTasks,
  fetchUnread,
  markRead,
  markTaskDone,
  refreshSession,
  saveEmailSettings,
  searchPortal,
  signOutPortal,
  undoTask,
  type EmailSettings,
  type MyAccess,
  type PortalMe,
  type PortalNotifications,
  type PortalTask,
  type PortalTasks,
} from './api'
import { PortalBandProvider, PortalFrameProvider, PortalGuardProvider, portalBrowserApi, usePortalLive, type GuardRegistry, type PortalBand, type PortalFrameValue, type UnsavedGuard } from './frame'
import {
  allNonEssentialOff,
  badgesOf,
  emailChanges,
  emailDraftOf,
  idleEndAfterCall,
  isTypingTarget,
  kindsOf,
  noticesOf,
  portalKeyAction,
  portalLink,
  portalPathOf,
  portalPrefix,
  sessionEndOf,
  shownNotice,
  signInHref,
  stillThereAt,
  staying,
  taskGroupsOf,
  whenText,
  withNonEssential,
  type EmailDraft,
  type PortalNotice,
  type SessionEnd,
} from './model'
import { portalChords, portalNavFor } from './nav/portal-nav'
import { PortalThread } from './thread/PortalThread'
import { EmailSettingsView } from './view/EmailSettingsView'
import { DisplayView, MyAccessView, ShortcutsView, StillThereView, UnsavedGuardView, type ShortcutGroup } from './view/FrameDialogs'
import { NotificationsView } from './view/NotificationsView'
import { PortalShellView, type PortalDialog } from './view/PortalShellView'
import { SearchView, type SearchViewModel } from './view/SearchView'
import { Modal } from '../../lib/i18n/ds-parts'
import type { TaskRowState, TasksViewModel } from './view/TasksView'

/**
 * The live portal frame (B-W2b-173): the signed-in partner (from the layout) → the frame's view model, and everything the
 * view does not do — the address, client navigation, the one task list (badges and Home), the bell, the one live channel,
 * the idle sign-out and "Still there?", the notices and their dismissal (per person, on this device), the pop-ups, the
 * keys, the unsaved-work guard, the company's branding on every pop-up (D24), the language (the person's own, kept by the
 * API) and the theme (this device). Pages read it through `usePortalFrame` / `usePortalBand` / `usePortalTasks`.
 */

export interface PortalShellProps {
  me: PortalMe
  branding: PublicBranding | null
  children?: ReactNode
}

// ── the one task list, for Home (and any page that answers a request) ────────────────────────────────────────────────
export interface PortalTasksValue {
  model: TasksViewModel
  onDone: (row: TaskRowState) => void
  onUndo: (row: TaskRowState) => void
  onRetry: () => void
}
const TasksContext = createContext<PortalTasksValue | null>(null)
export function usePortalTasks(): PortalTasksValue {
  const value = useContext(TasksContext)
  if (!value) throw new Error('usePortalTasks: outside the portal frame')
  return value
}

const NOTICES_KEY = (userId: string) => `fw-portal-notices:${userId}`
const readDismissed = (userId: string): Record<string, string> => {
  try {
    const value = JSON.parse(window.localStorage.getItem(NOTICES_KEY(userId)) ?? '{}') as unknown
    return typeof value === 'object' && value !== null ? (value as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function PortalShell({ me, branding, children }: PortalShellProps) {
  const router = useRouter()
  const pathname = usePathname() ?? '/'
  const search = useSearchParams()
  const t = useT('portal')
  const locale = useLocale()
  const { mode: theme, setTheme } = useTheme()
  const prefix = portalPrefix(me.party.code)
  const path = portalPathOf(pathname, prefix)
  const kinds = useMemo(() => kindsOf(me), [me])
  const can = useMemo(() => new Set(me.permissions), [me.permissions])
  const nav = useMemo(() => portalNavFor({ can: (permission) => can.has(permission), kinds }), [can, kinds])
  const brand = useMemo(() => (branding ? brandingTokensOf(branding, 'portal') : null), [branding])

  // ── the idle clock: each answer moves it (the API slides the idle end at most once a minute) ──
  const absoluteEnd = Date.parse(me.session.absoluteExpiresAt)
  const [idleEnd, setIdleEnd] = useState(() => Date.parse(me.session.idleExpiresAt))
  const onCall = useCallback((at: number) => setIdleEnd((current) => idleEndAfterCall(current, at, absoluteEnd)), [absoluteEnd])
  const api = useMemo(() => portalBrowserApi(onCall), [onCall])

  // ── branding and density reach every pop-up (they render into <body>) ──
  useEffect(() => brandPortals(brand), [brand])
  useEffect(() => {
    const body = document.body
    const before = body.getAttribute('data-density')
    body.setAttribute('data-density', 'comfortable')
    return () => {
      if (before === null) body.removeAttribute('data-density')
      else body.setAttribute('data-density', before)
    }
  }, [])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // ── the band and the unsaved-work guards the pages register ──
  const [band, setBand] = useState<PortalBand | null>(null)
  const guards = useRef(new Map<string, UnsavedGuard>())
  const [guardTick, setGuardTick] = useState(0)
  const registry = useMemo<GuardRegistry>(
    () => ({
      register: (id, guard) => {
        if (guard) guards.current.set(id, guard)
        else guards.current.delete(id)
        setGuardTick((tick) => tick + 1)
      },
    }),
    [],
  )
  const dirtyGuard = useCallback((): UnsavedGuard | null => [...guards.current.values()].find((guard) => guard.dirty) ?? null, [])
  const [leaving, setLeaving] = useState<{ href: string | null; guard: UnsavedGuard; saving: boolean } | null>(null)
  const leaveTo = useCallback(
    (href: string | null, then?: () => void) => {
      const guard = dirtyGuard()
      if (guard) {
        setLeaving({ href, guard, saving: false })
        pendingAfter.current = then ?? null
        return
      }
      if (then) then()
      else if (href) router.push(href)
    },
    [dirtyGuard, router],
  )
  const pendingAfter = useRef<(() => void) | null>(null)

  // In-app links anywhere in the frame: typed work asks first. The browser's own leaving asks too.
  useEffect(() => {
    const onClick = (event: globalThis.MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return
      const guard = dirtyGuard()
      if (!guard) return
      event.preventDefault()
      setLeaving({ href: `${url.pathname}${url.search}${url.hash}`, guard, saving: false })
    }
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!dirtyGuard()) return
      event.preventDefault()
      event.returnValue = ''
    }
    document.addEventListener('click', onClick, true)
    window.addEventListener('beforeunload', onLeave)
    return () => {
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('beforeunload', onLeave)
    }
  }, [dirtyGuard, guardTick])

  // ── the one task list (badges, Home) ──
  const [tasks, setTasks] = useState<PortalTasks | null>(null)
  const [tasksState, setTasksState] = useState<'loading' | 'error' | 'ready'>(can.has('portal.home.view') ? 'loading' : 'ready')
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [recentlyDone, setRecentlyDone] = useState<Record<string, PortalTask>>({})
  const [busyTask, setBusyTask] = useState<string | null>(null)
  const readTasks = useCallback(async () => {
    if (!can.has('portal.home.view')) return
    try {
      const answer = await fetchTasks(api)
      setTasks(answer)
      setTasksState('ready')
      setLoadedAt(Date.now())
    } catch {
      setTasksState((current) => (current === 'ready' ? 'ready' : 'error'))
    }
  }, [api, can])
  const readTasksRef = useRef(readTasks)
  readTasksRef.current = readTasks

  // ── the bell ──
  const [unread, setUnread] = useState<{ unread: number; complete: boolean } | null>(null)
  const readUnread = useCallback(async () => {
    if (!can.has('portal.home.view')) return
    try {
      const answer = await fetchUnread(api)
      setUnread({ unread: answer.unread, complete: answer.complete })
    } catch {
      setUnread(null)
    }
  }, [api, can])

  // ── My access (the menu, the end of access, the admins) ──
  const [access, setAccess] = useState<MyAccess | null>(null)
  const [accessState, setAccessState] = useState<'loading' | 'error' | 'ready'>('loading')
  const readAccess = useCallback(async () => {
    try {
      setAccess(await fetchMyAccess(api))
      setAccessState('ready')
    } catch {
      setAccessState('error')
    }
  }, [api])

  useEffect(() => {
    void readTasksRef.current()
    void readUnread()
    void readAccess()
  }, [readUnread, readAccess])

  // ── the live channel: hints only, each part reads itself again ──
  const [notifications, setNotifications] = useState<PortalNotifications | null>(null)
  const [dialog, setDialog] = useState<PortalDialog | null>(null)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog
  const readList = useCallback(async () => {
    setNotificationsState('loading')
    try {
      setNotifications(await fetchNotifications(api))
      setNotificationsState('ready')
    } catch {
      setNotificationsState('error')
    }
  }, [api])
  const [notificationsState, setNotificationsState] = useState<'loading' | 'error' | 'ready'>('loading')
  const live = usePortalLive(
    {
      onChange: (change) => {
        if (change.type.startsWith('partner_task.')) void readTasksRef.current()
        if (change.type === 'partner_notification.created') {
          void readUnread()
          if (dialogRef.current === 'notifications') void readList()
        }
      },
      onReconnect: () => {
        void readTasksRef.current()
        void readUnread()
      },
    },
    can.has('portal.home.view'),
  )
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  const offline = !online || (can.has('portal.home.view') && live === 'offline')

  // ── notices: one at a time, the most serious first; a dismissal is kept per person and value ──
  const [dismissed, setDismissed] = useState<Record<string, string>>({})
  useEffect(() => setDismissed(readDismissed(me.user.id)), [me.user.id])
  const notices = noticesOf({
    preview: me.preview ? { viewer: me.user.displayName, company: me.company.name, party: me.party.name } : null,
    offlineSince: offline && loadedAt ? formatTime(loadedAt, { locale }) : offline ? '—' : null,
    accessEnds: access?.accessEndsSoon && access.accessUntil ? formatDate(access.accessUntil, { locale }) : null,
    record: band?.readOnly ?? null,
  })
  const notice = shownNotice(notices, dismissed)
  const dismiss = (shown: PortalNotice) => {
    if (shown.value === undefined) return
    const next = { ...dismissed, [shown.id]: shown.value }
    setDismissed(next)
    try {
      window.localStorage.setItem(NOTICES_KEY(me.user.id), JSON.stringify(next))
    } catch {
      // A browser that keeps nothing shows the notice again next time.
    }
  }

  // ── "Still there?" two minutes before the idle sign-out ──
  const [stillThere, setStillThere] = useState<{ open: boolean; busy: boolean; failed: boolean }>({ open: false, busy: false, failed: false })
  useEffect(() => {
    const at = stillThereAt(idleEnd, absoluteEnd)
    const wait = Math.max(0, at - Date.now())
    const timer = window.setTimeout(() => setStillThere((current) => ({ ...current, open: true })), Math.min(wait, 2_147_000_000))
    return () => window.clearTimeout(timer)
  }, [idleEnd, absoluteEnd])
  const endsAt = new Date(Math.min(idleEnd, absoluteEnd)).toISOString()
  // To sign in and back here; `ended` (B-W2b-164's banner) when the session ended rather than the person choosing to leave.
  const goSignIn = useCallback(
    (ended: SessionEnd | null) => {
      void signOutPortal(api)
        .catch(() => undefined)
        .finally(() => window.location.assign(signInHref(`${window.location.pathname}${window.location.search}`, ended)))
    },
    [api],
  )
  // The countdown reached the end: the idle end (or the 12 hours) ended the session.
  const sessionEnded = () => goSignIn(sessionEndOf(Math.max(Date.now(), Math.min(idleEnd, absoluteEnd)), idleEnd, absoluteEnd))
  const stay = async () => {
    setStillThere({ open: true, busy: true, failed: false })
    try {
      const times = await refreshSession(api)
      setIdleEnd(Date.parse(times.idleExpiresAt))
      setStillThere({ open: false, busy: false, failed: false })
    } catch (error) {
      // The API no longer knows the session: past the idle clock it is the idle end, before it the session was ended elsewhere.
      if (isApiError(error) && error.kind === 'signed_out') goSignIn(sessionEndOf(Date.now(), idleEnd, absoluteEnd))
      else setStillThere({ open: true, busy: false, failed: true })
    }
  }

  // ── sign out ──
  const signOut = () =>
    leaveTo(null, () => {
      void signOutPortal(api)
        .catch(() => undefined)
        .finally(() => window.location.assign(signInHref(null)))
    })

  // ── the pop-ups ──
  const bellAnchor = useRef<HTMLSpanElement>(null)
  const [marking, setMarking] = useState(false)
  const open = (next: PortalDialog) => {
    setDialog(next)
    if (next === 'notifications') void readList()
    if (next === 'email') void readEmail()
    if (next === 'access') void readAccess()
    if (next === 'search') setSearchState((current) => ({ ...current, open: true }))
  }
  const close = () => setDialog(null)

  // E-mail settings: the draft, the save, closing with changes.
  const [email, setEmail] = useState<{ state: 'loading' | 'error' | 'ready'; settings: EmailSettings | null; draft: EmailDraft; saving: boolean; failed: string | null }>({ state: 'loading', settings: null, draft: {}, saving: false, failed: null })
  const [emailLeaving, setEmailLeaving] = useState(false)
  const readEmail = useCallback(async () => {
    setEmail((current) => ({ ...current, state: 'loading', failed: null }))
    try {
      const settings = await fetchEmailSettings(api)
      setEmail({ state: 'ready', settings, draft: emailDraftOf(settings), saving: false, failed: null })
    } catch {
      setEmail((current) => ({ ...current, state: 'error' }))
    }
  }, [api])
  const emailChanged = email.settings ? emailChanges(email.settings, email.draft) : []
  const saveEmail = async (): Promise<boolean> => {
    if (!email.settings || emailChanged.length === 0) return true
    setEmail((current) => ({ ...current, saving: true, failed: null }))
    try {
      const settings = await saveEmailSettings(api, { topics: emailChanged })
      setEmail({ state: 'ready', settings, draft: emailDraftOf(settings), saving: false, failed: null })
      return true
    } catch (error) {
      setEmail((current) => ({ ...current, saving: false, failed: t(isApiError(error) && error.kind === 'invalid' ? 'email.refused' : 'email.saveFailed') }))
      return false
    }
  }
  const closeEmail = () => (emailChanged.length > 0 ? setEmailLeaving(true) : close())

  // Opened from a mail's "Manage e-mails" (`?dialog=email-settings`): open once, then drop it from the address.
  useEffect(() => {
    if (search?.get('dialog') !== 'email-settings') return
    if (!me.preview) open('email')
    const rest = new URLSearchParams(search.toString())
    rest.delete('dialog')
    router.replace(`${pathname}${rest.toString() ? `?${rest}` : ''}`)
  }, [search])

  // Search (SAL-084): their numbers and ours, as typed, a quarter second after the last key.
  const [searchState, setSearchState] = useState<SearchViewModel>({ open: false, query: '', state: 'idle', groups: [], found: 0, capped: false, single: null })
  const searchSeq = useRef(0)
  const runSearch = useCallback(
    async (query: string) => {
      const seq = ++searchSeq.current
      if (query.trim() === '') {
        setSearchState((current) => ({ ...current, state: 'idle', groups: [], found: 0, capped: false, single: null }))
        return
      }
      setSearchState((current) => ({ ...current, state: 'searching' }))
      try {
        const answer = await searchPortal(api, query)
        if (seq !== searchSeq.current) return
        const href = (result: { recordType: string; recordId: string }) => `${prefix}/open/${encodeURIComponent(result.recordType)}/${encodeURIComponent(result.recordId)}`
        setSearchState((current) => ({
          ...current,
          state: answer.tooShort ? 'tooShort' : 'ready',
          found: answer.found,
          capped: answer.capped,
          single: answer.single ? href(answer.single) : null,
          groups: answer.groups.map((group) => ({
            group: group.group,
            label: t(`search.group.${group.group}`),
            count: group.count,
            results: group.results.map((result) => ({ key: `${result.recordType}:${result.recordId}`, href: href(result), theirs: result.theirRef, ours: result.ourRef, subtitle: result.subtitle, when: result.date ? formatDate(result.date, { locale }) : null })),
          })),
        }))
      } catch {
        if (seq === searchSeq.current) setSearchState((current) => ({ ...current, state: 'error' }))
      }
    },
    [api, prefix, t, locale],
  )
  const searchTimer = useRef<number | null>(null)
  const onQuery = (query: string) => {
    setSearchState((current) => ({ ...current, query }))
    if (searchTimer.current) window.clearTimeout(searchTimer.current)
    searchTimer.current = window.setTimeout(() => void runSearch(query), 250)
  }

  // Language (the person's own, kept by the API) and theme (this device).
  const [display, setDisplay] = useState({ saving: false, failed: false })
  const setLanguage = async (next: 'it' | 'en') => {
    if (next === locale) return
    setDisplay({ saving: true, failed: false })
    try {
      await changeLocale(api, next)
      setDisplay({ saving: false, failed: false })
      router.refresh()
    } catch {
      setDisplay({ saving: false, failed: true })
    }
  }

  // "Ask a question": the record's conversation with the box focused; on a page with no record, the account's.
  const [asking, setAsking] = useState<{ type: string; id: string; label: string | null } | null>(null)
  const ask = useCallback(
    (record: { type: string; id: string; label?: string | null } | null) => {
      const here = typeof document !== 'undefined' ? document.getElementById('messages') : null
      if (record && here) {
        here.scrollIntoView({ block: 'start' })
        here.querySelector<HTMLTextAreaElement>('textarea')?.focus()
        return
      }
      setAsking(record ? { type: record.type, id: record.id, label: record.label ?? null } : { type: 'Party', id: me.party.id, label: null })
    },
    [me.party.id],
  )

  // ── keys: / search, ? shortcuts, g + a letter goes to an area ──
  const chords = useMemo(() => portalChords(nav), [nav])
  const chordOpen = useRef<number | null>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || document.querySelector('[role="dialog"]')) return
      const action = portalKeyAction(event.key, chordOpen.current !== null && Date.now() - chordOpen.current < 1500, chords)
      chordOpen.current = null
      if (!action) return
      event.preventDefault()
      if (action.kind === 'search' && can.has('portal.search')) open('search')
      if (action.kind === 'shortcuts') open('shortcuts')
      if (action.kind === 'chord') chordOpen.current = Date.now()
      if (action.kind === 'go') leaveTo(action.href === '/' ? prefix : `${prefix}${action.href}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chords, prefix, can, leaveTo])

  const shortcutGroups: ShortcutGroup[] = [
    {
      title: t('keys.global'),
      keys: [
        ...(can.has('portal.search') ? [{ keys: ['/'], words: t('keys.search') }] : []),
        ...Object.entries(chords).map(([key, href]) => ({ keys: ['g', key], words: t('keys.go', { area: t(nav.areas.find((area) => area.href === href)?.label ?? 'nav.home') }) })),
        { keys: ['?'], words: t('keys.help') },
        { keys: ['Esc'], words: t('keys.escape') },
      ],
    },
    { title: t('keys.page'), keys: band?.keys ?? [] },
  ]

  // ── the task list for Home ──
  const doneTask = async (row: TaskRowState) => {
    const task = tasks?.items.find((item) => item.id === row.id)
    if (!task) return
    setBusyTask(task.id)
    try {
      const answer = await markTaskDone(api, task)
      setRecentlyDone((current) => ({ ...current, [task.id]: answer.task }))
      void readTasksRef.current()
      void readUnread()
    } catch {
      void readTasksRef.current()
    } finally {
      setBusyTask(null)
    }
  }
  const undoDone = async (row: TaskRowState) => {
    setBusyTask(row.id)
    try {
      await undoTask(api, row.id)
      setRecentlyDone((current) => {
        const { [row.id]: _gone, ...rest } = current
        return rest
      })
      void readTasksRef.current()
    } catch {
      void readTasksRef.current()
    } finally {
      setBusyTask(null)
    }
  }
  const openTasks = tasks?.items ?? []
  const shownTasks = [...openTasks, ...Object.values(recentlyDone).filter((task) => !openTasks.some((open) => open.id === task.id))]
  const tasksModel: TasksViewModel = {
    state: tasksState,
    groups: taskGroupsOf(shownTasks, locale, prefix).map((group) => ({
      ...group,
      rows: group.rows.map((row) => ({
        ...row,
        done: recentlyDone[row.id] ? { canUndo: recentlyDone[row.id].canUndo } : null,
        busy: busyTask === row.id,
        held: me.preview ? t('preview.held') : null,
      })),
    })),
  }

  const frame = useMemo<PortalFrameValue>(() => ({ me, prefix, kinds, api, access, ask, refreshTasks: () => void readTasksRef.current() }), [me, prefix, kinds, api, access, ask])
  const now = Date.now()

  return (
    <PortalFrameProvider value={frame}>
      <PortalBandProvider set={setBand}>
        <PortalGuardProvider registry={registry}>
          <TasksContext.Provider value={{ model: tasksModel, onDone: (row) => void doneTask(row), onUndo: (row) => void undoDone(row), onRetry: () => void readTasksRef.current() }}>
            <PortalShellView
              model={{
                brand,
                companyName: me.company.name,
                partyName: me.party.name,
                person: { displayName: me.user.displayName, email: me.user.email },
                nav,
                path,
                prefix,
                badges: badgesOf(tasks?.badges ?? null, locale),
                bell: unread,
                notice,
                band,
                live: can.has('portal.home.view') ? live : undefined,
                legal: me.company.legal[locale],
                privacyHref: `/privacy/${encodeURIComponent(me.company.id)}`,
                termsHref: `${prefix}/terms`,
                freeForSuppliers: kinds.some((kind) => kind === 'SUPPLIER' || kind === 'SUBCONTRACTOR') && !kinds.includes('CUSTOMER'),
                preview: me.preview,
                canSearch: can.has('portal.search'),
              }}
              onNavigate={(href) => leaveTo(href)}
              onOpen={open}
              onAsk={() => ask(band?.ask ?? null)}
              onSignOut={signOut}
              onDismissNotice={dismiss}
              bellRef={bellAnchor}
            >
              {children}
            </PortalShellView>

            <SearchView
              model={{ ...searchState, open: dialog === 'search' }}
              onQuery={onQuery}
              onClose={close}
              onRetry={() => void runSearch(searchState.query)}
              onOpen={(href, event?: MouseEvent<HTMLAnchorElement>) => {
                if (event && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) return
                event?.preventDefault()
                close()
                leaveTo(href)
              }}
            />
            <NotificationsView
              model={{
                open: dialog === 'notifications',
                state: notificationsState,
                unread: notifications?.unread ?? unread?.unread ?? 0,
                marking,
                markHeld: me.preview ? t('preview.held') : null,
                rows: (notifications?.items ?? []).map((item) => ({ id: item.id, sentence: item.sentence[locale], record: item.record.label, when: whenText(item.createdAt, now, locale), read: item.read, href: portalLink(item.link, prefix), more: Math.max(0, item.group.count - 1) })),
              }}
              anchor={bellAnchor.current}
              onClose={close}
              onRetry={() => void readList()}
              onMarkAll={async () => {
                setMarking(true)
                try {
                  await markRead(api, { all: true })
                  await Promise.all([readList(), readUnread()])
                } finally {
                  setMarking(false)
                }
              }}
              onOpen={(row, event) => {
                const item = notifications?.items.find((entry) => entry.id === row.id)
                if (item && !item.read && !me.preview) void markRead(api, { ids: item.group.ids }).then(() => readUnread()).catch(() => undefined)
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                event.preventDefault()
                close()
                leaveTo(row.href)
              }}
            />
            <EmailSettingsView
              model={{
                open: dialog === 'email',
                state: email.state,
                topics: (email.settings?.topics ?? []).map((topic) => ({ topic: topic.topic, name: topic.words[locale], frequency: email.draft[topic.topic] ?? topic.frequency, locked: topic.locked, reason: topic.reason ? topic.reason[locale] : null })),
                allOff: email.settings ? allNonEssentialOff(email.settings, email.draft) : false,
                changes: emailChanged.length,
                saving: email.saving,
                failed: email.failed,
              }}
              onClose={closeEmail}
              onChange={(topic, frequency) => setEmail((current) => ({ ...current, draft: { ...current.draft, [topic]: frequency } }))}
              onAllOff={(off) => setEmail((current) => (current.settings ? { ...current, draft: withNonEssential(current.settings, current.draft, off) } : current))}
              onSave={() => void saveEmail()}
              onDiscard={() => setEmail((current) => (current.settings ? { ...current, draft: emailDraftOf(current.settings), failed: null } : current))}
              onRetry={() => void readEmail()}
            />
            <UnsavedGuardView
              model={{ open: emailLeaving, what: t('unsaved.email', { count: emailChanged.length }), canSave: true, saving: email.saving }}
              onStay={() => setEmailLeaving(false)}
              onDiscard={() => {
                setEmailLeaving(false)
                setEmail((current) => (current.settings ? { ...current, draft: emailDraftOf(current.settings) } : current))
                close()
              }}
              onSave={async () => {
                if (await saveEmail()) {
                  setEmailLeaving(false)
                  close()
                } else setEmailLeaving(false)
              }}
            />
            <UnsavedGuardView
              model={{ open: leaving !== null, what: leaving?.guard.what ?? '', canSave: Boolean(leaving?.guard.save), saving: leaving?.saving ?? false }}
              onStay={() => setLeaving(null)}
              onDiscard={() => {
                const target = leaving
                setLeaving(null)
                guards.current.clear()
                if (pendingAfter.current) {
                  const then = pendingAfter.current
                  pendingAfter.current = null
                  then()
                } else if (target?.href) router.push(target.href)
              }}
              onSave={async () => {
                if (!leaving?.guard.save) return
                setLeaving({ ...leaving, saving: true })
                const ok = await leaving.guard.save()
                if (!ok) return setLeaving({ ...leaving, saving: false })
                const target = leaving
                setLeaving(null)
                if (pendingAfter.current) {
                  const then = pendingAfter.current
                  pendingAfter.current = null
                  then()
                } else if (target.href) router.push(target.href)
              }}
            />
            <ShortcutsView open={dialog === 'shortcuts'} groups={shortcutGroups} onClose={close} />
            <MyAccessView
              model={{
                open: dialog === 'access',
                state: accessState,
                role: access?.role ? t(`role.${access.role.key}`) : null,
                prices: access?.role?.seesPrices ?? false,
                capabilities: (access?.capabilities ?? []).map((capability) => t(`access.capability.${capability}`)),
                allows: (access?.allows ?? []).map((entry) => t(`access.permission.${entry.permission.replace(/\./g, '_')}`)),
                until: access?.accessUntil ? formatDate(access.accessUntil, { locale }) : null,
                admins: (access?.admins ?? []).map((admin) => admin.displayName),
                preview: me.preview,
              }}
              onClose={close}
              onRetry={() => void readAccess()}
            />
            <DisplayView model={{ open: dialog === 'display', locale, theme, saving: display.saving, failed: display.failed, preview: me.preview }} onLocale={(next) => void setLanguage(next)} onTheme={setTheme} onClose={close} />
            <StillThereView model={{ open: stillThere.open, endsAt, canStay: staying(idleEnd, absoluteEnd), busy: stillThere.busy, failed: stillThere.failed }} onStay={() => void stay()} onSignOut={() => goSignIn(null)} onEnded={sessionEnded} />
            <Modal open={asking !== null} onClose={() => setAsking(null)} sheet size="lg" title={asking?.type === 'Party' ? t('thread.accountTitle') : (asking?.label ?? t('thread.title'))}>
              {asking ? <PortalThread type={asking.type} id={asking.id} focus headingLevel={3} title={asking.type === 'Party' ? t('thread.accountHeading') : t('thread.title')} /> : null}
            </Modal>
          </TasksContext.Provider>
        </PortalGuardProvider>
      </PortalBandProvider>
    </PortalFrameProvider>
  )
}
