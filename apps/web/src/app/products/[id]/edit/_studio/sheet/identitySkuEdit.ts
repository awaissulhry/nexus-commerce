/**
 * S11 — THE FIRST COLUMN'S SKU: the one rule module for editing it, in both scopes of the product sheet (plan
 * docs/sheet-ids-sku-rows/PLAN.md, step S11). Pure — no React, no grid runtime — so the node suite reads it, and so do the
 * two writers (`master/masterWrite.ts`, `channel/useChannelSheet.ts`), which must stay node-testable.
 *
 * The Owner's rule (2026-10-05): "Depending on the channel scope I'm making changes to, the changes should be made on the
 * channel I publish to only, unless, obviously, I'm making the changes on the shared scope."
 *   - Shared scope: the first column is `Product.sku`. A new SKU RENAMES the product (`sku`, written to the product). The
 *     server keeps every channel in step: listings a channel still holds keep the SKU they have, drafts follow the new
 *     one, and the answer says which (`skuRenames[]`, one summary sentence each).
 *   - Channel scope: the first column is THIS listing's SKU — the SKU Publish sends for it (the row's `skuFacts`, read by
 *     the server's resolver). A new SKU is this listing's own (`channel_sku`, a channel write on the row's listing
 *     context: this channel, this market, this account, this listing). Empty = follow the Shared SKU again.
 *   The client checks only what the server checks too (trimmed, at most 100 characters, the product-SKU characters from
 *   `@nexus/shared/product-create`) so a typo is named at once; the server decides everything else (a SKU another product
 *   uses, a listing the channel holds, shared stock) and its sentence is the cell's.
 *
 * The Owner's warning ("give me a warning, or maybe color the cell…"): a channel SKU that is not the Shared SKU wears the
 * sheet's existing "differs from Shared" mark (`pinned`: ✎ and its tint), with the sentence `channelOnlySentence`; the
 * editor shows the same sentence while typing. No new visual language.
 *
 * 🔴 THE SEAM for Add rows (PLAN.md part 3, R1–R3): a row the person added and has not saved yet (`unsaved`) has no SKU to
 * rename — its first SKU CREATES (a variation in the Shared scope, an extra listing's row in a channel scope). This module
 * answers `create` for it, and the host hands it to the row's store (`IdentitySkuHost.create` → `newRows/useNewRows.ts`).
 * A real row's SKU is a RENAME (Shared) or a SET / FOLLOW (channel), never a create.
 */
import { channelPlace } from '@nexus/shared/channel-label'
import { PRODUCT_SKU_MAX_LENGTH, newProductProblems } from '@nexus/shared/product-create'
import { AG_AUTO_COL } from '@/design-system/grid/columns/columnPrefs'
import { writeGate } from '@/design-system/grid/editors/writeGate'
import type { CellProvenance } from '@/design-system/grid/renderers/provenance'
import type { CellSaveTracker } from '@/design-system/grid/editors/roundTrip'

/**
 * The first column's id on the grid. Both scopes draw it as AG's tree column, and AG names that column itself
 * (`ag-Grid-AutoColumn`) whatever `colId` the sheet asks for — so the writer, the save marks and the undo history address
 * the cell by this id, and the two writers turn it into the wire field below.
 */
export const IDENTITY_SKU_COLUMN = AG_AUTO_COL
/** The Shared scope's wire field: the product SKU (`PATCH /api/products/bulk`, no target = the product). */
export const SHARED_SKU_FIELD = 'sku'
/** The channel scope's wire field: this listing's own SKU (the API's `CHANNEL_SKU_FIELD`, `target: 'channel'`). */
export const CHANNEL_SKU_FIELD = 'channel_sku'
/** The longest SKU the server stores (the product-SKU rule). The editor's counter shows it. */
export const SKU_MAX_LENGTH = PRODUCT_SKU_MAX_LENGTH

export type IdentitySkuScope =
  | { kind: 'shared' }
  | { kind: 'channel'; channel: string; marketplace: string }

/** The server's facts about a channel row's first-column SKU (API `StudioRow.skuFacts`, `studio-sheet-sku.ts`). */
export interface IdentitySkuFacts {
  /** The SKU Publish sends for this listing; null = no single SKU (`conflict` says why). */
  wanted: string | null
  /** Where `wanted` came from; `'product'` = the listing simply follows the Shared SKU. */
  source: string | null
  /** The SKU the channel holds; null while the listing is still a Nexus draft. */
  live: string | null
  liveConfirmed: boolean
  /** The listing does not simply send the Shared SKU. */
  differs: boolean
  conflict?: string
  editable: boolean
  reason: string | null
}

