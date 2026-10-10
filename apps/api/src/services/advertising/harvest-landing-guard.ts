/**
 * HARVEST FIX (2026-10-10, bugs B1 + B10 of the Keyword Harvest research) — the landing guard the harvest paths ask before
 * they count a keyword as landed and negate the term at its source: the page's promote and a recommendation's accept
 * (ads-harvest.service.ts applyHarvest, harvest-promote.service.ts planPromotion), a rule's harvest (applyHarvest's landing
 * and its handover to a home elsewhere, promote_to_exact's handover), and the ads brain (brain/harvest.ts the destination
 * it chooses, brain/harvest-write.ts the pair it writes, the apply-brain-harvest request). harvest-search-term and
 * graduate-keyword do not ask it yet (the harvest engine lane takes them over).
 *
 * Why: the create services find a keyword by ad group, match type and text whatever its status (ads-create.service.ts
 * createKeywordLocal / createTargetLocal), so an archived or paused keyword in the destination came back "already there",
 * was counted as landed, and the source was negated: the term then served nowhere. A negative in the destination that
 * blocks the term did the same (no harvest path asked for it).
 *
 *   landed   an ENABLED keyword (an ASIN: a product target) with Amazon's id, whose last switch Amazon confirmed: the term
 *            already runs there. One switched on a moment ago and not confirmed yet is not landed yet (serves false).
 *   enable   a PAUSED one with Amazon's id, in a destination that serves: switched on again with the harvest's start bid
 *            (switchOnBid + enableLanding: the keyword state write path, ads-mutation.service.ts updateAdTargetWithSync — the
 *            bid held like a create's, the write gate asked now, sent through the queue at once). A paused keyword is NOT a
 *            landing: the source is never negated in the same call. It is negated once Amazon confirmed the switch
 *            (servingLandings): by the brain's next run, a rule's next handover, or the next harvest of the term.
 *   hold     nothing is written there and the source is never negated, with the reason in plain words:
 *              archived  an ARCHIVED one with Amazon's id. Amazon's archive is final (no write switches it on again,
 *                        ads-api-client.ts SP_V3_ARCHIVE) and the create services never add a second one to the same ad
 *                        group (their dedupe answers with the archived row), so this ad group cannot take the term.
 *              negative  a negative of the ad group, or of its campaign, that blocks the term: an exact negative with its
 *                        words, a phrase negative whose words it holds in order (ads-winner-lock.ts negativeBlocksTerm), a
 *                        negative product target of the ASIN. The new keyword would never show for it.
 *              idle      a paused one in a destination that does not serve: switching it on would land nothing.
 *              gone      the ad group is no longer in Nexus.
 *   create   nothing of the term there (or only a row Amazon never took, which the create services send): created as before.
 *   serves   the destination's campaign and ad group are ENABLED and the campaign's bids are not suppressed (a stop, or born
 *            at the floor and not started — brain/harvest-load.ts says the same). A landing that does not serve never
 *            negates the source; whether a keyword is still created there is the caller's choice (the brain never does).
 */
import prisma from '../../db.js'
import { normaliseNegTerm } from './ads-protect-converting.js'
import { negativeBlocksTerm } from './ads-winner-lock.js'
import { IN_FLIGHT_STATES } from '../ads-core/ad-mutation-state.js'

export type LandingMatch = 'EXACT' | 'PHRASE' | 'BROAD' | 'PRODUCT'
export interface LandingNegative { text: string; match: 'EXACT' | 'PHRASE' | 'PRODUCT'; level: 'AD_GROUP' | 'CAMPAIGN' }
/** `confirmed`: no switch of its status is on its way to Amazon, and the last one Amazon took (switchConfirmed). */
export interface LandingTarget { id: string; status: string; externalTargetId: string | null; confirmed: boolean }

/** One destination ad group as the guard reads it for one term. */
export interface LandingFacts {
  term: string
  match: LandingMatch
  adGroup: { id: string; name: string; status: string; campaign: { id: string; name: string; status: string; suppressed: boolean } } | null
  /** Positive keywords (or product targets) there with the term's text and match type, any status. */
  existing: readonly LandingTarget[]
  /** The negatives that stand there: the ad group's own and its campaign's. */
  negatives: readonly LandingNegative[]
}

