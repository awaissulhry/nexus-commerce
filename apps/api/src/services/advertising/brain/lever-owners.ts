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
 *   errors    an infrastructure error is never a refusal (review of #523): a read that fails answers the last answer
 *             this process knew for that business, campaign or portfolio, whatever its age (logged), and throws only when
 *             it never had one. The gate lets that error out exactly as any other failed read in it: the ads worker leaves
 *             the row to be reclaimed and sent again, a pre-ask's caller sees the error — never a SKIPPED write.
 */
import prisma from '../../../db.js'
import { LEGACY_WORKSPACE_ID, workspaceContext } from '../../../lib/workspace-context.js'
import { logger } from '../../../utils/logger.js'
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

/** Answers per business, campaign and portfolio. A stale one is kept: it is what a failed read answers. */
const memory = new Map<string, { at: number; value: unknown }>()
/** "Is anything enrolled?" per business, apart: never dropped by the size bound, so a failed read always has it. */
const enrolledMemory = new Map<string, { at: number; value: boolean }>()
const business = (): string => workspaceContext()?.workspaceId ?? LEGACY_WORKSPACE_ID

/** The answer remembered for `key` if it is younger than `ttlMs` (Infinity: any age, the fallback of a failed read). */
function recall<T>(key: string, ttlMs: number, from: Map<string, { at: number; value: unknown }> = memory): { value: T } | null {
  const hit = from.get(key)
  if (!hit || Date.now() - hit.at > ttlMs) return null
  return { value: hit.value as T }
}

function remember(key: string, value: unknown): void {
  if (memory.size >= MAX_REMEMBERED && !memory.has(key)) memory.clear()
  memory.set(key, { at: Date.now(), value })
}

/** Forget every remembered answer, stale ones included (a change of a brain in this process, and tests). */
export function forgetLeverOwners(): void {
  memory.clear()
  enrolledMemory.clear()
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Is any product enrolled in this business? One query, remembered ENROLLED_TTL_MS. A failed read answers the last answer
 * known (any age); with none it throws.
 */
export async function anyBrainEnrolled(): Promise<boolean> {
  const key = business()
  const hit = recall<boolean>(key, ENROLLED_TTL_MS, enrolledMemory)
  if (hit) return hit.value
  try {
    const row = await prisma.adsBrainEnrollment.findFirst({ select: { id: true } })
    enrolledMemory.set(key, { at: Date.now(), value: !!row })
    return !!row
  } catch (err) {
    const last = recall<boolean>(key, Infinity, enrolledMemory)
    if (!last) throw err
    logger.warn('[ads-brain] could not read whether a product is enrolled — the last answer known stands', { workspaceId: key, enrolled: last.value, error: errorText(err) })
    return last.value
  }
}

const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const

/** The reads behind campaignLeverOwners: the owners (≤ 4 queries), the enrollments and the deciding overrides (1 each). */
async function readCampaigns(ids: readonly string[]): Promise<{ owners: Map<string, CampaignOwnership>; enrolled: Set<string>; overrides: OverrideRow[] }> {
  const owners = await resolveCampaignOwnership(ids)
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
        OR: [{ scope: 'PRODUCT', productId: { in: enrolledProducts } }, { scope: 'CAMPAIGN', campaignId: { in: [...ids] } }],
      },
      select: OVERRIDE_SELECT,
    })
    : []
  return { owners, enrolled, overrides }
}

/**
 * Who holds the levers of these campaigns (only the campaigns someone holds a lever of are in the map). Nothing enrolled
 * in the business: one remembered query and an empty map. Otherwise a fixed number of queries for the campaigns not
 * remembered. A failed read answers the last answers known; it throws when a campaign never had one.
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
  let read: { owners: Map<string, CampaignOwnership>; enrolled: Set<string>; overrides: OverrideRow[] }
  try {
    read = await readCampaigns(missing)
  } catch (err) {
    // A failed read: the last answer known for each campaign (any age); one never answered → the error goes on.
    const last = missing.map((id) => [id, recall<CampaignLeverOwners | null>(`${ws}\u0000c\u0000${id}`, Infinity)] as const)
    if (last.some(([, hit]) => !hit)) throw err
    logger.warn('[ads-brain] could not read who holds these campaigns\' levers — the last answers known stand', { campaignIds: missing, error: errorText(err) })
    for (const [id, hit] of last) if (hit?.value) out.set(id, hit.value)
    return out
  }
  const { owners, enrolled, overrides } = read
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
 * Amazon's portfolio id (Campaign.portfolioId holds Amazon's). Null: nobody holds it (an empty portfolio included). A
 * failed read answers the last answer known for the portfolio; it throws when there was none.
 */
export async function portfolioCapHold(portfolioId: string): Promise<LeverHold | null> {
  if (!portfolioId || !(await anyBrainEnrolled())) return null
  const key = `${business()}\u0000p\u0000${portfolioId}`
  const hit = recall<LeverHold | null>(key, OWNERS_TTL_MS)
  if (hit) return hit.value
  let campaigns: Array<{ id: string }>
  let holders: Map<string, CampaignLeverOwners>
  try {
    const row = await prisma.amazonAdsPortfolio.findFirst({ where: { OR: [{ id: portfolioId }, { externalPortfolioId: portfolioId }] }, select: { externalPortfolioId: true } })
    campaigns = await prisma.campaign.findMany({ where: { portfolioId: row?.externalPortfolioId ?? portfolioId, status: { not: 'ARCHIVED' } }, select: { id: true } })
    holders = await campaignLeverOwners(campaigns.map((c) => c.id))
  } catch (err) {
    // A failed read: the last answer known for this portfolio (any age); never answered → the error goes on.
    const last = recall<LeverHold | null>(key, Infinity)
    if (!last) throw err
    logger.warn('[ads-brain] could not read who holds this portfolio\'s cap — the last answer known stands', { portfolioId, error: errorText(err) })
    return last.value
  }
  const holds = campaigns.map((c) => holders.get(c.id)?.levers.portfolioCap ?? null)
  const locked = holds.find((h) => h?.kind === 'locked') ?? null
  const owner = holds[0]?.kind === 'owned' ? holds[0] : null
  const owned = owner && holds.every((h) => h?.kind === 'owned' && h.productId === owner.productId && h.market === owner.market) ? owner : null
  const value = locked ?? owned
  remember(key, value)
  return value
}