/** What this module reads of a sheet row (both scopes' rows have it). */
export interface IdentitySkuRow {
  /** The product SKU — the Shared SKU. */
  sku: string
  /** Channel scope: the extra listing the row belongs to (null = the primary listing). */
  aliasId?: string | null
  /** Channel scope: the server's facts. */
  skuFacts?: IdentitySkuFacts | null
  /** Add rows: a row the person added that is not saved (`newRows/`). Its first SKU creates. */
  unsaved?: boolean
  /** Add rows: why this unsaved row's SKU cannot be typed now (its create is on its way, or done); null = it can. */
  unsavedReason?: string | null
  /**
   * Add rows: the empty row behind an unsaved grid row (`newRows/newRows.ts` `NewRow`): what its SKU creates (`kind`) and
   * what the server last answered (`state`, `reason`).
   */
  newRow?: { kind: string; state?: string; reason?: string | null } | null
}

/** What a typed first-column value means on this row. */
export type IdentitySkuIntent =
  | { kind: 'unchanged' }
  /** `sku`: on an unsaved row, what was typed (the row shows it with the reason). */
  | { kind: 'refused'; reason: string; sku?: string }
  /** Shared: Product.sku OLD → NEW. */
  | { kind: 'rename'; sku: string }
  /** Channel: this listing's own SKU. */
  | { kind: 'set'; sku: string }
  /** Channel: follow the Shared SKU again (the cell was emptied). */
  | { kind: 'follow' }
  /** Add rows: an unsaved row's first SKU creates (the host's `create`; a host without one refuses it, `CREATE_NOT_READY`). */
  | { kind: 'create'; sku: string }

/** The sentence a host without Add rows (no `create`) gives a `create`. */
export const CREATE_NOT_READY = 'Adding a product from an empty row is not available yet.'

/** The Shared scope editor's line (the Owner's words, 2026-10-05). */
export const SHARED_SKU_NOTICE = 'Changes the SKU on every channel and market that follows it. Listings a channel still holds keep their current SKU.'

/** A channel row whose server facts did not arrive (an older read): nothing here can say what Publish sends. */
export const NO_FACTS_REASON = 'This SKU cannot be edited here: the sheet did not say which SKU this listing sends. Reload the sheet.'

const text = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value)).trim()

/** "Amazon · DE", "eBay · IT (extra listing)", "Shopify" — where a channel row's listing sells, as the server names it (`channelPlace`). */
export function identitySkuPlace(scope: Extract<IdentitySkuScope, { kind: 'channel' }>, row: Pick<IdentitySkuRow, 'aliasId'>): string {
  return `${channelPlace(scope.channel, scope.marketplace)}${row.aliasId ? ' (extra listing)' : ''}`
}

/**
 * The warning a channel SKU wears (the mark's hover and accessible name) and the editor shows while typing — the Owner's
 * words: the SKU reaches this channel and market only; to change it everywhere, edit it in the Shared view.
 */
export function channelOnlySentence(scope: Extract<IdentitySkuScope, { kind: 'channel' }>, row: Pick<IdentitySkuRow, 'sku' | 'aliasId'>): string {
  return `This SKU is for ${identitySkuPlace(scope, row)} only. Other channels and markets keep ${row.sku}. To change it everywhere, edit it in the Shared view.`
}

/** What the first column shows: the product SKU (Shared), the SKU Publish sends for this listing (channel). */
export function identitySkuShown(scope: IdentitySkuScope, row: IdentitySkuRow): string {
  return scope.kind === 'shared' ? row.sku : row.skuFacts?.wanted ?? row.sku
}

/**
 * The SKU a channel row's listing is known by on its channel — what its Status and Action are about: the SKU the channel
 * holds (an End, a Delete, a pause act on it), else the SKU Publish sends (a create, a relist). The product SKU when the
 * server said nothing (an older read). The Shared scope names rows by their product SKU and never asks this.
 */
export function listingSkuLabel(row: Pick<IdentitySkuRow, 'sku' | 'skuFacts'>): string {
  return row.skuFacts?.live ?? row.skuFacts?.wanted ?? row.sku
}

