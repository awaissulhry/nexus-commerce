'use client'

/**
 * PES.8 — everything the sheet needs from this lane, in one hook.
 *
 * Two consumers, one call: PES.2's `buildMasterColumns({ draftFor })` renders the proposal in the
 * cell, and PES.1's View bar gets an `✦ AI drafts` chip. Both are derived from the same fetch, so a
 * lane wiring this in takes one line and gets a consistent count and overlay rather than two reads
 * that can disagree.
 *
 * 🔴 `draftFor` is REF-READING and its identity never changes.
 *
 * PES.2's contract asks for this explicitly and the reason is load-bearing: AG re-runs its entire
 * column model whenever `columnDefs` gets a new identity, so a `draftFor` that changed when drafts
 * arrived would rebuild a hundred column definitions on every fetch — the same inline-options trap
 * the grid's memoisation guard exists for (reference_ag_react_inline_options_rerun_column_model).
 * The drafts live in a ref; the function reading it is created once.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'

import { useRegisterViewChip, type ViewChip, type ViewChipCells } from '../contracts'

import { cellIndexKey, indexDrafts, toSheetDraft, type SheetAiDraft } from './drafts'
import { useAiDrafts, type UseAiDraftsInput, type UseAiDraftsValue } from './useAiDrafts'
import type { AiDraft } from './types'

export interface AiDraftLayer {
  /** Pass straight to `buildMasterColumns({ draftFor })`. Stable identity, reads a ref. */
  draftFor: (rowId: string, colId: string) => SheetAiDraft | null
  /** The full lane state, for the review surface. */
  drafts: UseAiDraftsValue
}

export function useAiDraftLayer(input: UseAiDraftsInput): AiDraftLayer {
  const drafts = useAiDrafts(input)

  // The ref the stable `draftFor` reads. Updated on every load; never a dependency of anything.
  const indexRef = useRef(new Map<string, AiDraft>())
  useEffect(() => {
    indexRef.current = indexDrafts(drafts.drafts)
  }, [drafts.drafts])

  const draftFor = useCallback((rowId: string, colId: string): SheetAiDraft | null => {
    const hit = indexRef.current.get(cellIndexKey(rowId, colId))
    return hit ? toSheetDraft(hit) : null
  }, [])

  /**
   * The chip's cells: which (row, column) pairs it counts, so selecting it filters the sheet to
   * exactly the drafted cells rather than to a rectangle around them.
   */
  const cells: ViewChipCells = useMemo(() => {
    const byRow: Record<string, string[]> = {}
    for (const d of drafts.drafts) {
      if (d.status !== 'pending') continue
      const cols = byRow[d.productId] ?? []
      if (!cols.includes(d.columnKey)) cols.push(d.columnKey)
      byRow[d.productId] = cols
    }
    return { byRow }
  }, [drafts.drafts])

  const chip: ViewChip = useMemo(() => {
    // 🔴 `null` is NOT zero, and this is the case that makes the distinction matter: while the
    // fetch is in flight, or when it FAILED, we have not counted. Reporting 0 there would tell the
    // operator "we checked, there are no drafts" on the strength of not having checked — and the
    // chip would then hide itself at that fake zero, so drafts waiting for review would be
    // invisible with nothing on screen admitting it.
    const counted = !drafts.loading && drafts.error === null
    const pending = drafts.drafts.filter((d) => d.status === 'pending').length
    return {
      id: 'ai-drafts',
      label: 'AI drafts',
      tone: 'info',
      count: counted ? pending : null,
      note: drafts.error
        ? `Could not read AI drafts: ${drafts.error}`
        : drafts.loading
          ? 'Counting AI drafts…'
          : 'Cells an AI has proposed a value for. Nothing applies until you approve it.',
      cells: counted ? cells : { byRow: {} },
    }
  }, [drafts.loading, drafts.error, drafts.drafts, cells])

  useRegisterViewChip('ai-drafts', chip)

  return { draftFor, drafts }
}