export type LandingHold = 'landing_gone' | 'landing_archived' | 'landing_negative' | 'landing_idle'
export type LandingDecision =
  | { kind: 'create'; serves: boolean; why: string }
  | { kind: 'landed'; targetId: string; externalTargetId: string; serves: boolean; why: string }
  /** Never a landing yet: switched on now, the source negated only once Amazon confirmed it. */
  | { kind: 'enable'; targetId: string; externalTargetId: string; why: string }
  | { kind: 'hold'; deniedAt: LandingHold; why: string }

const isAsinTerm = (t: string) => /^b0[a-z0-9]{8}$/i.test(t.trim())
const what = (match: LandingMatch) => (match === 'PRODUCT' ? 'product target' : `${match.toLowerCase()} keyword`)
const lower = (s: string) => s.toLowerCase()

/** The words a campaign whose bids are suppressed is named with (as brain/harvest-load.ts names it). */
export const SUPPRESSED_WORDS = 'its campaign\'s bids are suppressed (a stop, or born at the floor and not started)'

/** The key a term (an ASIN: upper-cased) is compared by, on both sides. */
export const landingKey = (term: string, isAsin: boolean): string => (isAsin ? term.trim().toUpperCase() : normaliseNegTerm(term))

/** Pure — the negative that blocks a search for `term` (an ASIN: its negative product target), or null. */
export function blockingNegative<N extends { text: string; match: string }>(term: string, negatives: readonly N[]): N | null {
  const asin = isAsinTerm(term)
  for (const n of negatives) {
    if (n.match === 'PRODUCT') { if (asin && landingKey(n.text, true) === landingKey(term, true)) return n; continue }
    if (!asin && (n.match === 'EXACT' || n.match === 'PHRASE') && negativeBlocksTerm({ text: n.text, match: n.match }, term)) return n
  }
  return null
}

/** The words of an archived keyword that holds an ad group (no number, no jargon). */
export function archivedWords(term: string, match: LandingMatch): string {
  return `the ${what(match)} "${term}" there is archived: Amazon cannot switch an archived one on again, and Nexus does not add it twice to one ad group`
}

/** The words of a negative that blocks the term in an ad group or its campaign. */
export function negativeWords(term: string, n: { text: string; match: string; level?: string | null }, where: { adGroup: string; campaign: string }): string {
  const neg = n.match === 'PRODUCT' ? `a negative product target ${n.text.trim().toUpperCase()}` : `a negative ${lower(n.match)} "${n.text}"`
  return `${neg} in ${n.level === 'CAMPAIGN' ? `campaign "${where.campaign}"` : `ad group "${where.adGroup}"`} blocks "${term}" there: a keyword for it would never show`
}

/** Why a destination does not serve now (null: it serves). */
function idleWords(g: NonNullable<LandingFacts['adGroup']>): string | null {
  if (g.campaign.status !== 'ENABLED') return `its campaign "${g.campaign.name}" is ${lower(g.campaign.status)}`
  if (g.status !== 'ENABLED') return `the ad group is ${lower(g.status)}`
  return g.campaign.suppressed ? SUPPRESSED_WORDS : null
}

