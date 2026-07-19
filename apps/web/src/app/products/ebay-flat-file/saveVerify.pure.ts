/**
 * FFT.2 (Z2) — a clean save clears the local draft ONLY after read-back
 * verification: the same GET a reload would issue must return every saved row
 * as saved. This module is the pure diff; the client supplies rows from the
 * real GET.
 *
 * Exclusions are deliberate: live/system fields (item ids, statuses, per-market
 * price/qty, pool-governed quantity) and tree-derived identity (parent_sku,
 * parentage) are NOT snapshot-owned, so they may legitimately read back
 * different. Aspect keys compare canonically (the server canonicalizes
 * language + casing on write). Empty saved values are skipped — a deliberate
 * clear is verified by the next save's own read, never re-flagged here.
 */

import { aspectVerifyKey } from './importAspects.pure'

export interface VerifyMismatch { sku: string; field: string; saved: string; readBack: string }
export interface VerifyResult { mismatches: VerifyMismatch[]; missingRows: string[] }

const MARKET_PREFIXES = ['it', 'de', 'fr', 'es', 'uk']

/** Fields the flat-file snapshot deliberately does NOT own on read-back. */
const VERIFY_EXCLUDED = new Set<string>([
  'sku', 'parent_sku', 'parentage', 'price', 'qty', 'quantity',
  'variation_theme', // Product-derived; server may normalize casing/spacing
  'ebay_item_id', 'listing_status', 'sync_status', 'last_pushed_at', 'platformproductid',
  'action',
  ...MARKET_PREFIXES.flatMap((p) => [`${p}_item_id`, `${p}_status`, `${p}_listing_id`, `${p}_price`, `${p}_qty`]),
])

/** Rows whose Action removes/ends them have no persist-verbatim contract. */
const ACTION_SKIP = new Set(['end', 'deactivate', 'skip', 'delete'])

const canonField = (k: string) =>
  k.toLowerCase().startsWith('aspect_') ? aspectVerifyKey(k) : k.trim().toLowerCase()
const normValue = (v: unknown) => String(v ?? '').trim()
const numeric = (s: string) => {
  if (s === '' || /[^0-9.,\-\s]/.test(s)) return null
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const valuesMatch = (a: string, b: string) => {
  if (a === b) return true
  const na = numeric(a)
  const nb = numeric(b)
  return na != null && nb != null && na === nb
}

export function diffSavedRowsAgainstServer(
  saved: Array<Record<string, unknown>>,
  server: Array<Record<string, unknown>>,
): VerifyResult {
  const byRowId = new Map<string, Record<string, unknown>>()
  const byFamSku = new Map<string, Record<string, unknown>>()
  const bySku = new Map<string, Record<string, unknown>>()
  for (const r of server) {
    const rowId = String(r._rowId ?? '')
    if (rowId && !byRowId.has(rowId)) byRowId.set(rowId, r)
    const sku = normValue(r.sku)
    if (!sku) continue
    const fam = `${normValue(r.parent_sku)}|${sku}`
    if (!byFamSku.has(fam)) byFamSku.set(fam, r)
    if (!bySku.has(sku)) bySku.set(sku, r)
  }

  const mismatches: VerifyMismatch[] = []
  const missingRows: string[] = []

  for (const row of saved) {
    const sku = normValue(row.sku)
    if (!sku && !String(row._rowId ?? '')) continue // blank pad rows have nothing to verify
    if (ACTION_SKIP.has(normValue(row.action).toLowerCase())) continue
    // Same resolution order as the draft merge: exact row identity first, then
    // family+sku (identities flip at publish: planned:: → shared::), then sku.
    const match =
      byRowId.get(String(row._rowId ?? '')) ??
      (sku ? byFamSku.get(`${normValue(row.parent_sku)}|${sku}`) ?? bySku.get(sku) : undefined)
    if (!match) {
      missingRows.push(sku || String(row._rowId ?? '?'))
      continue
    }
    const serverCanon = new Map<string, string>()
    for (const [k, v] of Object.entries(match)) {
      if (k.startsWith('_')) continue
      const ck = canonField(k)
      const val = normValue(v)
      if (!serverCanon.has(ck) || (serverCanon.get(ck) === '' && val !== '')) serverCanon.set(ck, val)
    }
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('_')) continue
      const value = normValue(v)
      if (value === '') continue
      const ck = canonField(k)
      if (VERIFY_EXCLUDED.has(ck)) continue
      const back = serverCanon.get(ck) ?? ''
      if (!valuesMatch(value, back)) {
        mismatches.push({ sku: sku || '(no sku)', field: k, saved: value, readBack: back })
      }
    }
  }

  return { mismatches, missingRows }
}
