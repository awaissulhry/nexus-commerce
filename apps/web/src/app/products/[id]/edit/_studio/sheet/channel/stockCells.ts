/**
 * Amazon sheet gaps (gaps 4–5) — the product sheet's Mode / Qty / Buffer cells write through the MATRIX DOOR.
 *
 * A stock cell is the Matrix's own cell (`row.stock.cells`, `studio-stock.ts` on the API), so its edit is the Matrix
 * write cell — `rowId`, `coordinateKey`, `cell`, the value, the listing's version and the listing the sheet saw — decided
 * by the engine's ONE routing branch (`matrixWrite`) and sent to `PATCH …/studio/matrix` (`patchMatrix`): the same
 * route, door, CAS and refusal sentences as the Matrix tab. The bulk route never sees these cells.
 *
 *   - batch: every stock cell committed in one tick for one family leaves as ONE `patchMatrix`; a second cell on the
 *     same listing (Mode + Qty pasted in one row) follows in a next round at the version the first answered with;
 *   - answer: applied / noop → saved; refused → the door's sentence, verbatim, and the cell shows the stored value
 *     again (the Matrix's rule, `matrix/refusals.ts`); conflict → "Changed elsewhere — reloaded", never retried;
 *   - after an applied or conflicting write: every row adopts the versions the door answered with (an Amazon EU cell
 *     moves every EU row; each row takes its own listing's), ONE Matrix read refreshes the family's stock and ASIN cells,
 *     and other windows hear `listing.values_changed` (source `local`).
 *
 * Pure except the two network calls, which are injectable (`StockWriteDeps`) so the node suite drives it.
 */
import {
  MATRIX_UNCHANGED,
  matrixApplyValue,
  matrixCellValue,
  matrixWrite,
  type SheetWriteRequest,
  type SheetWriteResult,
} from '@/design-system/grid'
import { sameValue } from '@/design-system/grid/editors/writeGate'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

import {
  MATRIX_COPY,
  type MatrixCells,
  type MatrixListingVersion,
  type MatrixRead,
  type MatrixWriteCell,
  type MatrixWriteOutcome,
  type MatrixWriteResult,
} from '../../matrix/contract'
import { fetchMatrix, patchMatrix, type MatrixSource } from '../../matrix/source'
import type { ChannelSheetRow, SheetColumn, StockControlCell, StudioCellValue } from './types'

/** The three stock columns (API `STUDIO_STOCK_KEYS`) and the ASIN column (API `LISTING_ASIN_KEY`). */
export const STOCK_COLUMN_KEYS = ['stock_mode', 'stock_qty', 'stock_buffer'] as const
export type StockColumnKey = (typeof STOCK_COLUMN_KEYS)[number]
export const LISTING_ASIN_KEY = 'listing_asin'
/** The cells a Matrix read refreshes on a sheet row. */
export const STOCK_REFRESH_COLUMNS: readonly string[] = [...STOCK_COLUMN_KEYS, LISTING_ASIN_KEY]

/** The Matrix cell behind each stock column, when the column itself does not say (`SheetColumn.matrixCell`). */
export const STOCK_CELL_OF: Readonly<Record<StockColumnKey, StockControlCell>> = { stock_mode: 'syncMode', stock_qty: 'syncQty', stock_buffer: 'syncBuffer' }

export function stockCellOf(col: Pick<SheetColumn, 'key' | 'matrixCell'> | undefined, colId: string): StockControlCell | null {
  return col?.matrixCell ?? STOCK_CELL_OF[colId as StockColumnKey] ?? null
}