/** Pure — what a harvest landing in this ad group does (see the header). */
export function decideLanding(f: LandingFacts): LandingDecision {
  const g = f.adGroup
  const held = (deniedAt: LandingHold, words: string): LandingDecision =>
    ({ kind: 'hold', deniedAt, why: `${g ? `ad group "${g.name}" cannot take "${f.term}"` : `"${f.term}" cannot land`}: ${words}. Nothing was written there and the source is not negated` })
  if (!g) return held('landing_gone', 'the destination ad group is no longer in Nexus')
  const neg = blockingNegative(f.term, f.negatives)
  if (neg) return held('landing_negative', negativeWords(f.term, neg, { adGroup: g.name, campaign: g.campaign.name }))
  const notServing = idleWords(g)
  const serves = notServing == null
  const idle = serves ? '' : `; ${notServing}, so the source is not negated`
  const atAmazon = f.existing.filter((t) => !!t.externalTargetId)
  const on = atAmazon.find((t) => t.status === 'ENABLED' && t.confirmed) ?? atAmazon.find((t) => t.status === 'ENABLED')
  if (on && !on.confirmed) {
    return { kind: 'landed', targetId: on.id, externalTargetId: on.externalTargetId!, serves: false, why: `the ${what(f.match)} "${f.term}" in ad group "${g.name}" was switched on again and Amazon has not confirmed it yet, so the source is not negated` }
  }
  if (on) return { kind: 'landed', targetId: on.id, externalTargetId: on.externalTargetId!, serves, why: `the ${what(f.match)} "${f.term}" already runs in ad group "${g.name}"${idle}` }
  const paused = atAmazon.find((t) => t.status === 'PAUSED')
  if (paused && !serves) return held('landing_idle', `the ${what(f.match)} "${f.term}" stands paused there, and switching it on would land nothing: ${notServing}`)
  if (paused) return { kind: 'enable', targetId: paused.id, externalTargetId: paused.externalTargetId!, why: `switch on the paused ${what(f.match)} "${f.term}" in ad group "${g.name}" again, at the harvest's start bid (nothing is created); its source is negated only once Amazon confirms it` }
  if (atAmazon.some((t) => t.status === 'ARCHIVED')) return held('landing_archived', archivedWords(f.term, f.match))
  return { kind: 'create', serves, why: `nothing of "${f.term}" stands in ad group "${g.name}": it is created there${idle}` }
}

/**
 * Of these targets, the ones whose status Amazon confirmed: no switch of it in flight (PENDING / IN_FLIGHT, inside the
 * trust window), and the newest settled switch APPLIED (a FAILED or CANCELLED one did not reach Amazon). A target Nexus
 * never switched (read from Amazon as it is) is confirmed. One read.
 */
async function switchConfirmed(targetIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(targetIds.filter(Boolean))]
  if (!ids.length) return new Set()
  const since = new Date(Date.now() - 24 * 3_600_000)
  const rows = await prisma.adMutation.findMany({
    where: { entityType: 'AD_TARGET', entityId: { in: ids }, field: 'status' },
    orderBy: { createdAt: 'desc' },
    select: { entityId: true, state: true, intendedValue: true, createdAt: true },
  })
  const out = new Set(ids)
  const seen = new Set<string>()
  for (const r of rows) {
    if ((IN_FLIGHT_STATES as readonly string[]).includes(r.state)) { if (r.createdAt >= since) out.delete(r.entityId); continue }
    if (seen.has(r.entityId)) continue
    seen.add(r.entityId)
    // A switch-on that never reached Amazon (the worker puts the row back; this covers the moment before it does).
    if ((r.state === 'FAILED' || r.state === 'CANCELLED') && r.intendedValue === 'ENABLED') out.delete(r.entityId)
  }
  return out
}

const negativeMatchOf = (kind: string, expressionType: string): LandingNegative['match'] | null =>
  kind === 'PRODUCT' ? 'PRODUCT' : /PHRASE/.test(expressionType) ? 'PHRASE' : /EXACT/.test(expressionType) ? 'EXACT' : null

