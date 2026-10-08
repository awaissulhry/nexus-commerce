/**
 * ONE BRAIN AB-15 — the Owner's KILL SWITCH per lever (design 2026-10-08-ads-one-brain/DESIGN.md §5 "kill switch, halt,
 * dial" — now per lever too, §10 individual control: "I should be able to control it individually as well"). The Owner,
 * or Claude with his word (set-brain-kill-switch: a request he approves), stops ONE lever of the brain for one product in
 * one market, or for every product (in one market, or in all of them), at once:
 *
 *   the brain     stops writing that lever: each lever's own run reads the kill before it writes or asks and holds,
 *                 naming it — the bid brain's keyword bids, placements and bidding strategy (bid-brain/shadow.ts), the money
 *                 writer's budgets and portfolio caps (budget-live.ts), the state brain's pauses and resumes (state-run.ts),
 *                 the negatives run (negatives-run.ts), the harvest run (harvest-run.ts: it only logs, as under a shadow
 *                 ceiling) and the hours painter (hours-proposal.ts). It may still decide and log in shadow. The
 *                 bidding-strategy lever (AB-17) reads it with leverKillWhy when it lands; until then the gate stops it.
 *   the gate      refuses the brain's own actors on that lever whatever they ask (ads-write-gate.ts brainKillRefusal, the last
 *                 line): automation:bid-brain on keyword bids, ad group bids, placements and bidding strategy, and every
 *                 automation:ads-brain… writer (money, state, negatives, harvest) on its lever — a lowering by the brain too
 *                 (its floors, its stops): the Owner stopped the brain there. A person's own write, a request a person
 *                 approved, the safety owners (budget enforcement, the retail guard, auto-undo, the repairs) and every other
 *                 automatic writer are judged exactly as before: the kill neither frees the lever for another engine nor
 *                 holds one that was free.
 *   other levers  untouched: a kill names one lever.
 *
 * Why AdsBrainOverride, and not a LOCK or a LEVEL OFF of it: the table is the Owner's choices over the brain, each with who,
 * when and why, never deleted (endedAt, endedBy) — what a kill must keep. But a kill is neither existing choice. A LEVEL
 * OFF hands the lever back to today's engines and the gate then holds nothing there (it would not refuse the brain). A
 * LOCK holds the lever at the Owner's own value against every automatic writer (also where the brain did not own it),
 * lets the brain's own placement and strategy writers pass (they obey a lock themselves, a stop still lowers it), moves the
 * bid brain's campaigns back to shadow on the bids lever, has no "every product", and — one open row per identity — would
 * END the Owner's own lock of that lever, so ending the kill would lose his lock. So a kill is its own row in the same
 * table: kind KILL, scope KILL. No resolver reads it (brain/settings.ts applies only PRODUCT and CAMPAIGN rows, and every
 * override reader filters on those scopes): it is layered over the resolved settings by this module and by the gate. The
 * lever's level, its locks and the bid brain's enrollment never change, so ending the kill puts the brain back exactly as
 * it was.
 *
 *   rows        productId = the family root, or '*' for every product; marketplace = the short market code, or '*' for
 *               every market (only with every product); key = the lever; value { products: 'one' | 'all' }; reason
 *               required. At most one open kill per (product, market, lever): a new one ends the old (its reason replaced).
 *   precedence  the most specific open kill names the stop (the product's, then every product of its market, then every
 *               product everywhere); any one of them stops the lever.
 *   reads       one query for every open kill of the business, remembered KILLS_TTL_MS (a change in this process forgets it
 *               at once; another process sees it within the TTL). A campaign's products are resolved only while a kill of
 *               one product is open (remembered as long). A failed read answers the last answer known and throws only when
 *               there was none — the gate then lets the error out (the write waits and is sent again, never dropped).
 */
import prisma from '../../../db.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, workspaceContext } from '../../../lib/workspace-context.js'
import { logger } from '../../../utils/logger.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { BRAIN_LEVERS, isLever, type BrainLever } from './levers.js'
import { productFamily, resolveCampaignOwnership } from './ownership.js'

/** The scope and the kind of a kill's AdsBrainOverride row. */
export const KILL = 'KILL' as const
/** productId / marketplace of a kill of every product (every market). */
export const EVERY = '*'
export const KILL_REASON_MIN = 3
export const KILL_REASON_MAX = 500
/** How long the open kills (and a campaign's products) are remembered. */
export const KILLS_TTL_MS = 15_000

/** One open kill, as the levers, the gate and the map read it. */
export interface BrainKill {
  id: string
  lever: BrainLever
  /** The product (family root); null = every product. */
  productId: string | null
  /** The short market code; null = every market. */
  market: string | null
  /** 'user:<id>' or 'claude:<approvalId>' — who stopped it. */
  by: string
  reason: string
  /** When it was set (ISO). */
  at: string
}

