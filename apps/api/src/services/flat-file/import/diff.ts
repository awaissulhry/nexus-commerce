/**
 * FF2.4 — Per-cell diff engine.
 *
 * Pure function — reads ONLY; writes nothing to DB or any external service.
 *
 * Compares each parsed workbook cell against the current DB state (WorkbookData)
 * and classifies it as one of:
 *
 *   add         — new SKU (not in DB) or Action=ADD row, non-blank file value
 *   update      — file value differs from current DB, DB row unchanged since snapshot
 *   delete      — Action=DELETE row (per in-scope cell), or __CLEAR__ on a non-empty field
 *   no-change   — blank cell OR file value matches current DB value (never emitted)
 *   conflict    — file value differs from DB AND the row changed in DB since snapshot
 *                 (fingerprint mismatch); carries 'Row changed in DB since export' note
 *   out-of-scope— column outside the import scope; diffed + shown greyed but never applied
 *
 * Resolver-aware: governed per-market fields (title, price, quantity, bullets,
 * description) compare against the EFFECTIVE value from resolveEffective(), matching
 * exactly what the operator saw in the exported workbook.
 *
 * Blank cells are the "no-change" sentinel and always produce no-change (never emitted).
 * __CLEAR__ = explicit clear — emits delete if the DB field is non-empty.
 *
 * follows_master control columns (e.g. price_follows_master@IT) are diffed as
 * string 'true'/'false' by reading the listing's follow-flag column directly.
 *
 * Master-sheet (Products) changes go to masterChanges.
 * Channel-sheet changes go to changes.
 * Action=IGNORE rows are skipped entirely.
 */

import type { ParsedWorkbook } from './parse.js'
import type { ScopedColumn } from './scope.js'
import type { WorkbookData } from '../fetch.js'
import { MASTER_FIELDS } from '../registry/master-fields.js'
import { CHANNEL_MARKET_FIELDS } from '../registry/channel-fields.js'
import type { FieldDefinition } from '../registry/types.js'
import { resolveEffective } from '../resolver.js'
import { rowFingerprint } from '../fingerprint.js'

// ── Constants ──────────────────────────────────────────────────────────────────

/** Field classes that are read-only on import — skipped from diff entirely. */
const READONLY_CLS = new Set<string>(['READONLY_SYNCED', 'DERIVED', 'SYSTEM'])

/** Map from sheet name → channel discriminant (mirrors scope.ts). */
const SHEET_CHANNEL: Record<string, string> = {
  Amazon: 'AMAZON',
  eBay: 'EBAY',
  Shopify: 'SHOPIFY',
}

/** Infix used to identify _follows_master control columns. */
const FM_INFIX = '_follows_master@'

// ── Registry lookup tables ────────────────────────────────────────────────────

const MASTER_BY_ID = new Map<string, FieldDefinition>()
for (const f of MASTER_FIELDS) {
  MASTER_BY_ID.set(f.id, f)
}

const CHANNEL_BY_ID = new Map<string, FieldDefinition>()
for (const f of CHANNEL_MARKET_FIELDS) {
  if (!CHANNEL_BY_ID.has(f.id)) CHANNEL_BY_ID.set(f.id, f)
}

// ── Public types ───────────────────────────────────────────────────────────────

export type DiffKind =
  | 'add'
  | 'update'
  | 'delete'
  | 'no-change'
  | 'conflict'
  | 'out-of-scope'

export interface CellChange {
  sku: string
  channel?: string
  market?: string
  column: string
  from: unknown
  to: unknown
  kind: DiffKind
  note?: string
}

export interface ImportDiff {
  /** Channel-sheet CellChanges (in-scope + out-of-scope). */
  changes: CellChange[]
  /** Products-sheet CellChanges (master data). */
  masterChanges: CellChange[]
  stats: {
    adds: number
    updates: number
    deletes: number
    conflicts: number
    outOfScope: number
  }
  actionRows: Array<{ sku: string; action: 'ADD' | 'DELETE' | 'IGNORE' | '' }>
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Normalise a DB value to the same string representation the flat-file parser
 * produces, so file vs DB comparisons are apples-to-apples.
 *
 *   null / undefined → ''
 *   boolean          → 'true' | 'false'
 *   number           → String(n)
 *   array            → joined with the field's arrayDelimiter (default ' | ')
 *   string           → as-is
 */
function toStr(v: unknown, field?: FieldDefinition): string {
  if (v == null) return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) {
    const delim = field?.arrayDelimiter ?? ' | '
    return (v as unknown[]).join(delim)
  }
  return String(v)
}

