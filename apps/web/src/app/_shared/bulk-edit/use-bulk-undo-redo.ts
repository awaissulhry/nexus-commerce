'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HistoryEntry } from './types'

/**
 * W1.4 — undo / redo stack extracted from BulkOperationsClient.tsx
 * (which crossed 4,000 LOC at audit time).
 *
 * The hook owns the *bookkeeping*: a capped history array, an active
 * cursor, a re-entry suppression flag, and the Cmd/Ctrl+Z global
 * shortcut. It does NOT know what an undo "means" for the underlying
 * grid state — that lives behind the `applyEntry` callback, which is
 * fed both the entry to replay and the direction (undo / redo).
 *
 * Behaviour preserved verbatim from the inline version:
 *   - Capped at 50 entries (HISTORY_LIMIT). Older entries fall off
 *     the front when the cap is exceeded.
 *   - Pushing while the cursor is mid-stack truncates forward
 *     history (standard Excel/Sheets feel).
 *   - Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z = redo. Native input undo
 *     is preserved when an input/textarea/contenteditable owns focus.
 *   - `isUndoingRef` flag exposed so the caller can suppress
 *     re-recording while a replay is in flight.
 */

const HISTORY_LIMIT = 50

export interface UseBulkUndoRedoOptions {
  /**
   * Replay one history entry against the caller-owned grid state. The
   * hook calls this with `isUndoingRef.current` already true so any
   * change-tracking writes the caller does inside this callback are
   * filtered out (the caller checks `isUndoingRef.current` before
   * pushing to history — same pattern as the original inline code).
   */
  applyEntry: (entry: HistoryEntry, direction: 'undo' | 'redo') => void
}

export interface UseBulkUndoRedoResult {
  history: HistoryEntry[]
  historyIndex: number
  /** Append a new entry. Truncates forward history when the cursor
   *  isn't at the tip — matches Excel / Google Sheets semantics. */
  pushEntry: (entry: HistoryEntry) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  /** Reset the stack. Used after a successful save — committed
   *  changes shouldn't be undoable via the local history. */
  clearHistory: () => void
  /** Mutable ref the caller reads inside its change-tracking pipeline
   *  to suppress re-recording while a replay is in flight. */
  isUndoingRef: React.MutableRefObject<boolean>
}

export function useBulkUndoRedo(
  opts: UseBulkUndoRedoOptions,
): UseBulkUndoRedoResult {
  const { applyEntry } = opts

  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const isUndoingRef = useRef(false)
  const historyIndexRef = useRef(historyIndex)

  // Mirror cursor into a ref so push/undo/redo callbacks read the
  // latest value without depending on `historyIndex` state directly.
  // Identical to the inline pattern in BulkOperationsClient pre-W1.4.
  useEffect(() => {
    historyIndexRef.current = historyIndex
  }, [historyIndex])

  const pushEntry = useCallback((entry: HistoryEntry) => {
    setHistory((prev) => {
      const next = prev.slice(0, historyIndexRef.current + 1)
      next.push(entry)
      const trimmed =
        next.length > HISTORY_LIMIT
          ? next.slice(next.length - HISTORY_LIMIT)
          : next
      historyIndexRef.current = trimmed.length - 1
      setHistoryIndex(trimmed.length - 1)
      return trimmed
    })
  }, [])

  const undo = useCallback(() => {
    const idx = historyIndexRef.current
    if (idx < 0) return
    isUndoingRef.current = true
    try {
      applyEntry(history[idx], 'undo')
    } finally {
      isUndoingRef.current = false
    }
    historyIndexRef.current = idx - 1
    setHistoryIndex(idx - 1)
  }, [history, applyEntry])

  const redo = useCallback(() => {
    const idx = historyIndexRef.current
    if (idx >= history.length - 1) return
    isUndoingRef.current = true
    try {
      applyEntry(history[idx + 1], 'redo')
    } finally {
      isUndoingRef.current = false
    }
    historyIndexRef.current = idx + 1
    setHistoryIndex(idx + 1)
  }, [history, applyEntry])

  // Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z global shortcuts. We intentionally
  // bail out when an input / textarea / contenteditable owns focus so
  // native field-level undo still works inside an open EditableCell.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() !== 'z') return
      const ae = document.activeElement as HTMLElement | null
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const clearHistory = useCallback(() => {
    setHistory([])
    setHistoryIndex(-1)
    historyIndexRef.current = -1
  }, [])

  return {
    history,
    historyIndex,
    pushEntry,
    undo,
    redo,
    canUndo: historyIndex >= 0,
    canRedo: historyIndex < history.length - 1,
    clearHistory,
    isUndoingRef,
  }
}
