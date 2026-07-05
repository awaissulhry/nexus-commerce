/**
 * FF2.3 — Import scope resolver.
 *
 * Pure function — no DB, no side effects.
 *
 * Responsibilities:
 *   - Define the ImportScope shape: which channel + markets (+ whether master
 *     columns are included) the operator intends to import.
 *   - defaultScope: build a single-market scope from the active launch context.
 *   - classifyColumns: iterate every header in a ParsedWorkbook and tag each one
 *     with scope metadata so the downstream diff (Task 4) and apply (Task 6)
 *     only touch columns the operator intended.
 *
 * Sheet → channel mapping:
 *   Amazon  → AMAZON
 *   eBay    → EBAY
 *   Shopify → SHOPIFY
 *   Products → master (no channel)
 *
 * Header parsing for channel sheets:
 *   'price@IT'               → base='price',  market='IT'
 *   'price_follows_master@IT'→ base='price',  market='IT'  (_follows_master stripped)
 *   'title' (no @)           → base='title',  market=undefined  (channel-shared column)
 *
 * Control columns ('Action', 'sku') are ALWAYS in scope regardless of channel/market.
 */

import type { ParsedWorkbook } from './parse.js'

// ── Public types ───────────────────────────────────────────────────────────────

export type Channel = 'AMAZON' | 'EBAY' | 'SHOPIFY'

export interface ImportScope {
  channel: Channel
  markets: string[] | 'ALL'
  includeMaster: boolean
}

export interface ScopedColumn {
  sheet: string
  column: string
  base: string
  market?: string
  inScope: boolean
  isMaster: boolean
  isControl: boolean
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Map from sheet name → Channel discriminant. */
const SHEET_CHANNEL_MAP: Record<string, Channel> = {
  Amazon: 'AMAZON',
  eBay: 'EBAY',
  Shopify: 'SHOPIFY',
}

const MASTER_SHEET = 'Products'

/** Row identity + action columns — always included, never scope-gated. */
const CONTROL_COLUMNS = new Set<string>(['Action', 'sku'])

/** Suffix stripped from the left side of an @ header to yield the base field id. */
const FOLLOWS_MASTER_SUFFIX = '_follows_master'

// ── defaultScope ───────────────────────────────────────────────────────────────

/**
 * Build the narrowest sensible scope: just the channel and market the operator
 * is actively working in, with master columns excluded by default.
 *
 * Callers can widen the scope by mutating `markets` to 'ALL' or adding entries,
 * or setting `includeMaster:true` before passing to classifyColumns.
 */
export function defaultScope(launch: { channel: Channel; market: string }): ImportScope {
  return {
    channel: launch.channel,
    markets: [launch.market],
    includeMaster: false,
  }
}

// ── parseHeader ───────────────────────────────────────────────────────────────

/**
 * Decompose a channel-sheet header into (base, market).
 *
 * Rules:
 *   - Split on the LAST '@'. Everything to the right is the market code.
 *   - If the left part ends with '_follows_master', strip that suffix to get the
 *     canonical base field id (e.g. 'price_follows_master' → 'price').
 *   - If there is no '@', the column is channel-shared: base = header, market = undefined.
 */
function parseHeader(column: string): { base: string; market: string | undefined } {
  const atIdx = column.lastIndexOf('@')

  if (atIdx === -1) {
    // No market suffix — channel-shared column
    return { base: column, market: undefined }
  }

  let left = column.slice(0, atIdx)
  const market = column.slice(atIdx + 1)

  // Strip _follows_master trailing suffix from the field key
  if (
    left.length > FOLLOWS_MASTER_SUFFIX.length &&
    left.slice(-FOLLOWS_MASTER_SUFFIX.length) === FOLLOWS_MASTER_SUFFIX
  ) {
    left = left.slice(0, -FOLLOWS_MASTER_SUFFIX.length)
  }

  return { base: left, market }
}

// ── classifyColumns ────────────────────────────────────────────────────────────

/**
 * Tag every header in the workbook with scope metadata.
 *
 * Returns one ScopedColumn per (sheet × header) in iteration order.
 * Columns whose inScope=false are still emitted so callers can surface
 * meaningful out-of-scope warnings rather than silently dropping content.
 */
export function classifyColumns(wb: ParsedWorkbook, scope: ImportScope): ScopedColumn[] {
  const result: ScopedColumn[] = []

  for (const [sheetName, sheet] of Object.entries(wb.sheets)) {
    const sheetChannel = SHEET_CHANNEL_MAP[sheetName]
    const isMasterSheet = sheetName === MASTER_SHEET

    for (const column of sheet.headers) {
      // ── Control columns: always in scope, on any sheet ────────────────────
      if (CONTROL_COLUMNS.has(column)) {
        result.push({
          sheet: sheetName,
          column,
          base: column,
          market: undefined,
          inScope: true,
          isMaster: false,
          isControl: true,
        })
        continue
      }

      // ── Products (master) sheet ───────────────────────────────────────────
      if (isMasterSheet) {
        result.push({
          sheet: sheetName,
          column,
          base: column,
          market: undefined,
          inScope: scope.includeMaster,
          isMaster: true,
          isControl: false,
        })
        continue
      }

      // ── Channel sheet ─────────────────────────────────────────────────────
      const { base, market } = parseHeader(column)

      // Channel must match scope.channel
      const channelMatch = sheetChannel === scope.channel

      // Market must be in scope (undefined = channel-shared; follows the channel)
      const marketMatch =
        market === undefined ||
        scope.markets === 'ALL' ||
        (Array.isArray(scope.markets) && scope.markets.includes(market))

      result.push({
        sheet: sheetName,
        column,
        base,
        market,
        inScope: channelMatch && marketMatch,
        isMaster: false,
        isControl: false,
      })
    }
  }

  return result
}
