/**
 * FFP.1 — eBay flat-file unsaved-edit draft layer (Amazon parity).
 *
 * Dirty/new rows autosave to localStorage per (marketplace, familyId) so a
 * reload / tab close / market switch never loses an unsaved edit. On load the
 * draft is merged OVER the server rows: the draft wins for everything the
 * operator can type, while system fields (item ids, listing status, sync
 * state, grouping) always come from the server row.
 */

import type { BaseRow } from '@/components/flat-file/FlatFileGrid.types'

const DRAFT_VERSION = 1
const MAX_DRAFT_ROWS = 500 // safety valve — a draft this large means something is wrong

export interface DraftEntry {
  v: number
  savedAt: number
  rows: BaseRow[]
}

export function draftKey(marketplace: string, familyId?: string | null): string {
  return `ff-ebay-draft-${marketplace}${familyId ? `-family-${familyId}` : ''}`
}

/** Keys that must always come from the SERVER row when merging a draft over it. */
const SYSTEM_KEYS = [
  'ebay_item_id', 'listing_status', 'sync_status', 'last_pushed_at',
  'platformProductId', '_productId', '_isParent', '_shared', '_readonly',
  ...['it', 'de', 'fr', 'es', 'uk'].flatMap((p) => [
    `${p}_item_id`, `${p}_status`, `${p}_listing_id`,
  ]),
]

export function readDraft(key: string): DraftEntry | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DraftEntry
    if (parsed?.v !== DRAFT_VERSION || !Array.isArray(parsed.rows)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * A row carries user content when any non-internal field is non-empty.
 * Blank grid padding rows are born `_isNew + _dirty` (makeBlankRow) — without
 * this check every empty pad row would be persisted and re-appended on each
 * restore.
 */
export function hasUserContent(row: BaseRow): boolean {
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('_')) continue
    if (v == null || v === false) continue
    if (typeof v === 'string') { if (v.trim() !== '') return true; continue }
    return true
  }
  return false
}

/** Persist the dirty/new subset; an empty subset clears the draft. */
export function writeDraft(key: string, allRows: BaseRow[]): void {
  try {
    // Shared membership rows carry _readonly (system flag) but ARE legitimately
    // edited via import (Lane-B fields persist to their membership). Excluding
    // them here silently vaporized those edits on any reload before a save —
    // part of the "reverts to the previous version" incident (2026-07-17).
    const dirty = allRows.filter((r) =>
      (r._dirty || r._isNew) &&
      !((r as { _readonly?: boolean; _shared?: boolean })._readonly && !(r as { _shared?: boolean })._shared) &&
      hasUserContent(r))
    if (dirty.length === 0) {
      localStorage.removeItem(key)
      return
    }
    const entry: DraftEntry = {
      v: DRAFT_VERSION,
      savedAt: Date.now(),
      rows: dirty.slice(0, MAX_DRAFT_ROWS),
    }
    localStorage.setItem(key, JSON.stringify(entry))
  } catch {
    // localStorage full/blocked — drafts are best-effort, never break editing
  }
}

export function clearDraft(key: string): void {
  try { localStorage.removeItem(key) } catch {}
}

/**
 * Purge specific rows from the draft (by SKU or _rowId). Deleting a row MUST
 * also delete its draft twin — otherwise the draft re-appends it on every
 * reload and the row "comes back again and again" (GALE delete incident,
 * 2026-07-17). An emptied draft is removed entirely.
 */
export function removeRowsFromDraft(
  key: string,
  match: { skus?: Iterable<string>; rowIds?: Iterable<string> },
): number {
  try {
    const draft = readDraft(key)
    if (!draft) return 0
    const skus = new Set([...(match.skus ?? [])].map((s) => s.trim()).filter(Boolean))
    const rowIds = new Set(match.rowIds ?? [])
    const kept = draft.rows.filter((r) => {
      const sku = String(r.sku ?? '').trim()
      if (sku && skus.has(sku)) return false
      if (rowIds.has(r._rowId)) return false
      return true
    })
    const removed = draft.rows.length - kept.length
    if (removed === 0) return 0
    if (kept.length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify({ ...draft, rows: kept }))
    return removed
  } catch {
    return 0
  }
}

/**
 * Merge draft rows over server rows.
 * - Match by SKU (trimmed, non-empty) first, then by _rowId (blank new rows).
 * - Matched: draft values win, EXCEPT SYSTEM_KEYS which are copied from the
 *   server row; identity (_rowId) stays the server row's so grid prefs
 *   (order, selection) keep working. Row is re-marked _dirty.
 * - Unmatched draft rows (new, never persisted) are appended as-is.
 */
export function mergeDraftRows(
  serverRows: BaseRow[],
  draftRows: BaseRow[],
): { rows: BaseRow[]; restored: number } {
  if (!draftRows.length) return { rows: serverRows, restored: 0 }

  const bySku = new Map<string, number>()
  const byRowId = new Map<string, number>()
  serverRows.forEach((r, i) => {
    const sku = String(r.sku ?? '').trim()
    if (sku && !bySku.has(sku)) bySku.set(sku, i)
    byRowId.set(r._rowId, i)
  })

  const out = [...serverRows]
  const appended: BaseRow[] = []
  let restored = 0

  for (const draft of draftRows) {
    const sku = String(draft.sku ?? '').trim()
    let idx = sku ? bySku.get(sku) : undefined
    if (idx == null) idx = byRowId.get(draft._rowId)
    if (idx == null) {
      appended.push({ ...draft, _dirty: true })
      restored++
      continue
    }
    const server = out[idx]
    const merged: BaseRow = { ...server, ...draft }
    for (const k of SYSTEM_KEYS) {
      if (k in server) merged[k] = server[k]
      else delete merged[k]
    }
    merged._rowId = server._rowId
    merged._dirty = true
    out[idx] = merged
    restored++
  }

  return { rows: [...out, ...appended], restored }
}
