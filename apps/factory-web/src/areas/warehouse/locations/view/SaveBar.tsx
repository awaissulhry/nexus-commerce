'use client'

import { useEffect, useRef } from 'react'
import { saveKeyAction } from '@nexus/ui/patterns'
import { Button, Kbd, Spinner } from '@nexus/ui/primitives'

/**
 * The DS EditModeBar in this page's words (its own words are English only: a missing DS part, named in the step's
 * notes): "1 unsaved change · Discard · Save (⌘S)". ⌘S / Ctrl+S saves unless held or busy; leaving the page with
 * changes asks first.
 */
export function SaveBar({ text, discard, save, held, busy, onDiscard, onSave, label }: { text: string; discard: string; save: string; held: string | null; busy: boolean; onDiscard: () => void; onSave: () => void; label: string }) {
  const latest = useRef({ onSave, held, busy })
  latest.current = { onSave, held, busy }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = saveKeyAction(event, { held: !!latest.current.held, busy: latest.current.busy })
      if (action === 'ignore') return
      event.preventDefault()
      if (action === 'save') latest.current.onSave()
    }
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', onLeave)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onLeave)
    }
  }, [])
  return (
    <div className="fw-lc-savebar" role="region" aria-label={label}>
      <span className="fw-lc-savebar-text">{text}</span>
      <span className="fw-st-actions">
        <Button size="sm" onClick={onDiscard} disabled={busy}>
          {discard}
        </Button>
        <Button size="sm" variant="primary" onClick={onSave} heldReason={held} aria-keyshortcuts="Meta+S Control+S">
          {busy ? <Spinner size={13} /> : null} {save} <Kbd>⌘S</Kbd>
        </Button>
      </span>
    </div>
  )
}
