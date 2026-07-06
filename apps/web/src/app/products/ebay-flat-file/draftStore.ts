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
    const dirty = allRows.filter((r) => (r._dirty || r._isNew) && !r._readonly && hasUserContent(r))
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
