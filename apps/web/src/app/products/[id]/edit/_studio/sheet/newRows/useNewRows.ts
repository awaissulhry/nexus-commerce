'use client'

/**
 * Add rows (plan docs/sheet-ids-sku-rows/PLAN.md, R2–R3) — the empty rows of one product sheet scope: page memory only,
 * the creates their SKUs start, and the one sheet read per batch that brings the real rows in.
 *
 * `NewRowsStore` holds the rules (no React), so the node suite drives it; `useNewRows` is the thin hook a scope adapter
 * calls. Each empty row is ONE intent with its own Idempotency-Key slot (its row id): a create whose answer is lost
 * keeps the key, and typing the same SKU again replays it instead of creating it twice. The person cannot change the
 * scope while a create is on its way (`registerScopeChangeGuard`): the answer must land on the sheet that asked.
 *
 * Creates go ONE AFTER ANOTHER (browser check 2026-10-05, F10): a store is one family's sheet, and the server refuses a
 * second create into a family while another is changing it ("This family changed during the operation…", 409). A paste
 * of three SKUs once fired three creates at once and two came back refused. Each row still has its own key; a refused or
 * lost row keeps its SKU and its sentence (a Reload too keeps it); the sheet is read once, after the last create.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { commandKeyFor } from '@/lib/command-key'
import { familyOps } from '../master/familyOps'
import type { FamilyResponse } from '../master/family'
import { addListingAlias } from '../channel/useChannelSheet'
import { IDENTITY_SKU_COLUMN } from '../identitySkuEdit'
import { channelLabel } from '@nexus/shared/channel-label'
import { unsavedOf } from './newRowsGrid'
import { collapsedAncestors, type LandingRowNode } from '@/design-system/grid'
import type { ChannelScopeChannel } from '../channel/types'
import {
  NEW_ROWS_WORDS, ROWS_TO_ADD_DEFAULT, clampRowsToAdd, landedRows, makeNewRows, newRowSkuProblem, pasteSentence, pastedSkus, planPaste,
  removable, takesSku, type NewRow, type NewRowKind, type NewRowState, type PastePlan,
} from './newRows'

/** Where a row of one kind is created. */
export type NewRowsTarget =
  | { kind: 'variation'; parentId: string; parentName: string }
  | { kind: 'alias'; productId: string; channel: ChannelScopeChannel; marketplace: string; accountId?: string }

/** A target, or the reason rows of that kind cannot be created here now (no parent, no account, no permission). */
export type NewRowsTargetAnswer = NewRowsTarget | { refused: string }

export type CreateOutcome = { ok: true; id: string | null } | { ok: false; reason: string; unknown?: boolean }

export interface NewRowsApi {
  createVariation(input: { parentId: string; sku: string; name: string; slot: string }): Promise<CreateOutcome>
  createAlias(input: { productId: string; channel: ChannelScopeChannel; marketplace: string; accountId?: string; sku: string; slot: string }): Promise<CreateOutcome>
}

/** A failed create whose key the slot still holds had no answer (lost, or still running): it may exist. */
const outcomeUnknown = (slot: string) => commandKeyFor(slot).pending !== null

/** The sheet's creates: the family's "add child" call and the listing-alias call, each keyed by the row. */
export const sheetNewRowsApi: NewRowsApi = {
  async createVariation({ parentId, sku, name, slot }) {
    try {
      const created = await familyOps.addVariation(parentId, { sku, name }, slot)
      return { ok: true, id: created?.data?.id ?? null }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error), unknown: outcomeUnknown(slot) }
    }
  },
  async createAlias({ slot, ...input }) {
    // The listing is named by its SKU, as the eBay import names the listings it makes.
    const created = await addListingAlias({ ...input, label: input.sku, slot })
    return created.ok ? { ok: true, id: created.alias?.id ?? null }
      : { ok: false, reason: created.reason ?? 'The listing could not be added.', unknown: !!created.unknown || outcomeUnknown(slot) }
  },
}

