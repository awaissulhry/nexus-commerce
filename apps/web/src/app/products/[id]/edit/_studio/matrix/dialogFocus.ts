/**
 * The Matrix dialogs' opening focus (Matrix polish, Owner 2026-10-08: "a dialog opens on its first field, or its title
 * when it has none — never a ring on ✕ at open").
 *
 * The DS Modal focuses the `[data-autofocus]` field, else its first control — the ✕ in its header. A pop-up that names
 * no field to open on (a phone, where the keyboard would cover it; a list with nothing to tick) would open on the ✕. This
 * moves that focus to the dialog box itself: it is not a control, so it draws no ring (`dialogs.box`), a reader still
 * announces the dialog by its title, and Tab goes on to the first control. Runs after the Modal's own focus (a parent's
 * effect follows its child's), and only when the ✕ holds the focus — a field the dialog focused keeps it.
 */
import { useEffect } from 'react'

export function useFocusOffClose(open = true): void {
  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const active = document.activeElement
    if (active instanceof HTMLElement && active.matches('.nds-modal-x')) active.closest<HTMLElement>('[role="dialog"]')?.focus()
  }, [open])
}
