/**
 * FF2.4 — Per-cell diff engine.
 *
 * Pure function — reads ONLY; writes nothing to DB or any external service and
 * never mutates its inputs.
 *
 * Compares each parsed workbook cell against the current DB state (WorkbookData)
 * and classifies it as one of:
 *
 *   add         — new SKU (not in DB) or Action=ADD row, non-blank file value
 *   update      — file value differs from current DB, DB row unchanged since snapshot
 *   delete      — __CLEAR__ on a non-empty field (explicit per-cell clear)
 *   no-change   — blank cell OR file value matches current DB value (never emitted)
 *   conflict    — file value differs from DB AND the row changed in DB since snapshot
 *                 (fingerprint mismatch); carries 'Row changed in DB since export' note
 *   out-of-scope— column outside the import scope; diffed + shown greyed but never applied
 *
 * Row-level Action semantics (evaluated BEFORE any per-cell diff):
 *   IGNORE — skip the whole row (emit nothing).
 *   DELETE — record { sku, sheet } in the `deletes` bucket, bump stats.deletes, and
 *            skip cell diffing entirely (no per-cell CellChanges are emitted). A row
 *            is never deleted implicitly — only ever via an explicit Action=DELETE.
 *
 * Resolver-aware: governed per-market fields (title, price, quantity, bullets,
 * description) compare against the EFFECTIVE value from resolveEffective(), matching
 * exactly what the operator saw in the exported workbook.
 *
 * Blank cells are the "no-change" sentinel and always produce no-change (never emitted).
 * __CLEAR__ as a CELL value is an explicit clear — emits a `delete` CellChange (to = '')
 * if the DB field is non-empty. This is distinct from Action=DELETE (a whole-row op).
 *
 * follows_master control columns (e.g. price_follows_master@IT) are diffed as
 * string 'true'/'false' by reading the listing's follow-flag column directly.
 *
 * Products-sheet changes go to `masterChanges`; channel-sheet changes go to `changes`.
 */

import type { ParsedWorkbook } from './parse.js'
import type { ScopedColumn, Channel, ImportScope } from './scope.js'
import type { WorkbookData } from '../fetch.js'
import { canonicalizeText, canonicalizeDecimal } from './normalize.js'
import { MASTER_FIELDS } from '../registry/master-fields.js'
import { CHANNEL_MARKET_FIELDS } from '../registry/channel-fields.js'
import type { FieldDefinition } from '../registry/types.js'
import { resolveEffective } from '../resolver.js'
import { rowFingerprint } from '../fingerprint.js'

// ── Constants ──────────────────────────────────────────────────────────────────

/** Field classes that are read-only on import — skipped from diff entirely. */
const READONLY_CLS = new Set<string>(['READONLY_SYNCED', 'DERIVED', 'SYSTEM'])