/** Whether the first column can be edited on this row, and why not. The Shared scope: every saved row. */
export function identitySkuEditability(scope: IdentitySkuScope, row: IdentitySkuRow): { editable: boolean; reason: string | null } {
  if (row.unsaved) return row.unsavedReason ? { editable: false, reason: row.unsavedReason } : { editable: true, reason: null }
  if (scope.kind === 'shared') return { editable: true, reason: null }
  const facts = row.skuFacts
  if (!facts) return { editable: false, reason: NO_FACTS_REASON }
  return facts.editable ? { editable: true, reason: null } : { editable: false, reason: facts.reason ?? NO_FACTS_REASON }
}

/**
 * The mark the first column wears — the sheet's existing members, nothing new: `attention` (no single SKU on record:
 * the resolver's sentence), `pinned` ("differs from Shared": this listing sends its own SKU), else none. The Shared scope
 * never wears one: its SKU IS the Shared SKU.
 */
export function identitySkuMark(scope: IdentitySkuScope, row: IdentitySkuRow): { member: CellProvenance; sentence: string | null } {
  if (scope.kind === 'shared') return { member: 'own', sentence: null }
  const facts = row.skuFacts
  if (!facts) return { member: 'own', sentence: null }
  if (facts.wanted === null) return { member: 'attention', sentence: facts.conflict ?? 'This listing has no single SKU on record.' }
  if (facts.differs && facts.wanted !== row.sku) return { member: 'pinned', sentence: channelOnlySentence(scope, row) }
  return { member: 'own', sentence: null }
}

/** What typing a SKU into an EMPTY row does (F9, browser check 2026-10-05): it creates; nothing is renamed or kept. */
export const NEW_VARIATION_NOTICE = 'Creates a new variation of this family: a draft, in Nexus only.'
export const newListingNotice = (scope: Extract<IdentitySkuScope, { kind: 'channel' }>): string =>
  `Creates another listing of this product on ${channelPlace(scope.channel, scope.marketplace)} with this SKU.`

/**
 * F3 / F8 (browser check 2026-10-05) — the ONE sentence of the first column's last refusal on this row, or null: an empty
 * row's refused create (`newRow.reason`), or a real row's refused save (the sheet tracker's entry for this cell). The
 * sheet shows it the way it shows every refused cell — the toast when it happens (`announceRefusals`; an empty row's
 * store says it the same way) and the cell's hover, which leads with it (`identitySkuHover`) — and the editor leads with
 * it when the person tries again (`identitySkuNotice`), where the 240 px band cannot print it whole.
 */
export function identitySkuRefusal(row: IdentitySkuRow, save?: { state: string; reason?: string } | null): string | null {
  if (row.unsaved) return row.newRow?.state === 'refused' ? row.newRow.reason?.trim() || null : null
  return save?.state === 'refused' ? save.reason?.trim() || null : null
}

/** The first column's hover on the band: the refusal first (it is what just happened), then the band's own sentence. */
export function identitySkuHover(refusal: string | null | undefined, own?: string | null): string | undefined {
  const parts = [refusal ? `Not saved: ${refusal}` : null, own].map(part => part?.trim()).filter((part): part is string => !!part)
  return parts.length ? parts.join('\n\n') : undefined
}

/**
 * The line the editor shows while the person types: what this SKU change reaches — on an EMPTY row, what typing creates
 * (F9) — led by the last refusal of this cell, when there is one (F3 / F8).
 */
export function identitySkuNotice(scope: IdentitySkuScope, row: IdentitySkuRow, refusal?: string | null): { text: string; tone: 'info' | 'warning' } {
  const base = row.unsaved
    ? { text: row.newRow?.kind === 'alias' && scope.kind === 'channel' ? newListingNotice(scope) : NEW_VARIATION_NOTICE, tone: 'info' as const }
    : scope.kind === 'shared' ? { text: SHARED_SKU_NOTICE, tone: 'info' as const } : { text: channelOnlySentence(scope, row), tone: 'warning' as const }
  return refusal ? { text: `Not saved: ${refusal} ${base.text}`, tone: 'warning' } : base
}

/** The product-SKU rule's own sentence for a typed SKU, or null (`@nexus/shared/product-create`, reused, never copied). */
export function skuProblem(sku: string): string | null {
  return newProductProblems({ sku }).sku ?? null
}

