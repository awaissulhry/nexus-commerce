/**
 * MX — the in-memory PREVIEW store: cell writes and verb operations applied to a `MatrixRead`, with versions,
 * compare-and-set and restore-by-value — the same semantics the service will have, so the page's write path is
 * exercised end to end today and swaps to the endpoint without a redesign. Pure: every function returns a new read.
 *
 * Preview-only derivations (a FOLLOW number is pool − buffer) mirror `resolveIntendedQuantity`; in live mode the
 * server's verdict arrives on the wire and nothing here runs.
 */
import {
  type CoordinateKey,
  type MatrixCells,
  type MatrixRead,
  type MatrixWriteCell,
  type MatrixWriteOutcome,
  type MatrixWriteResult,
  type VerbOperation,
  type VerbPreview,
} from './contract'
import { followQty } from './preview'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

function replaceCells(read: MatrixRead, rowId: string, key: CoordinateKey, cells: MatrixCells): MatrixRead {
  return { ...read, rows: read.rows.map(r => (r.id === rowId ? { ...r, cells: { ...r.cells, [key]: cells } } : r)) }
}

/** A region-inventory write lands on every market the group carries (design §3.5). */
function expandedTo(read: MatrixRead, key: CoordinateKey): CoordinateKey[] | undefined {
  const c = read.coordinates.find(x => x.key === key)
  if (!c?.sharedInventoryWith) return undefined
  return c.sharedInventoryWith.map(m => `${c.channel}:${m}`)
}