/** Map from sheet name → channel discriminant (mirrors scope.ts). */
const SHEET_CHANNEL: Record<string, Channel> = {
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

export type ChangeKind =
  | 'add'
  | 'update'
  | 'delete'
  | 'no-change'
  | 'conflict'
  | 'out-of-scope'

export interface CellChange {
  sku: string
  sheet: string
  channel?: Channel
  market?: string
  column: string
  base: string
  from: unknown
  to: unknown
  kind: ChangeKind
  note?: string
}

export interface ImportDiff {
  /** Channel-sheet CellChanges (in-scope + out-of-scope, excluding no-change). */
  changes: CellChange[]
  /** Products-sheet CellChanges (master data, separate bucket). */
  masterChanges: CellChange[]
  /** Rows flagged for deletion via Action=DELETE (one entry per row, scope-filtered). */
  deletes: { sku: string; sheet: string; channel?: Channel; markets?: string[] | 'ALL' }[]
  stats: {
    adds: number
    updates: number
    /**
     * Counts BOTH row-level Action=DELETE rows (in the `deletes[]` bucket) AND
     * cell-level `__CLEAR__` deletes (which are `kind:'delete'` CellChanges in
     * `changes`/`masterChanges`). Therefore `adds+updates+deletes+conflicts+outOfScope`
     * is NOT equal to `changes.length + masterChanges.length` when Action=DELETE rows
     * are present. The apply stage must process `deletes[]` and `kind:'delete'`
     * CellChanges separately.
     */
    deletes: number
    conflicts: number
    outOfScope: number
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Canonical comparison helper — symmetrically normalises both the file side and the
 * DB side before comparison so round-trip identity holds for:
 *   - Text with curly quotes or BOM (canonicalizeText)
 *   - Decimals in IT locale format or with trailing zeros (canonicalizeDecimal)
 *   - Arrays: joined with the field's arrayDelimiter, inner delimiter escaped to '/'
 *
 * Rules (in priority order):
 *   null / undefined  → ''
 *   boolean           → 'true' | 'false'
 *   Array             → escape+join (same algorithm as the workbook generator)
 *   decimal / number  → canonicalizeDecimal(String(v))
 *   everything else   → canonicalizeText(String(v))
 */
function canon(v: unknown, field?: FieldDefinition): string {
  if (v == null) return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) {
    const delim = field?.arrayDelimiter ?? ' | '
    const inner = delim.trim()
    return (v as unknown[]).map((x) => String(x).split(inner).join('/')).join(delim)
  }
  const s = String(v)
  if (field?.kind === 'decimal' || field?.kind === 'number') {
    return canonicalizeDecimal(s)
  }
  return canonicalizeText(s)
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
 * @param opts     Optional snapshot fingerprints for conflict detection.
 *                 fingerprints is keyed as 'Products|SKU' / 'Amazon|SKU' etc.
 * @returns        ImportDiff: changes, masterChanges, deletes, stats.
 */
export function computeDiff(
  wb: ParsedWorkbook,
  scoped: ScopedColumn[],
  current: WorkbookData,
  scope: ImportScope,
  opts?: { fingerprints?: Record<string, string> },
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
  const deletes: { sku: string; sheet: string; channel?: Channel; markets?: string[] | 'ALL' }[] = []

  // ── Process each sheet ────────────────────────────────────────────────────

  for (const [sheetName, sheet] of Object.entries(wb.sheets)) {
    const isProductsSheet = sheetName === 'Products'
    const channel: Channel | undefined = SHEET_CHANNEL[sheetName]

    // Emit a CellChange into the correct bucket, always stamping sheet + base.
    const emit = (
      sku: string,
      sc: ScopedColumn,
      from: unknown,
      to: unknown,
      kind: ChangeKind,
      note?: string,
    ): void => {
      const ch: CellChange = {
        sku,
        sheet: sheetName,
        channel,
        market: sc.market,
        column: sc.column,
        base: sc.base,
        from,
        to,
        kind,
      }
      if (note !== undefined) ch.note = note
      ;(isProductsSheet ? masterChanges : changes).push(ch)
    }

    for (const row of sheet.rows) {
      const sku = row.cells['sku']?.value ?? ''
      if (!sku) continue

      const rawAction = row.cells['Action']?.value ?? ''
      const action = rawAction as 'ADD' | 'DELETE' | 'IGNORE' | ''

      // ── Row-level Action gates (before any per-cell diff) ──────────────
      // IGNORE rows → skip entirely.
      if (action === 'IGNORE') continue

      // DELETE rows → record the row deletion and skip cell diffing entirely.
      // Deletion is never implicit; only an explicit Action=DELETE reaches here.
      // Scope-aware: only record deletes that are actionable for the current scope.
      if (action === 'DELETE') {
        if (isProductsSheet) {
          // Master delete: only if the operator explicitly opted into master changes.
          if (scope.includeMaster) {
            deletes.push({ sku, sheet: sheetName })
          }
          // includeMaster=false → silently skip; not actionable in this scope.
        } else if (channel !== undefined) {
          // Channel sheet delete: only if this sheet's channel matches the scope channel.
          // Cross-channel deletes (e.g. eBay row when scope=AMAZON) are not actionable.
          if (SHEET_CHANNEL[sheetName] === scope.channel) {
            deletes.push({ sku, sheet: sheetName, channel: SHEET_CHANNEL[sheetName], markets: scope.markets })
          }
          // Out-of-channel → silently skip.
        }
        continue
      }

      // ── Lazy conflict check for this row ───────────────────────────────
      //
      // Conflict = file value differs from DB AND DB row changed since
      // snapshot (fingerprint mismatch). Only computed on first need.
      let conflictChecked = false
      let rowIsConflict = false

      const checkRowConflict = (): boolean => {
        if (conflictChecked) return rowIsConflict
        conflictChecked = true

        const fingerprints = opts?.fingerprints
        if (!fingerprints) return (rowIsConflict = false)

        let currentFp: string | undefined

        if (isProductsSheet) {
          const fpKey = `Products|${sku}`
          if (!fpCache.has(fpKey)) {
            const p = productMap.get(sku)
            if (p) fpCache.set(fpKey, computeProductFp(sku, p))
          }
          currentFp = fpCache.get(fpKey)
        } else if (channel) {
          const fpKey = `${sheetName}|${sku}`
          if (!fpCache.has(fpKey)) {
            const markets = metaMarkets[channel] ?? []
            if (markets.length > 0) {
              fpCache.set(fpKey, computeChannelFp(sku, channel, markets, listingMap))
            }
          }
          currentFp = fpCache.get(fpKey)
        } else {
          return (rowIsConflict = false)
        }

        const snapshotFp = fingerprints[
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

        // Canonical DB value — symmetric with the file-side canon() so that
        // curly quotes, BOM, trailing spaces, and decimal locale variants don't
        // produce false updates on round-trip.
        const canonFrom = canon(fromValue, field)
        const fileValue = cell.value

        // ── Out-of-scope: diff + show greyed, but never apply ──────────

        if (!sc.inScope) {
          // Only emit if the file has a non-blank value that canonically differs from DB.
          // (blank = nothing to report; canonical match = nothing to warn about)
          if (fileValue !== '') {
            const canonFile = canon(fileValue, field)
            if (canonFile !== canonFrom) {
              const toValue = fileValue === '__CLEAR__' ? '' : canonFile
              const note = fileValue === '__CLEAR__' ? '__CLEAR__' : undefined
              emit(sku, sc, fromValue, toValue, 'out-of-scope', note)
            }
          }
          continue
        }

        // ── In-scope processing ────────────────────────────────────────

        // Blank = no-change sentinel; never emit.
        if (fileValue === '') continue

        // __CLEAR__ as a cell value: explicit clear → delete kind if DB has a value.
        // (Distinct from Action=DELETE, which is handled at row level above.)
        if (fileValue === '__CLEAR__') {
          if (canonFrom !== '') {
            emit(sku, sc, fromValue, '', 'delete', '__CLEAR__')
          }
          // DB already empty → no-change; skip
          continue
        }

        // Canonical comparison — both sides normalised identically.
        // Emits `to` as the clean canonical value (e.g. '189,90' → '189.9').
        const canonFile = canon(fileValue, field)

        // Values equal (canonically) → no-change; don't emit
        if (canonFile === canonFrom) continue

        // Values differ → classify kind
        const isNewSku = !productMap.has(sku)
        let kind: ChangeKind

        if (action === 'ADD' || isNewSku) {
          kind = 'add'
        } else if (checkRowConflict()) {
          kind = 'conflict'
        } else {
          kind = 'update'
        }

        emit(
          sku,
          sc,
          fromValue,
          canonFile,
          kind,
          kind === 'conflict' ? 'Row changed in DB since export' : undefined,
        )
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
  // Row-level Action=DELETE deletions live in the `deletes` bucket, not in the
  // CellChange arrays — fold their count into stats.deletes.
  stats.deletes += deletes.length

  return { changes, masterChanges, deletes, stats }
}