/**
 * Read a raw source value from a Product row using the field's source spec.
 * Mirrors workbook-generator.ts readSource() so fingerprints are consistent.
 */
function readSource(row: Record<string, unknown>, field: FieldDefinition): unknown {
  if (field.id === 'parent_sku') return row['parent_sku'] ?? ''
  if (field.id === 'hierarchy_level') {
    return row['parent_sku'] ? 'CHILD' : (row['isParent'] ? 'PARENT' : 'STANDALONE')
  }
  const col = field.source.column
  // Dot-path support for nested JSON columns (e.g. 'categoryAttributes.material')
  if (col.indexOf('.') !== -1) {
    return col.split('.').reduce<unknown>((o, k) => {
      if (o == null || typeof o !== 'object') return undefined
      return (o as Record<string, unknown>)[k]
    }, row) ?? ''
  }
  return row[col] ?? ''
}

// ── Fingerprint helpers ───────────────────────────────────────────────────────

/**
 * Compute the current DB fingerprint for a Products row.
 * Uses the identical algorithm as workbook-generator.ts buildProductsSheet().
 */
function computeProductFp(sku: string, product: Record<string, unknown>): string {
  const rowObj: Record<string, unknown> = {}
  for (const f of MASTER_FIELDS) {
    rowObj[f.id] = readSource(product, f)
  }
  return rowFingerprint(sku, 'MASTER', rowObj)
}

/**
 * Compute the current DB fingerprint for a channel sheet row (all markets).
 * Uses the identical algorithm as workbook-generator.ts buildChannelSheet().
 * The fingerprint covers ALL markets for the SKU, matching how the export works.
 */
function computeChannelFp(
  sku: string,
  channel: string,
  markets: string[],
  listingMap: Map<string, Record<string, unknown>>,
): string {
  const rowObj: Record<string, unknown> = {}
  for (const mkt of markets) {
    const listing = listingMap.get(`${sku}@${channel}@${mkt}`) ?? null
    for (const f of CHANNEL_MARKET_FIELDS) {
      const colKey = f.id + '@' + mkt
      const resolved = listing
        ? resolveEffective(listing, f)
        : { value: '', followsMaster: false }
      rowObj[colKey] = resolved.value
      if (f.followMaster) {
        rowObj[f.id + '_follows_master@' + mkt] = String(resolved.followsMaster)
      }
    }
  }
  return rowFingerprint(sku, channel, rowObj)
}

// ── computeDiff ───────────────────────────────────────────────────────────────

/**
 * Compute a per-cell diff between the uploaded workbook and the current DB state.
 *
 * @param wb       Parsed workbook (from parseWorkbook).
 * @param scoped   Scope-classified columns (from classifyColumns(wb, scope)).
 * @param current  Current DB data — products + channel listings (from fetchCatalog).
 * @param opts     Optional snapshot id + fingerprints for conflict detection.
 *                 fingerprints is keyed as 'Products|SKU' / 'Amazon|SKU' etc.
 * @returns        ImportDiff: changes, masterChanges, stats, actionRows.
 */