export interface KillRow { id: string; productId: string; marketplace: string; key: string; by: string; reason: string | null; createdAt: Date | string }

/** A stored row as a kill; null when it does not name a lever this code knows (ignored). Pure. */
export function killOfRow(r: KillRow): BrainKill | null {
  if (!isLever(r.key)) return null
  return {
    id: r.id, lever: r.key, productId: r.productId === EVERY ? null : r.productId, market: r.marketplace === EVERY ? null : r.marketplace,
    by: r.by, reason: r.reason ?? '', at: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
  }
}

/** "product p1 in IT" · "every product in IT" · "every product in every market". Pure. */
export function killScopeWords(k: Pick<BrainKill, 'productId' | 'market'>): string {
  if (k.productId) return `product ${k.productId} in ${k.market ?? 'its market'}`
  return k.market ? `every product in ${k.market}` : 'every product in every market'
}

/** The kill in words, for a hold's why and a refusal: who, when, where and his reason. Pure. */
export function killWords(k: BrainKill): string {
  return `stopped by the Owner's kill switch (${k.by}, ${k.at.slice(0, 10)}, ${killScopeWords(k)})${k.reason ? `: "${k.reason}"` : ''}`
}

const specificity = (k: BrainKill) => (k.productId ? 2 : 0) + (k.market ? 1 : 0)

/**
 * The kill that stops `lever` for this product in this market, the most specific first (then the newest); null: none.
 * `productId` null (a campaign no product's brain can be told): only a kill of every product applies. Pure.
 */