/** What the typed value means on this row (see `IdentitySkuIntent`). The row is read as it was BEFORE the edit. */
export function identitySkuIntent(scope: IdentitySkuScope, row: IdentitySkuRow, typed: unknown): IdentitySkuIntent {
  const sku = text(typed)
  if (row.unsaved) {
    if (!sku) return { kind: 'unchanged' }
    if (row.unsavedReason) return { kind: 'refused', reason: row.unsavedReason, sku }
    const problem = skuProblem(sku)
    return problem ? { kind: 'refused', reason: problem, sku } : { kind: 'create', sku }
  }
  const editable = identitySkuEditability(scope, row)
  if (!editable.editable) return { kind: 'refused', reason: editable.reason ?? NO_FACTS_REASON }
  if (scope.kind === 'shared') {
    if (sku === row.sku.trim()) return { kind: 'unchanged' }
    const problem = skuProblem(sku)
    return problem ? { kind: 'refused', reason: problem } : { kind: 'rename', sku }
  }
  const facts = row.skuFacts!
  if (!sku) return facts.source === 'product' ? { kind: 'unchanged' } : { kind: 'follow' }
  if (facts.wanted !== null && sku === facts.wanted.trim()) return { kind: 'unchanged' }
  const problem = skuProblem(sku)
  return problem ? { kind: 'refused', reason: problem } : { kind: 'set', sku }
}

/** The value the sheet writer queues for an intent (`writer.set(rowId, IDENTITY_SKU_COLUMN, value, { intent })`). */
export function identitySkuQueued(intent: Extract<IdentitySkuIntent, { kind: 'rename' | 'set' | 'follow' }>): { value: string | null; intent: 'set' | 'reset' } {
  return intent.kind === 'follow' ? { value: null, intent: 'reset' } : { value: intent.sku, intent: 'set' }
}

/**
 * The channel writer's change for a queued first-column cell: this listing's own SKU, a channel write (the request's
 * one listing context names the listing), `reset` = follow the Shared SKU again.
 */
export function identitySkuChannelChange(value: unknown, intent: string | undefined): { field: string; value: string | null; target: 'channel'; intent: 'set' | 'reset' } {
  const sku = text(value)
  return intent === 'reset' || intent === 'reset-list' || !sku
    ? { field: CHANNEL_SKU_FIELD, value: null, target: 'channel', intent: 'reset' }
    : { field: CHANNEL_SKU_FIELD, value: sku, target: 'channel', intent: 'set' }
}

/** The Shared writer's field for a column: the product SKU for the first column, else the column's own write field. */
export function sharedWriteField(colId: string, columnWriteField: string | undefined): string {
  return colId === IDENTITY_SKU_COLUMN ? SHARED_SKU_FIELD : columnWriteField ?? colId
}

/** What the row holds before an edit — enough to put it back when the save is refused. */
export type IdentitySkuSnapshot = { sku: string; skuFacts: IdentitySkuFacts | null | undefined }

export function identitySkuSnapshot(row: IdentitySkuRow): IdentitySkuSnapshot {
  return { sku: row.sku, skuFacts: row.skuFacts ? { ...row.skuFacts } : row.skuFacts }
}

/**
 * Show the typed SKU on the row at once (the grid re-reads the value from the row the moment the setter returns). Shared:
 * the product SKU. Channel: this listing's SKU, and whether it now differs from the Shared SKU; the next read confirms.
 */
export function applyIdentitySku(scope: IdentitySkuScope, row: IdentitySkuRow, intent: Extract<IdentitySkuIntent, { kind: 'rename' | 'set' | 'follow' }>): void {
  if (scope.kind === 'shared') {
    if (intent.kind === 'rename') row.sku = intent.sku
    return
  }
  const facts = row.skuFacts
  if (!facts) return
  row.skuFacts = intent.kind === 'follow'
    ? { ...facts, wanted: row.sku, source: 'product', differs: false, conflict: undefined }
    : { ...facts, wanted: intent.sku, source: 'channel', differs: intent.sku !== row.sku, conflict: undefined }
}

/** Put the row back as it was before the edit (a refused save, or a value the client check refused). */
export function restoreIdentitySku(row: IdentitySkuRow, snapshot: IdentitySkuSnapshot): void {
  row.sku = snapshot.sku
  row.skuFacts = snapshot.skuFacts
}

