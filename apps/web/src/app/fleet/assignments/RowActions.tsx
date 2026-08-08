'use client'

/**
 * NAF.SB.AS-S1R / S1.d — what you can do to one row, without opening it.
 *
 * THREE RULES THIS FILE EXISTS TO KEEP.
 *
 * 1. **The menu is always visible, never hover-only.** Carbon's data-table
 *    guidance and WCAG's content-on-hover-or-focus both land in the same place:
 *    an action that appears on hover is invisible to keyboard and touch users,
 *    which is an accessibility failure rather than a space saver. The trigger
 *    is a real focusable button on every row.
 *
 * 2. **There is no Start here, and that is deliberate.** Start is the only
 *    irreversible, money-spending action on this page, and it belongs where its
 *    pre-flight is — the detail page, which says what the run will read and
 *    what it will cost before you press anything. AS.6 refused a bulk Start for
 *    the same reason: making spending easy on a fleet the operator switched off
 *    is the one thing this page must not do.
 *
 * 3. **An item that the API would refuse is shown disabled, with the API's own
 *    sentence as its tooltip** — never hidden, and never offered and then
 *    rejected. `deleteAssignment` refuses a row that has run; `cancel` refuses
 *    the same. A menu whose items silently come and go teaches nothing about
 *    why.
 *
 * THE TRAP THIS FILE IS SHAPED AROUND. A popup rendered inside a grid cell is
 * clipped twice over: `.h10-ds-gridcard` is `overflow: hidden`, and a sticky
 * cell opens its own stacking context that no `z-index` escapes. So the menu
 * portals to `document.body` and positions itself from the trigger's rect —
 * the proven pattern in `dayparting/ScheduleRowActions.tsx`. The actions column
 * is deliberately NOT sticky, for the same reason.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { MoreHorizontal } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { AssignmentRow } from './AssignmentsClient'

interface Item {
  key: string
  label: string
  tip: string
  danger?: boolean
  disabled?: boolean
  run?: () => void | Promise<void>
}

export function RowActions({
  a,
  onDone,
  onError,
}: {
  a: AssignmentRow
  onDone: () => void
  onError: (message: string) => void
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)

  const call = useCallback(
    async (path: string, method: 'POST' | 'DELETE') => {
      setBusy(true)
      try {
        const res = await fetch(`${getBackendUrl()}/api/agent/fleet/assignments/${a.id}${path}`, {
          method,
          credentials: 'include',
        })
        if (!res.ok) {
          // The API writes operator-facing refusals; show its words, not ours.
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          onError(body?.error ?? `That did not work (${res.status}).`)
          return
        }
        onDone()
      } catch (e) {
        onError(String(e))
      } finally {
        setBusy(false)
        setOpen(false)
        setConfirming(false)
      }
    },
    [a.id, onDone, onError],
  )

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (btn.current?.contains(e.target as Node)) return
      if ((e.target as HTMLElement)?.closest?.('.as-menu')) return
      setOpen(false)
      setConfirming(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setConfirming(false)
        btn.current?.focus()
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const toggle = () => {
    if (open) {
      setOpen(false)
      setConfirming(false)
      return
    }
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    const H = 190
    const W = 216
    // Open rightward from the trigger and clamp to the viewport; flip above
    // when there is no room below, because clamping would drop the menu on top
    // of its own button.
    const left = Math.min(Math.max(8, r.left - W + r.width), window.innerWidth - W - 8)
    const below = window.innerHeight - r.bottom
    const top = below < H ? Math.max(8, r.top - H) : r.bottom + 4
    setPos({ top, left })
    setOpen(true)
  }

  const everRan = a.runCount > 0
  const isOpenState = a.state !== 'closed' && a.state !== 'cancelled'
  const running = a.state === 'running'

  const items: Item[] = [
    {
      key: 'open',
      label: 'Open',
      tip: 'Everything about this job: every attempt, what it read, what it found, and what it cost.',
      run: () => router.push(`/fleet/assignments/${a.id}`),
    },
  ]

  if (isOpenState) {
    items.push({
      key: 'close',
      label: 'Close',
      tip: running
        ? 'A run is open right now. Wait for it to come back — closing it would not stop it.'
        : 'Done with it. Its runs and findings are kept, and Reopen puts it back.',
      disabled: running,
      run: () => call('/close', 'POST'),
    })
    if (!everRan) {
      items.push({
        key: 'cancel',
        label: 'Cancel',
        tip: 'You called it off before it ran. Kept apart from Closed on purpose, and reversible.',
        run: () => call('/cancel', 'POST'),
      })
    }
  } else {
    items.push({
      key: 'reopen',
      label: 'Reopen',
      tip: 'Put it back among the open assignments, exactly as it was.',
      run: () => call('/reopen', 'POST'),
    })
  }

  items.push({
    key: 'delete',
    label: 'Delete…',
    danger: true,
    disabled: everRan,
    tip: everRan
      ? 'This has already run. Close it instead — its runs are part of the record.'
      : 'Removes the row. Nothing has run, so there is nothing to lose but the row itself.',
    run: () => setConfirming(true),
  })

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="as-kebab"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${a.title}`}
        title="What you can do with this one"
        onClick={toggle}
        disabled={busy}
      >
        <MoreHorizontal size={15} />
      </button>
      {open && pos && typeof document !== 'undefined'
        ? createPortal(
            <div className="as-menu" role="menu" style={{ top: pos.top, left: pos.left }}>
              {confirming ? (
                <div className="as-menu-confirm">
                  <strong>Delete this assignment?</strong>
                  <span>{a.title}</span>
                  <span className="acts">
                    <button className="acr-btn" onClick={() => setConfirming(false)} disabled={busy}>
                      Keep it
                    </button>
                    <button
                      className="acr-btn stop"
                      onClick={() => call('', 'DELETE')}
                      disabled={busy}
                    >
                      {busy ? 'Deleting…' : 'Delete'}
                    </button>
                  </span>
                </div>
              ) : (
                items.map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    role="menuitem"
                    className={`as-menu-item${it.danger ? ' danger' : ''}`}
                    title={it.tip}
                    disabled={it.disabled || busy}
                    onClick={() => it.run?.()}
                  >
                    {it.label}
                  </button>
                ))
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
