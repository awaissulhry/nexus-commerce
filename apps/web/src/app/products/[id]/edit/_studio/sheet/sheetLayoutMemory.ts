/**
 * TOOLBAR REBUILD (Owner, 2026-09-27) — the rules that keep a view, the languages and the progress columns apart.
 *
 * Pure. `useSheetColumns` is the only caller; the tests are `sheetLayoutMemory.vitest.test.ts`.
 *
 * 1. **A view names FIELDS, never languages.** With two or more languages on, the server splits every text field into
 *    `<key>@<lang>` columns. Views, layouts, presets and Customise all work on the plain `<key>`; the grid shows every
 *    language column of it. A view or layout stored before this rule with `name@de` keys reads as `name`.
 * 2. **The last pick is remembered.** "Current layout" (one per scope, per user, on the server) holds "My layout" and
 *    which view was picked last. The sheet opens on that pick, on every product and market of the scope.
 * 3. **Progress columns show unless hidden on purpose.** A layout that lists a progress key in its order but not in
 *    its columns hid it; any other layout or view shows it (every view saved before them could not have excluded them).
 */
import { isColumnsViewPayload, sheetLayoutPayload, type ColumnsViewPayload, type SheetLayoutPayload } from '@/design-system/grid/views/viewPayload'
import { languageColumn } from './languages'

/* ── 1. fields vs language columns ──────────────────────────────────────────────────────────── */

/** The column fields `languageKeyMap` needs. */
export interface KeyedColumn {
  key: string
  locale?: string
  group: string
  groupKey?: string
  /** A language column's own group before the Languages split — sent by the server since 2026-09-27. */
  sourceGroup?: string
  sourceGroupKey?: string
}

/** Where a language column's field goes when the server did not say (an older API). */
export const TEXT_FIELDS_GROUP = 'Text fields'
export const TEXT_FIELDS_GROUP_KEY = 'text-fields'

export interface LanguageKeyMap<C extends KeyedColumn> {
  /** One column per FIELD, in the order the fields first appear. A language column becomes its plain field. */
  fields: C[]
  /** Field key → the grid's column keys for it (one per language, or the field itself). */
  gridKeysOf: (field: string) => string[]
  /** Field keys → grid keys, in order, without repeats. Unknown keys are dropped. */
  toGrid: (fields: readonly string[]) => string[]
  /** Grid (or stored) keys → field keys, in order, without repeats. */
  toFields: (keys: readonly string[]) => string[]
  /** True when some field is shown in more than one language. */
  split: boolean
}

export function fieldKeyOf(key: string): string {
  return languageColumn(key).fieldKey
}

export function languageKeyMap<C extends KeyedColumn>(columns: readonly C[]): LanguageKeyMap<C> {
  const byField = new Map<string, string[]>()
  const fieldOf = new Map<string, string>()
  const fields: C[] = []
  for (const column of columns) {
    const field = column.locale ? fieldKeyOf(column.key) : column.key
    fieldOf.set(column.key, field)
    const known = byField.get(field)
    if (known) { known.push(column.key); continue }
    byField.set(field, [column.key])
    fields.push(column.locale
      ? { ...column, key: field, locale: undefined, group: column.sourceGroup || TEXT_FIELDS_GROUP, groupKey: column.sourceGroupKey || (column.sourceGroup ? column.groupKey : TEXT_FIELDS_GROUP_KEY) }
      : column)
  }
  const gridKeysOf = (field: string) => byField.get(field) ?? []
  const toGrid = (keys: readonly string[]) => [...new Set(keys.flatMap((key) => byField.get(key) ?? byField.get(fieldOf.get(key) ?? fieldKeyOf(key)) ?? []))]
  const toFields = (keys: readonly string[]) => [...new Set(keys.map((key) => fieldOf.get(key) ?? fieldKeyOf(key)))]
  return { fields, gridKeysOf, toGrid, toFields, split: [...byField.values()].some((keys) => keys.length > 1) }
}

/**
 * A stored payload with every `<key>@<lang>` read as `<key>` (rule 1). Returns the SAME object when there is nothing
 * to change, so a caller can compare identities. Group overrides of language groups are dropped: they named a split
 * that no longer exists in a stored layout.
 */
export function fieldPayload<P extends ColumnsViewPayload>(payload: P): P {
  const has = (keys: readonly string[]) => keys.some((key) => key.includes('@'))
  const v3 = payload.v === 3 ? (payload as SheetLayoutPayload) : null
  if (!has(payload.columns) && !(v3 && (has(v3.columnOrder) || has(v3.lockedColumns) || has(Object.keys(v3.groupOverrides)) || v3.groupOrder.some((g) => g.startsWith('language:'))))) return payload
  const plain = (keys: readonly string[]) => [...new Set(keys.map(fieldKeyOf))]
  if (!v3) return { ...payload, columns: plain(payload.columns) }
  const next: SheetLayoutPayload = {
    ...v3,
    columns: plain(v3.columns),
    columnOrder: plain(v3.columnOrder),
    lockedColumns: plain(v3.lockedColumns),
    groupOrder: v3.groupOrder.filter((g) => !g.startsWith('language:')),
    groupOverrides: Object.fromEntries(Object.entries(v3.groupOverrides).filter(([key, group]) => !key.includes('@') && !group.startsWith('language:'))),
  }
  return next as P
}

/* ── 2. the remembered pick ─────────────────────────────────────────────────────────────────── */

/** What the operator picked last on a scope. `custom` = "My layout". */
export type SheetPick =
  | { kind: 'all' }
  | { kind: 'preset'; id: string }
  | { kind: 'saved'; id: string }
  | { kind: 'custom' }

