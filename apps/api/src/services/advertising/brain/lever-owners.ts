/**
 * ONE BRAIN AB-5 — who holds each lever of a campaign, for the write gate (design 2026-10-08-ads-one-brain/DESIGN.md §3
 * target 2-5, §2.10, §10). Read only. The gate asks it only under the env ceiling `live` (NEXUS_BID_BRAIN_MODE) and only
 * for an automatic writer (a person's write and the safety owners never need it).
 *
 *   owned     a campaign whose serving ads all tie to one product family (brain/ownership.ts) belongs to that product's
 *             brain in the campaign's market. brain/settings.ts says per lever whether the brain owns it there: the
 *             product enrolled, the lever at PROPOSE or AUTO, the campaign not excluded and the lever not locked. A
 *             shared campaign is owned by no brain (D2 = A: the brain proposes a split).
 *   locked    the Owner's lock of a whole lever (the campaign's, else the product's) holds it at his own value: every
 *             automatic writer is refused on it, the brain too (§2.10: a lock is a hold without an end date). On a shared
 *             campaign one enrolled product's lock holds the lever. A lock of one thing inside a lever (an ad group, a
 *             term, a lane, an hour cell) is the brain's own modules' to obey, not the gate's.
 *   excluded  an exclusion (of the campaign, or of a product it advertises) wins over every lever: today's engines run it.
 *   levers    GATE_LEVERS. Not the keyword-bids lever: it stays the bid brain's BidBrainEnrollment (bid-brain/live.ts,
 *             BB-6), exactly as the 10 GALE IT campaigns run today. Not hours (no write of its own: its writes are bids and
 *             placements) and not offAmazon (no write path yet).
 *   fast      one cheap query per business while nothing is enrolled, remembered ENROLLED_TTL_MS: AdsBrainEnrollment is
 *             empty in production until the first product is enrolled, and until then the gate reads nothing more.
 *   batched   a fixed number of queries per lookup whatever the number of campaigns (the ownership resolver's four at
 *             most, the enrollments one, the overrides one); each campaign's answer is remembered OWNERS_TTL_MS, so a
 *             dispatch batch of writes on the same campaigns resolves each campaign once. A change of the brain in this
 *             process forgets everything at once (forgetLeverOwners, brain/enrollment.ts); another process sees it within
 *             the TTL.
 *   errors    a read that fails throws: the gate fails closed (an automatic write waits; a person's passes).
 */
import prisma from '../../../db.js'
import { LEGACY_WORKSPACE_ID, workspaceContext } from '../../../lib/workspace-context.js'
import type { BrainLever } from './levers.js'
import { resolveCampaignOwnership, type CampaignOwnership } from './ownership.js'
import { describeProvenance, resolveBrainSettings, type BrainSettings, type OverrideRow, type Provenance } from './settings.js'

/** The levers the gate judges by the product brain's settings. */
export const GATE_LEVERS: readonly BrainLever[] = ['adGroupBids', 'placements', 'biddingStrategy', 'state', 'budgets', 'portfolioCap', 'negatives', 'harvest', 'structure']

/** Who holds one lever of a campaign: the product's brain, or the Owner's lock. */
export interface LeverHold {
  kind: 'owned' | 'locked'
  /** The product (family root) whose brain owns the lever, or whose settings lock it. */
  productId: string
  market: string
  /** Where it comes from, in words: "AUTO by the Owner's product override (user:x, 2026-10-08)", "locked by …". */
  why: string
}

export interface CampaignLeverOwners {
  campaignId: string
  name: string
  market: string
  /** Only the levers someone holds. */
  levers: Partial<Record<BrainLever, LeverHold>>
}

/** "locked by the Owner's campaign override (user:x, 2026-10-08) ("my own budget")" */
const lockWords = (p: Provenance): string => `locked by ${describeProvenance(p)}${p.reason ? ` ("${p.reason}")` : ''}`
const enrollmentKey = (productId: string, market: string) => `${productId}\u0000${market}`

/**
 * The levers someone holds on one campaign, from its owner, the enrollments and the open overrides (pure). `enrolled`
 * holds enrollmentKey(product, market) of each enrolled product × market.
 */
export function leverHoldsOf(
  c: Pick<CampaignOwnership, 'campaignId' | 'market' | 'owner'>,
  enrolled: ReadonlySet<string>,
  overrides: readonly OverrideRow[],
): Partial<Record<BrainLever, LeverHold>> {
  const out: Partial<Record<BrainLever, LeverHold>> = {}
  const market = c.market
  if (!market || c.owner.kind === 'none') return out
  const products = c.owner.kind === 'product' ? [c.owner.productId] : c.owner.productIds
  const settings: BrainSettings[] = products
    .filter((productId) => enrolled.has(enrollmentKey(productId, market)))
    .map((productId) => resolveBrainSettings({ productId, market, campaignId: c.campaignId, enrolled: true, overrides }))
  // Nothing enrolled, or the Owner keeps the campaign out of the brain (one product's exclusion keeps a shared one out).
  if (!settings.length || settings.some((s) => s.excluded.value)) return out
  for (const lever of GATE_LEVERS) {
    const locked = settings.find((s) => s.levers[lever].effective === 'LOCKED' && s.levers[lever].lock)
    if (locked) {
      out[lever] = { kind: 'locked', productId: locked.productId, market, why: lockWords(locked.levers[lever].lock!) }
      continue
    }
    const own = c.owner.kind === 'product' ? settings[0].levers[lever] : null
    if (own?.owned) out[lever] = { kind: 'owned', productId: settings[0].productId, market, why: `${own.level.value} by ${describeProvenance(own.level)}` }
  }
  return out
}