/** The DS toast's tones, so a host passes `toast` as is. */
export type SayTone = 'info' | 'success' | 'warning' | 'danger'

export interface NewRowsHost {
  api: NewRowsApi
  /** Where a row of this kind is created, or why it cannot be now. Read when rows are added and when a SKU is typed. */
  target(kind: NewRowKind): NewRowsTargetAnswer
  /** What a typed SKU is checked against: the family on screen and every SKU on the sheet. */
  skuContext(): { family: FamilyResponse | null; takenSkus: Iterable<string> }
  /** Read the sheet again — once per batch of creates (a paste, one typed SKU); `kinds`: what the batch created. */
  onCreated(kinds: ReadonlySet<NewRowKind>): void
  /** Say a sentence at once (the sheet's toast). */
  say(message: string, tone: SayTone): void
}

/** Why the answer was lost, in words: the row keeps its key, so the same SKU again is safe. */
export const lostAnswer = (reason: string) =>
  `No answer from the server (${reason}). It may have been created: type the same SKU again to check. It is never created twice.`

export class NewRowsStore {
  private rows: NewRow[] = []
  private readonly listeners = new Set<() => void>()
  private inFlight = 0
  private readonly createdSinceRead = new Set<NewRowKind>()
  /** The creates' line: each starts when the one before it has its answer (the first at once). */
  private readonly line: Array<() => Promise<void>> = []
  private lineRunning = false
  /** The refusal sentences said in this batch (a paste, the creates in the line): each said once. */
  private readonly batchSaid = new Set<string>()
  private pasting = false