export function killOf(kills: readonly BrainKill[], at: { lever: BrainLever; productId: string | null; market: string | null }): BrainKill | null {
  const hits = kills.filter((k) => k.lever === at.lever && (k.productId === null || k.productId === at.productId) && (k.market === null || k.market === at.market))
  hits.sort((a, b) => specificity(b) - specificity(a) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  return hits[0] ?? null
}

/** Every lever a kill stops for this product in this market. Pure. */
export function killsOfProduct(kills: readonly BrainKill[], productId: string | null, market: string | null): Partial<Record<BrainLever, BrainKill>> {
  const out: Partial<Record<BrainLever, BrainKill>> = {}
  for (const lever of BRAIN_LEVERS) {
    const k = killOf(kills, { lever, productId, market })
    if (k) out[lever] = k
  }
  return out
}

export interface KillInput {
  lever: unknown
  /** A product (any member of its family); absent or null = every product. */
  productId?: string | null
  /** A market code; absent or null with every product = every market. */
  market?: string | null
  reason?: string | null
}

/** What a kill (or its end) names, normalised, or why it names nothing the Owner can stop. Pure (the family root is read later). */
export function killTarget(input: KillInput, op: 'kill' | 'end'): { lever: BrainLever; productId: string | null; market: string | null; reason: string } | { refusal: string } {
  if (!isLever(input.lever)) return { refusal: `${String(input.lever)} is not a lever of the brain (levers: ${BRAIN_LEVERS.join(', ')})` }
  const productId = typeof input.productId === 'string' && input.productId.trim() ? input.productId.trim() : null
  const rawMarket = typeof input.market === 'string' && input.market.trim() ? input.market.trim() : null
  const market = rawMarket ? strategyMarket(rawMarket) : null
  if (rawMarket && (!market || !/^[A-Z]{2}$/.test(market))) return { refusal: `${rawMarket} is not an Amazon market code (business-overview lists them: IT, DE …)` }
  if (productId && !market) return { refusal: 'a kill of one product names its market (market): a product\'s brain is one product in one market' }
  if (productId && (productId === EVERY || productId.length > 64)) return { refusal: 'productId is a Nexus product id (at most 64 characters); leave it out to stop every product' }
  const reason = typeof input.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ') : ''
  if (op === 'kill' && (reason.length < KILL_REASON_MIN || reason.length > KILL_REASON_MAX)) return { refusal: `a kill says why (reason, ${KILL_REASON_MIN} to ${KILL_REASON_MAX} characters): it is kept with who and when, and shown wherever the lever holds` }
  if (reason.length > KILL_REASON_MAX) return { refusal: `the reason is at most ${KILL_REASON_MAX} characters` }
  return { lever: input.lever, productId, market, reason }
}

// ── The memory ───────────────────────────────────────────────────────────────────────────────────────────────────

const killMemory = new Map<string, { at: number; value: BrainKill[] }>()
const campaignMemory = new Map<string, { at: number; value: { productIds: string[]; market: string | null } }>()
const MAX_REMEMBERED = 5_000
const business = (): string => workspaceContext()?.workspaceId ?? LEGACY_WORKSPACE_ID
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Forget the open kills and the campaigns' products (a kill set or ended in this process, and tests). */
export function forgetKills(): void {
  killMemory.clear()
  campaignMemory.clear()
}

const KILL_SELECT = { id: true, productId: true, marketplace: true, key: true, by: true, reason: true, createdAt: true } as const

/** Every open kill of this business. One query, remembered KILLS_TTL_MS; a failed read answers the last answer known. */
export async function openKills(): Promise<BrainKill[]> {
  const key = business()
  const hit = killMemory.get(key)
  if (hit && Date.now() - hit.at <= KILLS_TTL_MS) return hit.value
  try {
    const rows = await prisma.adsBrainOverride.findMany({ where: { scope: KILL, kind: KILL, endedAt: null }, select: KILL_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const value = rows.map((r) => killOfRow(r)).filter((k): k is BrainKill => !!k)
    killMemory.set(key, { at: Date.now(), value })
    return value
  } catch (err) {
    if (!hit) throw err
    logger.warn('[ads-brain] could not read the kill switches — the last answer known stands', { workspaceId: key, kills: hit.value.length, error: errorText(err) })
    return hit.value
  }
}

/** Every lever stopped for this product in this market (the map, the levers' runs). */
export async function productKills(productId: string, market: string): Promise<Partial<Record<BrainLever, BrainKill>>> {
  const kills = await openKills()
  return kills.length ? killsOfProduct(kills, productId, strategyMarket(market) ?? market) : {}
}

/** The why a lever's run holds with when the kill stops it for this product in this market; null: not stopped. */
export async function leverKillWhy(lever: BrainLever, productId: string, market: string): Promise<string | null> {
  const k = (await productKills(productId, market))[lever]
  return k ? killWords(k) : null
}

/** The family roots and the market of these campaigns, remembered KILLS_TTL_MS (read only while a product's kill is open). */
async function campaignProducts(ids: readonly string[]): Promise<Map<string, { productIds: string[]; market: string | null }>> {
  const ws = business()
  const out = new Map<string, { productIds: string[]; market: string | null }>()
  const missing: string[] = []
  for (const id of ids) {
    const hit = campaignMemory.get(`${ws}\u0000${id}`)
    if (hit && Date.now() - hit.at <= KILLS_TTL_MS) out.set(id, hit.value)
    else missing.push(id)
  }
  if (!missing.length) return out
  const owners = await resolveCampaignOwnership(missing)
  if (campaignMemory.size >= MAX_REMEMBERED) campaignMemory.clear()
  for (const id of missing) {
    const o = owners.get(id)
    const value = { productIds: o?.productIds ?? [], market: o?.market ?? null }
    campaignMemory.set(`${ws}\u0000${id}`, { at: Date.now(), value })
    out.set(id, value)
  }
  return out
}

/**
 * campaignId → the levers (of `levers`) a kill stops on it, each with its kill; campaigns with none are left out. A shared
 * campaign is stopped when one of its products is (as a lock holds it). No open kill of these levers: one remembered
 * query and nothing else; only kills of every product: the campaigns' markets (one query); a kill of one product: the
 * campaign → product resolver too.
 */
export async function campaignKills(campaignIds: readonly string[], levers: readonly BrainLever[] = BRAIN_LEVERS): Promise<Map<string, Partial<Record<BrainLever, BrainKill>>>> {
  const out = new Map<string, Partial<Record<BrainLever, BrainKill>>>()
  const ids = [...new Set(campaignIds.filter(Boolean))]
  if (!ids.length || !levers.length) return out
  const kills = (await openKills()).filter((k) => levers.includes(k.lever))
  if (!kills.length) return out
  let places: Map<string, { productIds: string[]; market: string | null }>
  if (kills.some((k) => k.productId)) places = await campaignProducts(ids)
  else {
    const rows = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, marketplace: true } })
    places = new Map(rows.map((r) => [r.id, { productIds: [], market: strategyMarket(r.marketplace) }]))
  }
  for (const id of ids) {
    const p = places.get(id)
    if (!p) continue
    const found: Partial<Record<BrainLever, BrainKill>> = {}
    for (const lever of levers) {
      const hits = (p.productIds.length ? p.productIds : [null]).map((productId) => killOf(kills, { lever, productId, market: p.market })).filter((k): k is BrainKill => !!k)
      hits.sort((a, b) => specificity(b) - specificity(a) || b.at.localeCompare(a.at))
      if (hits[0]) found[lever] = hits[0]
    }
    if (Object.keys(found).length) out.set(id, found)
  }
  return out
}