export function isSheetPick(value: unknown): value is SheetPick {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const pick = value as { kind?: unknown; id?: unknown }
  if (pick.kind === 'all' || pick.kind === 'custom') return true
  return (pick.kind === 'preset' || pick.kind === 'saved') && typeof pick.id === 'string' && pick.id.trim().length > 0
}

/** The "Current layout" payload: My layout (possibly empty) plus the last pick. */
export type WorkingLayoutPayload = SheetLayoutPayload & { picked?: SheetPick }

export function pickOf(payload: unknown): SheetPick | null {
  if (!payload || typeof payload !== 'object') return null
  const picked = (payload as { picked?: unknown }).picked
  return isSheetPick(picked) ? picked : null
}

/** An empty "My layout" — what a scope stores when the operator picked a view but never customised. */
export function emptyLayout(): SheetLayoutPayload {
  return sheetLayoutPayload({ columns: [], columnOrder: [], lockedColumns: [], groupOrder: [], groupOverrides: {} })
}

/** Is there a "My layout" to go back to? An empty column list is "never customised". */
export function hasMyLayout(payload: ColumnsViewPayload | null | undefined): payload is ColumnsViewPayload {
  return !!payload && payload.columns.length > 0
}

/** The layout part of a working payload, without the pick — what views and Customise read. */
export function layoutPart(payload: unknown): ColumnsViewPayload | null {
  if (!isColumnsViewPayload(payload)) return null
  const { picked: _picked, ...layout } = payload as WorkingLayoutPayload
  return fieldPayload(layout as ColumnsViewPayload)
}

/** A working payload that keeps My layout and records `pick`. A v2 layout is upgraded to v3 on the way. */
export function withPick(layout: ColumnsViewPayload | null, pick: SheetPick): WorkingLayoutPayload {
  const base: SheetLayoutPayload = layout?.v === 3 ? layout
    : layout ? sheetLayoutPayload({ columns: layout.columns, columnOrder: layout.columns, lockedColumns: [], groupOrder: [], groupOverrides: {} })
    : emptyLayout()
  const { chip: _chip, ...rest } = base
  return { ...rest, picked: pick }
}

/**
 * Picks made in this browser tab, by layout surface — read before the server's copy.
 *
 * A pick is written to the server at once, but a language switch can remount the sheet before that write returns;
 * the remounted sheet must open on the pick just made, not on the one the server still holds.
 */
const sessionPicks = new Map<string, SheetPick>()
export function rememberPick(surface: string, pick: SheetPick): void { sessionPicks.set(surface, pick) }
export function recalledPick(surface: string): SheetPick | null { return sessionPicks.get(surface) ?? null }
/** Tests only. */
export function forgetSessionPicks(): void { sessionPicks.clear() }

export interface LandingChoiceInput {
  pick: SheetPick | null
  presetIds: readonly string[]
  savedIds: readonly string[]
  myLayout: boolean
  /** A product-type default view id (mine, then the team's), when one exists. */
  typeDefaultId: string | null
  /** The global default view id, when one exists. */
  defaultId: string | null
}

export type LandingChoice =
  | { kind: 'all' }
  | { kind: 'preset'; id: string }
  | { kind: 'saved'; id: string; why: 'pick' | 'type-default' | 'default' }
  | { kind: 'custom' }

/**
 * D2 = A (Owner, 2026-09-27): the view picked last opens; a product-type default only when nothing was picked yet.
 * A pick that no longer resolves (a deleted view, a preset this product type does not offer) falls through.
 */
export function chooseLanding(input: LandingChoiceInput): LandingChoice {
  const { pick } = input
  if (pick?.kind === 'all') return { kind: 'all' }
  if (pick?.kind === 'preset' && input.presetIds.includes(pick.id)) return { kind: 'preset', id: pick.id }
  if (pick?.kind === 'saved' && input.savedIds.includes(pick.id)) return { kind: 'saved', id: pick.id, why: 'pick' }
  if (pick?.kind === 'custom' && input.myLayout) return { kind: 'custom' }
  if (input.typeDefaultId && input.savedIds.includes(input.typeDefaultId)) return { kind: 'saved', id: input.typeDefaultId, why: 'type-default' }
  // A layout stored before picks were remembered is what the operator last saved: it opens as My layout.
  if (!pick && input.myLayout) return { kind: 'custom' }
  if (input.defaultId && input.savedIds.includes(input.defaultId)) return { kind: 'saved', id: input.defaultId, why: 'default' }
  return { kind: 'all' }
}

/* ── 3. progress columns and the variation theme ──────────────────────────────────────────── */

/**
 * The groups the sheet shows FIRST by default. A layout saved before one of them existed never ordered it; Customise then
 * lists it first too (not at the bottom), so the dialog and the sheet agree. (Until 2026-10-01 the variation theme had a
 * front group of its own; it now sits in its group — Identity, or Listing / Variations on eBay and Amazon.)
 */
export const FRONT_GROUP_KEYS = ['progress'] as const

/**
 * The progress columns a payload shows by default: every one it does not hide ON PURPOSE. A v3 layout hides a key it
 * lists in `columnOrder` but not in `columns`; a v2 payload or a preset hides none.
 */
export function progressShown(payload: ColumnsViewPayload | null, progressKeys: readonly string[]): string[] {
  if (!payload || payload.v !== 3) return [...progressKeys]
  const visible = new Set(payload.columns)
  const known = new Set(payload.columnOrder)
  return progressKeys.filter((key) => visible.has(key) || !known.has(key))
}
