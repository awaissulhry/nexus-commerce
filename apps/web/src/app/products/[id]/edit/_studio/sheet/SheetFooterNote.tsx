'use client'

/**
 * The sheet footer's ONE note slot — offline · refusal · saved layout · keyboard hint — rendered identically on
 * every scope.
 *
 * Lifted verbatim from `master/MasterSheet.tsx` on 2026-09-04 (Owner: "no inconsistencies or any
 * differences in the UI at all"). The channel scopes had no note slot: no offline notice, no
 * refusal note with its "show affected rows", no keyboard hint, no help button. Measured — master's
 * footer read "21 rows · Enter to edit · …" and the channels' read "21 rows".
 *
 * §6.5 — occupants by priority. The refusal outranks the hint because a blocked write is the only
 * thing here an operator must act on; the hint is what they can already do. Height never changes
 * (DS.2 measured STRIP_GREW 0 for all kinds), so the strip does not move under an edit.
 */
import { useEffect, useState } from 'react'
import { useStudioDiscovery } from '../contracts'

import { GridSheetNote, SHEET_SHORTCUT_HINT } from '@/design-system/grid'
import { Button } from '@/design-system/primitives'

import { readRetired, retiresOnSave, shortcutHintState, writeRetired, type HintRetirement } from './shortcutHint'

/**
 * The hint's three-state rule (not yet read · retired · asked), one implementation. Retires itself
 * on the operator's first save; the `?` button re-asks. Lives in `shortcutHint.ts`, tested.
 */
export function useSheetShortcutHint(lastSavedAt: string | null | undefined) {
  const [retired, setRetired] = useState<HintRetirement>(null)
  const [asked, setAsked] = useState<boolean | null>(null)
  useEffect(() => setRetired(readRetired()), [])
  useEffect(() => {
    if (retiresOnSave(lastSavedAt) && retired === false) {
      setRetired(true)
      writeRetired()
    }
  }, [lastSavedAt, retired])
  const state = shortcutHintState(retired, asked)
  return { ...state, ask: (show: boolean) => setAsked(show) }
}

export interface SheetFooterNoteProps {
  offline: boolean
  refused: number
  showRefusedOnly: boolean
  onToggleRefused: () => void
  lastSavedAt: string | null | undefined
  layoutRecovery?: { retry: () => Promise<unknown> } | null
}

function SavedLayoutNote({ retry }: { retry: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const reload = async () => {
    setBusy(true)
    try { await retry() } catch { /* The layout loader retains the error until a retry succeeds. */ }
    finally { setBusy(false) }
  }
  return (
    <span className="nds-grid-sheet-noteslot">
      <GridSheetNote kind="provenance" title="Your saved column order and visibility settings could not be loaded. Retry to restore them.">
        Saved column layout unavailable
      </GridSheetNote>
      <Button inline variant="link" disabled={busy} onClick={() => void reload()}>{busy ? 'Retrying…' : 'Retry layout'}</Button>
    </span>
  )
}

export function SheetFooterNote({ offline, refused, showRefusedOnly, onToggleRefused, lastSavedAt, layoutRecovery }: SheetFooterNoteProps) {
  const hint = useSheetShortcutHint(lastSavedAt)
  const discovery = useStudioDiscovery()
  if (offline) {
    return (
      <GridSheetNote kind="offline" title="A write did not reach the server. The sheet is re-reading the row to find out whether it saved; nothing you have typed is lost.">
        Connection lost — reconnecting…
      </GridSheetNote>
    )
  }
  if (refused > 0) {
    /* `onShow` is REAL on both scopes: it narrows the sheet to the rows a write was refused on. A
       handler that did nothing would compile and would be the hover-only bug wearing a button. */
    return (
      <GridSheetNote kind="refusal" count={refused} noun="cell" lead={showRefusedOnly ? 'showing only the affected rows' : undefined} onShow={onToggleRefused} />
    )
  }
  if (discovery?.note) return <span className="nds-grid-sheet-noteslot">
    <GridSheetNote kind="provenance" title={discovery.note}>{discovery.note}</GridSheetNote>
    {discovery.failed && discovery.retry && <Button inline variant="link" disabled={discovery.retrying} onClick={() => void discovery.retry?.()}>
      {discovery.retrying ? 'Retrying…' : 'Retry channel availability'}
    </Button>}
  </span>
  if (layoutRecovery) return <SavedLayoutNote retry={layoutRecovery.retry} />
  return (
    <span className="nds-grid-sheet-noteslot">
      {hint.showHint && <GridSheetNote kind="hint">{SHEET_SHORTCUT_HINT}</GridSheetNote>}
      {hint.showHelp && (
        /* 18px square, which no Button size offers. `size` and the class are COUPLED — grid.css
           matches `.nds-btn.xs.nds-grid-sheet-help` to outweigh `.nds-btn.xs`; changing `size`
           silently drops the geometry. */
        <Button
          variant="quiet"
          size="xs"
          className="nds-grid-sheet-help"
          onClick={() => hint.ask(!hint.showHint)}
          aria-expanded={hint.showHint}
          aria-label={hint.showHint ? 'Hide the keyboard shortcuts' : 'Show the keyboard shortcuts'}
          title={hint.showHint ? 'Hide the keyboard shortcuts' : 'Keyboard shortcuts'}
        >
          ?
        </Button>
      )}
    </span>
  )
}
