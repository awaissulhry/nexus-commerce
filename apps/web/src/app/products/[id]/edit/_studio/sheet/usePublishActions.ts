'use client'

/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04), phase P8 — the waiting Status and Action values of one
 * product family, read and written for a sheet.
 *
 * `usePublishActions(productId, destination, { familyId })` reads `GET …/studio/publish-actions` (one channel sheet's
 * destination, or `{}` for every destination of the family), refetches when another sheet or tab changes a value
 * (`listing.publish_action_changed`, carried on the invalidation channel as `listing.updated` with that subtype) or a
 * Publish on this destination moves (`publication.status_changed`), and writes through ONE serial queue:
 *
 *   write(change, listingIds)
 *     1. the cells change AT ONCE (optimistic: who = you, when = now) — only on rows whose options offer the value;
 *     2. PUT with the compare-and-set `expected` map: each row's `setAt` of that column as this sheet last READ it;
 *     3. refused rows and rows someone else changed first go back to the stored value (the outcome says why);
 *     4. one quiet re-read replaces the optimistic values with the stored ones (exact who and when — the next write's
 *        compare-and-set needs the server's own `setAt`).
 *   A failed request reverts every row of the write and reads back (the answer may have been lost after the save).
 *
 * The pure parts — the store, the optimistic value, the waiting counts, the toolbar marks, the operation fence and its
 * one-toast summary — are exported so the shared scope (P9) and the tests use exactly these rules.
 *
 * Delete and relist (simplify, Owner 2026-10-04): a row Nexus deleted (`cell.deleted`) is a row not on the channel
 * (`cell.create`): its Status Active or Inactive lists it again (it counts as "listed again" in the waiting mark), Not
 * listed — its default — keeps it off. Its Action reads Full update, as on every row not on the channel.
 *
 * New listings (Owner 2026-10-04): a row not on the channel yet (`cell.create`) chooses Active / Inactive / Not listed in
 * its Status; its Action reads Full update (sent whole; nothing to set). A channel sheet's read also returns family members with no
 * listing there, with a `new:` listing id: a Status write on one starts the family's drafts (`started`), and the re-read
 * that follows brings the real rows — a sheet row finds its cell by product and listing alias (`publishCellKey`), so the
 * cell carries on without a flash. A choice made on a new row counts as a new listing in the waiting mark ("3 new
 * listings · 1 inactive"), Not listed as "left out".
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { StatusTarget } from '@nexus/shared/listing-actions'
import { NEW_LISTING_SENTENCE, RELIST_SENTENCE, STATUS_TARGET_LABEL, deletedStatusReason, isNewListingTarget } from '@nexus/shared/listing-actions'
import {
  EMPTY_WAITING, SEND_MODE_LABEL, countWaiting, fillResultSentence, waitingMark,
  type PublishActionCell, type PublishActionChange, type PublishActionStarted, type PublishActionWriteResult, type WaitingCounts, type WaitingValue,
} from '@nexus/shared/publish-actions'
import type { SheetStatus } from '@/design-system/grid'
import { isInactiveSellingState } from '@/design-system/grid/renderers/sellingStatus'
import { useAuth } from '@/lib/auth/AuthProvider'
import { emitInvalidation, useInvalidationChannel, type InvalidationEvent } from '@/lib/sync/invalidation-channel'
import { readPublishActions, writePublishActions, type PublishActionsDestination, type PublishActionsRead } from './publishActionsApi'

export type { PublishActionsDestination } from './publishActionsApi'

/** The server's event name; the web carries it as `listing.updated` with this `meta.subtype` (use-listing-events.ts). */
export const PUBLISH_ACTION_EVENT = 'listing.publish_action_changed'

type Column = PublishActionChange['column']
type ColumnValue = PublishActionCell['send'] | PublishActionCell['status']

export type PublishActionsReadState = 'idle' | 'loading' | 'ready' | 'error'

export interface PublishActionsSnapshot {
  /** `ready` once a read answered; a failed RE-read keeps the rows and sets `error`. */
  status: PublishActionsReadState
  error: string | null
  readAt: string | null
  /** The stored rows with this sheet's optimistic values on top. */
  rows: readonly PublishActionCell[]
  byListingId: ReadonlyMap<string, PublishActionCell>
  /**
   * Each row by product and listing alias (`publishCellKey`): how a sheet row with no listing id yet — a new row, or one
   * whose drafts a choice just started — finds its cell.
   */
  byProductKey: ReadonlyMap<string, PublishActionCell>
  /** Moves on every change: a cheap dependency for "repaint the two columns". */
  version: number
}

/** What became of one write. `ok: false` = the request failed (nothing is known to be stored; the sheet read back). */
export interface PublishActionWriteOutcome {
  ok: boolean
  change: PublishActionChange
  requested: string[]
  applied: string[]
  refused: PublishActionWriteResult['refused']
  conflicts: PublishActionWriteResult['conflicts']
  error: string | null
  /** New listings: the drafts this write started ("Started Amazon · IT for GALE and 6 variations."); absent = none. */
  started?: PublishActionStarted | null
  /** The Shared scope's markets without a listing, left out ("1 market without a listing was left out: …"); absent = none. */
  leftOut?: PublishActionWriteResult['leftOut']
}

export interface PublishActionsViewer { id: string | null; name: string | null }

export interface PublishActionsStoreDeps {
  read: (signal: AbortSignal) => Promise<PublishActionsRead>
  write: (change: PublishActionChange, body: { listingIds: readonly string[]; expected: Record<string, string | null> }) => Promise<PublishActionWriteResult>
  viewer: () => PublishActionsViewer
  now?: () => number
}

const EMPTY_MAP: ReadonlyMap<string, PublishActionCell> = new Map()
export const EMPTY_PUBLISH_ACTIONS: PublishActionsSnapshot = Object.freeze({
  status: 'idle', error: null, readAt: null, rows: Object.freeze([]) as readonly PublishActionCell[], byListingId: EMPTY_MAP, byProductKey: EMPTY_MAP, version: 0,
}) as PublishActionsSnapshot

/** A row's key by product and listing alias ('' = the primary listing) on one destination. */
export const publishCellKey = (productId: string, aliasKey: string | null | undefined) => `${productId}|${aliasKey ?? ''}`

/** A row not on the channel (Draft, no listing here, or deleted by Nexus): its Status is a new listing's choice; its Action reads Full update. */
export const isNewCell = (cell: PublishActionCell | null | undefined): cell is PublishActionCell & { create: NonNullable<PublishActionCell['create']> } => !!cell?.create

const cleared = (column: Column): ColumnValue => column === 'send'
  ? { mode: 'partial', setAt: null, setById: null, setByName: null, noLongerApplies: null }
  : { target: null, setAt: null, setById: null, setByName: null, noLongerApplies: null }

/**
 * The value a row shows the moment a change is made — the same decision the server makes (`decide`,
 * publish-action.service.ts): Partial update and "no status change" clear; a value the row's options do not offer
 * changes nothing here (`undefined`: the server refuses it and says why); a Status the listing is already in clears the
 * waiting value; anything else waits, set by the viewer, now.
 */
export function optimisticValue(cell: PublishActionCell, change: PublishActionChange, viewer: PublishActionsViewer, at: string): ColumnValue | undefined {
  if (isNewCell(cell)) {
    // A row not on the channel: its Action reads Full update (choosing it stores nothing; Partial update and Delete are
    // refused by the server); its Status choice is stored as chosen — even the default, so a variation's own choice
    // stands apart from its main row's.
    if (change.column === 'send') return change.mode === 'full' ? { mode: 'full', setAt: null, setById: null, setByName: null, noLongerApplies: null } : undefined
    if (change.target === null) return cleared('status')
    if (!cell.statusOptions.find(o => o.target === change.target)?.offered) return undefined
    return { target: change.target, setAt: at, setById: viewer.id, setByName: viewer.name, noLongerApplies: null }
  }
  if (change.column === 'send') {
    if (change.mode === 'partial') return cleared('send')
    if (!cell.sendOptions.find(o => o.mode === change.mode)?.offered) return undefined
    return { mode: change.mode, setAt: at, setById: viewer.id, setByName: viewer.name, noLongerApplies: null }
  }
  if (change.target === null) return cleared('status')
  const option = cell.statusOptions.find(o => o.target === change.target)
  if (!option?.offered) return undefined
  if (!option.action) return cleared('status')
  return { target: change.target, setAt: at, setById: viewer.id, setByName: viewer.name, noLongerApplies: null }
}

/**
 * A new row's choice after this sheet's own Status value (until the re-read says what the server decided): its own choice,
 * or — cleared — the default (a variation that follows its main product reads the main row's choice after the re-read). A
 * deleted row speaks of listing it again, and its default (Not listed) in the delete's own words.
 */
function createAfter(create: NonNullable<PublishActionCell['create']>, status: PublishActionCell['status'], deleted: PublishActionCell['deleted']): NonNullable<PublishActionCell['create']> {
  // An unlinked row (Item ID control) is never listed as new: it holds Not listed, in the unlink's own words.
  if (deleted?.unlinked) return { ...create, target: 'not_listed', source: 'default', sentence: deletedStatusReason(deleted) }
  const words = deleted ? RELIST_SENTENCE : NEW_LISTING_SENTENCE
  const target = status.target && isNewListingTarget(status.target) ? status.target : null
  if (target) return { ...create, target, source: 'own', sentence: words[target] }
  if (create.source !== 'own') return create
  const sentence = deleted && create.defaultTarget === 'not_listed' ? deletedStatusReason(deleted) : words[create.defaultTarget]
  return { ...create, target: create.defaultTarget, source: 'default', sentence }
}

interface OverlayEntry { value: ColumnValue; seq: number; settledTick: number | null }
const overlayKey = (listingId: string, column: Column) => `${listingId}|${column}`

/**
 * The state behind `usePublishActions`, React-free so it can be tested: the stored rows, this sheet's optimistic
 * values, one serial write queue and the read that settles them.
 */
export class PublishActionsStore {
  private server: PublishActionCell[] | null = null
  private serverById = new Map<string, PublishActionCell>()
  private readAt: string | null = null
  private status: PublishActionsReadState = 'idle'
  private error: string | null = null
  private readonly overlay = new Map<string, OverlayEntry>()
  private seq = 0
  /** Counts settled writes; a read that STARTED after a write settled may drop that write's optimistic values. */
  private tick = 0
  private loadSeq = 0
  private loadController: AbortController | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private snapshot: PublishActionsSnapshot = EMPTY_PUBLISH_ACTIONS
  private version = 0

  constructor(private readonly deps: PublishActionsStoreDeps) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  getSnapshot = (): PublishActionsSnapshot => this.snapshot

  /** The stored row (no optimistic value), as the compare-and-set needs it. */
  stored(listingId: string): PublishActionCell | undefined {
    return this.serverById.get(listingId)
  }

  /**
   * Stop the read in flight (the sheet unmounted, or React's development double effect). Not final: `load()` starts
   * again — StrictMode runs an effect's cleanup and then the effect once more on the SAME store.
   */
  stop(): void {
    this.loadSeq += 1
    this.loadController?.abort()
    this.loadController = null
  }

  private changed(): void {
    this.version += 1
    const rows = (this.server ?? []).map(cell => this.merged(cell))
    const byProductKey = new Map<string, PublishActionCell>()
    for (const row of rows) if (!byProductKey.has(publishCellKey(row.productId, row.aliasKey))) byProductKey.set(publishCellKey(row.productId, row.aliasKey), row)
    this.snapshot = { status: this.status, error: this.error, readAt: this.readAt, rows, byListingId: new Map(rows.map(r => [r.listingId, r])), byProductKey, version: this.version }
    for (const fn of [...this.listeners]) fn()
  }

  private merged(cell: PublishActionCell): PublishActionCell {
    const send = this.overlay.get(overlayKey(cell.listingId, 'send'))
    const status = this.overlay.get(overlayKey(cell.listingId, 'status'))
    if (!send && !status) return cell
    return {
      ...cell,
      ...(send ? { send: send.value as PublishActionCell['send'] } : {}),
      ...(status ? { status: status.value as PublishActionCell['status'] } : {}),
      ...(status && cell.create ? { create: createAfter(cell.create, status.value as PublishActionCell['status'], cell.deleted ?? null) } : {}),
    }
  }

  /** Read again. A newer read supersedes an older one; a failed re-read keeps the rows it had. */
  async load(): Promise<void> {
    const id = ++this.loadSeq
    const startTick = this.tick
    this.loadController?.abort()
    const controller = new AbortController()
    this.loadController = controller
    if (!this.server && this.status !== 'loading') { this.status = 'loading'; this.changed() }
    try {
      const read = await this.deps.read(controller.signal)
      if (id !== this.loadSeq) return
      this.server = read.rows
      this.serverById = new Map(read.rows.map(r => [r.listingId, r]))
      this.readAt = read.readAt
      this.status = 'ready'
      this.error = null
      for (const [key, entry] of this.overlay) if (entry.settledTick !== null && entry.settledTick <= startTick) this.overlay.delete(key)
      this.changed()
    } catch (err) {
      if (id !== this.loadSeq || controller.signal.aborted) return
      this.status = this.server ? 'ready' : 'error'
      this.error = err instanceof Error && err.message ? err.message : 'The Status and Action values could not be read.'
      this.changed()
    }
  }

  private revert(listingIds: Iterable<string>, column: Column, seq: number): void {
    for (const id of listingIds) {
      const key = overlayKey(id, column)
      if (this.overlay.get(key)?.seq === seq) this.overlay.delete(key)
    }
  }

  /** Set (or clear) one column on many rows: optimistic now, sent in turn, settled by one re-read. */
  write(change: PublishActionChange, listingIds: readonly string[]): Promise<PublishActionWriteOutcome> {
    const ids = [...new Set(listingIds)]
    const column = change.column
    const seq = ++this.seq
    const at = new Date(this.deps.now?.() ?? Date.now()).toISOString()
    const viewer = this.deps.viewer()
    for (const id of ids) {
      const cell = this.snapshot.byListingId.get(id) ?? this.serverById.get(id)
      if (!cell) continue
      const value = optimisticValue(cell, change, viewer, at)
      if (value === undefined) continue
      this.overlay.set(overlayKey(id, column), { value, seq, settledTick: null })
    }
    this.changed()

    const run = async (): Promise<PublishActionWriteOutcome> => {
      const base: PublishActionWriteOutcome = { ok: false, change, requested: ids, applied: [], refused: [], conflicts: [], error: null, started: null, leftOut: null }
      if (!ids.length) return { ...base, ok: true }
      const expected: Record<string, string | null> = {}
      for (const id of ids) {
        const stored = this.serverById.get(id)
        if (stored) expected[id] = column === 'send' ? stored.send.setAt : stored.status.setAt
      }
      let result: PublishActionWriteResult
      try {
        result = await this.deps.write(change, { listingIds: ids, expected })
      } catch (err) {
        this.revert(ids, column, seq)
        this.changed()
        // The answer may have been lost after the save: read what is stored.
        await this.load()
        return { ...base, error: err instanceof Error && err.message ? err.message : 'The change could not be saved.' }
      }
      const applied = new Set(result.applied)
      this.revert(ids.filter(id => !applied.has(id)), column, seq)
      this.tick += 1
      for (const id of result.applied) {
        const entry = this.overlay.get(overlayKey(id, column))
        if (entry?.seq === seq) entry.settledTick = this.tick
      }
      this.changed()
      // New listings: the drafts this write started replace the `new:` rows in the re-read (same product, same alias).
      await this.load()
      return { ...base, ok: true, applied: result.applied, refused: result.refused, conflicts: result.conflicts, started: result.started ?? null, leftOut: result.leftOut ?? null }
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }
}

// ── Waiting values, counts and the toolbar marks ─────────────────────────────────────────────────

/**
 * The values a row waits with (a value the listing outgrew — "No longer applies" — is not waiting: Publish skips it). A
 * row not on the channel (new, or deleted by Nexus) has none of its own: its Action reads Full update whatever is stored,
 * and its Status choice is no listing change — it is counted apart (`newChoiceOf`, `isRelistCell`).
 */
export function waitingValuesOf(cell: PublishActionCell | null | undefined): WaitingValue[] {
  if (!cell || cell.create) return []
  const out: WaitingValue[] = []
  if (cell.send.mode !== 'partial' && !cell.send.noLongerApplies && cell.send.setAt)
    out.push({ kind: 'send', value: cell.send.mode, setAt: cell.send.setAt, setById: cell.send.setById, setByName: cell.send.setByName })
  if (cell.status.target && !cell.status.noLongerApplies && cell.status.setAt)
    out.push({ kind: 'status', value: cell.status.target, setAt: cell.status.setAt, setById: cell.status.setById, setByName: cell.status.setByName })
  return out
}

/** A new row's own choice that waits for Publish: it creates the listing (Active, Inactive) or leaves it out; else null. A deleted row: `isRelistCell`. */
export function newChoiceOf(cell: PublishActionCell | null | undefined): 'active' | 'inactive' | 'not_listed' | null {
  if (!isNewCell(cell) || cell.deleted || !cell.status.target || cell.status.noLongerApplies || !cell.status.setAt) return null
  return isNewListingTarget(cell.status.target) ? cell.status.target : null
}

/**
 * A row Nexus deleted that the next Publish lists again: its Status (its own, or its main row's) is Active or Inactive.
 * Never an unlinked row: Publish leaves it out whatever it holds.
 */
export const isRelistCell = (cell: PublishActionCell | null | undefined): boolean => !!cell?.deleted && !cell.deleted.unlinked && !!cell.create && cell.create.target !== 'not_listed'
export const isWaitingCell = (cell: PublishActionCell | null | undefined): boolean => waitingValuesOf(cell).length > 0 || isRelistCell(cell) || newChoiceOf(cell) !== null
export const isInactiveCell = (cell: PublishActionCell | null | undefined): boolean => isInactiveSellingState(cell?.state)

/**
 * The waiting counts of a sheet: the shared ones, plus the deleted rows the next Publish lists again and the new rows
 * someone chose for — `created` new listings (`createdInactive` of them start Inactive) and `leftOut` (Not listed).
 */
export interface SheetWaitingCounts extends WaitingCounts { relist: number; created: number; createdInactive: number; leftOut: number }
export const EMPTY_SHEET_WAITING: SheetWaitingCounts = Object.freeze({ ...EMPTY_WAITING, relist: 0, created: 0, createdInactive: 0, leftOut: 0 }) as SheetWaitingCounts

export function waitingCountsOf(cells: Iterable<PublishActionCell | null | undefined>): SheetWaitingCounts {
  const values: WaitingValue[] = []
  let relist = 0, created = 0, createdInactive = 0, leftOut = 0
  for (const cell of cells) {
    values.push(...waitingValuesOf(cell))
    if (isRelistCell(cell)) relist += 1
    const choice = newChoiceOf(cell)
    if (choice === 'not_listed') leftOut += 1
    else if (choice) { created += 1; if (choice === 'inactive') createdInactive += 1 }
  }
  if (!values.length && !relist && !created && !leftOut) return EMPTY_SHEET_WAITING
  return { ...(values.length ? countWaiting(values) : EMPTY_WAITING), relist, created, createdInactive, leftOut }
}

type MarkCounts = WaitingCounts & Partial<Pick<SheetWaitingCounts, 'relist' | 'created' | 'createdInactive' | 'leftOut'>>

/** Every value that waits for Publish, the rows listed again and the new rows chosen for included. */
export const waitingTotalOf = (counts: MarkCounts): number =>
  counts.full + counts.delete + counts.active + counts.inactive + counts.ended + (counts.relist ?? 0) + (counts.created ?? 0) + (counts.leftOut ?? 0)

/**
 * The shared `waitingMark` with the deleted rows the next Publish lists again and the new rows chosen for: "5 waiting for
 * Publish" ("2 inactive · 1 listed again · 3 new listings (1 inactive) · 1 left out"). Null when nothing waits.
 */
export function sheetWaitingMark(counts: MarkCounts): ReturnType<typeof waitingMark> {
  const relist = counts.relist ?? 0, created = counts.created ?? 0, createdInactive = counts.createdInactive ?? 0, leftOut = counts.leftOut ?? 0
  const mark = waitingMark(counts)
  if (!relist && !created && !leftOut) return mark
  const total = waitingTotalOf(counts)
  const extra = [
    relist ? `${relist.toLocaleString('en')} listed again` : null,
    created ? `${created.toLocaleString('en')} new ${created === 1 ? 'listing' : 'listings'}${createdInactive ? ` (${createdInactive.toLocaleString('en')} inactive)` : ''}` : null,
    leftOut ? `${leftOut.toLocaleString('en')} left out` : null,
  ].filter(Boolean).join(' · ')
  return { label: `${total.toLocaleString('en')} waiting for Publish`, detail: mark ? `${mark.detail} · ${extra}` : extra, danger: mark?.danger ?? false }
}

export const SHOW_THESE_ROWS = 'Show these rows'
export const SHOW_ALL_ROWS = 'Show all rows'

/**
 * The toolbar mark "4 waiting for Publish" (detail "2 inactive · 1 ended · 1 full update"); pressing it shows only
 * those rows. Danger when an End or a Delete waits — a danger mark never folds into "+N" (`SheetStatuses`).
 */
export function waitingStatusMark(counts: MarkCounts, filterOn: boolean, toggle: () => void): SheetStatus | null {
  const mark = sheetWaitingMark(counts)
  if (!mark) return null
  return {
    tone: mark.danger ? 'danger' : 'info', label: mark.label,
    detail: `${mark.detail}. Nothing is sent until you press Publish.`,
    onSelect: toggle, actionLabel: filterOn ? SHOW_ALL_ROWS : SHOW_THESE_ROWS, selected: filterOn,
  }
}

/** The "3 inactive" chip: listings that do not sell here now (the live state, not a waiting value). */
export function inactiveStatusMark(count: number, destinationLabel: string, filterOn: boolean, toggle: () => void): SheetStatus | null {
  if (count < 1) return null
  const one = count === 1
  return {
    tone: 'warning', label: `${count.toLocaleString('en')} inactive`,
    detail: `${one ? '1 listing' : `${count.toLocaleString('en')} listings`} on ${destinationLabel} ${one ? 'is' : 'are'} inactive: buyers cannot buy ${one ? 'it' : 'them'} here. The ${one ? 'listing and its content stay' : 'listings and their content stay'}.`,
    onSelect: toggle, actionLabel: filterOn ? SHOW_ALL_ROWS : SHOW_THESE_ROWS, selected: filterOn,
  }
}

// ── One operation (an edit, a fill, a paste, a reset): staged, then sent as one write per column and value ─────

/**
 * What one cell of an operation asked for: a change, the reason it cannot be one, or nothing to do (`skip`: Full update
 * pasted or filled on a row not on the channel — it already reads Full update; a new row's own Status again).
 */
export type PublishCellInput = { change: PublishActionChange } | { refused: string } | { skip: true }
export const SKIP_CELL: PublishCellInput = Object.freeze({ skip: true }) as PublishCellInput

/**
 * New listings: a Status a new row already holds changes nothing, so it is never written — a paste, a fill or Action ▾
 * of the choice it holds would otherwise store it again and, on a row with no listing yet, start the family's drafts for
 * nothing. (A popup editor closed without a pick no longer writes at all: the DS SelectPanelEditor cancels it.)
 */
export function withoutSameNewChoice(cell: PublishActionCell | null | undefined, input: PublishCellInput): PublishCellInput {
  if (!cell?.create || !('change' in input) || input.change.column !== 'status') return input
  return input.change.target === cell.create.target ? SKIP_CELL : input
}

export interface StagedPublishCell {
  column: Column
  /** Null: the row has no listing on this destination (nothing to store a value on). */
  listingId: string | null
  sku: string
  input: PublishCellInput
}

export interface PublishWriteGroup { change: PublishActionChange; listingIds: string[] }

export const NOT_ON_CHANNEL = 'Not on the channel yet. Publish creates it'

/** The writes an operation makes — one per column and value — and the cells refused before any write. */
export function groupStaged(items: readonly StagedPublishCell[]): { writes: PublishWriteGroup[]; refused: Array<{ column: Column; sku: string; reason: string }> } {
  // The last value a cell received wins (a paste over a fill in the same operation).
  const last = new Map<string, StagedPublishCell>()
  const refused: Array<{ column: Column; sku: string; reason: string }> = []
  for (const item of items) {
    if ('skip' in item.input) continue
    if ('refused' in item.input) { refused.push({ column: item.column, sku: item.sku, reason: item.input.refused }); continue }
    if (!item.listingId) { refused.push({ column: item.column, sku: item.sku, reason: NOT_ON_CHANNEL }); continue }
    last.set(`${item.column}|${item.listingId}`, item)
  }
  const groups = new Map<string, PublishWriteGroup>()
  for (const item of last.values()) {
    const change = (item.input as { change: PublishActionChange }).change
    const key = JSON.stringify(change)
    const group = groups.get(key) ?? { change, listingIds: [] }
    group.listingIds.push(item.listingId!)
    groups.set(key, group)
  }
  // Status before Action, so the toast reads in the columns' order.
  const writes = [...groups.values()].sort((a, b) => (a.change.column === b.change.column ? 0 : a.change.column === 'status' ? -1 : 1))
  return { writes, refused }
}

export function changeLabel(change: PublishActionChange): string {
  return change.column === 'send' ? SEND_MODE_LABEL[change.mode] : change.target ? STATUS_TARGET_LABEL[change.target as StatusTarget] : 'No status change'
}

/**
 * "Inactive set on 18 rows. 3 not allowed: GALE-S (…)…" — and for a reset of the Status, "Waiting status cleared on 3
 * rows." New listings: the drafts a choice started ("Started Amazon · IT for GALE and 6 variations.") and the Shared
 * scope's markets left out follow the head.
 */
export function operationSentence(change: PublishActionChange, result: Pick<PublishActionWriteResult, 'applied' | 'refused' | 'conflicts'> & Partial<Pick<PublishActionWriteResult, 'started' | 'leftOut'>>): string {
  const sentence = fillResultSentence(changeLabel(change), result)
  return change.column === 'status' && change.target === null ? sentence.replace(/^No status change set on /, 'Waiting status cleared on ') : sentence
}

/**
 * The ONE toast of an operation: a sentence per write ("Inactive set on 18 rows. 3 not allowed: …"), cells refused
 * before any write folded into their column's first sentence, and the tone of the worst result. `quiet` = a single
 * cell that simply took its value: the cell says so itself, no toast.
 */
export function operationToast(outcomes: readonly PublishActionWriteOutcome[], refusedEarly: ReadonlyArray<{ column: Column; sku: string; reason: string }>):
  { message: string; tone: 'success' | 'warning' | 'danger'; quiet: boolean } | null {
  const sentences: string[] = []
  let tone: 'success' | 'warning' | 'danger' = 'success'
  const early = new Map<Column, Array<{ listingId: string; sku: string; reason: string }>>()
  for (const r of refusedEarly) early.set(r.column, [...(early.get(r.column) ?? []), { listingId: '', sku: r.sku, reason: r.reason }])
  let touched = 0
  for (const outcome of outcomes) {
    const extra = early.get(outcome.change.column) ?? []
    early.delete(outcome.change.column)
    if (!outcome.ok) {
      tone = 'danger'
      sentences.push(`${changeLabel(outcome.change)} was not saved: ${outcome.error ?? 'the request failed'}${/[.!?]$/.test(outcome.error ?? '') ? '' : '.'}`)
      continue
    }
    const refused = [...extra, ...outcome.refused]
    if ((refused.length || outcome.conflicts.length) && tone !== 'danger') tone = 'warning'
    touched += outcome.applied.length + refused.length + outcome.conflicts.length
    // A started draft or a market left out is always said, even after one cell.
    if (outcome.started || outcome.leftOut?.count) touched += 2
    sentences.push(operationSentence(outcome.change, { applied: outcome.applied, refused, conflicts: outcome.conflicts, started: outcome.started, leftOut: outcome.leftOut }))
  }
  for (const [column, refused] of early) {
    if (tone !== 'danger') tone = 'warning'
    touched += refused.length
    const head = column === 'status' ? 'Status' : 'Action'
    sentences.push(`${head}: nothing set. ${refused.length.toLocaleString('en')} not allowed: ${refused.slice(0, 3).map(r => `${r.sku} (${r.reason})`).join('; ')}${refused.length > 3 ? '; …' : ''}.`)
  }
  if (!sentences.length) return null
  return { message: sentences.join(' '), tone, quiet: tone === 'success' && touched <= 1 }
}

/**
 * The operation fence of the two columns: an edit, a fill or a paste stages its cells, and they leave together when
 * the grid says the operation ended (`onFillEnd`, `onPasteEnd`, …) — on the next turn, after AG reported every cell.
 * Outside a fence (one edit in the editor) the staged cells leave on the next turn. A fence that never closes opens
 * itself after `maxMs`, so a lost end event cannot hold values forever.
 */
export class PublishActionFence {
  private depth = 0
  private items: StagedPublishCell[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private guard: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly flush: (items: StagedPublishCell[]) => void, private readonly maxMs = 3000) {}

  begin(): void { this.depth += 1 }

  end(): void {
    if (this.depth > 0) this.depth -= 1
    if (this.depth === 0) this.later()
  }

  stage(item: StagedPublishCell): void {
    this.items.push(item)
    if (this.depth === 0) { this.later(); return }
    if (!this.guard) this.guard = setTimeout(() => { this.guard = null; this.depth = 0; this.later() }, this.maxMs)
  }

  private later(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.depth > 0) return
      if (this.guard) { clearTimeout(this.guard); this.guard = null }
      const items = this.items.splice(0)
      if (items.length) this.flush(items)
    }, 0)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.guard) clearTimeout(this.guard)
    this.items = []
  }
}