/**
 * The value the sheet's undo writes back for this row's first column (read BEFORE the edit). Shared: the old SKU. Channel:
 * empty when the listing followed the Shared SKU — so undo FOLLOWS again rather than pinning the same text as its own —
 * else the SKU it sent.
 */
export function identitySkuUndoValue(scope: IdentitySkuScope, row: IdentitySkuRow): string {
  if (scope.kind === 'shared') return row.sku
  const facts = row.skuFacts
  return !facts || facts.source === 'product' || facts.wanted === null ? '' : facts.wanted
}

/**
 * A lost answer read back (`sheetRecovery.ts`): did the stored row take the queued first-column value? Null = the read
 * cannot tell (no facts).
 */
export function identitySkuRecovered(stored: { sku?: unknown; skuFacts?: IdentitySkuFacts | null }, channel: boolean, value: unknown, intent: string | undefined): boolean | null {
  if (!channel) return typeof stored.sku === 'string' ? stored.sku.trim() === text(value) : null
  const facts = stored.skuFacts
  if (!facts) return null
  if (intent === 'reset' || !text(value)) return facts.source === 'product'
  return facts.wanted !== null && facts.wanted.trim() === text(value)
}

/* ── One edit's road: setter → change event → the sheet's writer, and back on a refusal ───────────────────────── */

/** What `IdentitySkuEdits` needs from its host sheet. Each member is read at call time. */
export interface IdentitySkuHost<Row extends IdentitySkuRow> {
  scope: () => IdentitySkuScope
  rowIdOf: (row: Row) => string
  tracker: Pick<CellSaveTracker, 'get' | 'set'>
  /** The sheet's writer: `writer.set(rowId, IDENTITY_SKU_COLUMN, value, { row, intent })`. */
  write: (rowId: string, value: string | null, row: Row, intent: 'set' | 'reset') => void
  /** The sheet's undo history (`useSheetUndo().record`; it skips the undo's own replays). */
  recordUndo: (change: { rowId: string; colId: string; before: unknown; after: unknown }, source?: string) => void
  /** Says a refusal the moment it happens (the sheet's `announceRefusals`). */
  announce: (refusals: ReadonlyArray<{ colId: string; reason?: string }>) => unknown
  /** Draw the row's first column again (after the value went back). */
  repaint: (row: Row) => void
  /**
   * Add rows: an unsaved row's typed SKU — a `create`, or a `refused` with what was typed — goes to the row's own store
   * (`newRows/useNewRows.ts`), which checks it again, creates the record and keeps the answer on the row. False = this
   * host has no Add rows (the cell is refused with `CREATE_NOT_READY`).
   */
  create?: (row: Row, sku: string) => boolean
}

type QueuedIntent = Extract<IdentitySkuIntent, { kind: 'rename' | 'set' | 'follow' }>

/**
 * The first column's edits between the grid and the sheet's writer — pure bookkeeping, so the node suite can drive it:
 *   1. the column's setter says what a typed value means (`setterSaw`, before the row shows it). A value the client check
 *      refuses never leaves: the cell is marked refused with the sentence, and it is said at once;
 *   2. the grid reports the change (`changed`): ONE undo step, and the save through the sheet's own writer;
 *   3. the tracker settles the save (`trackerChanged`): refused → the row goes back to what it was (the refusal and its
 *      sentence stay on the cell), stored → nothing to keep.
 */
export class IdentitySkuEdits<Row extends IdentitySkuRow> {
  /** What the setter accepted, until the grid reports the change (AG reports it after the current turn). */
  private readonly edits = new Map<string, { intent: QueuedIntent; undoBefore: string; before: IdentitySkuSnapshot }>()
  /** A save on its way: the row as the server last had it, put back if the save is refused. */
  private readonly reverts = new Map<string, { row: Row; before: IdentitySkuSnapshot }>()

  constructor(private readonly host: IdentitySkuHost<Row>) {}

