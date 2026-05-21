/**
 * HB.8 — canonical marketplace-code normalization.
 *
 * Different tables historically stored the marketplace in different shapes:
 *   - Order.marketplace          = 'IT'              (2-letter code — canonical)
 *   - AmazonAdsDailyPerformance  = 'APJ6JRA9NG5V4'   (SP-API id)
 *   - APlusContent.marketplace   = 'AMAZON_IT'       (prefixed compound)
 *   - SettlementReport.marketplaceId = 'APJ6JRA9NG5V4' (column name signals intent — OK)
 *
 * Going forward, every table whose column is named `marketplace` (not
 * `marketplaceId`) should hold the 2-letter code. This helper normalizes
 * any of the three input shapes into the canonical code so writers don't
 * have to remember the convention.
 *
 * Mapping is hard-coded because Amazon's marketplace ids are stable and
 * the set we care about is small. Adding a new marketplace = add a row.
 */

/** SP-API marketplaceId → ISO-ish 2-letter code (UK aliased to GB upstream). */
export const MARKETPLACE_ID_TO_CODE: Record<string, string> = {
  // EU
  APJ6JRA9NG5V4: 'IT',
  A1PA6795UKMFR9: 'DE',
  A13V1IB3VIYZZH: 'FR',
  A1RKKUPIHCS9HS: 'ES',
  A1805IZSGTT6HS: 'NL',
  A1F83G8C2ARO7P: 'UK',
  A1C3SOZRARQ6R3: 'PL',
  A2NODRKZP88ZB9: 'SE',
  AMEN7PMS3EDWL:  'IE', // Ireland — Xavia auth has it via Pan-EU but no Marketplace row yet
  // NA
  ATVPDKIKX0DER: 'US',
  A2EUQ1WTGCTBG2: 'CA',
  A1AM78C64UM0Y8: 'MX',
  // Common other regions for forward-compat
  A1F83G8C2ARO7P_GB: 'UK',
  A21TJRUUN4KGV: 'IN',
  A1VC38T7YXB528: 'JP',
  A39IBJ37TRP1C6: 'AU',
  A19VAU5U5O7RUS: 'SG',
  A2VIGQ35RCS4UG: 'AE',
  A17E79C6D8DWNP: 'SA',
  A2Q3Y263D00KWC: 'BR',
  AE08WJ6YKNBMC: 'BE',
  ARBP9OOSHTCHU: 'EG',
  A33AVAJ2PDY3EV: 'TR',
  A21TJRUUN4KGV_IN: 'IN',
  A1805IZSGTT6HS_NL: 'NL',
}

/** Inverse map (code → SP-API id). Built lazily, deterministic. */
let codeToIdCache: Record<string, string> | null = null
function buildCodeToId(): Record<string, string> {
  if (codeToIdCache) return codeToIdCache
  const out: Record<string, string> = {}
  for (const [id, code] of Object.entries(MARKETPLACE_ID_TO_CODE)) {
    // Skip alias keys that have trailing _SUFFIX.
    if (id.includes('_')) continue
    out[code] = id
  }
  codeToIdCache = out
  return out
}

/**
 * Normalize any of these into the canonical 2-letter code:
 *   - SP-API id (APJ6JRA9NG5V4 → IT)
 *   - Prefixed compound (AMAZON_IT → IT)
 *   - Already-canonical code (IT → IT)
 *   - lowercase code (it → IT)
 *
 * Returns the input unchanged if it's already a 2-letter uppercase code
 * we recognize, or the fallback (default 'UNKNOWN') for anything else.
 *
 * Safe to call on any persisted value — idempotent.
 */
export function normalizeMarketplaceCode(
  value: string | null | undefined,
  fallback = 'UNKNOWN',
): string {
  if (!value) return fallback
  const trimmed = value.trim()
  // Already SP-API id?
  if (MARKETPLACE_ID_TO_CODE[trimmed]) return MARKETPLACE_ID_TO_CODE[trimmed]
  // AMAZON_XX prefix?
  if (trimmed.startsWith('AMAZON_')) {
    const tail = trimmed.slice('AMAZON_'.length).toUpperCase()
    if (tail.length === 2) return tail
    return fallback
  }
  // Two-letter code (case-normalized)?
  if (/^[a-zA-Z]{2}$/.test(trimmed)) return trimmed.toUpperCase()
  return fallback
}

/**
 * Resolve a 2-letter code to its SP-API id. Used by code that needs to
 * call SP-API operations after holding a canonical code internally.
 *
 * Returns null for unknown codes (caller should guard).
 */
export function marketplaceCodeToId(code: string | null | undefined): string | null {
  if (!code) return null
  const upper = code.trim().toUpperCase()
  return buildCodeToId()[upper] ?? null
}
