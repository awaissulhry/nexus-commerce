/**
 * HARVEST FIX (2026-10-10, bugs B1 + B10 of the Keyword Harvest research) — the ONE landing guard every harvest path asks
 * before it counts a keyword as landed and negates the term at its source: the page's promote and a recommendation's
 * accept (ads-harvest.service.ts applyHarvest, harvest-promote.service.ts planPromotion), a rule's harvest (applyHarvest's
 * landing and its handover to a home elsewhere), and the ads brain (brain/harvest.ts the destination it chooses,
 * brain/harvest-write.ts the pair it writes, the apply-brain-harvest request).
 *
 * Why: the create services find a keyword by ad group, match type and text whatever its status (ads-create.service.ts
 * createKeywordLocal / createTargetLocal), so an archived or paused keyword in the destination came back "already there",
 * was counted as landed, and the source was negated: the term then served nowhere. A negative in the destination that
 * blocks the term did the same (no harvest path asked for it).
 *
 *   landed   an ENABLED keyword (an ASIN: a product target) with Amazon's id: the term already runs there.
 *   enable   a PAUSED one with Amazon's id: switched on again as the landing (enableLanding: the keyword state write path,
 *            ads-mutation.service.ts updateAdTargetWithSync — the write gate asked now, sent through the queue at once, the
 *            caller's actor and change set). The caller negates the source only once that switch was accepted.
 *   hold     nothing is written there and the source is never negated, with the reason in plain words:
 *              archived  an ARCHIVED one with Amazon's id. Amazon's archive is final (no write switches it on again,
 *                        ads-api-client.ts SP_V3_ARCHIVE) and the create services never add a second one to the same ad
 *                        group (their dedupe answers with the archived row), so this ad group cannot take the term.
 *              negative  a negative of the ad group, or of its campaign, that blocks the term: an exact negative with its
 *                        words, a phrase negative whose words it holds in order (ads-winner-lock.ts negativeBlocksTerm), a
 *                        negative product target of the ASIN. The new keyword would never show for it.
 *              gone      the ad group is no longer in Nexus.
 *   create   nothing of the term there (or only a row Amazon never took, which the create services send): created as before.
 *   serves   the destination's campaign and ad group are ENABLED. A landing that does not serve never negates the source;
 *            whether a keyword is still created there is the caller's choice (the brain never harvests into one).
 */
import prisma from '../../db.js'
import { normaliseNegTerm } from './ads-protect-converting.js'
import { negativeBlocksTerm } from './ads-winner-lock.js'

export type LandingMatch = 'EXACT' | 'PHRASE' | 'BROAD' | 'PRODUCT'
export interface LandingNegative { text: string; match: 'EXACT' | 'PHRASE' | 'PRODUCT'; level: 'AD_GROUP' | 'CAMPAIGN' }
export interface LandingTarget { id: string; status: string; externalTargetId: string | null }

/** One destination ad group as the guard reads it for one term. */
export interface LandingFacts {
  term: string
  match: LandingMatch
  adGroup: { id: string; name: string; status: string; campaign: { id: string; name: string; status: string } } | null
  /** Positive keywords (or product targets) there with the term's text and match type, any status. */
  existing: readonly LandingTarget[]
  /** The negatives that stand there: the ad group's own and its campaign's. */
  negatives: readonly LandingNegative[]
}

export type LandingHold = 'landing_gone' | 'landing_archived' | 'landing_negative'
export type LandingDecision =
  | { kind: 'create'; serves: boolean; why: string }
  | { kind: 'landed'; targetId: string; externalTargetId: string; serves: boolean; why: string }
  | { kind: 'enable'; targetId: string; externalTargetId: string; serves: boolean; why: string }
  | { kind: 'hold'; deniedAt: LandingHold; why: string }

const isAsinTerm = (t: string) => /^b0[a-z0-9]{8}$/i.test(t.trim())
const what = (match: LandingMatch) => (match === 'PRODUCT' ? 'product target' : `${match.toLowerCase()} keyword`)
const lower = (s: string) => s.toLowerCase()

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

