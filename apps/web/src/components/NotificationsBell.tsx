'use client'

/**
 * The top bar's notification bell.
 *
 * Polls /api/notifications for the badge, and opens a panel listing recent notices.
 * Clicking a notice marks it read and follows its link.
 *
 * ── 2026-09-16 — rebuilt on the design system, and made to show anything at all ──────────
 *
 * Measured before this rebuild, all on the first day the bell returned real rows:
 *
 *   • It had NEVER shown a notification. The API read the literal user 'default-user'
 *     while all 391,197 rows were addressed to real users (notifications.routes.ts).
 *   • In dark mode the panel painted rgb(255,255,255), and "All read" / "Refresh" were
 *     dark controls on that white panel. It was hand-written Tailwind, not the DS.
 *   • The only unread notice — a `danger` automation-halt alarm — sat below read digests,
 *     so the badge said "1 unread" about a row the list hid (`notifications-order.ts`).
 *   • Rows were <div role="button"> with no tabIndex and no key handler: a keyboard user
 *     could not open a single notification.
 *   • "View all in inbox" was a raw <a href="/inbox"> that dropped the business profile
 *     from the URL — the same defect as the studio's URL writes.
 *   • The trigger never said it opened anything, or whether it was open.
 *
 * Structure now follows the DS `Menu`: the trigger is a `ToolbarButton` (the same control
 * as the theme button beside it), and the panel is portalled to <body> and placed by
 * `usePopoverPosition`, so no scrolling ancestor can clip it.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, AlertTriangle, Bell, BellRing, CheckCircle2, Info, RefreshCw, X } from 'lucide-react'
import { ToolbarButton } from '@/design-system/components'
import { usePopoverPosition } from '@/design-system/components/usePopoverPosition'
import { Button } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { useRouter } from '@/lib/workspaces/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { orderNotifications } from './notifications-order'
import styles from './NotificationsBell.module.css'

interface NotificationRow {
  id: string
  type: string
  severity: 'info' | 'success' | 'warn' | 'danger' | string
  title: string
  body: string | null
  entityType: string | null
  entityId: string | null
  meta: unknown
  href: string | null
  readAt: string | null
  createdAt: string
}

const POLL_MS = 30_000
/** Shorter than POLL_MS, so a timed-out poll can never shadow the next tick. */
const POLL_TIMEOUT_MS = 15_000