// ── The hook ─────────────────────────────────────────────────────────────────────────────────────

export interface UsePublishActions extends PublishActionsSnapshot {
  /** Set (or clear) one column on these rows. Never throws: the outcome says what was stored, refused or lost. */
  write: (change: PublishActionChange, listingIds: readonly string[]) => Promise<PublishActionWriteOutcome>
  /** Read again now. */
  reload: () => Promise<void>
  /** Every waiting value of the rows read (outgrown values not counted), and the deleted rows listed again. */
  waiting: SheetWaitingCounts
  /** `waitingMark(waiting)`: "4 waiting for Publish" + detail + danger, or null. */
  mark: ReturnType<typeof waitingMark>
}

export interface UsePublishActionsOptions {
  /** The family's main product: the server announces changes under its id. */
  familyId?: string | null
}

const noopSubscribe = () => () => undefined
const emptySnapshot = () => EMPTY_PUBLISH_ACTIONS

/** Does this invalidation concern these rows? Own writes are not read twice (the store already re-read). */
export function publishActionEventMatches(event: InvalidationEvent, productIds: ReadonlySet<string>, destination: PublishActionsDestination, ownOrigin: string): boolean {
  const meta = (event.meta ?? {}) as Record<string, unknown>
  const product = typeof meta.productId === 'string' ? meta.productId : event.id
  if (!product || !productIds.has(product)) return false
  if (event.type === 'listing.updated') return meta.subtype === PUBLISH_ACTION_EVENT && meta.origin !== ownOrigin
  if (event.type === 'publication.status_changed') {
    // A Publish settles waiting values (and moves the live state): read again for this destination.
    if (destination.channel && typeof meta.channel === 'string' && meta.channel.toUpperCase() !== destination.channel.toUpperCase()) return false
    if (destination.marketplace && typeof meta.marketplace === 'string' && meta.marketplace.toUpperCase() !== destination.marketplace.toUpperCase()) return false
    return true
  }
  return false
}

