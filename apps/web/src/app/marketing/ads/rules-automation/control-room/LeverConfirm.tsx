'use client'

/**
 * R16 — the up-confirmation of an engine switch, shown in the lever drawer's own overlay (the design system's Drawer
 * `overlay`: a Modal would open BEHIND a drawer). While it is up it owns the keyboard: focus moves to its Cancel, and
 * Escape closes the confirmation, never the drawer behind it.
 */
import { useEffect, useRef } from 'react'
import { ActionConfirm, Card } from '@/design-system/components'
import type { ActionImpact } from '@/design-system/grid/actions/registry'

export function LeverConfirm({ impact, onCancel, onConfirm }: { impact: ActionImpact; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const t = window.setTimeout(() => ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus(), 0)
    // Capture phase: before the Drawer's own Escape (which closes the drawer) gets a turn.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
    document.addEventListener('keydown', onKey, true)
    return () => { window.clearTimeout(t); document.removeEventListener('keydown', onKey, true) }
  }, [onCancel])
  return (
    <div ref={ref}>
      <Card padded elevated>
        <ActionConfirm mode="inline" impact={impact} onCancel={onCancel} onConfirm={onConfirm} />
      </Card>
    </div>
  )
}