function applyOne(read: MatrixRead, w: MatrixWriteCell): { read: MatrixRead; outcome: MatrixWriteOutcome } {
  const row = read.rows.find(r => r.id === w.rowId)
  const cells = row?.cells[w.coordinateKey]
  const base = { rowId: w.rowId, coordinateKey: w.coordinateKey, cell: w.cell }
  if (!row || !cells) return { read, outcome: { ...base, outcome: 'refused', reason: 'No listing on this coordinate', version: cells?.version ?? 0 } }
  if (cells.version !== w.expectedVersion) return { read, outcome: { ...base, outcome: 'conflict', reason: 'Changed elsewhere — reloaded', version: cells.version } }
  if (cells.writable[w.cell] !== true) return { read, outcome: { ...base, outcome: 'refused', reason: cells.writeBlockedReason[w.cell] ?? 'This cell cannot be changed here', version: cells.version } }
  const next = clone(cells)
  let changed = false
  switch (w.cell) {
    case 'syncMode': {
      const s = next.sync; if (!s) break
      const mode = w.value === 'PINNED' ? 'PINNED' : w.value === 'FOLLOW' ? 'FOLLOW' : null
      if (!mode) return { read, outcome: { ...base, outcome: 'refused', reason: 'Mode is Follow or Pinned', version: cells.version } }
      if (s.mode === mode) break
      s.mode = mode
      if (mode === 'PINNED') { s.intended = s.held ?? followQty(s) ?? 0; if (s.kind !== 'PAUSED') s.kind = 'PINNED' }
      else { const f = followQty(s); s.intended = f; if (s.kind !== 'PAUSED') s.kind = f == null ? 'UNCOUNTED' : 'FOLLOW' }
      if (s.kind !== 'PAUSED' && s.intended != null) s.held = s.intended
      next.writable.syncBuffer = mode === 'FOLLOW'
      if (mode === 'FOLLOW') delete next.writeBlockedReason.syncBuffer; else next.writeBlockedReason.syncBuffer = 'A pinned listing ignores its buffer — set it to Follow first'
      changed = true; break
    }
    case 'syncQty': {
      const s = next.sync; if (!s) break
      const n = typeof w.value === 'number' ? w.value : Number(w.value)
      if (!Number.isInteger(n) || n < 0) return { read, outcome: { ...base, outcome: 'refused', reason: 'A pinned quantity is a whole number, zero or more', version: cells.version } }
      if (s.mode === 'PINNED' && s.intended === n) break
      /* Typing into a Follow cell PINS it (design D-MX3). */
      s.mode = 'PINNED'; s.intended = n; if (s.kind !== 'PAUSED') { s.kind = 'PINNED'; s.held = n }
      next.writable.syncBuffer = false; next.writeBlockedReason.syncBuffer = 'A pinned listing ignores its buffer — set it to Follow first'
      changed = true; break
    }
    case 'syncBuffer': {
      const s = next.sync; if (!s) break
      const n = typeof w.value === 'number' ? w.value : Number(w.value)
      if (!Number.isInteger(n) || n < 0) return { read, outcome: { ...base, outcome: 'refused', reason: 'A buffer is a whole number, zero or more', version: cells.version } }
      if (s.buffer === n) break
      s.buffer = n
      if (s.mode === 'FOLLOW') { const f = followQty(s); s.intended = f; if (s.kind !== 'PAUSED') { s.kind = f == null ? 'UNCOUNTED' : 'FOLLOW'; s.held = f } }
      changed = true; break
    }
    case 'fulfilment': {
      const f = next.fulfilment; if (!f) break
      const m = w.value === 'FBA' || w.value === 'FBM' || w.value === 'MCF' ? w.value : null
      if (!m) return { read, outcome: { ...base, outcome: 'refused', reason: 'Fulfilment is FBA, FBM or MCF', version: cells.version } }
      if (f.method === m && f.source === 'set') break
      f.method = m; f.source = 'set'; f.guard = m === 'FBA' ? 'FBA' : 'FBM'
      if (next.sync) {
        if (m === 'FBA') { next.sync.kind = 'FBA_EXCLUDED'; next.sync.intended = null; for (const k of ['syncMode', 'syncQty', 'syncBuffer'] as const) { next.writable[k] = false; next.writeBlockedReason[k] = 'Amazon-managed' } }
        else { const fq = followQty(next.sync); next.sync.kind = next.sync.mode === 'PINNED' ? 'PINNED' : fq == null ? 'UNCOUNTED' : 'FOLLOW'; next.sync.intended = next.sync.mode === 'PINNED' ? next.sync.intended ?? fq ?? 0 : fq; next.sync.fbaAtAmazon = null; for (const k of ['syncMode', 'syncQty'] as const) { next.writable[k] = true; delete next.writeBlockedReason[k] } next.writable.syncBuffer = next.sync.mode === 'FOLLOW' }
      }
      changed = true; break
    }
    case 'price': {
      const p = next.price; if (!p) break
      const n = typeof w.value === 'number' ? w.value : Number(w.value)
      if (!Number.isFinite(n) || n < 0) return { read, outcome: { ...base, outcome: 'refused', reason: 'A price is zero or more', version: cells.version } }
      const v = Math.round(n * 100) / 100
      if (p.value === v && p.source === 'override') break
      p.value = v; p.source = 'override'; p.formula = null; p.clamped = null
      changed = true; break
    }
    case 'salePrice': {
      const sale = next.sale; if (!sale) break
      const v = w.value as { value?: number | null; start?: string | null; end?: string | null } | null
      const value = v?.value ?? null
      if (value != null && (!Number.isFinite(value) || value < 0)) return { read, outcome: { ...base, outcome: 'refused', reason: 'A sale price is zero or more', version: cells.version } }
      if (sale.value === value && sale.start === (v?.start ?? null) && sale.end === (v?.end ?? null)) break
      sale.value = value == null ? null : Math.round(value * 100) / 100; sale.start = v?.start ?? null; sale.end = v?.end ?? null
      changed = true; break
    }
  }
  if (!changed) return { read, outcome: { ...base, outcome: 'noop', version: cells.version } }
  next.version = cells.version + 1
  if (next.queue && (w.cell !== 'salePrice')) next.queue = { ...next.queue, state: next.sync?.kind === 'PAUSED' ? 'paused' : next.sync?.kind === 'FBA_EXCLUDED' && w.cell !== 'price' ? 'never' : 'queued', at: new Date().toISOString(), reason: null, syncType: w.cell === 'price' ? 'PRICE_UPDATE' : 'QUANTITY_UPDATE', via: next.sync?.kind === 'PAUSED' ? next.sync.via : null }
  return { read: replaceCells(read, w.rowId, w.coordinateKey, next), outcome: { ...base, outcome: 'applied', version: next.version, expandedTo: expandedTo(read, w.coordinateKey) } }
}

/** The one door: every cell write, in order, each CAS-checked on its own listing version. */
export function applyCells(read: MatrixRead, cells: readonly MatrixWriteCell[]): { read: MatrixRead; result: MatrixWriteResult } {
  let current = read
  const results: MatrixWriteOutcome[] = []
  for (const w of cells) { const r = applyOne(current, w); current = r.read; results.push(r.outcome) }
  return { read: current, result: { results, version: current.version } }
}

