/**
 * Cell editor OPTION A (Owner, 2026-09-26) — what the one value editor shows beside a cell's value: an AI draft waiting
 * for it, its earlier values, and the row it follows. ONE module for both scopes, so master and channel cannot describe
 * the same cell two ways. Pure, and tested in `cellEditorContext.vitest.test.ts`; the adapters supply the verbs.
 */
import type { CellEditorContext, CellHistoryEntry } from '@/design-system/grid'

import type { AiDraft } from '../ai/types'
import { fieldHistorySelection } from '../drawer/fieldHistorySelection'
import { previousWasRecorded, type DrawerScope, type FieldHistoryEntry } from '../drawer/types'
import { fetchFieldHistory } from '../drawer/useFieldHistory'

/**
 * A value the one-line editor can show and put back: text, a number or a yes/no. A list, a record or a measure is not a
 * value this editor writes — its own editor or the drawer handles it — so it is never offered here.
 */
export function editorText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return null
}

const SHORT_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })

/**
 * Earlier values, newest first: each recorded change's PREVIOUS value, once each, never the value the cell holds now.
 * A change whose previous value was not recorded is skipped rather than shown as empty (hub ruling #14 — "empty" and "not
 * recorded" are different facts).
 */
export function historyEntriesOf(entries: readonly FieldHistoryEntry[], current: unknown, max = 8): CellHistoryEntry[] {
  const now = editorText(current)
  const seen = new Set<string>(now === null ? [] : [now])
  const out: CellHistoryEntry[] = []
  for (const entry of [...entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    if (!previousWasRecorded(entry)) continue
    const value = editorText(entry.previous)
    if (value === null || seen.has(value)) continue
    seen.add(value)
    const at = Date.parse(entry.at)
    out.push({ value, when: Number.isFinite(at) ? SHORT_DATE.format(at) : '', who: entry.by })
    if (out.length >= max) break
  }
  return out
}

/** A stored product id (`cmokmy24v004bpm0pnretnc03`) — never words an operator should read. */
const LOOKS_LIKE_ID = /^c[a-z0-9]{20,}$/i

/**
 * The row this cell follows, when it shows another row's value (🔗). `inheritedFrom` is an ID on the wire (measured
 * 2026-09-26: "Follows cmokmy24v…" on screen), so the caller names it (`nameOf` → a SKU). It can be the row's OWN id —
 * a content cell falls back to the shared record — so the caller returns null for that, and an id that cannot be named
 * reads "the parent", never as the id itself.
 */
export function inheritedContextOf(
  cell: { inherited?: boolean; inheritedFrom?: string | null; value?: unknown } | null | undefined,
  nameOf: (from: string) => string | null | undefined = () => null,
): CellEditorContext['inherited'] {
  if (!cell?.inherited) return null
  // Following an EMPTY parent is common (84 of 336 cells measured on master·IT, 2026-09-26) and worth saying.
  const value = cell.value == null ? '' : editorText(cell.value)
  if (value === null) return null
  // The wire also sends `<id>:<column>` (attribute-resolver) — the row is the part before the colon.
  const raw = cell.inheritedFrom?.trim().split(':')[0]
  const named = raw ? nameOf(raw) ?? (LOOKS_LIKE_ID.test(raw) ? null : raw) : null
  return { from: named || 'the parent', value }
}

/**
 * A PENDING AI draft for this cell, with the review's own verbs. A stale, failed or non-text draft stays in the review
 * (it cannot be used from one line), so the icon only appears for a draft the operator can take as it is.
 */
export function aiDraftContextOf(
  draft: Pick<AiDraft, 'id' | 'status' | 'draftValue' | 'stale'> | null | undefined,
  verbs: { approve: (ids: string[]) => Promise<unknown>; reject: (ids: string[]) => Promise<unknown>; onApplied?: () => void },
): CellEditorContext['aiDraft'] {
  if (!draft || draft.status !== 'pending' || draft.stale) return null
  const value = editorText(draft.draftValue)
  if (value === null) return null
  return {
    value,
    accept: async () => { const result = await verbs.approve([draft.id]); verbs.onApplied?.(); return result },
    reject: () => verbs.reject([draft.id]),
  }
}

/**
 * The history icon's loader for one cell: the SAME request the record drawer's history pane makes
 * (`fieldHistorySelection` → `fetchFieldHistory`), read only when the operator opens the list.
 */
export function historyLoaderFor(
  row: { id: string; values: Record<string, { writeField?: string | null; value?: unknown } | undefined> },
  columnKey: string,
  scope: DrawerScope,
  fetch: typeof fetchFieldHistory = fetchFieldHistory,
): () => Promise<CellHistoryEntry[]> {
  return async () => {
    const cell = row.values[columnKey]
    const selection = fieldHistorySelection(columnKey, cell?.writeField, scope)
    if (!selection.fieldKey) return []
    const page = await fetch({ productId: row.id, fieldKey: selection.fieldKey, scope: selection.scope, rowId: row.id })
    return historyEntriesOf(page.entries, cell?.value)
  }
}
