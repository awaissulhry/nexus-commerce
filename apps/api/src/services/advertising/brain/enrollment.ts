/**
 * ONE BRAIN AB-1 — a product's brain in one market (design 2026-10-08-ads-one-brain/DESIGN.md §3, §6, §8, §10): the
 * enrollment (AdsBrainEnrollment) and the Owner's overrides over the brain's defaults (AdsBrainOverride, resolved by
 * brain/settings.ts). The product is its family root (brain/ownership.ts); its own campaigns are the Sponsored Products
 * campaigns of the market that advertise only it; a shared campaign advertises it with another product.
 *
 *   enrollProduct  creates the enrollment. Every lever starts at the brain's default (OBSERVE). The bids lever is
 *                  ADOPTED from the campaigns as they are: when the bid brain already runs one of the product's own
 *                  campaigns (LIVE or HELD) a product override sets it AUTO ("adopted"), and each own campaign still in
 *                  shadow gets a campaign override OBSERVE ("adopted"), so nothing goes LIVE later behind the Owner's
 *                  back. Enrolling writes no BidBrainEnrollment row: campaigns put LIVE one by one (GALE IT, 2026-10-08)
 *                  stay exactly as they are.
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
 *                  A shared campaign never goes LIVE from here (D2 = A). It goes back to shadow only when the Owner keeps
 *                  the bid brain off it (an exclusion, or a lock of its whole bids lever): an exclusion wins. Otherwise
 *                  a LIVE row a person set on it stays, and the view names it.
 *                  Setting a choice it already has re-applies it (a campaign added since is put LIVE); a run with
 *                  nothing to change writes nothing.
 *   all or nothing one Serializable transaction per change; compare-and-set on the enrollment's version, and on the
 *                  plan's basis (planBasis: what it stores, ends and does to each campaign) when the approval names one.
 *   big door       a plan that puts any campaign LIVE (`goesLive`) needs the approver's code (`needsCode`), whatever
 *                  kind of change does it — ending an exclusion, a lock or an adopted OBSERVE included.
 *   by hand        set-bid-brain-enrollment op live / shadow / give-back is recorded as a campaign override
 *                  (recordCampaignBidsChoice), and op live / release is refused on a campaign the Owner keeps off
 *                  the bid brain (brain/owner-brakes.ts).
 *   Amazon's rules AB-4 (design §2.12) — a change that takes a lever to AUTO on one of the product's own campaigns is
 *                  refused while one of Amazon's own rules acts on that lever there (an Amazon budget rule on budgets, a
 *                  bidding strategy Amazon runs on bids): two brains on one lever. A campaign the change would put LIVE
 *                  only as a side effect (its bids resolved AUTO before it too) is a named skip instead, and the rest
 *                  of the plan runs; a step back to shadow (and a give-back) is never checked.
 *                  Read from the daily snapshot and the synced strategy (brain/native-rules.ts); a kind Nexus could not
 *                  read refuses nothing. Enrolling refuses nothing either: it adopts what already runs, and the map shows
 *                  the clash.
 *   reads          brainSettings (resolved, with provenance), brainView (settings, campaigns, drift),
 *                  bidBrainRowsByProduct (today's LIVE / HELD rows by product; it changes nothing).
 *
 * Nothing here writes to Amazon. A campaign put LIVE is written by the bid brain's own runs (while the env ceiling
 * NEXUS_BID_BRAIN_MODE is live), exactly as after set-bid-brain-enrollment; bid-brain/live.ts still reads only
 * BidBrainEnrollment. No tool calls this yet (AB-1): the change tool and its approval (enrolling, or a lever to AUTO, is
 * a big door: the approver's code) come in their own PR.
 */
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { logger } from '../../../utils/logger.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { enrollmentFacts, enrollRefusal, PLANS_JOIN_THE_BRAIN, setEnrollment, type EnrollMode } from '../bid-brain/enrollment.js'
import { giveBackStopMemory } from '../bid-brain/stop-memory.js'
import type { AdsActor } from '../ads-mutation.service.js'
import { BRAIN_LEVERS, readSnapshots, type BrainLever, type BrainLevel, type LeverSnapshot } from './levers.js'
import { loadNativeRules, nativeAutoRefusal, nativeRuleLines } from './native-rules.js'
import { productCampaigns, productFamily, resolveCampaignOwnership } from './ownership.js'
import {
  EXCLUDE_KEY, overrideIdentity, resolveBrainSettings, settingsPairRefusal, validateIdentity, validateOverride, type BrainSettings, type LeverSettings,
  type OverrideInput, type OverrideKind, type OverrideRow,
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
  /** The NOT is an Owner's brake (an exclusion, a lock of the whole bids lever): it is saved even when the campaign must wait. */
  brake?: boolean
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
  /** AB-1 review — an Owner's brake on a campaign that sits at a floor only the bid brain would lift: HELD meanwhile. */
  | { campaignId: string; name: string; op: 'wait'; why: string; hold: boolean }

/** How long a campaign waiting for its floor is held (the longest hold set-bid-brain-enrollment takes). */
export const WAIT_HOLD_DAYS = 60

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
 * reason; LIVE and HELD stay. Not wanting it: LIVE and HELD go back to shadow. One that cannot (keywords at a floor the
 * bid brain set that no engine would give back) refuses a level change; under an Owner's brake (exclusion, bids lock)
 * the brake is saved anyway and that campaign WAITS: HELD (the brain raises nothing, and still lifts its own floor),
 * named, until the choice is set again once the floor has lifted. AB-1 review, the safer of the two: a give-back
 * instead would write a weeks-old snapshot to Amazon from a Nexus-only change; waiting writes nothing and never strands
 * keywords at a floor no one lifts.
 */
export function planBids(campaigns: readonly BidsCampaignState[]): { steps: BidsStep[] } | { refusal: string } {
  const steps: BidsStep[] = []
  const stuck: string[] = []
  for (const c of campaigns) {
    const check = needsCheck(c.want, c.mode)
    if (!check) steps.push({ campaignId: c.campaignId, name: c.name, op: 'keep', mode: c.mode })
    else if (check === 'live') steps.push(c.liveRefusal ? { campaignId: c.campaignId, name: c.name, op: 'skip', why: c.liveRefusal } : { campaignId: c.campaignId, name: c.name, op: 'live' })
    else if (c.shadowRefusal && c.brake) {
      steps.push({ campaignId: c.campaignId, name: c.name, op: 'wait', hold: c.mode !== 'HELD', why: `${c.wantWhy ?? 'the Owner keeps the bid brain off it'}, but it waits: ${c.shadowRefusal} Until then it is HELD (the bid brain raises nothing and still lifts its own floor); set the choice again to take it to shadow.` })
    } else if (c.shadowRefusal) stuck.push(c.shadowRefusal)
    else steps.push({ campaignId: c.campaignId, name: c.name, op: 'shadow', why: c.wantWhy ?? 'the bids lever does not run it' })
  }
  if (stuck.length) return { refusal: `the bid brain cannot leave these campaigns now: ${stuck.join(' ')}` }
  return { steps }
}

/** True when a plan moves at least one campaign. */
export const planMoves = (steps: readonly BidsStep[]): boolean => steps.some((s) => s.op === 'live' || s.op === 'shadow' || (s.op === 'wait' && s.hold))

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

/**
 * AB-1 review — the approval basis of a plan: what it stores and ends and what it does to each campaign. A change
 * approved on one basis runs only on the same one (a campaign's allowlist, floor or mode moved since: refused).
 */
export function planBasis(plan: Pick<OverridePlan, 'set' | 'ends' | 'steps'>): string {
  const steps = plan.steps?.map((s) => [s.campaignId, s.op]) ?? null
  return createHash('sha256').update(JSON.stringify([plan.set, plan.ends, steps])).digest('base64url').slice(0, 16)
}

/** The campaigns a plan puts under the bid brain. Any one makes the change a big door (the approver's code). */
export const goesLive = (steps: readonly BidsStep[] | undefined): string[] => (steps ?? []).filter((s) => s.op === 'live').map((s) => s.campaignId)

/** The Owner keeps the bid brain off (excluded, bids locked): a brake. A shared campaign moves only this way, back to shadow. */
export const ownerKeepsOff = (bids: LeverSettings): boolean => bids.effective === 'EXCLUDED' || bids.effective === 'LOCKED'

/**
 * AB-1 review — the campaigns a product's choice of one lever does not reach, and why: excluded, held by a lock (its
 * own, or the product's when the choice is a level), or with a level of its own. The plan and the view name each one.
 */
export function notReachedBy(kind: 'LEVEL' | 'LOCK', lever: BrainLever, campaigns: ReadonlyArray<{ campaignId: string; name: string; settings: Pick<BrainSettings, 'excluded' | 'levers'> }>): Array<{ campaignId: string; name: string; why: string }> {
  return campaigns.flatMap((c) => {
    const l = c.settings.levers[lever]
    const own = c.settings.excluded.value
      || (kind === 'LEVEL' && (!!l.lock || l.level.source === 'campaign'))
      || (kind === 'LOCK' && l.lock?.source === 'campaign')
    return own ? [{ campaignId: c.campaignId, name: c.name, why: l.why }] : []
  })
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
    // The plan already resolved the Owner's overrides as they will be after the change (no checkOwnerBrake).
    const facts = await enrollmentFacts(c.campaignId, { plansJoin: PLANS_JOIN_THE_BRAIN })
    const refusal = facts ? enrollRefusal(facts, op) : `${c.name} is no longer in this business`
    // AB-2 follow-up — a stop's saved lanes or strategy still owed: setEnrollment refuses LIVE (it never drops them unseen),
    // so this campaign is a named skip, not a failed change; set-bid-brain-enrollment op live gives them back first.
    const owed = op === 'live' && !refusal && facts?.stopMemory ? `${c.name} cannot go LIVE yet: ${facts.stopMemory.words} — set-bid-brain-enrollment op live gives them back first` : null
    out.push(op === 'live' ? { ...c, liveRefusal: refusal ?? owed } : { ...c, shadowRefusal: refusal })
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
  /** The campaigns the product's bids choice does not reach (excluded, locked, or a level of their own), and why. */
  notReached: Array<{ campaignId: string; name: string; why: string }>
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
  const sharedLive = campaigns.filter((c) => c.owner === 'shared' && isOwnedMode(c.mode) && !ownerKeepsOff(c.bids))
  if (sharedLive.length) drift.push(`${count(sharedLive.length, 'shared campaign is', 'shared campaigns are')} LIVE by a per-campaign enrollment (${names(sharedLive)}): no product's lever moves ${sharedLive.length === 1 ? 'it' : 'them'}`)
  const keptOff = campaigns.filter((c) => isOwnedMode(c.mode) && ownerKeepsOff(c.bids))
  if (keptOff.length) drift.push(`${count(keptOff.length, 'campaign is', 'campaigns are')} LIVE although the Owner keeps the bid brain off (${names(keptOff)}): set that choice again to take ${keptOff.length === 1 ? 'it' : 'them'} back to shadow`)
  const left = [...new Set(strayRows.map((r) => r.campaignId).filter((id): id is string => !!id))]
  if (left.length) drift.push(`the Owner's overrides on ${count(left.length, 'campaign')} that no longer ${left.length === 1 ? 'advertises' : 'advertise'} this product here (${left.join(', ')}): they still apply to ${left.length === 1 ? 'that campaign' : 'those campaigns'}`)
  return {
    productId: camps.root, market: m, enrolled, version: row?.version ?? null, enrolledBy: row?.enrolledBy ?? null,
    updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt.toISOString() ?? null, snapshots: readSnapshots(row?.snapshots),
    settings: resolve(null), campaigns, bidsAsCampaigns: adoptedBidsLevel(camps.own),
    notReached: notReachedBy('LEVEL', 'bids', campaigns.map((c) => ({ campaignId: c.campaignId, name: c.name, settings: { excluded: c.excluded, levers: { bids: c.bids } as BrainSettings['levers'] } }))),
    drift,
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

/**
 * AB-1 review — every change of a brain runs Serializable: "one open override per thing" and the version's
 * compare-and-set hold only there. Inside an outer transaction at another level inDatabaseTransaction throws.
 */
const SERIALIZABLE = { isolationLevel: 'Serializable' as const }

/** Settings checked against each other (settingsPairRefusal). */
const PAIRED = new Set(['negativesPerEntityWarn', 'negativesPerEntityMax'])

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

/**
 * Enroll a product in one market: every lever at the brain's default, the bids lever adopted from its campaigns (no
 * campaign row written). AB-1 review — adopting AUTO keeps each own campaign that is in shadow where it is with a
 * campaign override OBSERVE ("adopted"): a later product re-apply or the cycle never puts it LIVE behind the Owner's
 * back; ending that override is the Owner's go (a big door).
 */
export async function enrollProduct(args: { productId: string; market: string; by: string; now?: Date }): Promise<Result<{ productId: string; market: string; bids: 'AUTO' | 'OBSERVE'; version: number; adoptedLive: string[]; keptInShadow: string[] }>> {
  const now = args.now ?? new Date()
  const done = await refusing(() => inDatabaseTransaction(prisma, async () => {
    const { root, market } = await scopeOf(args.productId, args.market)
    const camps = await campaignsOf(root, market)
    if (!camps) throw new BrainRefusal(`product ${args.productId} is no longer a live product of this business`)
    const bids = adoptedBidsLevel(camps.own)
    const adoptedLive = camps.own.filter((c) => isOwnedMode(c.mode)).map((c) => c.campaignId)
    const keptInShadow = bids === 'AUTO' ? camps.own.filter((c) => !isOwnedMode(c.mode)).map((c) => c.campaignId) : []
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
      await prisma.adsBrainOverride.createMany({
        data: [
          {
            productId: root, marketplace: market, scope: 'PRODUCT', kind: 'LEVEL', key: 'bids', value: 'AUTO', by: args.by,
            reason: `adopted at enrollment: the bid brain already runs ${count(adoptedLive.length, 'own campaign')} LIVE (${adoptedLive.join(', ')})`,
          },
          ...keptInShadow.map((campaignId) => ({
            productId: root, marketplace: market, scope: 'CAMPAIGN', campaignId, kind: 'LEVEL', key: 'bids', value: 'OBSERVE', by: args.by,
            reason: 'adopted at enrollment: in shadow when the product enrolled — the product\'s AUTO does not put it LIVE until this override is ended',
          })),
        ],
      })
    }
    return { ok: true as const, productId: root, market, bids, version: row.version, adoptedLive, keptInShadow }
  }, SERIALIZABLE))
  if (done.ok) logger.info('[ads-brain] product enrolled', { productId: done.productId, market: done.market, by: args.by, bids: done.bids, adoptedLive: done.adoptedLive, keptInShadow: done.keptInShadow })
  return done
}

export interface OverridePlan {
  productId: string
  market: string
  /** The override to store (null when an open one already says the same, or for an end). */
  set: { scope: string; campaignId: string | null; kind: OverrideKind; key: string; ref: string; value: unknown } | null
  /** The open override it ends (replaced, or ended on request), if any. */
  ends: string | null
  /** Bids lever only: what happens to each campaign the choice reaches. A shared one only ever goes back to shadow. */
  steps?: BidsStep[]
  /** A product's choice of a lever: the campaigns it does not reach (excluded, locked, or a level of their own), and why. */
  notReached: Array<{ campaignId: string; name: string; why: string }>
  /** The campaigns it puts under the bid brain. */
  goesLive: string[]
  /** A big door: it puts a campaign under the bid brain (whatever kind of change does it), so the approver's code. */
  needsCode: boolean
  /** What the approval is made on (planBasis): a change runs only on the same basis. */
  basis: string
  /** Nothing would change (the same choice, and no campaign to move). */
  unchanged: boolean
}

type Change = { op: 'set'; input: OverrideInput } | { op: 'end'; input: Pick<OverrideInput, 'scope' | 'campaignId' | 'kind' | 'key' | 'ref'> }

/** Who asks, why, and what the approval was made on (the enrollment's version, the plan's basis). */
export interface ChangeArgs { productId: string; market: string; by: string; reason?: string | null; expectVersion?: number; expectBasis?: string; now?: Date }

/** The plan of one change, read now (inside the change's transaction when it runs). */
async function changePlan(root: string, market: string, change: Change): Promise<OverridePlan> {
  // A set checks its value too; an end needs only what it ends.
  const valid = change.op === 'set' ? validateOverride(change.input) : validateIdentity(change.input)
  if ('refusal' in valid) throw new BrainRefusal(valid.refusal)
  const identity = 'override' in valid ? valid.override : valid.identity
  const camps = await campaignsOf(root, market)
  if (!camps) throw new BrainRefusal(`product ${root} is no longer a live product of this business`)
  const all = [...camps.own, ...camps.shared]
  if (identity.scope === 'CAMPAIGN' && change.op === 'set' && !all.some((c) => c.campaignId === identity.campaignId)) {
    throw new BrainRefusal(`campaign ${identity.campaignId} does not advertise this product in ${market} (archived campaigns and other ad products are left out)`)
  }
  // The campaign named is read too when it no longer advertises the product: its override can still be ended.
  const campaignIds = [...new Set(all.map((c) => c.campaignId).concat(identity.campaignId ? [identity.campaignId] : []))]
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
  const resolved = (campaignId: string | null) => resolveBrainSettings({ productId: root, market, campaignId, enrolled: true, overrides: after })
  // AB-4 — the levers this change takes to AUTO on the product's own campaigns (a shared campaign is no brain's, D2).
  const turnsAuto = camps.own.flatMap((c) => {
    const before = resolveBrainSettings({ productId: root, market, campaignId: c.campaignId, enrolled: true, overrides })
    const now = resolved(c.campaignId)
    return BRAIN_LEVERS.filter((l) => now.levers[l].effective === 'AUTO' && before.levers[l].effective !== 'AUTO').map((lever) => ({ campaignId: c.campaignId, name: c.name, lever }))
  })
  // AB-1 review — two settings checked against each other, for the product and every campaign with its own value.
  if (identity.kind === 'VALUE' && PAIRED.has(identity.key)) {
    const own = [...new Set(after.filter((o) => o.scope === 'CAMPAIGN' && o.kind === 'VALUE' && PAIRED.has(o.key) && o.campaignId).map((o) => o.campaignId!))]
    for (const campaignId of [null, ...own]) {
      const refusal = settingsPairRefusal(resolved(campaignId).values, campaignId ? ` on campaign ${campaignId}` : '')
      if (refusal) throw new BrainRefusal(refusal)
    }
  }
  const notReached = identity.scope === 'PRODUCT' && (identity.kind === 'LEVEL' || (identity.kind === 'LOCK' && !identity.ref))
    ? notReachedBy(identity.kind, identity.key as BrainLever, all.map((c) => ({ campaignId: c.campaignId, name: c.name, settings: resolved(c.campaignId) })))
    : []
  // AB-4 — refused while one of Amazon's own rules acts on such a lever there (brain/native-rules.ts): two brains on one lever.
  const refuseOverAmazonRules = async (asks: ReadonlyArray<{ campaignId: string; name: string; lever: BrainLever }>) => {
    if (!asks.length) return
    const refusal = nativeAutoRefusal(asks, await loadNativeRules(asks.map((a) => a.campaignId)))
    if (refusal) throw new BrainRefusal(refusal)
  }
  const done = (steps?: BidsStep[]): OverridePlan => {
    const live = goesLive(steps)
    const plan = { productId: root, market, set, ends, ...(steps ? { steps } : {}), notReached, goesLive: live, needsCode: live.length > 0, unchanged: !set && !ends && !(steps && planMoves(steps)) }
    return { ...plan, basis: planBasis(plan) }
  }
  if (!touchesBids(identity)) {
    await refuseOverAmazonRules(turnsAuto)
    return done()
  }
  // The bids lever, after the change, on each campaign the choice reaches: an own campaign follows what it resolves to;
  // a shared one only leaves (back to shadow) when the Owner keeps the bid brain off it — it never goes LIVE from here.
  const reach = identity.scope === 'CAMPAIGN' ? all.filter((c) => c.campaignId === identity.campaignId) : all
  const ownIds = new Set(camps.own.map((c) => c.campaignId))
  const wanted: BidsCampaignState[] = []
  for (const c of reach) {
    const bids = resolved(c.campaignId).levers.bids
    if (ownIds.has(c.campaignId)) {
      const w = bidsWant(bids)
      wanted.push({ campaignId: c.campaignId, name: c.name, status: c.status, mode: c.mode, want: w.want, wantWhy: w.why, brake: ownerKeepsOff(bids) })
    } else if (ownerKeepsOff(bids) && isOwnedMode(c.mode)) {
      wanted.push({ campaignId: c.campaignId, name: c.name, status: c.status, mode: c.mode, want: 'NOT', wantWhy: `${bids.why} (a shared campaign)`, brake: true })
    }
  }
  const checked = await withChecks(wanted)
  // AB-4 follow-up — a campaign this would put LIVE only as a side effect (its bids resolved AUTO before the change too: a
  // campaign choice of its own, a re-apply's newly added campaign) stays in shadow, named, while an Amazon rule acts on its
  // bids; the rest of the plan runs. The change's own AUTO still refuses below. Steps back to shadow are never checked.
  const sideLive = checked.filter((c) => needsCheck(c.want, c.mode) === 'live' && !c.liveRefusal && !turnsAuto.some((t) => t.campaignId === c.campaignId && t.lever === 'bids'))
  const sideRules = sideLive.length ? await loadNativeRules(sideLive.map((c) => c.campaignId)) : null
  const planned = planBids(checked.map((c) => {
    const lines = sideRules && sideLive.includes(c) ? nativeRuleLines(sideRules.get(c.campaignId), 'bids') : []
    return lines.length ? { ...c, liveRefusal: `an Amazon rule acts on it: ${lines.join('; ')} — it stays in shadow` } : c
  }))
  if ('refusal' in planned) throw new BrainRefusal(planned.refusal)
  await refuseOverAmazonRules(turnsAuto)
  return done(planned.steps)
}

/** Run one change: end the replaced override, store the new one, move the bids lever's campaigns, bump the version. */
async function runChange(args: ChangeArgs, change: Change): Promise<Result<{ plan: OverridePlan; version: number }>> {
  const now = args.now ?? new Date()
  const done = await refusing(() => inDatabaseTransaction(prisma, async () => {
    const { root, market } = await scopeOf(args.productId, args.market)
    const row = await currentRow(root, market, args.expectVersion)
    const plan = await changePlan(root, market, change)
    // AB-1 review — the version does not move when an allowlist, a floor or a campaign's mode does: the steps decide.
    if (args.expectBasis && plan.basis !== args.expectBasis) {
      throw new BrainRefusal('what this change would do changed since it was approved (a campaign\'s allowlist, floor or place in the bid brain moved): nothing changed, preview it again')
    }
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
      if (s.op === 'wait' && s.hold) await setEnrollment({ campaignId: s.campaignId, marketplace: market, op: 'hold', holdDays: WAIT_HOLD_DAYS, by: args.by, reason: `the Owner keeps the bid brain off it; it waits for its floor to lift — ${args.reason ?? 'no raises meanwhile'}`, now })
    }
    // The bids lever's snapshot: taken whenever it puts a campaign LIVE.
    const snapshot = plan.steps?.some((s) => s.op === 'live') ? { takenAt: now.toISOString(), by: args.by, data: bidsSnapshotOf(plan.steps) } : null
    const version = await writeRow(row, snapshot ? { snapshots: json({ ...readSnapshots(row.snapshots), bids: snapshot }) } : {}, args.by)
    return { ok: true as const, plan, version }
  }, SERIALIZABLE))
  if (done.ok && !done.plan.unchanged) {
    const steps = done.plan.steps
    logger.info('[ads-brain] override changed', {
      productId: done.plan.productId, market: done.plan.market, change: change.op, scope: change.input.scope, campaignId: change.input.campaignId ?? null,
      kind: change.input.kind, key: change.input.key, by: args.by,
      ...(steps ? { live: steps.filter((s) => s.op === 'live').length, shadow: steps.filter((s) => s.op === 'shadow').length, skipped: steps.filter((s) => s.op === 'skip').length } : {}),
    })
    // AB-2 follow-up — each campaign the change took back to shadow gets what a stop saved back (the lanes it set to 0 %, the
    // strategy it switched to down only), as the per-campaign op shadow does — after the commit, never inside it. A refused
    // write keeps its memory: the next restore of its stop (restoreCampaignBids) or op give-back gives it back.
    for (const s of steps ?? []) {
      if (s.op !== 'shadow') continue
      const person = args.by.startsWith('user:')
      const actor = (person || args.by.startsWith('automation:') ? args.by : 'automation:ads-brain') as AdsActor
      try {
        const back = await giveBackStopMemory(s.campaignId, { actor, reason: `the product's brain took it back to shadow — ${args.reason ?? s.why}`, manual: person })
        if (back.owed) logger.warn('[ads-brain] a stop\'s saved settings could not all be given back on the way to shadow', { campaignId: s.campaignId, refused: back.refused })
      } catch (err) {
        logger.warn('[ads-brain] could not give back a stop\'s saved settings on the way to shadow', { campaignId: s.campaignId, error: err instanceof Error ? err.message : String(err) })
      }
    }
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
export async function setOverride(args: ChangeArgs & { override: OverrideInput }) {
  return runChange(args, { op: 'set', input: args.override })
}

/** End one Owner choice: the next level (product, then the brain's default) applies again. All or nothing. */
export async function endOverride(args: ChangeArgs & { override: Change['input'] }) {
  return runChange(args, { op: 'end', input: args.override })
}

/** The product's level of one lever (a PRODUCT LEVEL override). */
export async function setLever(args: ChangeArgs & { lever: BrainLever; level: BrainLevel }) {
  return runChange(args, { op: 'set', input: { scope: 'PRODUCT', kind: 'LEVEL', key: args.lever, value: args.level } })
}

/**
 * AB-1 review — set-bid-brain-enrollment moved one campaign by hand (op live, shadow or give-back): the product's
 * brain records it as a campaign override of the bids lever (AUTO for live, OBSERVE for shadow), so a later product
 * re-apply or the cycle never undoes the Owner's per-campaign choice. Only for an own campaign of an enrolled product,
 * and only when its bids resolve otherwise now (the campaign override then names the person). Run inside the tool's
 * transaction: a refusal throws, so the campaign's move and its record go together or not at all. Null: nothing to record.
 */
export async function recordCampaignBidsChoice(args: { campaignId: string; level: 'AUTO' | 'OBSERVE'; by: string; reason?: string | null; now?: Date }): Promise<{ productId: string; market: string } | null> {
  const owner = (await resolveCampaignOwnership([args.campaignId])).get(args.campaignId)
  // An archived campaign is nothing the product's lever moves (productCampaigns leaves it out): nothing to record.
  if (!owner || owner.owner.kind !== 'product' || !owner.market || owner.adProduct !== 'SPONSORED_PRODUCTS' || owner.status === 'ARCHIVED') return null
  const productId = owner.owner.productId
  const enrolled = await prisma.adsBrainEnrollment.findFirst({ where: { productId, marketplace: owner.market }, select: { id: true } })
  if (!enrolled) return null
  const bids = resolveBrainSettings({ productId, market: owner.market, campaignId: args.campaignId, enrolled: true, overrides: await openOverrides(productId, owner.market, [args.campaignId]) }).levers.bids
  if ((bids.effective === 'AUTO') === (args.level === 'AUTO')) return null
  const done = await setOverride({ productId, market: owner.market, override: { scope: 'CAMPAIGN', campaignId: args.campaignId, kind: 'LEVEL', key: 'bids', value: args.level }, by: args.by, reason: args.reason ?? null, now: args.now })
  if ('refusal' in done) throw new BrainRefusal(`the product's brain could not record this campaign's choice: ${done.refusal}`)
  return { productId, market: owner.market }
}

export { EXCLUDE_KEY }
