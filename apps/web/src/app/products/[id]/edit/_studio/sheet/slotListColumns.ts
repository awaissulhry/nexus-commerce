/**
 * Step 4.3 #3 (A-52; R-55, R-56) — the studio's half of "bullets in one cell": where the one cell sits, what the sheet
 * shows by default, and how the one cell's edit becomes slot writes.
 *
 * The server serves a channel's bullets as ten SLOT columns (`bulletPoints_1…10`, write field `bulletPoints[i]`). They stay
 * exactly as they are — the write path, the per-slot caps, formulas, readiness, import and export all key off them. This
 * module inserts ONE client-only column before them (`slots:bulletPoints`, the media column's pattern), hides the ten by
 * default (R-56: still in Customise, still in every import/export), and turns an edit of the one cell into one slot write
 * per CHANGED position, sent through the same handler a typed slot takes.
 *
 * Bullets only (R-56 names Bullet 1–10): Amazon slots every list of ten or fewer, and a one-cell for each of those is
 * beyond the ruling.
 */
import { isSlotListKey, slotListChanges, slotListKey, type SlotGroup } from '@/design-system/grid/editors/slotList'

/** The lists that get one cell, with the words the cell uses. */
export const SLOT_LIST_FIELDS: Readonly<Record<string, { label: string; itemLabel: string }>> = {
  bulletPoints: { label: 'Bullet points', itemLabel: 'Bullet' },
}

export interface SlotColumnLike {
  key: string
  label: string
  group: string
  groupKey?: string
  locale?: string
  localizable?: boolean
  maxLength?: number | null
  storage?: string
  scope?: string
  width?: number
  slot?: { of: string; index: number; max: number; label: string }
  /** Set on the one-cell column only: the group it shows. */
  slotGroup?: SlotGroup
}

/** Every COMPLETE bullets slot group in the columns (one per language in the Languages view), positions in order. */
export function slotGroupsOf(columns: readonly SlotColumnLike[]): SlotGroup[] {
  const found = new Map<string, { of: string; locale: string | null; max: number; keys: Array<string | undefined>; caps: number[] }>()
  for (const c of columns) {
    if (!c.slot || !SLOT_LIST_FIELDS[c.slot.of]) continue
    const id = slotListKey(c.slot.of, c.locale)
    const g = found.get(id) ?? { of: c.slot.of, locale: c.locale ?? null, max: c.slot.max, keys: [], caps: [] }
    g.keys[c.slot.index - 1] = c.key
    if (typeof c.maxLength === 'number') g.caps.push(c.maxLength)
    found.set(id, g)
  }
  const groups: SlotGroup[] = []
  for (const g of found.values()) {
    const keys = Array.from({ length: g.max }, (_, i) => g.keys[i])
    /* A group with a missing position has no honest positional view — no one-cell for it. */
    if (keys.some((k) => !k)) continue
    groups.push({ of: g.of, max: g.max, keys: keys as string[], maxLength: g.caps.length ? Math.min(...g.caps) : null, ...(g.locale ? { locale: g.locale } : {}) })
  }
  return groups
}

/** The group a one-cell key shows — read off the one-cell column when it is in the list, else derived from the slots. */
export function slotGroupOfKey(colId: string | null | undefined, columns: readonly SlotColumnLike[]): SlotGroup | null {
  if (!isSlotListKey(colId)) return null
  const own = columns.find((c) => c.key === colId)?.slotGroup
  if (own) return own
  return slotGroupsOf(columns).find((g) => slotListKey(g.of, g.locale) === colId) ?? null
}

/** The one-cell key a slot column belongs to, if any (`bulletPoints_3` → `slots:bulletPoints`). */
export function slotListKeyOfSlot(slotKey: string, columns: readonly SlotColumnLike[]): string | null {
  const g = slotGroupsOf(columns).find((x) => x.keys.includes(slotKey))
  return g ? slotListKey(g.of, g.locale) : null
}

/**
 * Insert the one cell IMMEDIATELY before each group's first slot (same group, so the Customise dialog lists it beside
 * them). Idempotent; without a bullets slot group the columns come back unchanged. The ten are NOT removed — hiding them
 * is the view's decision (`defaultViewKeys`), never the column list's.
 */
export function withSlotListColumns<T extends SlotColumnLike>(columns: T[]): T[] {
  if (columns.some((c) => isSlotListKey(c.key))) return columns
  const groups = slotGroupsOf(columns)
  if (!groups.length) return columns
  const before = new Map(groups.map((g) => [g.keys[0], g]))
  const out: T[] = []
  for (const c of columns) {
    const g = before.get(c.key)
    if (g) out.push(oneCellColumn(g, c))
    out.push(c)
  }
  return out
}

