/**
 * ONE BRAIN AB-1 — a product's brain in one market (design 2026-10-08-ads-one-brain/DESIGN.md §3, §6, §8, §10): the
 * enrollment (AdsBrainEnrollment) and the Owner's overrides over the brain's defaults (AdsBrainOverride, resolved by
 * brain/settings.ts). The product is its family root (brain/ownership.ts); its own campaigns are the Sponsored Products
 * campaigns of the market that advertise only it; a shared campaign advertises it with another product.
 *
 *   enrollProduct  creates the enrollment. Every lever starts at the brain's default (OBSERVE). The bids lever is
 *                  ADOPTED from the campaigns as they are: when the bid brain already runs one of the product's own
 *                  campaigns (LIVE or HELD) a product override sets it AUTO ("adopted"). Enrolling writes no
 *                  BidBrainEnrollment row: campaigns put LIVE one by one (GALE IT, 2026-10-08) stay exactly as they are.
 *   setOverride    one Owner choice at product or campaign scope (a level, a lock, an exclusion, a setting); it ends
 *                  the open choice it replaces. endOverride ends one (the next level applies again). setLever is the
 *                  product's level of one lever.
 *   bids lever     a choice that changes what the bids lever resolves to (its level, a lock of the whole bids lever, an
 *                  exclusion) moves the BidBrainEnrollment rows of the campaigns it reaches — every own campaign for a
 *                  product choice, that campaign for a campaign choice — with the rules of set-bid-brain-enrollment
 *                  (enrollRefusal):
 *                    resolves AUTO  a campaign not LIVE or HELD goes LIVE (op live: its bids and placements are kept
 *                                   first, in its own snapshot) when it may — allowlisted, no writer the brain does not
 *                                   take over, bids serving; one that may not stays in shadow, named with its reason.
 *                                   LIVE and HELD stay as they are (a hold keeps its end and its snapshot).
 *                    anything else  (OBSERVE, excluded, locked) a LIVE or HELD campaign goes back to shadow (op shadow:
 *                                   bids stay); one that may not (a floor the brain set that no engine would give
 *                                   back) refuses the whole change. An excluded or locked campaign never goes LIVE.
 *                  A shared campaign is never moved (D2 = A): a LIVE row a person set on it stays; the view names it.
 *                  Setting a choice it already has re-applies it (a campaign added since is put LIVE); a run with
 *                  nothing to change writes nothing.
 *   all or nothing one transaction per change; compare-and-set on the enrollment's version.
 *   reads          brainSettings (resolved, with provenance), brainView (settings, campaigns, drift),
 *                  bidBrainRowsByProduct (today's LIVE / HELD rows by product; it changes nothing).
 *
 * Nothing here writes to Amazon. A campaign put LIVE is written by the bid brain's own runs (while the env ceiling
 * NEXUS_BID_BRAIN_MODE is live), exactly as after set-bid-brain-enrollment; bid-brain/live.ts still reads only
 * BidBrainEnrollment. No tool calls this yet (AB-1): the change tool and its approval (enrolling, or a lever to AUTO, is
 * a big door: the approver's code) come in their own PR.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { logger } from '../../../utils/logger.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { enrollmentFacts, enrollRefusal, PLANS_JOIN_THE_BRAIN, setEnrollment, type EnrollMode } from '../bid-brain/enrollment.js'
import { readSnapshots, type BrainLever, type BrainLevel, type LeverSnapshot } from './levers.js'
import { productCampaigns, productFamily, resolveCampaignOwnership } from './ownership.js'
import {
  EXCLUDE_KEY, overrideIdentity, resolveBrainSettings, validateIdentity, validateOverride, type BrainSettings, type LeverSettings, type OverrideInput,
  type OverrideKind, type OverrideRow,
} from './settings.js'

const OWNED_MODES: readonly EnrollMode[] = ['LIVE', 'HELD']
const isOwnedMode = (m: EnrollMode | null): boolean => m != null && OWNED_MODES.includes(m)

// ── The bids lever: a plan over the product's own campaigns (pure) ──────────────────────────────────────────────

/** One own campaign as the bids lever sees it. */
export interface BidsCampaignState {
  campaignId: string
  name: string
  status: string
  /** Its BidBrainEnrollment mode; null = no row (shadow). */
  mode: EnrollMode | null
  /** What the bids lever resolves to on it (brain/settings.ts): AUTO, or why not (OBSERVE, excluded, locked …). */
  want: 'AUTO' | 'NOT'
  wantWhy?: string
  /** Why it cannot go LIVE now (it wants AUTO and is in shadow); null = it can, or not asked. */
  liveRefusal?: string | null
  /** Why it cannot go back to shadow now (it does not want AUTO and is LIVE or HELD); null = it can, or not asked. */
  shadowRefusal?: string | null
}