/** Run a previewed verb: the preview's changes become cell writes under ONE operation that can be reverted by value. */
export function applyVerb(read: MatrixRead, preview: VerbPreview, now = new Date()): { read: MatrixRead; operation: VerbOperation; results: MatrixWriteOutcome[] } {
  const before: Array<{ rowId: string; coordinateKey: CoordinateKey; cells: MatrixCells }> = []
  const touched = new Set<string>()
  for (const ch of preview.changes) {
    const k = `${ch.rowId}|${ch.coordinateKey}`
    if (touched.has(k)) continue
    touched.add(k)
    const cells = read.rows.find(r => r.id === ch.rowId)?.cells[ch.coordinateKey]
    if (cells) before.push({ rowId: ch.rowId, coordinateKey: ch.coordinateKey, cells: clone(cells) })
  }
  const writes: MatrixWriteCell[] = preview.changes.map(ch => {
    const cells = read.rows.find(r => r.id === ch.rowId)?.cells[ch.coordinateKey]
    const version = cells?.version ?? 0
    switch (ch.cell) {
      case 'price': return { rowId: ch.rowId, coordinateKey: ch.coordinateKey, cell: 'price', value: ch.to, expectedVersion: version }
      case 'syncQty': return { rowId: ch.rowId, coordinateKey: ch.coordinateKey, cell: 'syncQty', value: ch.to, expectedVersion: version }
      case 'syncMode': return { rowId: ch.rowId, coordinateKey: ch.coordinateKey, cell: 'syncMode', value: ch.to, expectedVersion: version }
      case 'syncBuffer': return { rowId: ch.rowId, coordinateKey: ch.coordinateKey, cell: 'syncBuffer', value: ch.to, expectedVersion: version }
      case 'fulfilment': return { rowId: ch.rowId, coordinateKey: ch.coordinateKey, cell: 'fulfilment', value: ch.to, expectedVersion: version }
      default: return { rowId: ch.rowId, coordinateKey: ch.coordinateKey, cell: 'syncMode', value: '__state__', expectedVersion: version }
    }
  })
  /* Pause / resume / push / retry are STATE changes the one door does not spell as a cell value: apply them directly. */
  let current = read
  const results: MatrixWriteOutcome[] = []
  for (const [i, ch] of preview.changes.entries()) {
    const w = writes[i]!
    if (ch.cell === 'syncState') {
      const row = current.rows.find(r => r.id === ch.rowId)
      const cells = row?.cells[ch.coordinateKey]
      if (!cells?.sync) { results.push({ rowId: ch.rowId, coordinateKey: ch.coordinateKey, cell: 'syncMode', outcome: 'refused', reason: 'No inventory on this coordinate', version: cells?.version ?? 0 }); continue }
      const next = clone(cells)
      const s = next.sync!
      if (ch.to === 'PAUSED') { s.kind = 'PAUSED'; s.via = 'LISTING'; s.intended = null; next.queue = { state: 'paused', at: now.toISOString(), reason: null, syncType: null, via: 'LISTING' } }
      else if (ch.from === 'PAUSED') { const f = followQty(s); s.via = null; s.kind = s.mode === 'PINNED' ? 'PINNED' : f == null ? 'UNCOUNTED' : 'FOLLOW'; s.intended = s.mode === 'PINNED' ? s.held : f; if (s.intended != null) s.held = s.intended; next.queue = { state: 'queued', at: now.toISOString(), reason: null, syncType: 'QUANTITY_UPDATE', via: null } }
      else next.queue = { state: 'queued', at: now.toISOString(), reason: null, syncType: 'QUANTITY_UPDATE', via: null }
      next.version = cells.version + 1
      current = replaceCells(current, ch.rowId, ch.coordinateKey, next)
      results.push({ rowId: ch.rowId, coordinateKey: ch.coordinateKey, cell: 'syncMode', outcome: 'applied', version: next.version, expandedTo: expandedTo(current, ch.coordinateKey) })
      continue
    }
    const r = applyOne(current, w); current = r.read; results.push(r.outcome)
  }
  const operation: VerbOperation = {
    id: `op-${now.getTime().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`, verb: preview.verb, appliedAt: now.toISOString(),
    applied: results.filter(r => r.outcome === 'applied').length, refused: results.filter(r => r.outcome !== 'applied').length + preview.refusals.length, before,
  }
  return { read: current, operation, results }
}

/** Restore by VALUE: every cell the operation touched goes back to its captured prior state, version bumped. */
export function revertOperation(read: MatrixRead, op: VerbOperation): MatrixRead {
  let current = read
  for (const b of op.before) {
    const live = current.rows.find(r => r.id === b.rowId)?.cells[b.coordinateKey]
    const restored = { ...clone(b.cells), version: (live?.version ?? b.cells.version) + 1 }
    current = replaceCells(current, b.rowId, b.coordinateKey, restored)
  }
  return current
}