/**
 * The waiting values of `productId`'s family on `destination` (`null` = read nothing yet; `{}` = every destination).
 * See the file header for the write contract.
 */
export function usePublishActions(productId: string, destination: PublishActionsDestination | null, options: UsePublishActionsOptions = {}): UsePublishActions {
  const auth = useAuth()
  const viewer = useRef<PublishActionsViewer>({ id: null, name: null })
  viewer.current = { id: auth.user?.id ?? null, name: auth.user?.displayName ?? null }
  // Random, not `useId`: two tabs on the same page would draw the same `useId`, and a tab must not take another tab's
  // write for its own.
  const [origin] = useState(() => `pa-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`)

  const key = destination ? JSON.stringify({
    channel: destination.channel ?? null, marketplace: destination.marketplace ?? null,
    accountId: destination.accountId ?? null, aliasKey: destination.aliasKey ?? null,
  }) : null
  const target = useMemo(() => (key ? JSON.parse(key) as PublishActionsDestination : null), [key])

  const store = useMemo(() => target ? new PublishActionsStore({
    read: signal => readPublishActions(productId, target, signal),
    // No channel = the Shared scope (every market of the family).
    write: (change, body) => writePublishActions(productId, change, { ...body, sharedScope: !target.channel }),
    viewer: () => viewer.current,
  }) : null, [productId, target])

  useEffect(() => {
    if (!store) return
    void store.load()
    return () => store.stop()
  }, [store])

  const snapshot = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getSnapshot ?? emptySnapshot, emptySnapshot)

  const productIds = useMemo(() => new Set([productId, ...(options.familyId ? [options.familyId] : []), ...snapshot.rows.map(r => r.productId)]),
    [productId, options.familyId, snapshot.rows])
  const live = useRef({ productIds, target, store })
  live.current = { productIds, target, store }

  // A burst of events (a fill in another tab, a Publish settling many rows) reads ONCE.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useInvalidationChannel(['listing.updated', 'publication.status_changed'], useCallback((event: InvalidationEvent) => {
    const { productIds, target, store } = live.current
    if (!store || !target || !publishActionEventMatches(event, productIds, target, origin)) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = null; void live.current.store?.load() }, 250)
  }, [origin]))

  const write = useCallback(async (change: PublishActionChange, listingIds: readonly string[]): Promise<PublishActionWriteOutcome> => {
    const current = live.current.store
    if (!current) return { ok: false, change, requested: [...listingIds], applied: [], refused: [], conflicts: [], error: 'The sheet is still loading. Try again in a moment.' }
    const outcome = await current.write(change, listingIds)
    if (outcome.applied.length) {
      // Other tabs and other sheets of this family read again; the server's own event follows on the stream.
      const family = options.familyId ?? productId
      emitInvalidation({ type: 'listing.updated', id: family, meta: { source: 'publish-actions', subtype: PUBLISH_ACTION_EVENT, productId: family,
        listingIds: outcome.applied, column: change.column, origin } })
    }
    return outcome
  }, [options.familyId, productId, origin])

  const reload = useCallback(async () => { await live.current.store?.load() }, [])
  const waiting = useMemo(() => waitingCountsOf(snapshot.rows), [snapshot.rows])
  const mark = useMemo(() => sheetWaitingMark(waiting), [waiting])
  return useMemo(() => ({ ...snapshot, write, reload, waiting, mark }), [snapshot, write, reload, waiting, mark])
}