/** Pure — what a harvest landing in this ad group does (see the header). */
export function decideLanding(f: LandingFacts): LandingDecision {
  const g = f.adGroup
  const held = (deniedAt: LandingHold, words: string): LandingDecision =>
    ({ kind: 'hold', deniedAt, why: `${g ? `ad group "${g.name}" cannot take "${f.term}"` : `"${f.term}" cannot land`}: ${words}. Nothing was written there and the source is not negated` })
  if (!g) return held('landing_gone', 'the destination ad group is no longer in Nexus')
  const neg = blockingNegative(f.term, f.negatives)
  if (neg) return held('landing_negative', negativeWords(f.term, neg, { adGroup: g.name, campaign: g.campaign.name }))
  const serves = g.status === 'ENABLED' && g.campaign.status === 'ENABLED'
  const idle = serves ? '' : `; ${g.campaign.status !== 'ENABLED' ? `its campaign "${g.campaign.name}" is ${lower(g.campaign.status)}` : `the ad group is ${lower(g.status)}`}, so the source is not negated`
  const atAmazon = f.existing.filter((t) => !!t.externalTargetId)
  const on = atAmazon.find((t) => t.status === 'ENABLED')
  if (on) return { kind: 'landed', targetId: on.id, externalTargetId: on.externalTargetId!, serves, why: `the ${what(f.match)} "${f.term}" already runs in ad group "${g.name}"${idle}` }
  const paused = atAmazon.find((t) => t.status === 'PAUSED')
  if (paused) return { kind: 'enable', targetId: paused.id, externalTargetId: paused.externalTargetId!, serves, why: `the ${what(f.match)} "${f.term}" stands paused in ad group "${g.name}": it is switched on again as the landing${idle}` }
  if (atAmazon.some((t) => t.status === 'ARCHIVED')) return held('landing_archived', archivedWords(f.term, f.match))
  return { kind: 'create', serves, why: `nothing of "${f.term}" stands in ad group "${g.name}": it is created there${idle}` }
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
  const g = await prisma.adGroup.findUnique({ where: { id: args.adGroupId }, select: { id: true, name: true, status: true, campaign: { select: { id: true, name: true, status: true } } } })
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
  return {
    term, match: args.match,
    adGroup: { id: g.id, name: g.name, status: String(g.status), campaign: { id: g.campaign.id, name: g.campaign.name, status: String(g.campaign.status) } },
    existing: existing.map((t) => ({ id: t.id, status: String(t.status), externalTargetId: t.externalTargetId })),
    negatives: negatives.map(({ text, match, level }) => ({ text, match, level })),
  }
}

/** What a harvest landing of `term` in this ad group does now (see the header). */
export async function checkLanding(args: { adGroupId: string; term: string; match: LandingMatch }): Promise<LandingDecision> {
  return decideLanding(await landingFacts(args))
}

/** Who switches a paused landing on again: the harvest's own writer, its change set and why. */
export interface LandingWho { actor: string; manual?: boolean; confirmOwnLimits?: boolean; changeSetId?: string | null; reason: string }

/**
 * Switch a paused landing on again, through the keyword state write path (updateAdTargetWithSync: the write gate asked
 * now as the writer, then the queue sends it at once through the channel gateway). Only once this is accepted may the
 * caller negate the source.
 */
export async function enableLanding(targetId: string, who: LandingWho): Promise<{ ok: boolean; actionLogId: string | null; why: string | null }> {
  const { updateAdTargetWithSync } = await import('./ads-mutation.service.js')
  const actor = (who.actor.startsWith('user:') || who.actor.startsWith('automation:') ? who.actor : `user:${who.actor}`) as `user:${string}` | `automation:${string}`
  const res = await updateAdTargetWithSync({
    adTargetId: targetId, patch: { status: 'ENABLED' }, actor, reason: who.reason.slice(0, 500), changeSetId: who.changeSetId ?? null,
    manual: who.manual, confirmOwnLimits: who.confirmOwnLimits, askGate: true, applyImmediately: true,
  })
  return res.ok ? { ok: true, actionLogId: res.actionLogId, why: null } : { ok: false, actionLogId: null, why: res.error ?? 'the write was refused' }
}

/**
 * The homes among these that a source may hand its term to (a rule's handover): the target ENABLED with Amazon's id, in
 * an ENABLED ad group of an ENABLED campaign, and no negative there that blocks the term. A paused, archived or blocked
 * home would leave the term serving nowhere once its source is negated. Two reads.
 */
export async function servingLandings(items: ReadonlyArray<{ adTargetId: string; term: string }>): Promise<Set<string>> {
  const out = new Set<string>()
  const ids = [...new Set(items.map((i) => i.adTargetId).filter(Boolean))]
  if (!ids.length) return out
  const rows = await prisma.adTarget.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, externalTargetId: true, kind: true, adGroupId: true, adGroup: { select: { status: true, campaignId: true, campaign: { select: { status: true } } } } },
  })
  const live = new Map(rows.filter((r) => String(r.status) === 'ENABLED' && !!r.externalTargetId && String(r.adGroup?.status) === 'ENABLED' && String(r.adGroup?.campaign?.status) === 'ENABLED').map((r) => [r.id, r]))
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
