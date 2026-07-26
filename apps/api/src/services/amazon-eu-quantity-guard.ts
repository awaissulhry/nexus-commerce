/**
 * SCT.4 — Amazon EU shared-quantity guard.
 *
 * PROVED 2026-07-26 (DE pilot + the 18:42 storewide incident): Amazon holds
 * ONE merchant-fulfilled quantity per SKU across the EU marketplaces. The
 * `marketplaceIds` parameter on a quantity PATCH does NOT scope the number —
 * pushing 0 "to DE" zeroes IT, FR and ES in the same instant. 302 market-
 * scoped Zero & Pins therefore blanked the entire IT storefront.
 *
 * The guard makes contradictory per-market intents UNREPRESENTABLE:
 *   - the ACTION layer (Sync Control / Excel / follow endpoints) rejects a
 *     write that would leave a product's Amazon EU rows intending different
 *     quantities, BEFORE anything is written;
 *   - the PUSH layer (outbound sync) refuses to send a quantity that fights a
 *     sibling marketplace's intent — the belt that catches every other path
 *     (imports, heals, cascades, old queue rows).
 *
 * When all EU rows agree (all Follow, or all pinned at the same number) pushes
 * flow normally. Per-market suppression is NOT a quantity operation — it is a
 * Seller Central offer-close — and the error messages say so.
 */

/** Marketplaces that share one Amazon EU merchant quantity per SKU. */
export const AMAZON_EU_SHARED_MARKETS = new Set([
  'IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'PL', 'SE', 'IE',
])

export interface EuIntentRow {
  marketplace: string
  /** null/true = follows the pool; false = pinned. */
  followMasterQuantity: boolean | null
  /** The pinned value when pinned (override wins over quantity). */
  quantityOverride: number | null
  quantity: number | null
  /** Rows whose pushes are frozen don't express a live intent. */
  syncPaused?: boolean | null
  /** FBA rows are Amazon-managed and never participate. */
  isFba?: boolean
  /** SCT.6 — a CLOSED market offer expresses NO quantity intent. */
  offerClosed?: boolean
}

export interface EuIntent {
  marketplace: string
  kind: 'FOLLOW' | 'PINNED'
  /** Concrete number for PINNED; null for FOLLOW (pool-valued). */
  value: number | null
}

/** The quantity a row intends on the SHARED EU number. */
export function intentOf(row: EuIntentRow): EuIntent | null {
  if (row.isFba || row.syncPaused || row.offerClosed) return null
  const mkt = row.marketplace.toUpperCase()
  if (!AMAZON_EU_SHARED_MARKETS.has(mkt)) return null
  if (row.followMasterQuantity === false) {
    return { marketplace: mkt, kind: 'PINNED', value: row.quantityOverride ?? row.quantity ?? 0 }
  }
  return { marketplace: mkt, kind: 'FOLLOW', value: null }
}

export interface EuConflict {
  conflict: boolean
  /** Human sentence naming the disagreeing markets, for errors/logs. */
  detail: string
}

/**
 * Do these EU rows agree on ONE shared quantity?
 * Agreement = all FOLLOW (they all want pool truth), or all PINNED at the
 * same value. A FOLLOW next to any PIN is a contradiction: the pool number
 * and the pinned number fight over the single EU quantity (the 18:42 incident
 * was exactly IT-FOLLOW vs DE/ES/FR-PINNED@0).
 */
export function detectEuIntentConflict(rows: EuIntentRow[]): EuConflict {
  const intents = rows.map(intentOf).filter((x): x is EuIntent => x !== null)
  if (intents.length <= 1) return { conflict: false, detail: '' }

  const pins = intents.filter((i) => i.kind === 'PINNED')
  const follows = intents.filter((i) => i.kind === 'FOLLOW')

  if (pins.length > 0 && follows.length > 0) {
    return {
      conflict: true,
      detail:
        `${follows.map((f) => f.marketplace).join('/')} follow the pool while ` +
        `${pins.map((p) => `${p.marketplace} is pinned at ${p.value}`).join(', ')} — ` +
        `Amazon keeps ONE quantity per SKU across EU markets, so these fight each other`,
    }
  }
  const pinValues = new Set(pins.map((p) => p.value ?? 0))
  if (pinValues.size > 1) {
    return {
      conflict: true,
      detail:
        `pinned at different values (${pins.map((p) => `${p.marketplace}=${p.value}`).join(', ')}) — ` +
        `Amazon keeps ONE quantity per SKU across EU markets`,
    }
  }
  return { conflict: false, detail: '' }
}

/**
 * Project what a Sync Control action would leave behind, then check alignment.
 * `targets` = the marketplaces the action touches for this product.
 */
export function projectActionAndDetect(
  rows: EuIntentRow[],
  targets: Set<string>,
  action: 'FOLLOW' | 'PIN' | 'ZERO_PIN',
): EuConflict {
  const projected = rows.map((r) => {
    if (!targets.has(r.marketplace.toUpperCase())) return r
    if (action === 'FOLLOW') return { ...r, followMasterQuantity: true, quantityOverride: null }
    if (action === 'ZERO_PIN') return { ...r, followMasterQuantity: false, quantityOverride: 0, syncPaused: false }
    // PIN freezes at the current number
    return { ...r, followMasterQuantity: false, quantityOverride: r.quantityOverride ?? r.quantity ?? 0 }
  })
  return detectEuIntentConflict(projected)
}

/** The operator-facing remedy, appended to every guard error. */
export const EU_GUARD_REMEDY =
  'Apply the action to ALL Amazon EU markets of these SKUs so they agree, or use ' +
  'Seller Central to close the offer in one market — per-market quantity is not a thing Amazon supports.'