  constructor(private readonly host: NewRowsHost) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): readonly NewRow[] => this.rows

  /** A create is on its way. */
  get busy(): boolean { return this.inFlight > 0 }

  rowFor(id: string): NewRow | undefined { return this.rows.find((row) => row.id === id) }

  private commit(next: NewRow[]): void {
    if (next === this.rows) return
    this.rows = next
    for (const listener of [...this.listeners]) listener()
  }

  private patch(id: string, change: Partial<NewRow>): void {
    this.commit(this.rows.map((row) => (row.id === id ? { ...row, ...change } : row)))
  }

  /**
   * F8 (browser check 2026-10-05): a refused row's sentence is said at once, in the sheet's toast (the voice of every
   * refused cell), not only in the narrow first column. A batch says each distinct sentence once: a paste of three SKUs
   * refused for one reason is one toast. A lost answer keeps its own words on the row (no toast).
   */
  private sayRefusal(reason: string): void {
    if (!this.batchSaid.has(reason)) {
      this.batchSaid.add(reason)
      this.host.say(reason, 'danger')
    }
    this.endBatchIfIdle()
  }

  /** The batch ends when nothing is pasting and no create is on its way: its sentences may be said again. */
  private endBatchIfIdle(): void {
    if (!this.pasting && this.inFlight === 0) this.batchSaid.clear()
  }

  /** Add `count` (1–50) empty rows of one kind at the end. Refused, with its reason said, when that kind cannot be created here. */
  add(kind: NewRowKind, count: number): NewRow[] {
    const target = this.host.target(kind)
    if ('refused' in target) {
      this.host.say(target.refused, 'warning')
      return []
    }
    const added = makeNewRows(kind, count)
    this.commit([...this.rows, ...added])
    return added
  }

  /** Remove one empty row (the button, the Delete key). A create on its way cannot be removed: its answer is coming. */
  remove(id: string): boolean {
    const row = this.rowFor(id)
    if (!row || !removable(row)) return false
    this.commit(this.rows.filter((r) => r.id !== id))
    return true
  }

  /**
   * Drop the rows that hold nothing of the person's (a reload): an untyped empty row, and a created one (the read shows
   * its record). A create on its way stays (its answer still lands), and so does a refused or unconfirmed row: its typed
   * SKU and the server's sentence stay until the person removes it or types again.
   */
  clear(): void {
    this.commit(this.rows.filter((row) => row.state === 'saving' || row.state === 'refused' || row.state === 'unknown'))
  }

  /** The sheet read now shows these products and listings: the rows that created them are done. */
  landed(presentIds: ReadonlySet<string>): void {
    this.commit(landedRows(this.rows, presentIds))
  }

  /** The Delete key on an empty row removes it (a create on its way stays). True when the key was this store's. */
  cellKey(rowId: string, key: string): boolean {
    return key === 'Delete' && this.remove(rowId)
  }

  /**
   * A SKU typed into an empty row: checked, then created at once. Returns the row's state after it (null: not an empty
   * row that takes a SKU). An empty value on a refused row clears it back to empty.
   */
  type(rowId: string, raw: string): NewRowState | null {
    const row = this.rowFor(rowId)
    if (!row || !takesSku(row)) return null
    const sku = raw.trim()
    if (!sku) {
      if (row.state === 'refused') this.patch(rowId, { sku: '', state: 'empty', reason: null })
      return this.rowFor(rowId)!.state
    }
    const target = this.host.target(row.kind)
    if ('refused' in target) {
      this.patch(rowId, { sku, state: 'refused', reason: target.refused })
      this.sayRefusal(target.refused)
      return 'refused'
    }
    const { family, takenSkus } = this.host.skuContext()
    const otherNewSkus = this.rows.filter((r) => r.id !== rowId && r.sku && (r.state === 'saving' || r.state === 'created' || r.state === 'unknown')).map((r) => r.sku)
    const problem = newRowSkuProblem(sku, { kind: row.kind, family, takenSkus, otherNewSkus })
    if (problem) {
      this.patch(rowId, { sku, state: 'refused', reason: problem })
      this.sayRefusal(problem)
      return 'refused'
    }
    this.patch(rowId, { sku, state: 'saving', reason: null })
    this.inFlight++
    // One after another: this create starts once every create typed before it has its answer.
    this.line.push(() => this.send(rowId, target, sku))
    if (!this.lineRunning) void this.runLine()
    return 'saving'
  }

  /** Send the line's creates one by one; the first starts at once (this call), the next after each answer. */
  private async runLine(): Promise<void> {
    this.lineRunning = true
    try {
      for (let next = this.line.shift(); next; next = this.line.shift()) await next().catch(() => undefined)
    } finally {
      this.lineRunning = false
    }
  }

  private async send(rowId: string, target: NewRowsTarget, sku: string): Promise<void> {
    let outcome: CreateOutcome
    try {
      outcome = target.kind === 'variation'
        ? await this.host.api.createVariation({ parentId: target.parentId, sku, name: target.parentName.trim() || sku, slot: rowId })
        : await this.host.api.createAlias({ productId: target.productId, channel: target.channel, marketplace: target.marketplace,
          ...(target.accountId ? { accountId: target.accountId } : {}), sku, slot: rowId })
    } catch (error) {
      outcome = { ok: false, reason: error instanceof Error ? error.message : String(error), unknown: true }
    }
    if (outcome.ok) {
      this.patch(rowId, { state: 'created', createdId: outcome.id, reason: null })
      this.createdSinceRead.add(this.rowFor(rowId)?.kind ?? target.kind)
    } else if (outcome.unknown) {
      this.patch(rowId, { state: 'unknown', reason: lostAnswer(outcome.reason) })
    } else {
      this.patch(rowId, { state: 'refused', reason: outcome.reason })
      this.sayRefusal(outcome.reason)
    }
    this.inFlight--
    // One read per batch: the last answer of the creates in the line reads the sheet again, once.
    if (this.inFlight === 0 && this.createdSinceRead.size > 0) {
      const kinds = new Set(this.createdSinceRead)
      this.createdSinceRead.clear()
      this.host.onCreated(kinds)
    }
    this.endBatchIfIdle()
  }

  /**
   * A paste into an empty row's SKU: its first column fills the empty rows in order from that row; what does not fit is
   * counted and said, never dropped silently.
   */
  paste(startRowId: string, data: ReadonlyArray<ReadonlyArray<string> | string>): PastePlan & { sentence: string | null } {
    const { skus, extraColumns } = pastedSkus(data)
    const plan = planPaste(this.rows, startRowId, skus)
    this.pasting = true
    try {
      for (const { rowId, sku } of plan.fill) this.type(rowId, sku)
    } finally {
      this.pasting = false
      this.endBatchIfIdle()
    }
    const sentence = pasteSentence(plan, extraColumns)
    if (sentence) this.host.say(sentence, plan.leftOver > 0 ? 'warning' : 'info')
    return { ...plan, sentence }
  }
}