function oneCellColumn<T extends SlotColumnLike>(group: SlotGroup, first: T): T {
  const words = SLOT_LIST_FIELDS[group.of]
  const key = slotListKey(group.of, group.locale)
  return {
    key,
    /* NEVER a write field: the adapter refuses an unknown field, and this column's edit leaves as slot writes. */
    writeField: '',
    label: words.label,
    /* The Languages view groups a field's languages under the field; the slots there are grouped per slot. */
    group: group.locale ? words.label : first.group,
    groupKey: group.locale ? `language:${slotListKey(group.of)}` : first.groupKey,
    kind: 'text',
    storage: first.storage,
    scope: first.scope,
    ...(first.localizable !== undefined ? { localizable: first.localizable } : {}),
    requiredBy: [],
    editable: true,
    formulaWritable: false,
    width: 240,
    defaultVisible: true,
    helpText: `All ${group.max} ${words.label.toLowerCase()} in one cell. ${words.itemLabel} 1–${group.max} are each also a column in Customise, and every import and export uses them.`,
    ...(group.locale ? { locale: group.locale } : {}),
    slotGroup: group,
  } as unknown as T
}

/** R-56 — the slot keys hidden by default: those of every group whose one cell is in the list. */
export function slotKeysHiddenByDefault(columns: readonly SlotColumnLike[]): string[] {
  return columns.filter((c) => isSlotListKey(c.key) && c.slotGroup).flatMap((c) => [...c.slotGroup!.keys])
}

/**
 * R-56 — what the sheet LANDS on (and "All attributes" shows): every column minus the hidden slots, order otherwise
 * unchanged. Never applied to the sheet's `orderedKeys` itself — that list is also what Customise can address, what a
 * saved view resolves against and what "export all" writes, and the ten stay in all three.
 */
export function defaultViewKeys(orderedKeys: readonly string[], columns: readonly SlotColumnLike[]): string[] {
  const hidden = new Set(slotKeysHiddenByDefault(columns))
  return hidden.size ? orderedKeys.filter((k) => !hidden.has(k)) : [...orderedKeys]
}

/** The sentence the "All attributes" preset says when positions are folded into one cell — so it never claims "every column". */
export function slotListViewNote(columns: readonly SlotColumnLike[]): string | null {
  const cells = columns.filter((c) => isSlotListKey(c.key) && c.slotGroup)
  if (!cells.length) return null
  const g = cells[0].slotGroup!
  const words = SLOT_LIST_FIELDS[g.of]
  return `Every column this sheet has; ${words.itemLabel} 1–${g.max} show together in ${words.label} (each is in Customise)`
}

/** One slot write the one cell's edit becomes. */
export interface SlotDispatch { colId: string; oldValue: string | null; newValue: string | null }

/**
 * The one cell's change → one dispatch per CHANGED position, each addressed to that slot column — never to the one cell
 * (`slots:…` is not a field). `null` when `colId` is not a one-cell; `[]` when nothing changed.
 */
export function slotFanOut(colId: string | null | undefined, oldValue: unknown, newValue: unknown, columns: readonly SlotColumnLike[]): SlotDispatch[] | null {
  if (!isSlotListKey(colId)) return null
  const group = slotGroupOfKey(colId, columns)
  if (!group) return []
  const before = Array.isArray(oldValue) ? oldValue : []
  return slotListChanges(before, Array.isArray(newValue) ? newValue : [], group.max).map((c) => {
    const old = before[c.position - 1]
    return { colId: group.keys[c.position - 1], oldValue: old === null || old === undefined || old === '' ? null : String(old), newValue: c.value }
  })
}

/**
 * "Attributes displayed in the grid" (the workbook export) names FIELDS: a visible one cell stands for its list, exactly
 * as a visible slot does — so the export keeps bullets while the ten are hidden (R-56).
 */
export function expandSlotListKeys(keys: readonly string[], columns: readonly SlotColumnLike[]): string[] {
  return keys.flatMap((k) => {
    const g = slotGroupOfKey(k, columns)
    return g ? [g.keys[0]] : [k]
  })
}

/** Why a locked one cell will not open: the first locked position's own reason (so the sheet says it, `none+say`). */
export function slotListRefusal<Row>(colId: string, row: Row, columns: readonly SlotColumnLike[], reasonOf: (slotKey: string, row: Row) => string | null): string | null {
  const g = slotGroupOfKey(colId, columns)
  if (!g) return null
  for (const k of g.keys) {
    const reason = reasonOf(k, row)
    if (reason) return reason
  }
  return null
}

/**
 * LX.14 — the channel sheet's queue of edits waiting for a shared/pin choice, moved here unchanged from the adapter so the
 * bullets arm runs the real reducer. Each changed bullet that follows shared text queues its OWN entry ("N edits await a
 * choice"); a second edit of the same cell replaces its entry and keeps the first `previous`. `null` takes the head.
 */
export function queuePendingEdit<E extends { rowId: string; colId: string; previous: unknown }>(prior: E[], next: E | null): E[] {
  if (!next) return prior.slice(1)
  const existing = prior.find((edit) => edit.rowId === next.rowId && edit.colId === next.colId)
  return existing ? prior.map((edit) => (edit === existing ? { ...next, previous: existing.previous } : edit)) : [...prior, next]
}

/** Declining one queued edit puts THAT cell back to its previous value — only that cell (unchanged from the adapter). */
export function revertPendingEdit(pm: { row: { values: Record<string, unknown> }; colId: string; previous: unknown }): void {
  const cell = pm.row.values[pm.colId] as Record<string, unknown> | undefined
  pm.row.values = { ...pm.row.values, [pm.colId]: { ...cell, value: pm.previous } }
}
