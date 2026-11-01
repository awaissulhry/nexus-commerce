'use client'

import { EditModeBar } from '../../../../lib/i18n/ds-parts'

/**
 * The record's explicit save = the DS EditModeBar (B-W2b-18; composed here while its words were English only): "1 unsaved
 * change · Save with ⌘S · Discard · Save". ⌘S / Ctrl+S saves unless held or busy; leaving the page with changes asks first.
 */
export function SaveBar({ count, save, held, busy, onDiscard, onSave }: { count: number; save: string; held: string | null; busy: boolean; onDiscard: () => void; onSave: () => void }) {
  return <EditModeBar count={count} onDiscard={onDiscard} onApply={onSave} applyLabel={save} busy={busy} applyHeldReason={held} saveShortcut />
}