/** The root a variation row is created under (both scopes read it from their own rows). */
export interface VariationRoot { id: string; name: string | null; isParent?: boolean; childCount?: number }

/** Where a Variations row is created: under the family's parent — never under a standalone product, never without edit rights. */
export function variationTarget(root: VariationRoot | null | undefined, canEdit: boolean): NewRowsTargetAnswer {
  if (!canEdit) return { refused: NEW_ROWS_WORDS.noPermission }
  if (!root || !(root.isParent || (root.childCount ?? 0) > 0)) return { refused: NEW_ROWS_WORDS.noParent }
  return { kind: 'variation', parentId: root.id, parentName: root.name ?? '' }
}

/** Where a "Listing (alias)" row is created: this channel · market · account. With no account connected, the server's words. */
export function aliasTarget(input: { productId: string; channel: ChannelScopeChannel; marketplace: string; accountId?: string; noAccount: boolean; canEdit: boolean }): NewRowsTargetAnswer {
  if (!input.canEdit) return { refused: NEW_ROWS_WORDS.noPermission }
  if (input.noAccount) {
    const label = channelLabel(input.channel) || input.channel
    return { refused: `Connect ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label} account before adding a listing on ${input.marketplace}.` }
  }
  return { kind: 'alias', productId: input.productId, channel: input.channel, marketplace: input.marketplace, ...(input.accountId ? { accountId: input.accountId } : {}) }
}

/** The part of a grid key event `newRowsGridKey` reads. */
export interface NewRowsKeyEvent {
  data?: unknown
  column?: { getColId(): string } | null
  rowIndex?: number | null
  event?: Event | null
  api?: { getEditingCells(): unknown[]; startEditingCell(params: { rowIndex: number; colKey: string }): void } | null
}

/**
 * First in the sheet's key handler: on an empty row (not while a cell is being edited), Delete removes the row, and Enter
 * on its SKU cell starts typing the SKU (the Shared scope's Enter otherwise opens the record, which an empty row does not
 * have yet). True = handled; the sheet does nothing else with the key.
 */
export function newRowsGridKey(store: NewRowsStore, e: NewRowsKeyEvent): boolean {
  const row = unsavedOf(e.data)
  const key = (e.event as KeyboardEvent | null | undefined)?.key
  if (!row || !key || (e.api?.getEditingCells().length ?? 0) > 0) return false
  const sku = e.column?.getColId() === IDENTITY_SKU_COLUMN
  if (key === 'Enter' && sku && e.api && e.rowIndex != null) {
    e.event?.preventDefault()
    e.api.startEditingCell({ rowIndex: e.rowIndex, colKey: IDENTITY_SKU_COLUMN })
    return true
  }
  return store.cellKey(row.id, key)
}

/** The part of AG's clipboard event `newRowsPaste` reads. */
export interface NewRowsPasteEvent {
  data: string[][]
  api: { getFocusedCell(): { rowIndex: number; column: { getColId(): string } } | null; getDisplayedRowAtIndex(index: number): { data?: unknown } | null | undefined }
}

/**
 * A paste that starts on an empty row's SKU cell fills the empty rows in order (and says what was left over); the grid
 * then pastes nothing, so no SKU spills into the real rows below. Every other paste is `next`'s.
 */