export type BidsStep =
  | { campaignId: string; name: string; op: 'live' }
  | { campaignId: string; name: string; op: 'shadow'; why: string }
  | { campaignId: string; name: string; op: 'keep'; mode: EnrollMode | null }
  | { campaignId: string; name: string; op: 'skip'; why: string }

/** The bids lever's level as the campaigns hold it: AUTO when the bid brain runs one of them, else OBSERVE. */
export function adoptedBidsLevel(own: ReadonlyArray<Pick<BidsCampaignState, 'mode'>>): 'AUTO' | 'OBSERVE' {
  return own.some((c) => isOwnedMode(c.mode)) ? 'AUTO' : 'OBSERVE'
}

/** Which check a campaign needs (enrollRefusal): only the ones that would move. */
export function needsCheck(want: 'AUTO' | 'NOT', mode: EnrollMode | null): 'live' | 'shadow' | null {
  if (want === 'AUTO') return isOwnedMode(mode) ? null : 'live'
  return isOwnedMode(mode) ? 'shadow' : null
}

/**
 * What the bids lever does to each campaign it reaches. Wanting AUTO: a campaign in shadow goes LIVE, or stays with its
 * reason; LIVE and HELD stay. Not wanting it: LIVE and HELD go back to shadow; one that cannot refuses the whole change.
 */
export function planBids(campaigns: readonly BidsCampaignState[]): { steps: BidsStep[] } | { refusal: string } {
  const steps: BidsStep[] = []
  const stuck: string[] = []
  for (const c of campaigns) {
    const check = needsCheck(c.want, c.mode)
    if (!check) steps.push({ campaignId: c.campaignId, name: c.name, op: 'keep', mode: c.mode })
    else if (check === 'live') steps.push(c.liveRefusal ? { campaignId: c.campaignId, name: c.name, op: 'skip', why: c.liveRefusal } : { campaignId: c.campaignId, name: c.name, op: 'live' })
    else if (c.shadowRefusal) stuck.push(c.shadowRefusal)
    else steps.push({ campaignId: c.campaignId, name: c.name, op: 'shadow', why: c.wantWhy ?? 'the bids lever does not run it' })
  }
  if (stuck.length) return { refusal: `the bid brain cannot leave these campaigns now: ${stuck.join(' ')}` }
  return { steps }
}

/** True when a plan moves at least one campaign. */
export const planMoves = (steps: readonly BidsStep[]): boolean => steps.some((s) => s.op === 'live' || s.op === 'shadow')

/** What the bids lever's snapshot keeps when it puts campaigns LIVE: the ones it put LIVE, the ones LIVE already, the skipped. */
export interface BidsLeverSnapshot {
  enrolled: string[]
  alreadyLive: string[]
  skipped: Array<{ campaignId: string; why: string }>
}

export function bidsSnapshotOf(steps: readonly BidsStep[]): BidsLeverSnapshot {
  return {
    enrolled: steps.filter((s) => s.op === 'live').map((s) => s.campaignId),
    alreadyLive: steps.flatMap((s) => (s.op === 'keep' && isOwnedMode(s.mode) ? [s.campaignId] : [])),
    skipped: steps.flatMap((s) => (s.op === 'skip' ? [{ campaignId: s.campaignId, why: s.why }] : [])),
  }
}