/** The negatives (not archived) that stand in these ad groups, and at campaign level in these campaigns. One read. */
async function standingNegatives(adGroupIds: readonly string[], campaignIds: readonly string[], kinds: readonly string[]) {
  const rows = await prisma.adTarget.findMany({
    where: {
      isNegative: true, status: { not: 'ARCHIVED' }, kind: { in: [...kinds] },
      OR: [
        { adGroupId: { in: [...adGroupIds] }, OR: [{ negativeLevel: 'AD_GROUP' }, { negativeLevel: null }] },
        { negativeLevel: 'CAMPAIGN', adGroup: { campaignId: { in: [...campaignIds] } } },
      ],
    },
    select: { adGroupId: true, kind: true, expressionType: true, expressionValue: true, negativeLevel: true, adGroup: { select: { campaignId: true } } },
  })
  return rows.flatMap((r) => {
    const match = negativeMatchOf(r.kind, r.expressionType)
    return match ? [{ adGroupId: r.adGroupId, campaignId: r.adGroup?.campaignId ?? null, text: r.expressionValue, match, level: (r.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP') as LandingNegative['level'] }] : []
  })
}

/** The facts of one destination ad group for one term, as Nexus holds them now (three reads). */
export async function landingFacts(args: { adGroupId: string; term: string; match: LandingMatch }): Promise<LandingFacts> {
  const term = args.term.trim()
  const product = args.match === 'PRODUCT'
  const g = await prisma.adGroup.findUnique({ where: { id: args.adGroupId }, select: { id: true, name: true, status: true, campaign: { select: { id: true, name: true, status: true, bidsSuppressedAt: true } } } })
  if (!g || !g.campaign) return { term, match: args.match, adGroup: null, existing: [], negatives: [] }
  const [existing, negatives] = await Promise.all([
    prisma.adTarget.findMany({
      where: {
        adGroupId: g.id, isNegative: false, expressionValue: { equals: term, mode: 'insensitive' },
        ...(product ? { kind: 'PRODUCT' } : { kind: 'KEYWORD', expressionType: { in: [args.match, `_${args.match}`] } }),
      },
      select: { id: true, status: true, externalTargetId: true },
    }),
    standingNegatives([g.id], [g.campaign.id], [product ? 'PRODUCT' : 'KEYWORD']),
  ])
  const confirmed = await switchConfirmed(existing.filter((t) => String(t.status) === 'ENABLED').map((t) => t.id))
  return {
    term, match: args.match,
    adGroup: { id: g.id, name: g.name, status: String(g.status), campaign: { id: g.campaign.id, name: g.campaign.name, status: String(g.campaign.status), suppressed: !!g.campaign.bidsSuppressedAt } },
    existing: existing.map((t) => ({ id: t.id, status: String(t.status), externalTargetId: t.externalTargetId, confirmed: confirmed.has(t.id) })),
    negatives: negatives.map(({ text, match, level }) => ({ text, match, level })),
  }
}

/** What a harvest landing of `term` in this ad group does now (see the header). */
export async function checkLanding(args: { adGroupId: string; term: string; match: LandingMatch }): Promise<LandingDecision> {
  return decideLanding(await landingFacts(args))
}

/** Who switches a paused landing on again: the harvest's own writer, its change set and why. */
export interface LandingWho { actor: string; manual?: boolean; confirmOwnLimits?: boolean; changeSetId?: string | null; reason: string }

const actorOf = (a: string) => (a.startsWith('user:') || a.startsWith('automation:') ? a : `user:${a}`) as `user:${string}` | `automation:${string}`

/**
 * The bid a paused landing is switched on with: the harvest's start bid, held as a create's is — inside the ads strategy's
 * band (its lowest and highest bid for the ad group) and the campaign's own bounds — and then, for an engine's or a rule's
 * write (never a person's own, isPersonEdit), the mutation layer's step from its current bid (ads-strategy/bids.ts
 * stepClamp, the same arithmetic updateAdTargetWithSync applies). So the bid a preview shows is the bid that is written.
 * `held` says what moved it (no number in the words). Two reads.
 */
export async function switchOnBid(args: { targetId: string; wantCents: number; who: Pick<LandingWho, 'actor' | 'manual'> }): Promise<{ cents: number; currentCents: number; held: string | null }> {
  const { bidLimitsFor, clampToStrategy, stepClamp } = await import('./ads-strategy/bids.js')
  const t = await prisma.adTarget.findUnique({
    where: { id: args.targetId },
    select: { bidCents: true, adGroupId: true, adGroup: { select: { campaign: { select: { id: true, marketplace: true, minBidCents: true, maxBidCents: true, dynamicBidding: true } } } } },
  })
  const want = Math.round(args.wantCents)
  if (!t) return { cents: want, currentCents: 0, held: null }
  const c = t.adGroup?.campaign
  const limits = await bidLimitsFor({ marketplace: c?.marketplace ?? null, adGroupId: t.adGroupId, campaignId: c?.id ?? null })
  const held: string[] = []
  let cents = clampToStrategy(want, limits).cents
  if (cents !== want) held.push('the ads strategy\'s band')
  if (c?.maxBidCents != null && cents > c.maxBidCents) { cents = c.maxBidCents; held.push('the campaign\'s highest bid') }
  if (c?.minBidCents != null && cents < c.minBidCents) { cents = c.minBidCents; held.push('the campaign\'s lowest bid') }
  const person = args.who.manual === true && actorOf(args.who.actor).startsWith('user:')
  if (!person) {
    const step = stepClamp(t.bidCents, cents, c?.dynamicBidding, limits)
    if (step.cents !== cents) { cents = step.cents; held.push('the largest bid change per step') }
  }
  return { cents, currentCents: t.bidCents, held: held.length ? `held by ${held.join(' and ')}` : null }
}

/**
 * Switch a paused landing on again with its bid, in one patch through the keyword state write path
 * (updateAdTargetWithSync: the bounds and the write gate asked now as the writer, then the queue sends it at once through
 * the channel gateway). `bidCents`: switchOnBid's — what is written comes back. Accepted is NOT landed: the caller
 * negates no source until Amazon confirmed the switch (servingLandings).
 */
export async function enableLanding(targetId: string, bidCents: number, who: LandingWho): Promise<{ ok: boolean; actionLogId: string | null; why: string | null; bidCents: number | null }> {
  const { updateAdTargetWithSync } = await import('./ads-mutation.service.js')
  const res = await updateAdTargetWithSync({
    adTargetId: targetId, patch: { status: 'ENABLED', bidCents: Math.round(bidCents) }, actor: actorOf(who.actor), reason: who.reason.slice(0, 500), changeSetId: who.changeSetId ?? null,
    manual: who.manual, confirmOwnLimits: who.confirmOwnLimits, askGate: true, applyImmediately: true,
  })
  if (!res.ok) return { ok: false, actionLogId: null, why: res.error ?? 'the write was refused', bidCents: null }
  const written = await prisma.adTarget.findUnique({ where: { id: targetId }, select: { bidCents: true } })
  return { ok: true, actionLogId: res.actionLogId, why: null, bidCents: written?.bidCents ?? Math.round(bidCents) }
}

/**
 * The homes among these that a source may hand its term to: the target ENABLED with Amazon's id and its last switch
 * confirmed by Amazon (switchConfirmed), in an ENABLED ad group of an ENABLED campaign whose bids are not suppressed, and
 * no negative there that blocks the term. A paused, archived, unconfirmed, stopped or blocked home would leave the term
 * serving nowhere once its source is negated. Three reads.
 */
export async function servingLandings(items: ReadonlyArray<{ adTargetId: string; term: string }>): Promise<Set<string>> {
  const out = new Set<string>()
  const ids = [...new Set(items.map((i) => i.adTargetId).filter(Boolean))]
  if (!ids.length) return out
  const rows = await prisma.adTarget.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, externalTargetId: true, kind: true, adGroupId: true, adGroup: { select: { status: true, campaignId: true, campaign: { select: { status: true, bidsSuppressedAt: true } } } } },
  })
  const confirmed = await switchConfirmed(rows.map((r) => r.id))
  const live = new Map(rows.filter((r) => String(r.status) === 'ENABLED' && !!r.externalTargetId && confirmed.has(r.id) && String(r.adGroup?.status) === 'ENABLED'
    && String(r.adGroup?.campaign?.status) === 'ENABLED' && !r.adGroup?.campaign?.bidsSuppressedAt).map((r) => [r.id, r]))
  if (!live.size) return out
  const negatives = await standingNegatives([...new Set([...live.values()].map((r) => r.adGroupId))], [...new Set([...live.values()].map((r) => r.adGroup!.campaignId))], ['KEYWORD', 'PRODUCT'])
  for (const i of items) {
    const r = live.get(i.adTargetId)
    if (!r) continue
    const there = negatives.filter((n) => (n.level === 'CAMPAIGN' ? n.campaignId === r.adGroup!.campaignId : n.adGroupId === r.adGroupId))
    if (!blockingNegative(i.term, there)) out.add(r.id)
  }
  return out
}