export function newRowsPaste<P extends NewRowsPasteEvent>(store: NewRowsStore, next: (params: P) => string[][] | null): (params: P) => string[][] | null {
  return (params) => {
    const focused = params.api.getFocusedCell()
    const row = focused && focused.column.getColId() === IDENTITY_SKU_COLUMN ? unsavedOf(params.api.getDisplayedRowAtIndex(focused.rowIndex)?.data) : null
    if (!row) return next(params)
    store.paste(row.id, params.data)
    return null
  }
}

/** One item of the grid's cell menu, as AG takes it. */
export interface NewRowMenuItem { name: string; action: () => void }

/**
 * The cell menu (right-click, Shift+F10, the context-menu key) on an empty row: only "Remove this row" — the row's remove
 * button, by another way — or nothing while its create is on its way. The sheet's cell verbs (Cell details, reset, copy,
 * the row's actions) are about records, and an empty row is not one yet. Every other row's menu is `next`'s.
 */
export function newRowsContextMenu<P extends { node?: { data?: unknown } | null }, Item>(store: NewRowsStore, next: (params: P) => Item[]): (params: P) => Array<Item | NewRowMenuItem> {
  return (params) => {
    const row = unsavedOf(params.node?.data)
    if (!row) return next(params)
    return removable(row) ? [{ name: NEW_ROWS_WORDS.removeRow, action: () => { store.remove(row.id) } }] : []
  }
}

/** The slice of AG's API that focusing a new row needs — structural, so a test passes a fake. */
export interface NewRowFocusApi {
  getRowNode(id: string): LandingRowNode | undefined
  ensureIndexVisible(index: number, position?: 'top' | 'bottom' | 'middle' | null): void
  ensureColumnVisible(key: string, position?: 'auto' | 'start' | 'middle' | 'end'): void
  setFocusedCell(rowIndex: number, colKey: string): void
  isDestroyed(): boolean
}

/** Frames to wait for the grid to hold the new row (the sheet re-renders, AG takes the rows) and then draw its cell. */
export const NEW_ROW_FOCUS_FRAMES = 12

/**
 * Focus may move to the new row while it is where the person left it: on the page (nothing focused), in the grid, or on
 * the Add rows control in the footer's start slot (the button, or the menu's trigger it returns to). Focus the person
 * moved anywhere else meanwhile is theirs.
 */
export function focusMayMove(active: Element | null): boolean {
  if (!active || (typeof document !== 'undefined' && active === document.body)) return true
  return active.closest('.ag-root-wrapper, .nds-grid-sheet-status-start') !== null
}

export interface FocusNewRowOptions {
  colId?: string
  /** Frame scheduler — `requestAnimationFrame` in the browser. */
  schedule?: (fn: () => void) => void
  /** Where the grid's cells are. Default: `document`. */
  root?: ParentNode | null
  /** The focused element now. Default: `document.activeElement`. */
  active?: () => Element | null
}

/**
 * After "Add rows": the grid's cursor and the browser's focus go to the FIRST new row's SKU cell, scrolled into view, so
 * the person types the SKU at once (Enter or F2 edits it too). Waits for the grid to hold the row (a collapsed parent
 * or band is opened), then for AG to draw the cell — AG moves the browser's focus only into a drawn cell (the reason
 * `landOnCell` waits too). Gives up quietly after `NEW_ROW_FOCUS_FRAMES`.
 */
