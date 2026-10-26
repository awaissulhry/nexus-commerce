'use client'

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Kbd } from '@/design-system/primitives'
import { isMacPlatform, saveKeyAction, saveShortcutWords, warnBeforeLeaving } from './editModeBarKeys'

export interface EditModeBarProps {
  /** custom message; defaults to "N unsaved change(s)" from `count` */
  message?: ReactNode
  count?: number
  onDiscard?: () => void
  onApply?: () => void
  applyLabel?: ReactNode
  busy?: boolean
  /** Hold Apply alone (a check still running, a problem to fix first); Discard stays available. */
  applyDisabled?: boolean
  /**
   * HELD Apply: why it cannot run now ("Fix 1 problem in the message first"). Use this, not `applyDisabled`, for new
   * editors: the button keeps its focus and says why on hover, focus and to a screen reader (Button `heldReason`).
   */
  applyHeldReason?: string | null
  /**
   * ⌘S / Ctrl+S runs Apply (Reviews parts, 2026-10-26) — not while it is held or busy, when the key does nothing — and
   * the bar says so ("Save with ⌘S"). While `count` > 0, leaving the page asks first (`beforeunload`).
   */
  saveShortcut?: boolean
}

const noSubscribe = () => () => {}
const onMac = () => isMacPlatform(navigator.platform || navigator.userAgent)
const macOnServer = () => true

/** Sticky discard/apply bar for unsaved edits (H10 `.h10-am-editbar`). */
export function EditModeBar({ message, count, onDiscard, onApply, applyLabel = 'Apply changes', busy, applyDisabled, applyHeldReason, saveShortcut }: EditModeBarProps) {
  const mac = useSyncExternalStore(noSubscribe, onMac, macOnServer)
  const held = !!applyHeldReason || !!applyDisabled
  const latest = useRef({ onApply, held, busy: !!busy })
  useEffect(() => { latest.current = { onApply, held, busy: !!busy } })

  useEffect(() => {
    if (!saveShortcut) return
    const onKey = (event: KeyboardEvent) => {
      const { onApply: apply, held: isHeld, busy: isBusy } = latest.current
      if (!apply) return
      const action = saveKeyAction(event, { held: isHeld, busy: isBusy })
      if (action === 'ignore') return
      // Held or busy: the browser's "Save page" stays away too; the Apply button says why.
      event.preventDefault()
      if (action === 'save') apply()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [saveShortcut])

  const warn = !!saveShortcut && warnBeforeLeaving(count)
  useEffect(() => {
    if (!warn) return
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [warn])

  const label =
    message ??
    (count != null ? (
      <>
        <b>{count}</b> unsaved {count === 1 ? 'change' : 'changes'}
      </>
    ) : (
      'Unsaved changes'
    ))
  return (
    <div className="nds-actionbar" role="region" aria-label="Edit mode">
      <span className="lbl">
        {label}
        {saveShortcut && onApply && (
          <span className="nds-actionbar-key"> · Save with <Kbd>{saveShortcutWords(mac)}</Kbd></span>
        )}
      </span>
      <span className="grow" />
      <span className="acts">
        {onDiscard && (
          <Button onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
        )}
        {onApply && (
          <Button
            variant="primary"
            onClick={onApply}
            heldReason={applyHeldReason}
            disabled={applyHeldReason ? undefined : busy || applyDisabled}
            aria-keyshortcuts={saveShortcut ? (mac ? 'Meta+S' : 'Control+S') : undefined}
          >
            {applyLabel}
          </Button>
        )}
      </span>
    </div>
  )
}