  /** The column's setter, BEFORE the row shows the value. `refused` / `create` are never applied to the row. */
  setterSaw(row: Row, intent: IdentitySkuIntent, before: IdentitySkuSnapshot): void {
    const rowId = this.host.rowIdOf(row)
    // Add rows: an unsaved row's SKU is the row's own business (its store checks, creates and answers on the row).
    if (row.unsaved && (intent.kind === 'create' || (intent.kind === 'refused' && intent.sku !== undefined)) && this.host.create?.(row, intent.sku ?? '')) return
    if (intent.kind === 'refused' || intent.kind === 'create') {
      const reason = intent.kind === 'refused' ? intent.reason : CREATE_NOT_READY
      this.host.tracker.set(rowId, IDENTITY_SKU_COLUMN, 'refused', reason)
      this.host.announce([{ colId: IDENTITY_SKU_COLUMN, reason }])
      this.host.repaint(row)
      return
    }
    if (intent.kind === 'unchanged') return
    this.edits.set(rowId, { intent, undoBefore: identitySkuUndoValue(this.host.scope(), before), before })
  }

  /** The grid's change event. True = the first column's (handled here, whatever happened). */
  changed(e: { data?: Row; colDef: { colId?: string }; source?: string }): boolean {
    if (e.colDef.colId !== IDENTITY_SKU_COLUMN) return false
    if (!e.data || !writeGate({ colId: e.colDef.colId, source: e.source }).write) return true
    const rowId = this.host.rowIdOf(e.data)
    const edit = this.edits.get(rowId)
    this.edits.delete(rowId)
    if (!edit) return true
    const queued = identitySkuQueued(edit.intent)
    this.host.recordUndo({ rowId, colId: IDENTITY_SKU_COLUMN, before: edit.undoBefore, after: queued.value ?? '' }, e.source)
    // Kept from here on (the write marks the cell `saving` at once). An earlier save of this cell still on its way keeps
    // the snapshot from before IT: that is what the server last had.
    if (!(this.reverts.has(rowId) && this.host.tracker.get(rowId, IDENTITY_SKU_COLUMN)?.state === 'saving')) this.reverts.set(rowId, { row: e.data, before: edit.before })
    this.host.write(rowId, queued.value, e.data, queued.intent)
    return true
  }

  /** The save tracker changed: a refused save puts its row back; a stored one is done. */
  trackerChanged(): void {
    for (const [rowId, pending] of this.reverts) {
      const state = this.host.tracker.get(rowId, IDENTITY_SKU_COLUMN)?.state
      if (state === 'refused') {
        restoreIdentitySku(pending.row, pending.before)
        this.reverts.delete(rowId)
        this.host.repaint(pending.row)
      } else if (state === 'saved' || state === undefined) this.reverts.delete(rowId)
    }
  }
}

/* ── After a Shared rename ─────────────────────────────────────────────────────────────────────────────────── */

/** One rename the server made, with what it did on the channels (API `skuRenames[]`, S9). */
export interface SkuRename { productId: string; from: string; to: string; summary: string }

/** The answer's renames; anything malformed is left out rather than guessed. */
export function skuRenamesOf(body: unknown): SkuRename[] {
  const list = (body as { skuRenames?: unknown } | null)?.skuRenames
  if (!Array.isArray(list)) return []
  return list.flatMap((entry) => {
    const e = entry as Partial<Record<keyof SkuRename, unknown>> | null
    return e && typeof e.productId === 'string' && typeof e.from === 'string' && typeof e.to === 'string'
      ? [{ productId: e.productId, from: e.from, to: e.to, summary: typeof e.summary === 'string' ? e.summary : '' }] : []
  })
}

/** The notice a Shared rename shows: each rename and the server's own sentence about the channels. */
export function skuRenameMessage(renames: readonly SkuRename[]): string | null {
  if (!renames.length) return null
  const lines = renames.slice(0, 3).map(r => `${r.from} is now ${r.to}.${r.summary ? ` ${r.summary}` : ''}`)
  if (renames.length > 3) lines.push(`${renames.length - 3} more ${renames.length - 3 === 1 ? 'SKU was' : 'SKUs were'} renamed the same way.`)
  return lines.join(' ')
}

/**
 * The studio's record after confirmed renames (its header, the Publish window): the open product's SKU and its family's
 * parent SKU. The same objects back when nothing they show changed, so readers do not re-render for nothing.
 */
export function renamedStudioRecord<P extends { id: string; sku: string }, F extends { parentId: string; parentSku: string }>(
  product: P, family: F | null, skus: Readonly<Record<string, string>>,
): { product: P; family: F | null } {
  const sku = skus[product.id]
  const parentSku = family ? skus[family.parentId] : undefined
  return {
    product: sku && sku !== product.sku ? { ...product, sku } : product,
    family: family && parentSku && parentSku !== family.parentSku ? { ...family, parentSku } : family,
  }
}