export function focusNewRow(api: NewRowFocusApi, rowId: string, options: FocusNewRowOptions = {}): void {
  const colId = options.colId ?? IDENTITY_SKU_COLUMN
  const later = options.schedule ?? ((fn: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : setTimeout(fn, 16)))
  const root = options.root === undefined ? (typeof document !== 'undefined' ? document : null) : options.root
  const active = options.active ?? (() => (typeof document !== 'undefined' ? document.activeElement : null))
  const drawn = () => !!root?.querySelector(`.ag-row[row-id="${rowId.replace(/["\\]/g, '\\$&')}"] .ag-cell[col-id="${colId}"]`)
  const attempt = (frame: number) => later(() => {
    if (api.isDestroyed() || !focusMayMove(active())) return
    const node = api.getRowNode(rowId)
    if (node) for (const ancestor of collapsedAncestors(node)) ancestor.setExpanded?.(true)
    if (!node || node.rowIndex == null) { if (frame < NEW_ROW_FOCUS_FRAMES) attempt(frame + 1); return }
    // Drawn BEFORE the cursor is set, or once more on the next frame: only a drawn cell takes the browser's focus.
    const wasDrawn = drawn()
    api.ensureIndexVisible(node.rowIndex)
    api.ensureColumnVisible(colId, 'auto')
    api.setFocusedCell(node.rowIndex, colId)
    if (!wasDrawn && frame < NEW_ROW_FOCUS_FRAMES) attempt(frame + 1)
  })
  attempt(1)
}

/** "Add rows" (the button, or a menu item; mouse or keyboard): the rows, then the focus on the first one's SKU cell. */
export function addRowsAndFocus(store: NewRowsStore, kind: NewRowKind, count: number, api: NewRowFocusApi | null | undefined,
  focus: (api: NewRowFocusApi, rowId: string) => void = focusNewRow): NewRow[] {
  const added = store.add(kind, count)
  if (added[0] && api) focus(api, added[0].id)
  return added
}

export interface UseNewRowsOptions extends Omit<NewRowsHost, 'api'> {
  /** Which kinds this scope offers: the Shared scope variations; a channel scope variations and listings (aliases). */
  kinds: readonly NewRowKind[]
  api?: NewRowsApi
  /** The studio's scope guard (`useStudioScope().registerScopeChangeGuard`). */
  registerScopeChangeGuard?: (guard: () => boolean) => () => void
  /** The sheet's grid: after "Add rows" the first new row's SKU cell takes the focus (`focusNewRow`). */
  getGridApi?: () => NewRowFocusApi | null | undefined
}

export interface NewRowsHandle {
  rows: readonly NewRow[]
  store: NewRowsStore
  /** Spread into `<NewRowsControl>`. */
  control: {
    kinds: readonly NewRowKind[]
    unavailable: Partial<Record<NewRowKind, string | null>>
    count: number
    onCount: (next: number) => void
    onAdd: (kind: NewRowKind) => void
    onHeld: (reason: string) => void
  }
}

export function useNewRows(options: UseNewRowsOptions): NewRowsHandle {
  const latest = useRef(options)
  latest.current = options
  const [store] = useState(() => new NewRowsStore({
    api: options.api ?? sheetNewRowsApi,
    target: (kind) => latest.current.target(kind),
    skuContext: () => latest.current.skuContext(),
    onCreated: (kinds) => latest.current.onCreated(kinds),
    say: (message, tone) => latest.current.say(message, tone),
  }))
  const rows = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [count, setCount] = useState(ROWS_TO_ADD_DEFAULT)
  const register = options.registerScopeChangeGuard
  useEffect(() => register?.(() => {
    if (!store.busy) return true
    latest.current.say(NEW_ROWS_WORDS.wait, 'warning')
    return false
  }), [register, store])
  const { kinds, target } = options
  const unavailable = Object.fromEntries(kinds.map((kind) => {
    const answer = target(kind)
    return [kind, 'refused' in answer ? answer.refused : null]
  })) as Partial<Record<NewRowKind, string | null>>
  const unavailableKey = kinds.map((kind) => `${kind}:${unavailable[kind] ?? ''}`).join('|')
  const control = useMemo(() => ({
    kinds,
    unavailable,
    count,
    onCount: (next: number) => setCount(clampRowsToAdd(next)),
    onAdd: (kind: NewRowKind) => { addRowsAndFocus(store, kind, count, latest.current.getGridApi?.()) },
    onHeld: (reason: string) => latest.current.say(reason, 'info'),
  // `unavailable` is rebuilt each render: its words are the key.
  }), [kinds.join('|'), unavailableKey, count, store])
  return useMemo(() => ({ rows, store, control }), [rows, store, control])
}
