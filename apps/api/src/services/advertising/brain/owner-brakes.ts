/**
 * ONE BRAIN AB-1 review — the campaigns the Owner keeps away from the bid brain: excluded (the campaign, or a product it
 * advertises), or with its whole bids lever locked at his own value (brain/settings.ts ownerBrakeOf). The per-campaign
 * tool set-bid-brain-enrollment refuses op live and release on them (bid-brain/enrollment.ts enrollRefusal), so no path
 * — today's tool or a future override tool — puts such a campaign under the bid brain. A shared campaign counts for
 * every product it advertises: one product's exclusion keeps it out.
 *
 * A leaf (prisma, the resolver, the pure settings): bid-brain/enrollment.ts imports it without a cycle. Three queries
 * for the ownership at most, one for the overrides.
 *
 * AB-2 — and the Owner's locks the stop recipe obeys (ownerLeverLocks): a LOCK of a campaign's placements (the whole lever
 * or one lane) or of its bidding strategy. A stop still lowers a locked lever (as it beats a pinned bid); its give-back
 * puts the Owner's value back, never the brain's, and the why says so (bid-brain/stop-recipe.ts).
 */
import prisma from '../../../db.js'
import { resolveCampaignOwnership, type CampaignOwnership } from './ownership.js'
import { describeProvenance, ownerBrakeOf, resolveBrainSettings, type OverrideRow, type Provenance } from './settings.js'

const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const

/** campaignId → why the Owner keeps the bid brain off it; campaigns nothing keeps off are left out. */
export async function ownerBrakes(campaignIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const owners = await resolveCampaignOwnership(campaignIds)
  if (!owners.size) return out
  const products = [...new Set([...owners.values()].flatMap((o) => o.productIds))]
  const rows: OverrideRow[] = await prisma.adsBrainOverride.findMany({
    where: { endedAt: null, OR: [{ scope: 'CAMPAIGN', campaignId: { in: [...owners.keys()] } }, ...(products.length ? [{ scope: 'PRODUCT', productId: { in: products } }] : [])] },
    select: OVERRIDE_SELECT,
  })
  if (!rows.length) return out
  for (const o of owners.values()) {
    if (!o.market) continue
    // A campaign override applies to its campaign under any product; with no product it still applies (resolved alone).
    for (const productId of o.productIds.length ? o.productIds : ['']) {
      const brake = ownerBrakeOf(resolveBrainSettings({ productId, market: o.market, campaignId: o.campaignId, enrolled: true, overrides: rows }))
      if (brake) { out.set(o.campaignId, brake); break }
    }
  }
  return out
}

/**
 * ONE BRAIN AB-2 — a campaign's Owner locks on the levers the stop recipe writes (bid-brain/stop-recipe.ts). A stop still
 * LOWERS a locked lever (lanes to 0 %, down only), as a stop beats a pinned bid; only its give-back obeys the lock: the
 * lever goes back to the Owner's value (the lock's value, else what it held before the stop), never to the brain's.
 */
export interface LeverLocks {
  /** The locks could not be read this tick: the give-back waits (nothing dropped), a stop still lowers. */
  unreadable?: true
  /** The whole placements lever: its words ("locked by the Owner's campaign override (…)") and his value per lane (null: as it was). */
  placements: { words: string; value: Partial<Record<string, number>> | null } | null
  /** One lane each (TOP_OF_SEARCH, PRODUCT_PAGE, REST_OF_SEARCH → its lock in words): it goes back to its value before the stop. */
  lanes: ReadonlyMap<string, string>
  /** The bidding strategy: its words and his value (null: as it was). */
  biddingStrategy: { words: string; value: string | null } | null
}

/** "locked by the Owner's campaign override (user:x, 2026-10-08) ("my own strategy")" — a lock in words, for the why. */
const lockWords = (p: Provenance): string => `locked by ${describeProvenance(p)}${p.reason ? ` ("${p.reason}")` : ''}`

/**
 * AB-2 — campaignId → the Owner's locks of its placements (the whole lever, or one lane) and of its bidding strategy, as
 * its product's brain resolves them (brain/settings.ts: the campaign's lock, else the product's); campaigns with none are
 * left out. A shared campaign counts every product it advertises: one product's lock holds the lever. One query when no
 * such lock is open in the business; the campaign → product resolver only when a product lock is.
 */
export async function ownerLeverLocks(campaignIds: readonly string[]): Promise<Map<string, LeverLocks>> {
  const out = new Map<string, LeverLocks>()
  const ids = [...new Set(campaignIds.filter(Boolean))]
  if (!ids.length) return out
  const rows: OverrideRow[] = await prisma.adsBrainOverride.findMany({
    where: { endedAt: null, kind: 'LOCK', key: { in: ['placements', 'biddingStrategy'] }, OR: [{ scope: 'CAMPAIGN', campaignId: { in: ids } }, { scope: 'PRODUCT' }] },
    select: OVERRIDE_SELECT,
  })
  if (!rows.length) return out
  const owners = rows.some((r) => r.scope === 'PRODUCT') ? await resolveCampaignOwnership(ids) : new Map<string, CampaignOwnership>()
  for (const campaignId of ids) {
    const o = owners.get(campaignId)
    let placements: LeverLocks['placements'] = null
    let biddingStrategy: LeverLocks['biddingStrategy'] = null
    const lanes = new Map<string, string>()
    // A campaign lock applies under any product (with none, resolved alone); a product lock to its product's campaigns.
    for (const productId of o?.productIds.length ? o.productIds : ['']) {
      const s = resolveBrainSettings({ productId, market: o?.market ?? '', campaignId, enrolled: true, overrides: rows })
      const p = s.levers.placements
      if (p.lock && !placements) placements = { words: lockWords(p.lock), value: p.lock.value && typeof p.lock.value === 'object' ? p.lock.value as Record<string, number> : null }
      for (const l of p.locks) {
        const lane = l.ref.startsWith('lane:') ? l.ref.slice('lane:'.length) : null
        if (lane && !lanes.has(lane)) lanes.set(lane, lockWords(l))
      }
      const b = s.levers.biddingStrategy
      if (b.lock && !biddingStrategy) biddingStrategy = { words: lockWords(b.lock), value: typeof b.lock.value === 'string' ? b.lock.value : null }
    }
    if (placements || lanes.size || biddingStrategy) out.set(campaignId, { placements, lanes, biddingStrategy })
  }
  return out
}