/** Does this choice change what the bids lever resolves to? (its level, a lock of the whole bids lever, an exclusion) */
export const touchesBids = (o: { kind: string; key: string; ref?: string | null }): boolean =>
  (o.kind === 'LEVEL' && o.key === 'bids') || (o.kind === 'LOCK' && o.key === 'bids' && !o.ref) || o.kind === 'EXCLUDE'

/** The bids lever on one campaign, from its resolved settings. */
export function bidsWant(bids: LeverSettings): { want: 'AUTO' | 'NOT'; why: string } {
  return bids.effective === 'AUTO' ? { want: 'AUTO', why: bids.why } : { want: 'NOT', why: bids.why }
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A refusal the service answers instead of writing (thrown inside a transaction to roll it back). */
export class BrainRefusal extends Error {}

/** The market as enrollments store it ('IT'); null when it is not a market code. */
function marketOf(market: string): string | null {
  const m = strategyMarket(market)
  return m && /^[A-Z]{2}$/.test(m) ? m : null
}

const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const

/** The open overrides of a product × market and of these campaigns (one query). */
async function openOverrides(productId: string, market: string, campaignIds: readonly string[]): Promise<OverrideRow[]> {
  return prisma.adsBrainOverride.findMany({
    where: { endedAt: null, OR: [{ scope: 'PRODUCT', productId, marketplace: market }, ...(campaignIds.length ? [{ scope: 'CAMPAIGN', campaignId: { in: [...campaignIds] } }] : [])] },
    select: OVERRIDE_SELECT,
  })
}

/** The product's own and shared campaigns in the market, with each one's BidBrainEnrollment mode. */
async function campaignsOf(productId: string, market: string) {
  const found = await productCampaigns(productId, market)
  if (!found) return null
  const ids = [...found.owned, ...found.shared].map((c) => c.campaignId)
  const rows = ids.length ? await prisma.bidBrainEnrollment.findMany({ where: { campaignId: { in: ids } }, select: { campaignId: true, mode: true } }) : []
  const modeOf = new Map(rows.map((r) => [r.campaignId, r.mode as EnrollMode]))
  const row = (c: (typeof found.owned)[number]) => ({ campaignId: c.campaignId, name: c.name, status: c.status, mode: modeOf.get(c.campaignId) ?? null, productIds: c.productIds, unresolved: c.unresolved })
  return { root: found.root, own: found.owned.map(row), shared: found.shared.map(row) }
}

/** Ask enrollRefusal for each campaign the change would move (the per-campaign tool's facts and rules, unchanged). */
async function withChecks(campaigns: readonly BidsCampaignState[]): Promise<BidsCampaignState[]> {
  const out: BidsCampaignState[] = []
  for (const c of campaigns) {
    const op = needsCheck(c.want, c.mode)
    if (!op) { out.push(c); continue }
    const facts = await enrollmentFacts(c.campaignId, { plansJoin: PLANS_JOIN_THE_BRAIN })
    const refusal = facts ? enrollRefusal(facts, op) : `${c.name} is no longer in this business`
    out.push(op === 'live' ? { ...c, liveRefusal: refusal } : { ...c, shadowRefusal: refusal })
  }
  return out
}

/** The brain's settings for a product in a market (and one campaign), resolved with where each value comes from. Null: no product. */
export async function brainSettings(productId: string, market: string, campaignId?: string | null): Promise<BrainSettings | null> {
  const m = marketOf(market)
  if (!m) return null
  const family = await productFamily(productId)
  if (!family) return null
  const [enrollment, overrides] = await Promise.all([
    prisma.adsBrainEnrollment.findFirst({ where: { productId: family.root, marketplace: m }, select: { id: true } }),
    openOverrides(family.root, m, campaignId ? [campaignId] : []),
  ])
  return resolveBrainSettings({ productId: family.root, market: m, campaignId: campaignId ?? null, enrolled: !!enrollment, overrides })
}

export interface BrainCampaignView {
  campaignId: string
  name: string
  status: string
  owner: 'product' | 'shared'
  productIds: string[]
  /** Its BidBrainEnrollment mode; null = no row (shadow). */
  mode: EnrollMode | null
  excluded: BrainSettings['excluded']
  /** The bids lever resolved on this campaign. */
  bids: LeverSettings
  /** The Owner's open overrides on this campaign. */
  overrides: number
}

export interface BrainView {
  productId: string
  market: string
  enrolled: boolean
  version: number | null
  enrolledBy: string | null
  updatedBy: string | null
  updatedAt: string | null
  snapshots: Partial<Record<BrainLever, LeverSnapshot>>
  /** The product-level settings (no campaign), with provenance. */
  settings: BrainSettings
  campaigns: BrainCampaignView[]
  /** The bids lever as the campaigns hold it (adoptedBidsLevel over the own campaigns). */
  bidsAsCampaigns: 'AUTO' | 'OBSERVE'
  /** Where BidBrainEnrollment differs from what the settings resolve to, and overrides on campaigns that left the product. */
  drift: string[]
}

const names = (list: ReadonlyArray<{ name: string }>) => list.map((c) => c.name).join(', ')
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The product's brain in the market: enrollment, settings, campaigns and drift. Null: no product or no market. */
export async function brainView(productId: string, market: string): Promise<BrainView | null> {
  const m = marketOf(market)
  if (!m) return null
  const camps = await campaignsOf(productId, m)
  if (!camps) return null
  const all = [...camps.own.map((c) => ({ ...c, owner: 'product' as const })), ...camps.shared.map((c) => ({ ...c, owner: 'shared' as const }))]
  const [row, overrides, strayRows] = await Promise.all([
    prisma.adsBrainEnrollment.findFirst({ where: { productId: camps.root, marketplace: m } }),
    openOverrides(camps.root, m, all.map((c) => c.campaignId)),
    prisma.adsBrainOverride.findMany({ where: { endedAt: null, scope: 'CAMPAIGN', productId: camps.root, marketplace: m, campaignId: { notIn: all.map((c) => c.campaignId) } }, select: { campaignId: true } }),
  ])
  const enrolled = !!row
  const resolve = (campaignId: string | null) => resolveBrainSettings({ productId: camps.root, market: m, campaignId, enrolled, overrides })
  const campaigns: BrainCampaignView[] = all.map((c) => {
    const s = resolve(c.campaignId)
    return {
      campaignId: c.campaignId, name: c.name, status: c.status, owner: c.owner, productIds: c.productIds, mode: c.mode,
      excluded: s.excluded, bids: s.levers.bids, overrides: overrides.filter((o) => o.scope === 'CAMPAIGN' && o.campaignId === c.campaignId).length,
    }
  })
  const drift: string[] = []
  if (enrolled) {
    const waiting = campaigns.filter((c) => c.owner === 'product' && c.bids.effective === 'AUTO' && !isOwnedMode(c.mode))
    if (waiting.length) drift.push(`${count(waiting.length, 'own campaign is', 'own campaigns are')} not LIVE although bids resolve to AUTO (${names(waiting)}): set the bids lever again to put the ones that may go LIVE`)
    const stray = campaigns.filter((c) => c.owner === 'product' && c.bids.effective !== 'AUTO' && isOwnedMode(c.mode))
    if (stray.length) drift.push(`${count(stray.length, 'own campaign is', 'own campaigns are')} LIVE although bids resolve to ${[...new Set(stray.map((c) => c.bids.effective))].join(' / ')} (${names(stray)}): put LIVE one by one`)
  }
  const sharedLive = campaigns.filter((c) => c.owner === 'shared' && isOwnedMode(c.mode))
  if (sharedLive.length) drift.push(`${count(sharedLive.length, 'shared campaign is', 'shared campaigns are')} LIVE by a per-campaign enrollment (${names(sharedLive)}): no product's lever moves ${sharedLive.length === 1 ? 'it' : 'them'}`)
  const left = [...new Set(strayRows.map((r) => r.campaignId).filter((id): id is string => !!id))]
  if (left.length) drift.push(`the Owner's overrides on ${count(left.length, 'campaign')} that no longer ${left.length === 1 ? 'advertises' : 'advertise'} this product here (${left.join(', ')}): they still apply to ${left.length === 1 ? 'that campaign' : 'those campaigns'}`)
  return {
    productId: camps.root, market: m, enrolled, version: row?.version ?? null, enrolledBy: row?.enrolledBy ?? null,
    updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt.toISOString() ?? null, snapshots: readSnapshots(row?.snapshots),
    settings: resolve(null), campaigns, bidsAsCampaigns: adoptedBidsLevel(camps.own), drift,
  }
}

/**
 * Today's LIVE and HELD BidBrainEnrollment rows by owner (a read: it maps the rows set per campaign — GALE IT's ten —
 * and changes none): per product and market the campaigns and whether the product is enrolled; the shared and the
 * unowned campaigns apart.
 */
export async function bidBrainRowsByProduct(market?: string): Promise<{
  products: Array<{ productId: string; market: string; campaignIds: string[]; enrolled: boolean }>
  shared: Array<{ campaignId: string; market: string | null; productIds: string[] }>
  none: Array<{ campaignId: string; market: string | null }>
}> {
  const m = market ? marketOf(market) : null
  if (market && !m) return { products: [], shared: [], none: [] }
  const rows = (await prisma.bidBrainEnrollment.findMany({ where: { mode: { in: [...OWNED_MODES] } }, select: { campaignId: true, marketplace: true } }))
    .filter((r) => !m || strategyMarket(r.marketplace) === m)
  const owners = await resolveCampaignOwnership(rows.map((r) => r.campaignId))
  const byProduct = new Map<string, { productId: string; market: string; campaignIds: string[] }>()
  const shared: Array<{ campaignId: string; market: string | null; productIds: string[] }> = []
  const none: Array<{ campaignId: string; market: string | null }> = []
  for (const r of rows) {
    const o = owners.get(r.campaignId)
    const rowMarket = o?.market ?? strategyMarket(r.marketplace)
    if (o?.owner.kind === 'product' && rowMarket) {
      const key = `${o.owner.productId}\u0000${rowMarket}`
      const g = byProduct.get(key) ?? { productId: o.owner.productId, market: rowMarket, campaignIds: [] }
      g.campaignIds.push(r.campaignId)
      byProduct.set(key, g)
    } else if (o?.owner.kind === 'shared') shared.push({ campaignId: r.campaignId, market: rowMarket, productIds: o.owner.productIds })
    else none.push({ campaignId: r.campaignId, market: rowMarket })
  }
  const groups = [...byProduct.values()]
  const enrollments = groups.length
    ? await prisma.adsBrainEnrollment.findMany({ where: { productId: { in: [...new Set(groups.map((g) => g.productId))] } }, select: { productId: true, marketplace: true } })
    : []
  const enrolled = new Set(enrollments.map((e) => `${e.productId}\u0000${e.marketplace}`))
  return {
    products: groups
      .map((g) => ({ ...g, campaignIds: g.campaignIds.sort(), enrolled: enrolled.has(`${g.productId}\u0000${g.market}`) }))
      .sort((a, b) => a.market.localeCompare(b.market) || a.productId.localeCompare(b.productId)),
    shared: shared.sort((a, b) => a.campaignId.localeCompare(b.campaignId)),
    none: none.sort((a, b) => a.campaignId.localeCompare(b.campaignId)),
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Result<T> = ({ ok: true } & T) | { ok: false; refusal: string }

async function refusing<T>(work: () => Promise<{ ok: true } & T>): Promise<Result<T>> {
  try {
    return await work()
  } catch (e) {
    if (e instanceof BrainRefusal) return { ok: false, refusal: e.message }
    throw e
  }
}

const json = (v: unknown) => v as Prisma.InputJsonValue
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** The market code and the product's family root a change is about (a variation names its parent's enrollment). */
async function scopeOf(productId: string, market: string): Promise<{ root: string; market: string }> {
  const m = marketOf(market)
  if (!m) throw new BrainRefusal(`${market} is not a market code`)
  const family = await productFamily(productId)
  if (!family) throw new BrainRefusal(`product ${productId} is not a live product of this business with one family (a product whose ASIN variations of several families carry has no family until it is fixed)`)
  return { root: family.root, market: m }
}

/** The enrollment, read inside the transaction; refuses when there is none or its version moved since `expectVersion`. */
async function currentRow(productId: string, market: string, expectVersion?: number) {
  const row = await prisma.adsBrainEnrollment.findFirst({ where: { productId, marketplace: market } })
  if (!row) throw new BrainRefusal(`the product is not enrolled in the brain for ${market} yet`)
  if (expectVersion != null && row.version !== expectVersion) throw new BrainRefusal(`the product's brain for ${market} changed since it was read (version ${row.version}, not ${expectVersion}): read it again`)
  return row
}

/** Bump the enrollment's version only if nobody changed it since it was read (compare-and-set). */
async function writeRow(row: { id: string; version: number }, data: Prisma.AdsBrainEnrollmentUpdateManyMutationInput, by: string): Promise<number> {
  const moved = await prisma.adsBrainEnrollment.updateMany({ where: { id: row.id, version: row.version }, data: { ...data, version: { increment: 1 }, updatedBy: by } })
  if (!moved.count) throw new BrainRefusal('the product\'s brain changed while this change ran: nothing changed, read it again')
  return row.version + 1
}

/** Enroll a product in one market: every lever at the brain's default, the bids lever adopted from its campaigns (no campaign row written). */
export async function enrollProduct(args: { productId: string; market: string; by: string; now?: Date }): Promise<Result<{ productId: string; market: string; bids: 'AUTO' | 'OBSERVE'; version: number; adoptedLive: string[] }>> {
  const now = args.now ?? new Date()
  const done = await refusing(() => inDatabaseTransaction(prisma, async () => {
    const { root, market } = await scopeOf(args.productId, args.market)
    const camps = await campaignsOf(root, market)
    if (!camps) throw new BrainRefusal(`product ${args.productId} is no longer a live product of this business`)
    const bids = adoptedBidsLevel(camps.own)
    const adoptedLive = camps.own.filter((c) => isOwnedMode(c.mode)).map((c) => c.campaignId)
    const existing = await prisma.adsBrainEnrollment.findFirst({ where: { productId: root, marketplace: market }, select: { id: true } })
    if (existing) throw new BrainRefusal(`the product is already enrolled in the brain for ${market}`)
    const row = await prisma.adsBrainEnrollment.create({
      data: {
        productId: root, marketplace: market, enrolledBy: args.by, updatedBy: args.by,
        ...(bids === 'AUTO' ? { snapshots: json({ bids: { takenAt: now.toISOString(), by: args.by, data: { enrolled: [], alreadyLive: adoptedLive, skipped: [] } satisfies BidsLeverSnapshot } }) } : {}),
      },
      select: { version: true },
    }).catch((e: { code?: string }) => {
      if (e?.code === 'P2002') throw new BrainRefusal(`the product is already enrolled in the brain for ${market}`)
      throw e
    })
    if (bids === 'AUTO') {
      await prisma.adsBrainOverride.create({
        data: {
          productId: root, marketplace: market, scope: 'PRODUCT', kind: 'LEVEL', key: 'bids', value: 'AUTO', by: args.by,
          reason: `adopted at enrollment: the bid brain already runs ${count(adoptedLive.length, 'own campaign')} LIVE (${adoptedLive.join(', ')})`,
        },
      })
    }
    return { ok: true as const, productId: root, market, bids, version: row.version, adoptedLive }
  }))
  if (done.ok) logger.info('[ads-brain] product enrolled', { productId: done.productId, market: done.market, by: args.by, bids: done.bids, adoptedLive: done.adoptedLive })
  return done
}

export interface OverridePlan {
  productId: string
  market: string
  /** The override to store (null when an open one already says the same, or for an end). */
  set: { scope: string; campaignId: string | null; kind: OverrideKind; key: string; ref: string; value: unknown } | null
  /** The open override it ends (replaced, or ended on request), if any. */
  ends: string | null
  /** Bids lever only: what happens to each campaign the choice reaches; the shared ones are never moved. */
  steps?: BidsStep[]
  /** Nothing would change (the same choice, and no campaign to move). */
  unchanged: boolean
}

type Change = { op: 'set'; input: OverrideInput } | { op: 'end'; input: Pick<OverrideInput, 'scope' | 'campaignId' | 'kind' | 'key' | 'ref'> }

/** The plan of one change, read now (inside the change's transaction when it runs). */
async function changePlan(root: string, market: string, change: Change): Promise<OverridePlan> {
  // A set checks its value too; an end needs only what it ends.
  const valid = change.op === 'set' ? validateOverride(change.input) : validateIdentity(change.input)
  if ('refusal' in valid) throw new BrainRefusal(valid.refusal)
  const identity = 'override' in valid ? valid.override : valid.identity
  const camps = await campaignsOf(root, market)
  if (!camps) throw new BrainRefusal(`product ${root} is no longer a live product of this business`)
  const reach = identity.scope === 'CAMPAIGN' ? [...camps.own, ...camps.shared].filter((c) => c.campaignId === identity.campaignId) : camps.own
  if (identity.scope === 'CAMPAIGN' && !reach.length && change.op === 'set') throw new BrainRefusal(`campaign ${identity.campaignId} does not advertise this product in ${market} (archived campaigns and other ad products are left out)`)
  // The campaign named is read too when it no longer advertises the product: its override can still be ended.
  const campaignIds = [...new Set([...camps.own, ...camps.shared].map((c) => c.campaignId).concat(identity.campaignId ? [identity.campaignId] : []))]
  const overrides = await openOverrides(root, market, campaignIds)
  const key = overrideIdentity(identity)
  const open = overrides.filter((o) => overrideIdentity(o) === key).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null
  let after: OverrideRow[]
  let set: OverridePlan['set'] = null
  if (change.op === 'set') {
    const value = 'override' in valid ? valid.override.value : null
    if (open && sameValue(open.value, value)) after = overrides
    else {
      set = { scope: identity.scope, campaignId: identity.campaignId, kind: identity.kind, key: identity.key, ref: identity.ref, value }
      after = [...overrides.filter((o) => o.id !== open?.id), { ...set, id: 'new', productId: root, marketplace: market, by: '', reason: null, createdAt: new Date(), endedAt: null }]
    }
  } else {
    if (!open) throw new BrainRefusal(`there is no open ${identity.kind.toLowerCase()} override of ${identity.key}${identity.ref ? ` (${identity.ref})` : ''} at ${identity.scope.toLowerCase()} scope${identity.campaignId ? ` on campaign ${identity.campaignId}` : ''}`)
    after = overrides.filter((o) => o.id !== open.id)
  }
  const ends = set || change.op === 'end' ? open?.id ?? null : null
  if (!touchesBids(identity)) return { productId: root, market, set, ends, unchanged: !set && !ends }
  // The bids lever: what it resolves to on each own campaign the choice reaches, after the change. Shared: never moved.
  const own = reach.filter((c) => camps.own.some((o) => o.campaignId === c.campaignId))
  const wanted: BidsCampaignState[] = own.map((c) => {
    const w = bidsWant(resolveBrainSettings({ productId: root, market, campaignId: c.campaignId, enrolled: true, overrides: after }).levers.bids)
    return { campaignId: c.campaignId, name: c.name, status: c.status, mode: c.mode, want: w.want, wantWhy: w.why }
  })
  const planned = planBids(await withChecks(wanted))
  if ('refusal' in planned) throw new BrainRefusal(planned.refusal)
  return { productId: root, market, set, ends, steps: planned.steps, unchanged: !set && !ends && !planMoves(planned.steps) }
}

/** Run one change: end the replaced override, store the new one, move the bids lever's campaigns, bump the version. */
async function runChange(args: { productId: string; market: string; by: string; reason?: string | null; expectVersion?: number; now?: Date }, change: Change): Promise<Result<{ plan: OverridePlan; version: number }>> {
  const now = args.now ?? new Date()
  const done = await refusing(() => inDatabaseTransaction(prisma, async () => {
    const { root, market } = await scopeOf(args.productId, args.market)
    const row = await currentRow(root, market, args.expectVersion)
    const plan = await changePlan(root, market, change)
    if (plan.unchanged) return { ok: true as const, plan, version: row.version }
    if (plan.ends) {
      const ended = await prisma.adsBrainOverride.updateMany({ where: { id: plan.ends, endedAt: null }, data: { endedAt: now, endedBy: args.by } })
      if (!ended.count) throw new BrainRefusal('the override changed while this change ran: nothing changed, read it again')
    }
    if (plan.set) {
      await prisma.adsBrainOverride.create({
        data: { productId: root, marketplace: market, scope: plan.set.scope, campaignId: plan.set.campaignId, kind: plan.set.kind, key: plan.set.key, ref: plan.set.ref, value: plan.set.value === null ? undefined : json(plan.set.value), by: args.by, reason: args.reason?.slice(0, 500) ?? null },
      })
    }
    for (const s of plan.steps ?? []) {
      if (s.op === 'live') await setEnrollment({ campaignId: s.campaignId, marketplace: market, op: 'live', by: args.by, reason: args.reason ?? 'the product\'s bids lever resolves to AUTO', now })
      if (s.op === 'shadow') await setEnrollment({ campaignId: s.campaignId, marketplace: market, op: 'shadow', by: args.by, reason: args.reason ?? s.why, now })
    }
    // The bids lever's snapshot: taken whenever it puts a campaign LIVE.
    const snapshot = plan.steps?.some((s) => s.op === 'live') ? { takenAt: now.toISOString(), by: args.by, data: bidsSnapshotOf(plan.steps) } : null
    const version = await writeRow(row, snapshot ? { snapshots: json({ ...readSnapshots(row.snapshots), bids: snapshot }) } : {}, args.by)
    return { ok: true as const, plan, version }
  }))
  if (done.ok && !done.plan.unchanged) {
    const steps = done.plan.steps
    logger.info('[ads-brain] override changed', {
      productId: done.plan.productId, market: done.plan.market, change: change.op, scope: change.input.scope, campaignId: change.input.campaignId ?? null,
      kind: change.input.kind, key: change.input.key, by: args.by,
      ...(steps ? { live: steps.filter((s) => s.op === 'live').length, shadow: steps.filter((s) => s.op === 'shadow').length, skipped: steps.filter((s) => s.op === 'skip').length } : {}),
    })
  }
  return done
}

/** What a change would do now, without changing anything (the preview a change tool shows). */
export async function planOverride(args: { productId: string; market: string } & ({ set: OverrideInput } | { end: Change['input'] })): Promise<Result<{ plan: OverridePlan; version: number }>> {
  return refusing(async () => {
    const { root, market } = await scopeOf(args.productId, args.market)
    const row = await currentRow(root, market)
    const change: Change = 'set' in args ? { op: 'set', input: args.set } : { op: 'end', input: args.end }
    return { ok: true as const, plan: await changePlan(root, market, change), version: row.version }
  })
}

/** Set one Owner choice (it ends the open one it replaces). All or nothing. */
export async function setOverride(args: { productId: string; market: string; override: OverrideInput; by: string; reason?: string | null; expectVersion?: number; now?: Date }) {
  return runChange(args, { op: 'set', input: args.override })
}

/** End one Owner choice: the next level (product, then the brain's default) applies again. All or nothing. */
export async function endOverride(args: { productId: string; market: string; override: Change['input']; by: string; reason?: string | null; expectVersion?: number; now?: Date }) {
  return runChange(args, { op: 'end', input: args.override })
}

/** The product's level of one lever (a PRODUCT LEVEL override). */
export async function setLever(args: { productId: string; market: string; lever: BrainLever; level: BrainLevel; by: string; reason?: string | null; expectVersion?: number; now?: Date }) {
  return runChange(args, { op: 'set', input: { scope: 'PRODUCT', kind: 'LEVEL', key: args.lever, value: args.level } })
}

export { EXCLUDE_KEY }