// ── Setting and ending a kill ────────────────────────────────────────────────────────────────────────────────────

export type KillResult<T> = ({ ok: true } & T) | { ok: false; refusal: string }

/** The stored (productId, marketplace) of a target: a product's family root, or '*'. */
async function storedTarget(t: { productId: string | null; market: string | null }): Promise<{ productId: string; marketplace: string } | { refusal: string }> {
  if (!t.productId) return { productId: EVERY, marketplace: t.market ?? EVERY }
  const family = await productFamily(t.productId)
  if (!family) return { refusal: `product ${t.productId} is not found here, or it has no single family (a parentless product carried by the ASIN variations of several families): fix its family first` }
  return { productId: family.root, marketplace: t.market! }
}

/**
 * Stop one lever of the brain (see the header). An open kill of the same lever and target is ended by this one (its reason
 * replaced). One transaction. `by` is who stopped it ('user:<id>', 'claude:<approvalId>').
 */
export async function setBrainKill(args: KillInput & { by: string; now?: Date }): Promise<KillResult<{ kill: BrainKill; replaced: BrainKill | null }>> {
  const t = killTarget(args, 'kill')
  if ('refusal' in t) return { ok: false, refusal: t.refusal }
  const where = await storedTarget(t)
  if ('refusal' in where) return { ok: false, refusal: where.refusal }
  const now = args.now ?? new Date()
  const { kill, replaced } = await inDatabaseTransaction(prisma, async () => {
    const open = await prisma.adsBrainOverride.findMany({ where: { scope: KILL, kind: KILL, key: t.lever, productId: where.productId, marketplace: where.marketplace, endedAt: null }, select: KILL_SELECT })
    if (open.length) await prisma.adsBrainOverride.updateMany({ where: { id: { in: open.map((o) => o.id) }, endedAt: null }, data: { endedAt: now, endedBy: args.by } })
    const row = await prisma.adsBrainOverride.create({
      data: {
        productId: where.productId, marketplace: where.marketplace, scope: KILL, campaignId: null, kind: KILL, key: t.lever, ref: '',
        value: { products: where.productId === EVERY ? 'all' : 'one' }, by: args.by, reason: t.reason, createdAt: now,
      },
      select: KILL_SELECT,
    })
    return { kill: killOfRow(row)!, replaced: open.length ? killOfRow(open[open.length - 1]) : null }
  }, { isolationLevel: 'Serializable' })
  forgetKills()
  logger.info('[ads-brain] a lever of the brain was stopped by the kill switch', { lever: kill.lever, productId: kill.productId, market: kill.market, by: kill.by })
  return { ok: true, kill, replaced }
}

/** End the open kill of one lever and target: the brain writes that lever again as its level says. Who ended it is kept. */
export async function endBrainKill(args: KillInput & { by: string; now?: Date }): Promise<KillResult<{ ended: BrainKill }>> {
  const t = killTarget(args, 'end')
  if ('refusal' in t) return { ok: false, refusal: t.refusal }
  const where = await storedTarget(t)
  if ('refusal' in where) return { ok: false, refusal: where.refusal }
  const open = await prisma.adsBrainOverride.findMany({ where: { scope: KILL, kind: KILL, key: t.lever, productId: where.productId, marketplace: where.marketplace, endedAt: null }, select: KILL_SELECT, orderBy: { createdAt: 'desc' } })
  if (!open.length) return { ok: false, refusal: `no kill switch stops the ${t.lever} lever of ${killScopeWords({ productId: where.productId === EVERY ? null : where.productId, market: where.marketplace === EVERY ? null : where.marketplace })}: nothing to end` }
  await prisma.adsBrainOverride.updateMany({ where: { id: { in: open.map((o) => o.id) }, endedAt: null }, data: { endedAt: args.now ?? new Date(), endedBy: args.by } })
  forgetKills()
  const ended = killOfRow(open[0])!
  logger.info('[ads-brain] a kill switch was ended', { lever: ended.lever, productId: ended.productId, market: ended.market, by: args.by })
  return { ok: true, ended }
}

/** The open kill of one lever and target, if any (the tool's preview). */
export async function killStanding(t: { lever: BrainLever; productId: string | null; market: string | null }): Promise<BrainKill | null> {
  const where = await storedTarget(t)
  if ('refusal' in where) return null
  const row = await prisma.adsBrainOverride.findFirst({ where: { scope: KILL, kind: KILL, key: t.lever, productId: where.productId, marketplace: where.marketplace, endedAt: null }, select: KILL_SELECT, orderBy: { createdAt: 'desc' } })
  return row ? killOfRow(row) : null
}