/** The `listing.values_changed` fields a stock cell moves — the words the server's write services announce with. */
const FIELDS_OF: Readonly<Record<StockControlCell, readonly string[]>> = {
  syncMode: ['quantityMode', 'quantity'], syncQty: ['quantityMode', 'quantity'], syncBuffer: ['stockBuffer', 'quantity'],
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const cellKey = (c: Pick<MatrixWriteCell, 'rowId' | 'coordinateKey' | 'cell'>) => `${c.rowId}|${c.coordinateKey}|${c.cell}`
const listingKey = (c: Pick<MatrixWriteCell, 'rowId' | 'coordinateKey'>) => `${c.rowId}|${c.coordinateKey}`

/* ── the edit on screen: a copy, and the stored cells kept until the save settles ─────────────────────────────────── */

/** A row's stock cells as stored, while an edit of them is on screen and not settled. */
const storedCells = new WeakMap<object, MatrixCells>()

/**
 * The column's `applyValue` (`matrixColumnDef`): the typed value goes into a COPY of the row's cells, so the stored
 * cells stay available — a refusal shows them again, and the write is compared against them. An unchanged value
 * touches nothing.
 */
export function applyStockValue(row: ChannelSheetRow, kind: string, value: unknown): void {
  const stock = row.stock
  const cells = stock?.cells
  if (!stock || !cells) return
  const cell = kind as StockControlCell
  const before = matrixCellValue(cell, cells)
  const next = clone(cells)
  if (!matrixApplyValue(next, cell, value) || sameValue(before, matrixCellValue(cell, next))) return
  if (!storedCells.has(row)) storedCells.set(row, cells)
  row.stock = { ...stock, cells: next }
}

/** An edit of this row's stock cells is on screen and its save has not settled. */
export const stockEditPending = (row: object): boolean => storedCells.has(row)

function restoreStoredCells(row: ChannelSheetRow): void {
  const stored = storedCells.get(row)
  if (stored && row.stock) row.stock = { ...row.stock, cells: stored }
  storedCells.delete(row)
}

/* ── listing versions this browser learned from the door ──────────────────────────────────────────────────────────── */

/** listingId → the newest version a write answered with (an EU write names markets the sheet does not show). */
const learnedVersions = new Map<string, number>()

export function rememberListingVersions(listings: ReadonlyArray<Pick<MatrixListingVersion, 'listingId' | 'version'>>): void {
  for (const l of listings) learnedVersions.set(l.listingId, Math.max(learnedVersions.get(l.listingId) ?? -1, l.version))
}

/** Every listing version the sheet holds — its rows' listings and stock cells — and every one a write answered with. */
export function knownListingVersions(rows: Iterable<ChannelSheetRow>): Map<string, number> {
  const out = new Map(learnedVersions)
  const keep = (id: string | null | undefined, version: number | undefined) => {
    if (id && typeof version === 'number') out.set(id, Math.max(out.get(id) ?? -1, version))
  }
  for (const row of rows) {
    keep(row.listing?.id, row.listing?.version)
    keep(row.stock?.cells?.listingId, row.stock?.cells?.version)
  }
  return out
}

/* ── the write cell ───────────────────────────────────────────────────────────────────────────────────────────────── */

export type StockCellDecision = { send: true; cell: MatrixWriteCell } | { send: false; ok: boolean; reason?: string }

/**
 * What one stock cell edit sends — the engine's routing branch (`matrixWrite`) on this row's cells, plus the listing
 * the sheet saw (`expectedListingId`). Exactly the API's `sheetStockWriteCell`. A held row answers its own sentence.
 */
export function stockWriteCell(row: ChannelSheetRow, colId: string, cell: StockControlCell, value: unknown): StockCellDecision {
  const stock = row.stock
  const cells = stock?.cells ?? null
  if (!stock || !cells?.listingId) {
    const held = row.values?.[colId]?.writeBlockedReason
    return { send: false, ok: false, reason: held || MATRIX_COPY.noListingYet }
  }
  const before = matrixCellValue(cell, storedCells.get(row) ?? cells)
  const decision = matrixWrite({ kind: cell, coordinateKey: stock.key, rowId: row.id }, cells, before, value)
  if (!decision.send) return decision.reason === MATRIX_UNCHANGED ? { send: false, ok: true } : { send: false, ok: false, reason: decision.reason }
  return { send: true, cell: { ...decision.cell, expectedListingId: cells.listingId } }
}

/* ── one tick, one family, one door call ──────────────────────────────────────────────────────────────────────────── */

export interface StockWriteDeps {
  patch: (productId: string, cells: readonly MatrixWriteCell[], opts: { accountId?: string | null }) => Promise<MatrixWriteResult>
  read: (productId: string, opts: { accountId?: string | null }) => Promise<MatrixSource>
  /** When the batch leaves: after the current turn, so every row a fill or paste commits joins it. */
  schedule: (run: () => void) => void
  /** Tells the other windows of this browser (`emitInvalidation`). */
  announce: (familyId: string, listings: MatrixListingVersion[], fields: string[]) => void
}

export interface StockBatchAnswer {
  outcomes: MatrixWriteOutcome[]
  /** The family's Matrix after the write; null when nothing moved, or the read failed (`readFailed`). */
  read: MatrixRead | null
  readFailed: boolean
}

interface Waiting { cells: MatrixWriteCell[]; resolve: (a: StockBatchAnswer) => void; reject: (e: unknown) => void }

/**
 * Sends one family's stock cells together. Round 1 carries the first cell of every listing; a further cell on the same
 * listing goes in the next round at the version the previous one answered with (a conflict there ends that listing's
 * cells: the rest answer `conflict` without being sent). Each caller hears only its own cells' outcomes.
 */
export function createStockWriteBatcher(deps: StockWriteDeps) {
  const queues = new Map<string, { familyId: string; accountId: string | null; waiting: Waiting[] }>()

  async function flush(familyId: string, accountId: string | null, waiting: Waiting[]): Promise<void> {
    const all = waiting.flatMap((w) => w.cells)
    const byListing = new Map<string, MatrixWriteCell[]>()
    for (const c of all) byListing.set(listingKey(c), [...(byListing.get(listingKey(c)) ?? []), c])
    const outcomes = new Map<string, MatrixWriteOutcome>()
    const last = new Map<string, MatrixWriteOutcome>()
    const rounds = Math.max(...[...byListing.values()].map((cells) => cells.length))
    try {
      for (let round = 0; round < rounds; round++) {
        const send: MatrixWriteCell[] = []
        for (const [key, cells] of byListing) {
          const c = cells[round]
          if (!c) continue
          const prev = last.get(key)
          if (prev?.outcome === 'conflict') {
            outcomes.set(cellKey(c), { rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: 'conflict', reason: prev.reason ?? MATRIX_COPY.changedElsewhere, version: prev.version })
            continue
          }
          send.push(prev ? { ...c, expectedVersion: prev.version } : c)
        }
        if (send.length === 0) continue
        const result = await deps.patch(familyId, send, { accountId })
        for (const c of send) {
          const o = result.results.find((r) => cellKey(r) === cellKey(c))
            ?? { rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: 'refused' as const, reason: 'The Matrix answered without this cell', version: c.expectedVersion }
          outcomes.set(cellKey(c), o)
          last.set(listingKey(c), o)
        }
      }
    } catch (err) {
      for (const w of waiting) w.reject(err)
      return
    }
    const answered = [...outcomes.values()]
    const listings = movedListings(answered)
    rememberListingVersions(listings)
    let read: MatrixRead | null = null
    let readFailed = false
    if (answered.some((o) => o.outcome === 'applied' || o.outcome === 'conflict')) {
      const got = await deps.read(familyId, { accountId }).catch(() => null)
      if (got?.kind === 'live') read = got.read
      else readFailed = true
    }
    if (listings.length) {
      const fields = [...new Set(answered.filter((o) => o.outcome === 'applied').flatMap((o) => FIELDS_OF[o.cell as StockControlCell] ?? []))]
      if (fields.length) deps.announce(familyId, listings, fields)
    }
    for (const w of waiting) {
      w.resolve({ outcomes: w.cells.map((c) => outcomes.get(cellKey(c))!).filter(Boolean), read, readFailed })
    }
  }

  return {
    send(familyId: string, accountId: string | null, cells: MatrixWriteCell[]): Promise<StockBatchAnswer> {
      const key = `${familyId}|${accountId ?? ''}`
      return new Promise<StockBatchAnswer>((resolve, reject) => {
        const queued = queues.get(key)
        if (queued) { queued.waiting.push({ cells, resolve, reject }); return }
        queues.set(key, { familyId, accountId, waiting: [{ cells, resolve, reject }] })
        deps.schedule(() => {
          const q = queues.get(key)
          queues.delete(key)
          if (q) void flush(q.familyId, q.accountId, q.waiting)
        })
      })
    },
  }
}

/** Every listing an answer moved, at its version after the write (an EU cell: every EU row). Newest version wins. */
export function movedListings(outcomes: readonly MatrixWriteOutcome[]): MatrixListingVersion[] {
  const out = new Map<string, MatrixListingVersion>()
  for (const o of outcomes) for (const l of o.listings ?? []) {
    const had = out.get(l.listingId)
    if (!had || had.version < l.version) out.set(l.listingId, l)
  }
  return [...out.values()]
}

export const DEFAULT_STOCK_WRITE_DEPS: StockWriteDeps = {
  patch: (productId, cells, opts) => patchMatrix(productId, cells, opts),
  read: (productId, opts) => fetchMatrix(productId, opts),
  schedule: (run) => { setTimeout(run, 0) },
  announce: (familyId, listings, fields) => emitInvalidation({
    type: 'listing.values_changed', id: familyId, fields, meta: { source: 'local', productId: familyId, listings, fields },
  }),
}

/** One batcher per set of deps: every row committed in one tick with the same deps joins the same batch. */
const batchers = new WeakMap<StockWriteDeps, ReturnType<typeof createStockWriteBatcher>>()
function batcherFor(deps: StockWriteDeps): ReturnType<typeof createStockWriteBatcher> {
  let batcher = batchers.get(deps)
  if (!batcher) { batcher = createStockWriteBatcher(deps); batchers.set(deps, batcher) }
  return batcher
}

/* ── the answer, onto the rows ────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Adopt the versions a write answered with: every row whose listing — or whose stock cells' listing — moved takes that
 * listing's new version (an EU cell moves every EU row; each row takes its own listing's). Returns the rows it changed.
 */
export function adoptListingVersions(rows: Iterable<ChannelSheetRow>, listings: readonly MatrixListingVersion[]): ChannelSheetRow[] {
  const version = new Map(listings.map((l) => [l.listingId, l.version]))
  const changed: ChannelSheetRow[] = []
  for (const row of rows) {
    let moved = false
    const own = row.listing ? version.get(row.listing.id) : undefined
    if (row.listing && own !== undefined && row.listing.version < own) { row.listing.version = own; moved = true }
    const cells = row.stock?.cells
    const stockVersion = cells?.listingId ? version.get(cells.listingId) : undefined
    if (cells && stockVersion !== undefined && cells.version < stockVersion) {
      cells.version = stockVersion
      const stored = storedCells.get(row)
      if (stored && stored.listingId === cells.listingId) stored.version = stockVersion
      moved = true
    }
    if (moved) changed.push(row)
  }
  return changed
}

/** A stock column's cell value from its Matrix cells: the API's `attachStudioStock` values, from the same facts. */
function stockCellValue(prev: StudioCellValue, cells: MatrixCells, cell: StockControlCell): StudioCellValue {
  const writable = cells.writable[cell] === true
  const value = cell === 'syncMode' ? cells.sync?.mode ?? null : cell === 'syncQty' ? cells.sync?.intended ?? null : cells.sync?.buffer ?? null
  return { ...prev, value, editable: writable, writable, writeBlockedReason: writable ? null : cells.writeBlockedReason[cell] ?? 'This cell cannot be changed here' }
}

export interface StockPatchResult {
  /** The rows whose stock or ASIN cells now show the read. */
  changed: ChannelSheetRow[]
  /** Rows the read shows with another listing than the sheet holds: only a full read can place them. */
  mismatched: ChannelSheetRow[]
  /** Rows left alone (`skip`): an editor open, or a save of their own in flight. */
  skipped: ChannelSheetRow[]
}

/**
 * Lay a Matrix read over the sheet's rows, in place: each row's stock cells (`row.stock.cells`, its values) and its ASIN.
 * A held row (no cells) stays held; a row whose listing the read does not hold is reported, never overwritten.
 */
export function patchStockRows(rows: Iterable<ChannelSheetRow>, read: MatrixRead, skip: (row: ChannelSheetRow) => boolean = () => false): StockPatchResult {
  const byId = new Map(read.rows.map((r) => [r.id, r]))
  const coordinate = new Map(read.coordinates.map((c) => [c.key, c]))
  const out: StockPatchResult = { changed: [], mismatched: [], skipped: [] }
  for (const row of rows) {
    const stock = row.stock
    const held = stock?.cells
    if (!stock || !held) continue
    const matrixRow = byId.get(row.id)
    const fresh = matrixRow?.cells[stock.key]
    if (!fresh || fresh.listingId !== held.listingId) { out.mismatched.push(row); continue }
    const market = matrixRow?.cells[stock.marketKey]
    const asin = row.listing && market?.listingId === row.listing.id && market.listing ? market.listing.externalId ?? null : undefined
    const asinMoved = asin !== undefined && (row.listing?.externalListingId ?? null) !== asin
    if (sameValue(fresh, held) && !asinMoved) continue
    if (skip(row)) { out.skipped.push(row); continue }
    const cells = clone(fresh)
    row.stock = { ...stock, cells, coordinate: coordinate.get(stock.key) ?? stock.coordinate }
    const values = { ...row.values }
    for (const key of STOCK_COLUMN_KEYS) if (values[key]) values[key] = stockCellValue(values[key], cells, STOCK_CELL_OF[key])
    if (asinMoved && row.listing) {
      row.listing.externalListingId = asin
      if (values[LISTING_ASIN_KEY]) values[LISTING_ASIN_KEY] = { ...values[LISTING_ASIN_KEY], value: asin }
    }
    row.values = values
    out.changed.push(row)
  }
  return out
}

/* ── one row's stock cells through the door ───────────────────────────────────────────────────────────────────────── */

/** What the commit needs from the sheet (a subset of `ChannelWriteCoord`). */
export interface StockWriteCoord {
  accountId?: string
  familyRows?: () => Iterable<ChannelSheetRow>
  columnOf?: (colId: string) => SheetColumn | undefined
  onFamilyChanged?: (rows: ChannelSheetRow[], columns?: string[]) => void
  onStored?: (outcome: { patched: ChannelSheetRow[]; columns: string[] } | { read: string }) => void
}

export const STOCK_READ_FAILED = 'The Matrix could not be read after this save'

/** The words of one outcome on its cell. */
export function stockOutcomeResult(o: MatrixWriteOutcome): { ok: boolean; reason?: string } {
  if (o.outcome === 'applied' || o.outcome === 'noop') return { ok: true }
  if (o.outcome === 'conflict') return { ok: false, reason: o.reason || MATRIX_COPY.changedElsewhere }
  return { ok: false, reason: o.reason || 'Refused' }
}

/**
 * Send ONE row's stock cells — the part of `commitChannelRow` a `stockControl` column takes. A refusal is a RESULT; a
 * lost answer is `unreachable` (the sheet writer reconciles it), never a refusal.
 */
export async function commitStockCells(req: SheetWriteRequest<ChannelSheetRow>, coord: StockWriteCoord, deps: StockWriteDeps = DEFAULT_STOCK_WRITE_DEPS): Promise<SheetWriteResult> {
  const row = req.row
  if (!row) return { ok: false, reason: 'The grid no longer holds this row — reload the sheet' }
  const results: NonNullable<SheetWriteResult['cells']> = {}
  const sending: Array<{ colId: string; cell: MatrixWriteCell }> = []
  for (const { colId, value } of req.cells) {
    const kind = stockCellOf(coord.columnOf?.(colId), colId)
    if (!kind) { results[colId] = { ok: false, reason: 'Not a stock column' }; continue }
    const decision = stockWriteCell(row, colId, kind, value)
    if (decision.send) sending.push({ colId, cell: decision.cell })
    else results[colId] = decision.reason ? { ok: decision.ok, reason: decision.reason } : { ok: decision.ok }
  }
  const sentColumns = req.cells.map((c) => c.colId)
  const finish = (conflict = false): SheetWriteResult => {
    const ok = Object.values(results).every((r) => r.ok)
    return { ok, cells: results, ...(conflict ? { conflict: true } : {}), ...(ok ? {} : { reason: Object.values(results).find((r) => !r.ok)?.reason }) }
  }
  if (sending.length === 0) {
    restoreStoredCells(row)
    coord.onStored?.({ patched: [row], columns: sentColumns })
    return finish()
  }

  const familyId = row.parentId ?? row.id
  // The account the sheet's Matrix read resolved this coordinate with — the door reads with the same one.
  const accountId = row.stock?.coordinate?.accountId ?? coord.accountId ?? null
  let answer: StockBatchAnswer
  try {
    answer = await batcherFor(deps).send(familyId, accountId, sending.map((s) => s.cell))
  } catch (err) {
    storedCells.delete(row)
    return { ok: false, unreachable: true, reason: `Connection lost — refresh to check whether this saved. ${err instanceof Error ? err.message : String(err)}` }
  }

  let conflict = false
  for (const { colId, cell } of sending) {
    const o = answer.outcomes.find((x) => cellKey(x) === cellKey(cell))
    results[colId] = o ? stockOutcomeResult(o) : { ok: false, reason: 'The Matrix answered without this cell' }
    if (o?.outcome === 'conflict') conflict = true
  }
  const family = [row, ...[...(coord.familyRows?.() ?? [])].filter((r) => r !== row)]
  adoptListingVersions(family, movedListings(answer.outcomes))
  // A conflict names the listing's CURRENT version: the next edit on this row carries it (the read below replaces it).
  for (const o of answer.outcomes) {
    const cells = row.stock?.cells
    if (o.outcome === 'conflict' && cells && o.rowId === row.id && o.coordinateKey === row.stock?.key && cells.version < o.version) cells.version = o.version
  }

  const moved = answer.outcomes.some((o) => o.outcome === 'applied' || o.outcome === 'conflict')
  if (!moved) {
    // Nothing was written: the cell shows what is stored again, the reason on its hover.
    restoreStoredCells(row)
    coord.onStored?.({ patched: [row], columns: sentColumns })
    return finish(conflict)
  }
  if (!answer.read) {
    storedCells.delete(row)
    coord.onStored?.({ read: STOCK_READ_FAILED })
    return finish(conflict)
  }
  // Other rows with a stock edit of their own still on screen settle from their own answer.
  const patch = patchStockRows(family, answer.read, (r) => r !== row && stockEditPending(r))
  storedCells.delete(row)
  const others = patch.changed.filter((r) => r !== row)
  if (others.length) coord.onFamilyChanged?.(others, [...STOCK_REFRESH_COLUMNS])
  if (patch.mismatched.includes(row)) coord.onStored?.({ read: STOCK_READ_FAILED })
  else coord.onStored?.({ patched: [row], columns: [...new Set([...sentColumns, ...STOCK_REFRESH_COLUMNS.filter((k) => !!row.values?.[k])])] })
  return finish(conflict)
}