type Tone = 'info' | 'success' | 'warn' | 'danger'
const TONE_ICON: Record<Tone, typeof Info> = { info: Info, success: CheckCircle2, warn: AlertTriangle, danger: AlertCircle }
/** Spoken with the title, because the icon and accent bar carry severity only by sight. */
const TONE_WORD: Record<Tone, string> = { info: 'Information', success: 'Done', warn: 'Warning', danger: 'Alert' }
const toneOf = (severity: string): Tone => (severity in TONE_ICON ? (severity as Tone) : 'info')

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export default function NotificationsBell() {
  const router = useRouter()
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<NotificationRow[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const { popRef, style: popStyle } = usePopoverPosition(open, wrapRef, { width: 'auto', align: 'end', offset: 8 })

  useEffect(() => { setMounted(true) }, [])

  /*
   * Never stack a poll on one still in flight (measured 2026-09-01: three copies pending at
   * once against a local API). Each pending request holds one of the ~6 connections a browser
   * allows per origin, so a poll that outruns the backend starves the rest of the page.
   * Only safe because the fetch carries a timeout: `finally` on a promise that never settles
   * never runs, and the first hung poll would latch this on for the life of the page.
   */
  const inFlightRef = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/notifications?limit=30`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(res.status === 401 ? 'Sign in to see your notifications.' : `Notifications could not be loaded (${res.status}).`)
      const json = await res.json()
      setRows(json.rows ?? [])
      setUnreadCount(json.unreadCount ?? 0)
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === 'TimeoutError'
          ? `No answer in ${POLL_TIMEOUT_MS / 1000}s. Try again.`
          : e instanceof Error ? e.message : String(e),
      )
    } finally {
      setLoading(false)
      inFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) wrapRef.current?.querySelector('button')?.focus()
  }, [])

  // Click outside closes. The panel is portalled, so it is outside `wrapRef` in the DOM and
  // must be checked on its own — without that, every click INSIDE the panel closed it.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node
      if (wrapRef.current?.contains(target) || popRef.current?.contains(target)) return
      close(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(true) }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close, popRef])

  const markRead = async (id: string) => {
    setRows(prev => prev.map(r => (r.id === id && !r.readAt ? { ...r, readAt: new Date().toISOString() } : r)))
    setUnreadCount(n => Math.max(0, n - 1))
    try {
      await fetch(`${getBackendUrl()}/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' })
    } catch {
      // The optimistic update stands; the next poll reconciles if the server did not accept.
    }
  }

  const markAllRead = async () => {
    setRows(prev => prev.map(r => (r.readAt ? r : { ...r, readAt: new Date().toISOString() })))
    setUnreadCount(0)
    try {
      await fetch(`${getBackendUrl()}/api/notifications/read-all`, { method: 'POST' })
    } catch {
      void refresh()
    }
  }

  const openRow = (row: NotificationRow) => {
    if (!row.readAt) void markRead(row.id)
    if (row.href) {
      router.push(row.href)
      close(false)
    }
  }

  const ordered = orderNotifications(rows)
  const label = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'

  return (
    <span ref={wrapRef} className="nds-menu-wrap">
      <ToolbarButton
        icon={unreadCount > 0 ? <BellRing size={16} aria-hidden /> : <Bell size={16} aria-hidden />}
        label={label}
        badge={unreadCount}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(v => !v)}
      />

      {open && mounted && createPortal(
        <div
          id={panelId}
          ref={popRef}
          style={popStyle}
          className={styles.panel}
          role="dialog"
          aria-label="Notifications"
        >
          <div className={styles.header}>
            <h2 className={styles.heading}>
              Notifications
              {unreadCount > 0 && <span className={styles.count}>· {unreadCount} unread</span>}
            </h2>
            <div className={styles.headerActions}>
              {unreadCount > 0 && (
                <Button size="xs" variant="quiet" onClick={() => void markAllRead()}>Mark all read</Button>
              )}
              <ToolbarButton icon={<X size={14} aria-hidden />} label="Close notifications" onClick={() => close(true)} />
            </div>
          </div>

          {error && <p className={styles.error} role="alert">{error}</p>}

          {loading && rows.length === 0 ? (
            <p className={styles.state} role="status">Loading notifications…</p>
          ) : ordered.length === 0 ? (
            <p className={styles.state} role="status">You are all caught up.</p>
          ) : (
            <ul className={styles.list}>
              {ordered.map(r => {
                const unread = !r.readAt
                const tone = toneOf(r.severity)
                const Icon = TONE_ICON[tone]
                const content = (
                  <>
                    <span className={styles.accent} data-tone={tone} aria-hidden />
                    <span className={styles.icon} data-tone={tone} aria-hidden><Icon size={13} /></span>
                    <span className={styles.text}>
                      <span className={styles.title}>
                        <span className={styles.srOnly}>{unread ? 'Unread. ' : ''}{TONE_WORD[tone]}: </span>
                        {r.title}
                      </span>
                      {r.body && <span className={styles.body}>{r.body}</span>}
                      <span className={styles.meta}>
                        <time dateTime={r.createdAt}>{fmtRelative(r.createdAt)}</time>
                        {r.href && <span aria-hidden>· Open</span>}
                      </span>
                    </span>
                  </>
                )
                return (
                  <li key={r.id} className={`${styles.item}${unread ? ` ${styles.unread}` : ''}`}>
                    {r.href ? (
                      <button type="button" className={styles.row} onClick={() => openRow(r)}>{content}</button>
                    ) : (
                      <div className={`${styles.row} ${styles.rowStatic}`}>{content}</div>
                    )}
                    {unread && (
                      <div className={styles.markRead}>
                        <Button size="xs" variant="quiet" onClick={() => void markRead(r.id)} aria-label={`Mark "${r.title}" as read`}>
                          Mark read
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          <div className={styles.footer}>
            <Button asChild size="xs" variant="link">
              <Link href="/inbox" onClick={() => close(false)}>View all in inbox</Link>
            </Button>
            <Button size="xs" variant="quiet" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw size={12} aria-hidden /> {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </div>,
        document.body,
      )}
    </span>
  )
}