// ── The memory ───────────────────────────────────────────────────────────────────────────────────────────────────

/** How long "is anything enrolled in this business?" is remembered. */
export const ENROLLED_TTL_MS = 30_000
/** How long one campaign's (or portfolio's) holders are remembered: a dispatch batch resolves each once. */
export const OWNERS_TTL_MS = 15_000
const MAX_REMEMBERED = 5_000

const memory = new Map<string, { at: number; value: unknown }>()
const business = (): string => workspaceContext()?.workspaceId ?? LEGACY_WORKSPACE_ID

function recall<T>(key: string, ttlMs: number): { value: T } | null {
  const hit = memory.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > ttlMs) { memory.delete(key); return null }
  return { value: hit.value as T }
}

function remember(key: string, value: unknown): void {
  if (memory.size >= MAX_REMEMBERED) memory.clear()
  memory.set(key, { at: Date.now(), value })
}

/** Forget every remembered answer (a change of a brain in this process, and tests). */
export function forgetLeverOwners(): void {
  memory.clear()
}

/** Is any product enrolled in this business? One query, remembered ENROLLED_TTL_MS. */
export async function anyBrainEnrolled(): Promise<boolean> {
  const key = `${business()}\u0000enrolled`
  const hit = recall<boolean>(key, ENROLLED_TTL_MS)
  if (hit) return hit.value
  const row = await prisma.adsBrainEnrollment.findFirst({ select: { id: true } })
  remember(key, !!row)
  return !!row
}

const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const

/**
 * Who holds the levers of these campaigns (only the campaigns someone holds a lever of are in the map). Nothing enrolled
 * in the business: one remembered query and an empty map. Otherwise a fixed number of queries for the campaigns not
 * remembered. Throws when a read fails.
 */
export async function campaignLeverOwners(campaignIds: readonly string[]): Promise<Map<string, CampaignLeverOwners>> {
  const out = new Map<string, CampaignLeverOwners>()
  const ids = [...new Set(campaignIds.filter(Boolean))]
  if (!ids.length || !(await anyBrainEnrolled())) return out
  const ws = business()
  const missing: string[] = []
  for (const id of ids) {
    const hit = recall<CampaignLeverOwners | null>(`${ws}\u0000c\u0000${id}`, OWNERS_TTL_MS)
    if (!hit) missing.push(id)
    else if (hit.value) out.set(id, hit.value)
  }
  if (!missing.length) return out
  const owners = await resolveCampaignOwnership(missing)
  const products = [...new Set([...owners.values()].flatMap((o) => (o.owner.kind === 'none' ? [] : o.productIds)))]
  const enrollments = products.length
    ? await prisma.adsBrainEnrollment.findMany({ where: { productId: { in: products } }, select: { productId: true, marketplace: true } })
    : []
  const enrolled = new Set(enrollments.map((e) => enrollmentKey(e.productId, e.marketplace)))
  const enrolledProducts = [...new Set(enrollments.map((e) => e.productId))]
  // The choices that decide a lever: its level, a lock, an exclusion (a setting's value decides none here).
  const overrides: OverrideRow[] = enrolledProducts.length
    ? await prisma.adsBrainOverride.findMany({
      where: {
        endedAt: null,
        kind: { in: ['LEVEL', 'LOCK', 'EXCLUDE'] },
        OR: [{ scope: 'PRODUCT', productId: { in: enrolledProducts } }, { scope: 'CAMPAIGN', campaignId: { in: missing } }],
      },
      select: OVERRIDE_SELECT,
    })
    : []
  for (const id of missing) {
    const o = owners.get(id)
    const levers = o ? leverHoldsOf(o, enrolled, overrides) : {}
    const value: CampaignLeverOwners | null = o?.market && Object.keys(levers).length ? { campaignId: id, name: o.name, market: o.market, levers } : null
    remember(`${ws}\u0000c\u0000${id}`, value)
    if (value) out.set(id, value)
  }
  return out
}

/**
 * Who holds a portfolio's cap: the product brain that owns the portfolioCap lever of EVERY campaign in it (one product,
 * all of them), or the Owner's lock of that lever on any campaign in it. `portfolioId` is Nexus's portfolio row id or
 * Amazon's portfolio id (Campaign.portfolioId holds Amazon's). Null: nobody holds it (an empty portfolio included).
 */
export async function portfolioCapHold(portfolioId: string): Promise<LeverHold | null> {
  if (!portfolioId || !(await anyBrainEnrolled())) return null
  const key = `${business()}\u0000p\u0000${portfolioId}`
  const hit = recall<LeverHold | null>(key, OWNERS_TTL_MS)
  if (hit) return hit.value
  const row = await prisma.amazonAdsPortfolio.findFirst({ where: { OR: [{ id: portfolioId }, { externalPortfolioId: portfolioId }] }, select: { externalPortfolioId: true } })
  const campaigns = await prisma.campaign.findMany({ where: { portfolioId: row?.externalPortfolioId ?? portfolioId, status: { not: 'ARCHIVED' } }, select: { id: true } })
  const holders = await campaignLeverOwners(campaigns.map((c) => c.id))
  const holds = campaigns.map((c) => holders.get(c.id)?.levers.portfolioCap ?? null)
  const locked = holds.find((h) => h?.kind === 'locked') ?? null
  const owner = holds[0]?.kind === 'owned' ? holds[0] : null
  const owned = owner && holds.every((h) => h?.kind === 'owned' && h.productId === owner.productId && h.market === owner.market) ? owner : null
  const value = locked ?? owned
  remember(key, value)
  return value
}