export function computeDiff(
  wb: ParsedWorkbook,
  scoped: ScopedColumn[],
  current: WorkbookData,
  opts: { snapshotId?: string; fingerprints?: Record<string, string> },
): ImportDiff {
  // ── Build lookup maps ─────────────────────────────────────────────────────

  const productMap = new Map<string, Record<string, unknown>>()
  for (const p of current.products) {
    const sku = String(p['sku'] ?? '')
    if (sku) productMap.set(sku, p)
  }

  // Keyed by `${sku}@${channel}@${market}`
  const listingMap = new Map<string, Record<string, unknown>>()
  for (const [ch, listings] of Object.entries(current.listings)) {
    for (const l of listings) {
      const sku = String(l['sku'] ?? '')
      const market = String(l['marketplace'] ?? '')
      if (sku && market) {
        listingMap.set(`${sku}@${ch}@${market}`, l)
      }
    }
  }

  // ScopedColumn lookup by `${sheet}:${column}`
  const scopeMap = new Map<string, ScopedColumn>()
  for (const sc of scoped) {
    scopeMap.set(`${sc.sheet}:${sc.column}`, sc)
  }

  // Markets per channel from _meta (needed for full-row fingerprint computation)
  const metaMarkets: Record<string, string[]> = wb.meta.markets ?? {}

  // Fingerprint cache: avoid recomputing the same row across multiple cells
  const fpCache = new Map<string, string>()

  // ── Accumulators ──────────────────────────────────────────────────────────

  const changes: CellChange[] = []
  const masterChanges: CellChange[] = []
  const actionRows: ImportDiff['actionRows'] = []

  // ── Process each sheet ────────────────────────────────────────────────────

  for (const [sheetName, sheet] of Object.entries(wb.sheets)) {
    const isProductsSheet = sheetName === 'Products'
    const channel: string | undefined = SHEET_CHANNEL[sheetName]

    for (const row of sheet.rows) {
      const sku = row.cells['sku']?.value ?? ''
      if (!sku) continue

      const rawAction = row.cells['Action']?.value ?? ''
      const action = rawAction as 'ADD' | 'DELETE' | 'IGNORE' | ''

      actionRows.push({ sku, action })

      // IGNORE rows → skip all cells
      if (action === 'IGNORE') continue

      // ── Lazy conflict check for this row ───────────────────────────────
      //
      // Conflict = file value differs from DB AND DB row changed since
      // snapshot (fingerprint mismatch). Only computed on first need.
      let conflictChecked = false
      let rowIsConflict = false

      function checkRowConflict(): boolean {
        if (conflictChecked) return rowIsConflict
        conflictChecked = true

        if (!opts.fingerprints) return (rowIsConflict = false)

        let fpKey: string
        let currentFp: string | undefined

        if (isProductsSheet) {
          fpKey = `Products|${sku}`
          if (!fpCache.has(fpKey)) {
            const p = productMap.get(sku)
            if (p) fpCache.set(fpKey, computeProductFp(sku, p))
          }
          currentFp = fpCache.get(fpKey)
        } else if (channel) {
          fpKey = `${sheetName}|${sku}`
          if (!fpCache.has(fpKey)) {
            const markets = metaMarkets[channel] ?? []
            if (markets.length > 0) {
              fpCache.set(fpKey, computeChannelFp(sku, channel, markets, listingMap))
            }
          }
          currentFp = fpCache.get(`${sheetName}|${sku}`)
        } else {
          return (rowIsConflict = false)
        }

        const snapshotFp = opts.fingerprints![
          isProductsSheet ? `Products|${sku}` : `${sheetName}|${sku}`
        ]
        if (!snapshotFp || !currentFp) return (rowIsConflict = false)
        return (rowIsConflict = snapshotFp !== currentFp)
      }

      // ── Per-cell diff ──────────────────────────────────────────────────

      for (const [header, cell] of Object.entries(row.cells)) {
        // Control columns carry no data to diff
        if (header === 'Action' || header === 'sku') continue

        const sc = scopeMap.get(`${sheetName}:${header}`)
        if (!sc) continue

        const isFollowsMaster = header.indexOf(FM_INFIX) !== -1

        // ── Resolve field definition ───────────────────────────────────

        let field: FieldDefinition | undefined
        if (!isFollowsMaster) {
          const atIdx = header.lastIndexOf('@')
          const fieldId = atIdx !== -1 ? header.slice(0, atIdx) : header
          field = (isProductsSheet || sc.isMaster)
            ? MASTER_BY_ID.get(fieldId)
            : CHANNEL_BY_ID.get(fieldId)
        }

        // Skip readonly fields (DERIVED / READONLY_SYNCED / SYSTEM)
        if (field && READONLY_CLS.has(field.cls)) continue

        // ── Compute current DB "from" value ────────────────────────────

        let fromValue: unknown

        if (isFollowsMaster) {
          // follows_master columns → read the follow flag from the listing
          if (channel && sc.market) {
            const listing = listingMap.get(`${sku}@${channel}@${sc.market}`)
            if (listing) {
              // sc.base has _follows_master stripped by the scope resolver
              const baseField = CHANNEL_BY_ID.get(sc.base)
              if (baseField?.followMaster) {
                const flagVal = listing[baseField.followMaster.followColumn]
                fromValue = flagVal !== false ? 'true' : 'false'
              } else {
                fromValue = 'true' // safe default
              }
            } else {
              fromValue = ''
            }
          } else {
            fromValue = ''
          }
        } else if (field) {
          if (isProductsSheet || sc.isMaster) {
            const p = productMap.get(sku)
            fromValue = p ? readSource(p, field) : undefined
          } else if (channel && sc.market) {
            const listing = listingMap.get(`${sku}@${channel}@${sc.market}`)
            fromValue = listing ? resolveEffective(listing, field).value : undefined
          } else {
            fromValue = undefined
          }
        } else {
          // No field definition and not a follows_master column → skip
          continue
        }

        const fromStr = toStr(fromValue, field)
        const fileValue = cell.value

        // ── Out-of-scope: diff + show greyed, but never apply ──────────

        if (!sc.inScope) {
          // Only emit if the file has a non-blank value that differs from DB
          // (blank = nothing to report; matching = nothing to warn about)
          if (fileValue !== '' && fileValue !== fromStr) {
            const toValue = fileValue === '__CLEAR__' ? '' : fileValue
            const ch: CellChange = {
              sku,
              channel,
              market: sc.market,
              column: header,
              from: fromValue,
              to: toValue,
              kind: 'out-of-scope',
            }
            if (sc.isMaster) masterChanges.push(ch)
            else changes.push(ch)
          }
          continue
        }

        // ── In-scope processing ────────────────────────────────────────

        // Action=DELETE: emit a per-cell delete for every populated DB field.
        // Must come before the blank sentinel so DELETE rows aren't silently skipped
        // (the operator intentionally leaves cells blank on DELETE rows).
        if (action === 'DELETE') {
          if (fromValue !== undefined && fromStr !== '') {
            const ch: CellChange = {
              sku,
              channel,
              market: sc.market,
              column: header,
              from: fromValue,
              to: '',
              kind: 'delete',
            }
            if (sc.isMaster) masterChanges.push(ch)
            else changes.push(ch)
          }
          continue
        }

        // Blank = no-change sentinel; never emit (place after DELETE so blank cells
        // on DELETE rows do not short-circuit the per-field delete logic above)
        if (fileValue === '') continue

        // __CLEAR__: explicit clear → delete kind if DB has a value
        if (fileValue === '__CLEAR__') {
          if (fromStr !== '') {
            const ch: CellChange = {
              sku,
              channel,
              market: sc.market,
              column: header,
              from: fromValue,
              to: '',
              kind: 'delete',
              note: '__CLEAR__',
            }
            if (sc.isMaster) masterChanges.push(ch)
            else changes.push(ch)
          }
          // DB already empty → no-change; skip
          continue
        }

        // Values equal → no-change; don't emit
        if (fileValue === fromStr) continue

        // Values differ → classify kind
        const isNewSku = !productMap.has(sku)
        let kind: DiffKind

        if (action === 'ADD' || isNewSku) {
          kind = 'add'
        } else if (checkRowConflict()) {
          kind = 'conflict'
        } else {
          kind = 'update'
        }

        const ch: CellChange = {
          sku,
          channel,
          market: sc.market,
          column: header,
          from: fromValue,
          to: fileValue,
          kind,
        }
        if (kind === 'conflict') {
          ch.note = 'Row changed in DB since export'
        }

        if (sc.isMaster) masterChanges.push(ch)
        else changes.push(ch)
      }
    }
  }

  // ── Compute stats ─────────────────────────────────────────────────────────

  const stats = { adds: 0, updates: 0, deletes: 0, conflicts: 0, outOfScope: 0 }
  const allChanges = [...changes, ...masterChanges]
  for (let i = 0; i < allChanges.length; i++) {
    const k = allChanges[i].kind
    if (k === 'add') stats.adds++
    else if (k === 'update') stats.updates++
    else if (k === 'delete') stats.deletes++
    else if (k === 'conflict') stats.conflicts++
    else if (k === 'out-of-scope') stats.outOfScope++
  }

  return { changes, masterChanges, stats, actionRows }
}
