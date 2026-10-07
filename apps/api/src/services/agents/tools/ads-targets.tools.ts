/**
 * ADS AUTONOMY W4-5 (design 6 §4 "W3-4a") — targeting for Amazon Sponsored Products, in Claude's hands:
 *
 *   add-ad-targets           keywords (EXACT, PHRASE, BROAD), product targets (ASINs) and category targets (browse-node
 *                            ids) into ONE ad group of a manual campaign, up to 250 in one request, one step. Through the
 *                            ad group's own create services (ads-create.service.ts createKeywordLocal, createTargetLocal)
 *                            with `requireAmazon`: nothing is written unless Amazon took it. Each at the bid asked for —
 *                            it adds spend, so a person approves it with the approver's authenticator code (stepUp) — or,
 *                            with startAtFloor, born at the 5-cent floor with its planned bid remembered in the change
 *                            (no code: set-target-bid or bulk-ad-bid-change raises it later). A keyword or ASIN this
 *                            product already buys in another of its ad groups (the winners lock's "same product") is not
 *                            queued until the person says skip (it stays where it runs: the Owner's rule 2) or accept
 *                            (both buy it), never by rule once accepted — as build-sp-wizard-campaigns. Another
 *                            product buying the same words is allowed (rule 3). Undo: bulk-ad-bid-change lowers each to
 *                            the stop bid (they stay at Amazon: Nexus never archives in an undo).
 *   harvest-search-term      a search term made a keyword (an ASIN: a product target) in the harvest destination, and an
 *                            exact negative of it in the ad group it ran in, ONE step — graduate-keyword and
 *                            create-negative-keyword together. The keyword is created first; the source is negated only
 *                            once it stands. Never "harvested away": a term that converts in its source is not negated
 *                            there (the Owner's rule 2: ask with negateSource false — it keeps running there too; once its
 *                            new home wins, add-negative-targets closes the old place, the proven handover). A term at
 *                            home already for the same product is not created again (PB-6a L2). It behaves exactly like
 *                            graduate-keyword for spend (the money family rule: a lever an older tool has without the
 *                            code): no code, by rule only inside its limits. Undo: its own op undo — the keyword to the
 *                            stop bid and the source negative retired, both by this tool.
 *   set-harvest-destination  where a harvest lands for a scope (an ad group, a campaign, a portfolio, a line, a market or the
 *                            account) and a match type — the Keyword Harvest page's own stored destination
 *                            (harvest-destination.service.ts saveHarvestDestination, deleteHarvestDestination). Nexus only:
 *                            nothing is sent to Amazon; the harvest rules, harvest-search-term and graduate-keyword read
 *                            it. Undo: the destination it replaced, set again (or removed).
 *
 * Every one follows ads-change-kit.ts — previewed first; refused, and not queued, when the write gate would refuse it;
 * run only as an approved request, as the approver, with changeSetId = the approval on every write and every row it
 * makes; re-checked in `execute` — and is strategy-bound (ads-autonomy-kit.ts): by default nothing runs alone (maxItems
 * 0, no market listed).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { createKeywordLocal, createTargetLocal } from '../../advertising/ads-create.service.js'
import { adGroupPlaces, targetingAdGroups, TARGETING_CAMPAIGN_SELECT, type TargetingGroup } from '../../advertising/ads-targeting-lookup.service.js'
import { updateAdTargetWithSync } from '../../advertising/ads-mutation.service.js'
import { writeNegativeKeyword, writeNegativeProductTarget } from '../../advertising/ads-negative-kw.service.js'
import { isAsin, protectedNegativeRefusal } from '../../advertising/ads-negation-policy.js'
import { normaliseNegTerm } from '../../advertising/ads-protect-converting.js'
import { familyAdGroups, negativeBlocksTerm, positivesIn, productFamilyOf, sameProductHome } from '../../advertising/ads-winner-lock.js'
import { meetsHarvest, searchTermTotals } from '../../advertising/ads-harvest.service.js'
import { harvestForScope } from '../../advertising/ads-strategy/terms.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import {
  HV_DEST_ACCOUNT, deleteHarvestDestination, loadDestinationGraph, resolveDestination, resolveStoredDestinations, saveHarvestDestination, storedHarvestDestination,
  type HvCreateType, type HvDestGrain,
} from '../../advertising/harvest-destination.service.js'
import { STEP_UP_NEEDS } from '../step-up-approval.js'
import { alsoChangedBy, approvedRun, BY_RULE_WORDS, gateRefusal, notRun, reachNote, recheck, ruleFactsFor, ruleRefusal, spOnlyRefusal, STOP_MIN_CENTS, type RuleWrite, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, LIMIT_FACTS_MONEY, limitFactsOf, type KitItem } from './ads-autonomy-kit.js'
import { amountLabel, campaignCurrency } from './ads-tool-guards.js'
import { convertingWords, fingerprint, named, otherProductWords, placeWords, plural, productRootsOf, reachOver, spendGate, termRulesFor, WINDOW_DAYS } from './ads-targeting-kit.js'
import type { AgentTool, FieldPermission, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = { add: 'add-ad-targets', harvest: 'harvest-search-term', destination: 'set-harvest-destination' } as const
/** The most targets one request adds (the tool contract's bound for a list), as ONE step. */
const MAX_TARGETS = 250
/** At most this many lines are listed in a preview; the rest are counted. */
const LINES_SHOWN = 20
/**
 * The floor a target born at the floor starts at: the lowest bid a Claude bid change takes (set-target-bid,
 * graduate-keyword's undo), so set-target-bid or bulk-ad-bid-change can raise it later (a bid at 3 cents or less without
 * a no-pause memory is never raised by them: ads-tool-guards.ts suppressionOf).
 */
const FLOOR_CENTS = STOP_MIN_CENTS
/** Amazon's most words in a keyword. */
const KEYWORD_MAX_WORDS = 10

const ID = z.string().trim().min(1).max(64)
const ASIN = z.string().trim().toUpperCase().regex(/^B0[A-Z0-9]{8}$/, 'an ASIN is B0 and 8 letters or digits')
const TEXT = z.string().trim().min(1).max(80)
const BID = z.coerce.number().int().min(FLOOR_CENTS).max(100_000)
const MATCH = z.enum(['EXACT', 'PHRASE', 'BROAD'])
type Match = z.infer<typeof MATCH>
const whyArg = z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit')
const marketsLimit = z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([])
  .describe('the markets where it may run by rule; empty = none: every request waits for a person')

type GroupRow = TargetingGroup
const groupById = async (id: string): Promise<GroupRow | null> => (await targetingAdGroups([id]))[0] ?? null

/** Why a target may not be added to this ad group at all, or null. `takes`: it must be in a manual campaign. */
function groupRefusal(g: GroupRow, takes: boolean): string | null {
  const c = g.campaign
  const notSp = spOnlyRefusal({ type: c.type == null ? null : String(c.type), adProduct: c.adProduct, name: c.name })
  if (notSp) return notSp
  if (String(c.status) === 'ARCHIVED') return 'its campaign is archived: an archived campaign serves no more'
  if (String(g.status) === 'ARCHIVED') return 'it is archived: an archived ad group serves no more'
  if (!c.externalCampaignId || !g.externalAdGroupId) return 'Nexus holds no Amazon id for it: it is not at Amazon'
  if (g.orphanedAt) return 'Amazon no longer has it (Nexus marked it gone)'
  if (takes && c.targetingType === 'AUTO') return 'its campaign is an automatic one: Amazon makes an auto campaign\'s targets itself. Add keywords and product targets to an ad group of a manual campaign'
  return null
}

/** The search term as the ads strategy places it: in its ad group (by Amazon's ids). */
const termEntity = (query: string, g: GroupRow) => ({ kind: 'searchTerm' as const, query, externalCampaignId: g.campaign.externalCampaignId ?? '', externalAdGroupId: g.externalAdGroupId })

/** What a person calls a target on a card. */
const targetWords = (t: { kind: 'KEYWORD' | 'PRODUCT' | 'CATEGORY'; value: string; match: Match | null }) =>
  t.kind === 'PRODUCT' ? `product target ${t.value}` : t.kind === 'CATEGORY' ? `category target ${t.value}` : `${t.match!.toLowerCase()} keyword "${t.value}"`

/** A positive target's match as Nexus stores it (`EXACT`, `_EXACT` while two ingests disagree, a v3 spelling). */
const storedMatch = (expressionType: string) => expressionType.replace(/^_+/, '').replace(/^NEGATIVE_/, '').toUpperCase()

// ── add-ad-targets ────────────────────────────────────────────────────────────────────────────────

const ADD_INPUT = z.object({
  adGroupId: ID.describe('the ad group the targets go into (Nexus adGroupId in ad-targets): an ad group of a manual Sponsored Products campaign at Amazon'),
  keywords: z.array(z.object({
    text: TEXT.describe("the keyword's words (at most 10)"),
    matchType: MATCH.describe('EXACT, PHRASE or BROAD'),
    bidCents: BID.optional().describe("its bid, in minor units of the campaign's currency (default: bidCents below, else the ad group's default bid)"),
  })).max(MAX_TARGETS).optional().describe('keywords to add'),
  productTargets: z.array(z.object({
    asin: ASIN.describe('the ASIN whose product page shows the ads'),
    bidCents: BID.optional().describe('its bid, in minor units of the campaign\'s currency (default as for keywords)'),
  })).max(MAX_TARGETS).optional().describe('product targets (ASINs) to add'),
  categoryTargets: z.array(z.object({
    categoryId: z.string().trim().regex(/^\d{1,20}$/, 'an Amazon browse-node id is digits').describe("Amazon's browse-node id of the category"),
    bidCents: BID.optional().describe('its bid, in minor units of the campaign\'s currency (default as for keywords)'),
  })).max(MAX_TARGETS).optional().describe('category targets to add'),
  bidCents: BID.optional().describe("the bid of every target that names none, in minor units of the campaign's currency (default: the ad group's default bid)"),
  startAtFloor: z.boolean().optional()
    .describe(`true: every target is born at the ${FLOOR_CENTS}-cent floor with its planned bid remembered in the change (no authenticator code: it spends next to nothing); set-target-bid raises it later. Default false: at its bid, which adds spend and needs the approver's code`),
  sameProductTerms: z.enum(['skip', 'accept']).optional()
    .describe('a keyword or ASIN this product already buys in another of its ad groups: skip = leave it out (it keeps running where it is), accept = this ad group buys it too (both bid for it; never by rule). Without it, such a request is not queued'),
  why: whyArg,
})
type AddArgs = z.infer<typeof ADD_INPUT>

/** One target a request adds, at the bid it is written at, and the bid planned for it. */
interface NewTarget { key: string; kind: 'KEYWORD' | 'PRODUCT' | 'CATEGORY'; value: string; match: Match | null; plannedCents: number; writtenCents: number }

/** add-ad-targets' Claude limits: by default nothing runs alone (maxItems 0, maxBidCents 0, no market). */
const ADD_LIMITS = adKitLimits({ maxItems: 0 }, {
  matchTypes: z.array(MATCH).max(3).default(['EXACT']).describe('the keyword match types that may be added by rule'),
  maxBidCents: z.number().int().min(0).max(100_000).default(0)
    .describe("the highest bid a target added by rule may start at, in minor units of the campaign's currency; 0 = every request waits for a person"),
  allowProductTargets: z.boolean().default(false).describe('let product (ASIN) and category targets be added by rule'),
  campaignIds: z.array(ID).max(100).default([]).describe('the campaigns (Nexus ids) whose ad groups may take targets by rule; empty = any campaign of the markets below'),
  markets: marketsLimit,
})

/** How a request at its bids is approved, in one sentence (its stepUp). */
const ADD_HOW = 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms it in '
  + 'Claude with theirs when the business set add-ad-targets to confirm in Claude. By rule only inside this tool\'s limits (maxBidCents, 0 by default).'

async function decideAdd(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>, opts: { rule: boolean }): Promise<{ result: ToolResult; group?: GroupRow; targets: NewTarget[] }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult, targets: [] as NewTarget[] })
  const parsed = ADD_INPUT.safeParse(raw)
  if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '))
  const a: AddArgs = parsed.data
  const g = await groupById(a.adGroupId)
  if (!g) return refuse(`Not queued: ad group ${a.adGroupId} was not found in this business.`)
  const cannot = groupRefusal(g, true)
  if (cannot) return refuse(`Not queued: ${placeWords(g)}: ${cannot}.`)
  const asked = [
    ...(a.keywords ?? []).map((k) => ({ kind: 'KEYWORD' as const, value: k.text, match: k.matchType as Match | null, bid: k.bidCents })),
    ...(a.productTargets ?? []).map((t) => ({ kind: 'PRODUCT' as const, value: t.asin, match: null, bid: t.bidCents })),
    ...(a.categoryTargets ?? []).map((t) => ({ kind: 'CATEGORY' as const, value: t.categoryId, match: null, bid: t.bidCents })),
  ]
  if (!asked.length) return refuse('Name the targets to add: keywords, productTargets or categoryTargets.')
  if (asked.length > MAX_TARGETS) return refuse(`${asked.length} targets asked for: at most ${MAX_TARGETS} in one request. Split them.`)
  const problems: string[] = []
  for (const k of asked.filter((x) => x.kind === 'KEYWORD')) {
    if (isAsin(k.value)) problems.push(`"${k.value}" is an ASIN, a product: name it in productTargets`)
    else if (normaliseNegTerm(k.value).split(' ').length > KEYWORD_MAX_WORDS) problems.push(`"${k.value}" has more than ${KEYWORD_MAX_WORDS} words, which Amazon does not accept in a keyword`)
  }
  if (problems.length) return refuse(`Not queued: ${named(problems)}.`)
  const currency = campaignCurrency(g.campaign)
  const keyOf = (x: { kind: string; value: string; match: Match | null }) => `${x.kind}:${x.match ?? ''}:${x.kind === 'KEYWORD' ? normaliseNegTerm(x.value) : x.value.toUpperCase()}`
  const twice = asked.filter((x, i) => asked.findIndex((y) => keyOf(y) === keyOf(x)) !== i).map(targetWords)
  if (twice.length) return refuse(`Not queued: asked for twice — ${named([...new Set(twice)])}. Name each once.`)

  // A floored campaign or ad group (a temporary stop with low bids): a new target at its bid would spend while the rest
  // is stopped, so only a target born at the floor goes in.
  const floored = g.campaign.bidsSuppressedAt ? `campaign "${g.campaign.name}"` : g.bidsSuppressedAt ? placeWords(g) : null
  if (floored && a.startAtFloor !== true) {
    return refuse(`Not queued: the bids of ${floored} are at the floor (a temporary stop, by ${(g.campaign.bidsSuppressedAt ? g.campaign.bidsSuppressedBy : g.bidsSuppressedBy) ?? 'an unrecorded writer'}): a target at its bid would spend while the rest is stopped. Ask with startAtFloor: true, or restore its bids first (restore-campaign).`)
  }
  const fallback = a.bidCents ?? (g.defaultBidCents > 0 ? g.defaultBidCents : null)
  const missingBid = asked.filter((x) => x.bid == null && fallback == null)
  if (missingBid.length) return refuse(`Not queued: name a bid (bidCents): ${placeWords(g)} has no default bid for ${named(missingBid.map(targetWords))}.`)

  // Already in this ad group — enabled, paused, archived or only in Nexus: the create services would find that row and
  // write nothing (an archived one stays archived at Amazon).
  const existing = await prisma.adTarget.findMany({ where: { adGroupId: g.id, isNegative: false, kind: { in: ['KEYWORD', 'PRODUCT', 'CATEGORY'] } }, select: { kind: true, expressionType: true, expressionValue: true, status: true, externalTargetId: true } })
  const there = new Map(existing.map((t) => [keyOf({ kind: String(t.kind), value: t.expressionValue, match: String(t.kind) === 'KEYWORD' ? storedMatch(t.expressionType) as Match : null }), t]))
  const dupes = asked.filter((x) => there.has(keyOf(x))).map((x) => {
    const t = there.get(keyOf(x))!
    const state = String(t.status) === 'ARCHIVED' ? 'archived (Amazon never switches it on again, and Nexus does not add the same one again here)' : !t.externalTargetId ? 'in Nexus only (it never reached Amazon)' : String(t.status).toLowerCase()
    return `${targetWords(x)} is already in this ad group, ${state}`
  })
  if (dupes.length) return refuse(`Not queued: ${named(dupes)}.`)

  // The Owner's rule 2 (winners stay) and rule 3 (per product): what this product already buys in its other ad groups.
  const family = await productFamilyOf([g.id])
  const scope = (await familyAdGroups(family, g.campaign.marketplace)).filter((id) => id !== g.id)
  const elsewhere = [...(await positivesIn(scope)).values()].flat()
  const homes = await adGroupPlaces(elsewhere.map((p) => p.adGroupId))
  const clashes = asked.flatMap((x) => {
    if (x.kind === 'CATEGORY') return []
    const same = elsewhere.filter((p) => (x.kind === 'PRODUCT' ? p.match === 'PRODUCT' && p.text.toUpperCase() === x.value.toUpperCase() : p.match !== 'PRODUCT' && normaliseNegTerm(p.text) === normaliseNegTerm(x.value)))
    return same.length ? [{ key: keyOf(x), target: targetWords(x), where: [...new Set(same.map((p) => (homes.get(p.adGroupId) ? placeWords(homes.get(p.adGroupId)!) : p.adGroupId)))].slice(0, 3) }] : []
  })
  if (clashes.length && !a.sameProductTerms) {
    return refuse(`Not queued: this product already buys ${named(clashes.map((c) => `${c.target} in ${c.where.join(', ')}`))} — ${placeWords(g)} would bid against it. `
      + 'Ask again with sameProductTerms skip (they keep running where they are) or accept (both buy them; never by rule).')
  }
  const skipped = a.sameProductTerms === 'skip' ? new Set(clashes.map((c) => c.key)) : new Set<string>()
  const kept = asked.filter((x) => !skipped.has(keyOf(x)))
  if (!kept.length) return refuse(`Nothing to add: every target is one this product already buys elsewhere, and sameProductTerms skip leaves them where they run (${named(clashes.map((c) => c.target))}).`)
  const accepted = a.sameProductTerms === 'accept' ? clashes : []

  const targets: NewTarget[] = kept.map((x) => {
    const planned = x.bid ?? (fallback as number)
    return { key: keyOf(x), kind: x.kind, value: x.value, match: x.match, plannedCents: planned, writtenCents: a.startAtFloor ? Math.min(FLOOR_CENTS, planned) : planned }
  })
  // A negative of this ad group (or a campaign negative) that blocks a new keyword: it would never serve. Said, not refused.
  const negatives = await prisma.adTarget.findMany({
    where: { isNegative: true, status: { not: 'ARCHIVED' }, OR: [{ adGroupId: g.id }, { negativeLevel: 'CAMPAIGN', adGroup: { campaignId: g.campaign.id } }] },
    select: { kind: true, expressionType: true, expressionValue: true },
  })
  const warnings = targets.flatMap((t) => {
    const blocker = negatives.find((n) => (t.kind === 'PRODUCT'
      ? String(n.kind) === 'PRODUCT' && n.expressionValue.toUpperCase() === t.value.toUpperCase()
      : t.kind === 'KEYWORD' && String(n.kind) === 'KEYWORD' && negativeBlocksTerm({ text: n.expressionValue, match: /PHRASE/.test(n.expressionType) ? 'PHRASE' : 'EXACT' }, t.value)))
    return blocker ? [`${targetWords(t)}: a negative "${blocker.expressionValue}" here blocks it, so it will not serve until that negative is retired (retire-negatives)`] : []
  })

  // Where it lands: the gate asked with the highest and the lowest bid written (the campaign's bounds and the strategy
  // band bind both sides; a person's approval past them is his "Send anyway", warned on the card).
  const bids = [...new Set(targets.map((t) => t.writtenCents))].sort((x, y) => x - y)
  const writes = [...new Set([bids[0], bids[bids.length - 1]])].map((cents) => ({
    campaignId: g.campaign.id, adGroupId: g.id, marketplace: g.campaign.marketplace, changes: [{ field: 'bid', valueCents: cents }], label: `campaign "${g.campaign.name}"`,
  }))
  const reached = await reachOver(writes)
  if ('refused' in reached) return refuse(`Not queued: ${reached.label}: ${gateRefusal(reached.refused)}`)
  const stored = reached.reach
  const bound = await alsoChangedBy(g.campaign.id)
  const queryOf = (t: NewTarget) => (t.kind === 'CATEGORY' ? `category:${t.value}` : t.value)
  const kit: KitItem[] = targets.map((t) => ({ entity: termEntity(queryOf(t), g), change: { field: 'bid', fromCents: null, toCents: t.writtenCents } }))
  const facts = opts.rule
    ? await ruleFactsFor({ tool: TOOL.add, limits: ADD_LIMITS, items: kit, writes: [{ ...writes[writes.length - 1] } as RuleWrite], approvalId: ctx.approvalId ?? null })
    : null

  const atBid = targets.filter((t) => t.writtenCents === t.plannedCents && !(a.startAtFloor))
  const lines = targets.map((t) => ({
    label: targetWords(t), kind: t.kind, match: t.match, fromLabel: 'none',
    toLabel: a.startAtFloor ? `at the ${FLOOR_CENTS}-cent floor (planned ${amountLabel(t.plannedCents, currency)})` : `at ${amountLabel(t.writtenCents, currency)}`,
    bidCents: t.writtenCents, plannedBidCents: t.plannedCents, currency,
  }))
  const highest = Math.max(...targets.map((t) => t.writtenCents))
  const counts = { keywords: targets.filter((t) => t.kind === 'KEYWORD').length, productTargets: targets.filter((t) => t.kind === 'PRODUCT').length, categoryTargets: targets.filter((t) => t.kind === 'CATEGORY').length }
  const effect = `Adds ${plural(targets.length, 'target')} to ${placeWords(g)} at Amazon: ${named(lines.map((l) => `${l.label} ${l.toLabel}`))}.`
    + (a.startAtFloor
      ? ` Each starts at the ${FLOOR_CENTS}-cent floor and spends next to nothing; its planned bid is kept in this change, and set-target-bid (or bulk-ad-bid-change) raises it when it should spend.`
      : ` They start spending at their bids (the highest ${amountLabel(highest, currency)}).`)
    + (skipped.size ? ` Left out (this product buys them elsewhere, where they keep running): ${named(clashes.map((c) => c.target))}.` : '')
    + (accepted.length ? ` Accepted: this product already buys ${named(accepted.map((c) => c.target))} elsewhere — both now bid for ${accepted.length === 1 ? 'it' : 'them'}.` : '')
  return {
    group: g,
    targets,
    result: {
      ok: true,
      preview: {
        action: TOOL.add,
        adGroup: { id: g.id, name: g.name },
        campaign: { id: g.campaign.id, name: g.campaign.name, marketplace: g.campaign.marketplace },
        currency,
        totals: { targets: targets.length, ...counts, atBid: atBid.length, atFloor: a.startAtFloor ? targets.length : 0, leftOut: skipped.size },
        changes: lines.slice(0, LINES_SHOWN),
        ...(lines.length > LINES_SHOWN ? { moreChanges: lines.length - LINES_SHOWN } : {}),
        // Every target at its bid starts spending: each is listed, and approving needs the approver's code.
        raises: atBid.map((t) => `${targetWords(t)} at ${amountLabel(t.writtenCents, currency)}`),
        ...(atBid.length ? { stepUp: { what: `adds ${plural(atBid.length, 'target')} that ${atBid.length === 1 ? 'starts' : 'start'} spending at ${atBid.length === 1 ? 'its bid' : 'their bids'}`, raises: ['Bids', 'Spend'], needs: STEP_UP_NEEDS, how: ADD_HOW } } : {}),
        ...(a.startAtFloor ? { startsAtFloor: { floorCents: FLOOR_CENTS, note: `Every target starts at the ${FLOOR_CENTS}-cent floor; its planned bid is kept in this change. set-target-bid raises it when it should spend (a raise, judged then).` } } : {}),
        highestBidCents: highest,
        // Rule 2 / rule 3 — what this product already buys elsewhere that this ad group buys too (accepted: never by rule).
        sameProductClashes: accepted,
        ...(skipped.size ? { leftOut: clashes.map((c) => ({ target: c.target, keepsRunningIn: c.where })) } : {}),
        ...(warnings.length ? { warnings } : {}),
        alsoChangedBy: bound.automations,
        ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
        // Every target with its written and planned bid, and the ad group's floor state: a move after approval is caught.
        basis: fingerprint({ adGroup: g.id, floored: !!floored, targets: targets.map((t) => [t.key, t.writtenCents, t.plannedCents]), accepted: accepted.map((c) => c.key) }),
        reach: stored,
        reachNote: reachNote(stored),
        effect,
        undoNote: 'Undo lowers each target it added to the stop bid (bulk-ad-bid-change): they stay at Amazon (Nexus never archives in an undo), spending next to nothing; archive-ads removes them for good.',
        ...(facts ?? {}),
      },
    },
  }
}

/** add-ad-targets' own checks after the common ones (pure, on the preview). */
function addRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { action?: string; sameProductClashes?: unknown[]; campaign?: { id?: string; marketplace?: string | null }; changes?: unknown; highestBidCents?: number; currency?: string; totals?: { productTargets?: number; categoryTargets?: number } }
  if (p.action !== TOOL.add) return 'there is no preview of these targets to check; a person decides'
  if (!Array.isArray(p.sameProductClashes)) return 'the preview does not say whether this product already buys these terms elsewhere; a person decides'
  if (p.sameProductClashes.length) return `it adds ${plural(p.sameProductClashes.length, 'target')} this product already buys in another ad group (accepted): they would bid against each other; a person decides`
  const markets = (limits.markets as string[] | undefined) ?? []
  if (!markets.length) return 'this business names no market where targets may be added by rule (markets is empty); a person decides'
  if (!p.campaign?.marketplace || !markets.includes(p.campaign.marketplace)) return `this business lets targets be added by rule only in ${markets.join(', ')}; a person decides`
  const campaigns = (limits.campaignIds as string[] | undefined) ?? []
  if (campaigns.length && !campaigns.includes(p.campaign.id ?? '')) return 'this business lets targets be added by rule only to the campaigns its limits name (campaignIds); a person decides'
  if (((p.totals?.productTargets ?? 0) + (p.totals?.categoryTargets ?? 0)) > 0 && limits.allowProductTargets !== true) {
    return 'it adds product or category targets; this tool\'s limits do not let them be added by rule (allowProductTargets is off); a person decides'
  }
  const facts = limitFactsOf(preview)
  if (!facts) return null // ruleRefusal says it
  const matchTypes = new Set((limits.matchTypes as string[] | undefined) ?? ['EXACT'])
  for (const line of Array.isArray(p.changes) ? (p.changes as Array<{ kind?: string; match?: string | null }>) : []) {
    if (line.kind === 'KEYWORD' && line.match && !matchTypes.has(line.match)) return `it adds a ${line.match.toLowerCase()} keyword, which this tool's limits do not let be added by rule (matchTypes); a person decides`
  }
  const max = typeof limits.maxBidCents === 'number' ? limits.maxBidCents : 0
  const highest = p.highestBidCents ?? Number.POSITIVE_INFINITY
  if (!(highest <= max)) return `its highest bid ${amountLabel(highest, p.currency ?? 'EUR')} is above the ${amountLabel(max, p.currency ?? 'EUR')} this tool's limits let a new target start at by rule${max === 0 ? ' (0: every request waits for a person)' : ''}; a person decides`
  return null
}

/** add-ad-targets' material fields: every target with its bids and the ad group's floor state, and where it lands. */
const ADD_MATERIAL = ['basis', 'reach'] as const

/** What is stored NOW for each target a request added (the undo guard compares it with `after`). */
async function targetBidsNow(change: ToolChange): Promise<{ targets: Array<{ targetId: string; bidCents: number | null }> }> {
  const listed = ((change.after as { targets?: Array<{ targetId?: unknown }> } | null)?.targets ?? []).map((t) => String(t.targetId ?? ''))
  const rows = listed.length ? await prisma.adTarget.findMany({ where: { id: { in: listed } }, select: { id: true, bidCents: true } }) : []
  const bid = new Map(rows.map((r) => [r.id, r.bidCents]))
  return { targets: listed.map((targetId) => ({ targetId, bidCents: bid.get(targetId) ?? null })) }
}

/**
 * C2 — undo of an add: each target it added lowered to the stop bid of its campaign (bulk-ad-bid-change `stop`: one move,
 * never a raise; one at or below it is left as it is). They stay at Amazon: Nexus never archives in an undo (archive-ads
 * does that, for good). Partly reversible: they served meanwhile.
 */
export const ADD_TARGETS_UNDO: ToolUndo = {
  current: targetBidsNow,
  request(change) {
    const targets = ((change.after as { targets?: Array<{ targetId?: unknown; bidCents?: unknown }> } | null)?.targets ?? [])
    const above = targets.filter((t) => typeof t.bidCents === 'number' && t.bidCents > FLOOR_CENTS)
    if (!targets.length) return { refusal: 'This change does not record the targets it added.' }
    if (!above.length) return { refusal: `Every target it added sits at the ${FLOOR_CENTS}-cent floor already: there is nothing to lower. archive-ads removes them for good.` }
    return { tool: 'bulk-ad-bid-change', args: { bids: above.map((t) => ({ targetId: String(t.targetId), stop: true })), why: 'undo of add-ad-targets: each target it added lowered to the stop bid (it stays at Amazon)' } }
  },
}

const addAdTargets: AgentTool = {
  name: TOOL.add,
  title: 'Add keywords and targets',
  input: ADD_INPUT,
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  restrictedFields: LIMIT_FACTS_MONEY as Readonly<Record<string, FieldPermission>>,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  // Created at Amazon once approved (no cancel window).
  openWorld: true,
  // Undo lowers them to the stop bid: they stay at Amazon, and they served meanwhile.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: ADD_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits) ?? addRefusal(preview, limits),
  undo: ADD_TARGETS_UNDO,
  description:
    `Add keywords (EXACT, PHRASE, BROAD), product targets (ASINs) and category targets to ONE ad group of a manual Amazon `
    + `Sponsored Products campaign, up to ${MAX_TARGETS} in one request (one step), through the ad group's own create services: `
    + 'nothing is written unless Amazon takes it. At its bid (each its own, else bidCents, else the ad group\'s default bid) a '
    + 'target starts spending, so a person with settings.security.manage approves it in Nexus with their authenticator code '
    + '(or the person who asked confirms it in Claude with theirs); with startAtFloor: true every target is born at the '
    + `${FLOOR_CENTS}-cent floor with its planned bid kept in the change, no code, and set-target-bid raises it later. A keyword or `
    + 'ASIN this product already buys in another of its ad groups is not queued until sameProductTerms says skip (it stays '
    + 'where it runs) or accept (both buy it; never by rule); another product buying the same words is allowed. Refused, '
    + 'and not queued, for an auto campaign, a target already in the ad group, a floored campaign without startAtFloor, or '
    + `when Amazon's write gate would refuse it. ${BY_RULE_WORDS} (by default it does not: maxItems 0, no market). `
    + 'graduate-keyword stays the one-term form for a converting search term. Undo (undo-change) lowers what it added to the '
    + 'stop bid; archive-ads removes it for good.',
  async handler(args, ctx) {
    return (await decideAdd(args, ctx, { rule: true })).result
  },
  async execute(args, ctx) {
    const { result: fresh, group: g, targets } = await decideAdd(args, ctx, { rule: false })
    const refusal = recheck(ctx, fresh, ADD_MATERIAL)
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { reach: StoredReach; effect: string; raises: string[]; sameProductClashes: unknown[] }
    // Accepting what this product already buys elsewhere is a person's word: never a run the business's rule decided.
    if (ctx.decidedVia === 'auto' && p.sameProductClashes.length) return notRun('Not run: it adds what this product already buys elsewhere (accepted), which a person decides, never a rule. Ask for it again; a person approves it.')
    const gate = await spendGate(ctx, p.raises.length > 0, `adds ${plural(p.raises.length, 'target')} that start spending`)
    if ('refusal' in gate) return notRun(gate.refusal)
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const made: Array<{ targetId: string; t: NewTarget; atAmazon: boolean }> = []
    const failed: string[] = []
    for (const t of targets) {
      // The ad group's own creates (as the screen's add): the gate with the campaign named, nothing written unless Amazon
      // took it (requireAmazon), its audit row on this change set; a person's approval is his own click (4A).
      const common = { adGroupId: g!.id, bidEur: t.writtenCents / 100, userId: run.actor, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId, requireAmazon: true }
      const out = t.kind === 'KEYWORD'
        ? await createKeywordLocal({ ...common, keywordText: t.value, matchType: t.match!, evidence: { metric: 'claudeRequest', note: run.reason } })
        : await createTargetLocal({ ...common, kind: t.kind, value: t.value })
      if (out.id && (out.outcome === 'created' || out.outcome === 'local')) made.push({ targetId: out.id, t, atAmazon: out.externalTargetId != null })
      else failed.push(`${targetWords(t)} (${out.reason ?? out.outcome ?? 'not created'})`)
    }
    if (!made.length) return notRun(`Not run: no target was added — ${named(failed)}. Nothing changed.`)
    const data = {
      added: made.length,
      reachedAmazon: made.filter((m) => m.atAmazon).length,
      ...(failed.length ? { partial: true, failed: failed.length, problems: failed.slice(0, LINES_SHOWN), problem: `Added ${made.length} of ${targets.length}: ${named(failed)}. The rest was not added; ask for it again once that is fixed.` } : {}),
      targets: made.slice(0, LINES_SHOWN).map((m) => ({ targetId: m.targetId, target: targetWords(m.t), bidCents: m.t.writtenCents, plannedBidCents: m.t.plannedCents })),
      reach: p.reach,
      changeSetId: run.changeSetId,
      note: p.reach.reach === 'live' ? 'Created at Amazon at once (no cancel window).' : 'Sandbox: recorded in Nexus only; nothing reached Amazon.',
    }
    return {
      ok: true,
      data,
      change: {
        before: { changeSetId: run.changeSetId, adGroupId: g!.id, targets: [], added: made.map((m) => ({ targetId: m.targetId, kind: m.t.kind, value: m.t.value, match: m.t.match, plannedBidCents: m.t.plannedCents })) },
        after: await targetBidsNow({ before: null, after: { targets: made.map((m) => ({ targetId: m.targetId })) } }),
      },
    }
  },
}

// ── harvest-search-term ───────────────────────────────────────────────────────────────────────────

const HARVEST_INPUT = z.object({
  op: z.enum(['harvest', 'undo']).default('harvest')
    .describe('harvest (default): the term made a keyword in its destination, and negated in the ad group it ran in; undo: put back a harvest this tool made (its keyword lowered to the stop bid, its source negative retired)'),
  query: z.string().trim().min(1).max(80).optional().describe('harvest: the search term (query in ad-search-terms); an ASIN becomes a product target'),
  sourceAdGroupId: ID.optional().describe('harvest: the ad group it ran in (adGroupId in ad-search-terms)'),
  destAdGroupId: ID.optional().describe('harvest: the ad group the keyword goes into (Nexus id); default: the harvest destination stored for the source (set-harvest-destination), else the only one the harvest resolver offers'),
  matchType: MATCH.optional().describe('harvest: the new keyword\'s match type (default EXACT; an ASIN is a product target)'),
  bidCents: BID.optional().describe("harvest: its starting bid in minor units of the campaign's currency (default: the term's cost per click in its source over the last 60 days, at least 5)"),
  negateSource: z.boolean().optional()
    .describe('harvest: an exact negative of the term in the ad group it ran in (default true, or the stored destination\'s own choice). A term that converts there is never negated: ask with false and it keeps running there too'),
  changeSetId: ID.optional().describe('undo: the approvalId of the harvest to put back'),
  keywordId: ID.optional().describe('undo: the keyword (or product target) that harvest created'),
  negativeId: ID.optional().describe('undo: the source negative that harvest created, when it made one'),
  why: whyArg,
})
type HarvestArgs = z.infer<typeof HARVEST_INPUT>

/**
 * harvest-search-term's Claude limits — as graduate-keyword's and create-negative-keyword's together: the highest
 * starting bid a keyword may get by rule (0: every harvest waits for a person) and the markets (none by default).
 */
const HARVEST_LIMITS = adKitLimits({ maxItems: 0 }, {
  maxStartBidCents: z.number().int().min(0).max(100_000).default(0)
    .describe("the highest starting bid, in minor units of the campaign's currency, a harvested keyword may get by rule; 0 = every harvest waits for a person"),
  markets: marketsLimit,
})

interface HarvestPlan {
  query: string
  product: boolean
  match: Match
  source: GroupRow
  dest: GroupRow
  bidCents: number
  negate: 'add' | 'standing' | 'none'
  why: string
}

/** The term's record in its source over the window (search-term report). */
async function sourceRecord(query: string, g: GroupRow, windowDays = WINDOW_DAYS) {
  const all = g.externalAdGroupId ? [...(await searchTermTotals(windowDays, [g.externalAdGroupId])).values()] : []
  const key = isAsin(query) ? query.trim().toUpperCase() : normaliseNegTerm(query)
  const hit = all.filter((t) => (isAsin(t.query) ? t.query.trim().toUpperCase() : normaliseNegTerm(t.query)) === key)
  return { windowDays, impressions: hit.reduce((n, t) => n + t.impressions, 0), clicks: hit.reduce((n, t) => n + t.clicks, 0), spendCents: hit.reduce((n, t) => n + t.costCents, 0), orders: hit.reduce((n, t) => n + t.orders, 0), salesCents: hit.reduce((n, t) => n + t.salesCents, 0) }
}

async function decideHarvest(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>, opts: { rule: boolean }): Promise<{ result: ToolResult; plan?: HarvestPlan }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult })
  const parsed = HARVEST_INPUT.safeParse(raw)
  if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '))
  const a: HarvestArgs = parsed.data
  if (a.op === 'undo') return { result: await undoPreview(a, ctx, opts) }
  if (!a.query || !a.sourceAdGroupId) return refuse('Name the search term (query) and the ad group it ran in (sourceAdGroupId; ad-search-terms gives both).')
  const query = a.query
  const product = isAsin(query)
  if (product && a.matchType && a.matchType !== 'EXACT') return refuse(`"${query}" is an ASIN: it becomes a product target, which has no match type.`)
  const match: Match = product ? 'EXACT' : a.matchType ?? 'EXACT'
  const source = await groupById(a.sourceAdGroupId)
  if (!source) return refuse(`Not queued: ad group ${a.sourceAdGroupId} was not found in this business.`)
  const sourceCannot = groupRefusal(source, false)
  if (sourceCannot) return refuse(`Not queued: ${placeWords(source)}: ${sourceCannot}.`)
  const record = await sourceRecord(query, source)
  if (!record.impressions && !record.clicks) {
    return refuse(`Not queued: "${query}" did not run in ${placeWords(source)} over the last ${WINDOW_DAYS} days: there is nothing to harvest. To add a keyword of your own, ask add-ad-targets.`)
  }

  // Where it lands: the ad group named, else the harvest destination the account resolves (graduate-keyword's way).
  let dest: GroupRow | null
  let destWhy: string
  let storedNegate: boolean | null = null
  if (a.destAdGroupId) {
    dest = await groupById(a.destAdGroupId)
    if (!dest) return refuse(`Not queued: ad group ${a.destAdGroupId} was not found in this business.`)
    destWhy = 'named in the request'
  } else {
    const [graph, stored] = await Promise.all([
      loadDestinationGraph(),
      resolveStoredDestinations({ market: source.campaign.marketplace ?? 'all', campaign: source.campaign.id, adGroup: source.id }),
    ])
    const createType: HvCreateType = product ? 'PRODUCT' : match
    const resolved = resolveDestination({ graph, stored, sourceAdGroupId: source.id, sourceAdGroupName: source.name, term: query, kind: product ? 'product' : 'keyword', createType })
    if (!resolved.chosen) {
      return refuse(`Not queued: no destination ad group is decided for "${query}" (${resolved.source === 'resolved-ambiguous' ? `${resolved.shortlist.length} could take it` : 'none fits'}). Name one (destAdGroupId), or store one with set-harvest-destination.`)
    }
    dest = await groupById(resolved.chosen.adGroupId)
    if (!dest) return refuse('Not queued: the resolved destination ad group was not found.')
    destWhy = resolved.source === 'stored' ? 'the harvest destination stored for this source' : 'the only ad group the harvest resolver offers'
    if (resolved.source === 'stored') storedNegate = stored.get(createType)?.negateAtSource ?? null
  }
  const destCannot = groupRefusal(dest, true)
  if (destCannot) return refuse(`Not queued: ${placeWords(dest)}: ${destCannot}.`)
  const negateAsked = a.negateSource ?? storedNegate ?? true
  if (negateAsked && dest.id === source.id) return refuse(`Not queued: the keyword lands in ${placeWords(source)}, the ad group the term ran in: a negative there would block it. Ask with negateSource: false, or name another destination.`)

  // Already there, or at home for the same product elsewhere: a winner stays where it is (PB-6a L2).
  const kind = product ? 'PRODUCT' : 'KEYWORD'
  const already = await prisma.adTarget.findFirst({
    where: { adGroupId: dest.id, isNegative: false, kind, expressionValue: { equals: query, mode: 'insensitive' } },
    select: { expressionType: true, status: true },
  })
  if (already && (product || storedMatch(already.expressionType) === match)) return refuse(`Not queued: ${targetWords({ kind, value: query, match: product ? null : match })} is already in ${placeWords(dest)} (${String(already.status).toLowerCase()}).`)
  const home = await sameProductHome(query, { destAdGroupId: dest.id, source: { adGroupId: source.id, campaignId: source.campaign.id }, marketplace: dest.campaign.marketplace })
  if (home) return refuse(`Not queued: "${query}" already lives in ${home.campaign} › ${home.adGroup}, which advertises the same product, so it is not created again: a winner stays where it is.`)

  // The source negative — never harvesting a winner away (rule 2), never another product's (rule 3).
  let negate: HarvestPlan['negate'] = 'none'
  if (negateAsked) {
    const standing = await prisma.adTarget.findFirst({
      where: { adGroupId: source.id, isNegative: true, status: { not: 'ARCHIVED' }, kind, expressionValue: { equals: query, mode: 'insensitive' }, ...(product ? {} : { expressionType: { in: ['NEGATIVE_EXACT', 'EXACT'] } }) },
      select: { id: true },
    })
    if (standing) negate = 'standing'
    else {
      const protectedHit = product ? null : await protectedNegativeRefusal({ text: query, matchType: 'NEGATIVE_EXACT', marketplace: source.campaign.marketplace, campaignId: source.campaign.id })
      if (protectedHit && !protectedHit.protectedProduct) return refuse(`Not queued: ${protectedHit.reason.replace(/\.$/, '')}. Ask with negateSource: false to harvest it without the source negative.`)
      const destRoots = (await productRootsOf([dest.id])).get(dest.id)?.roots ?? new Set<string>()
      const rules = await termRulesFor([{ key: 'source', text: query, match: product ? 'PRODUCT' : 'EXACT', adGroupIds: [source.id] }], { product: destRoots.size === 1 ? { root: [...destRoots][0], label: 'the destination\'s product' } : null })
      if (rules.converting.length) {
        return refuse(`Not queued: "${query}" converts where it runs — ${convertingWords(rules.converting)} over the last ${rules.windowDays} days — so negating it there would harvest a winner away from where it wins (the Owner's rule 2). `
          + 'Ask with negateSource: false: the keyword is added and the term keeps running in its source too; once the new keyword wins, add-negative-targets closes the old place (the proven handover).')
      }
      if (rules.otherProducts.length) {
        return refuse(`Not queued: the source negative would stop another product from a term it buys — ${otherProductWords(rules.otherProducts)} (the Owner's rule 3). Ask with negateSource: false, or ask add-negative-targets for that negative with allowOtherProducts.`)
      }
      negate = 'add'
    }
  }

  // The starting bid: the one asked, else the harvest's own (the term's cost per click in its source), never below 5.
  const bidCents = a.bidCents ?? (record.clicks > 0 ? Math.max(FLOOR_CENTS, Math.round(record.spendCents / record.clicks)) : 50)
  const writes: Array<RuleWrite & { label: string }> = [
    { campaignId: dest.campaign.id, adGroupId: dest.id, marketplace: dest.campaign.marketplace, changes: [{ field: 'bid', valueCents: bidCents }], label: `campaign "${dest.campaign.name}"` },
    ...(negate === 'add' ? [{ campaignId: source.campaign.id, marketplace: source.campaign.marketplace, changes: [{ field: 'negativeKeyword', valueCents: null }], isNegation: true, keywordText: query, label: `campaign "${source.campaign.name}"` }] : []),
  ]
  const reached = await reachOver(writes)
  if ('refused' in reached) return refuse(`Not queued: ${reached.label}: ${gateRefusal(reached.refused)}`)
  const stored = reached.reach
  const currency = campaignCurrency(dest.campaign)
  const bound = await alsoChangedBy(dest.campaign.id)
  const plan: HarvestPlan = { query, product, match, source, dest, bidCents, negate, why: destWhy }
  const rule = opts.rule ? await harvestRuleFacts(plan, writes, ctx.approvalId ?? null) : null
  const created = targetWords({ kind, value: query, match: product ? null : match })
  const sourceCurrency = campaignCurrency(source.campaign)
  const effect = `Harvests "${query}": a ${created} at ${amountLabel(bidCents, currency)} in ${placeWords(dest)} (${destWhy}); in ${placeWords(source)} it had ${record.clicks} click${record.clicks === 1 ? '' : 's'}, ${record.orders} order${record.orders === 1 ? '' : 's'} on ${amountLabel(record.spendCents, sourceCurrency)} over the last ${WINDOW_DAYS} days. `
    + (negate === 'add' ? `Then an exact negative of it in ${placeWords(source)}, so that ad group stops bidding for it — only once the keyword stands.`
      : negate === 'standing' ? `${placeWords(source)} negates it already: no negative is added.`
        : `${placeWords(source)} is not negated: the term keeps running there too.`)
  return {
    plan,
    result: {
      ok: true,
      preview: {
        action: TOOL.harvest,
        op: 'harvest',
        query,
        currency,
        source: { adGroupId: source.id, name: source.name, campaign: source.campaign.name, marketplace: source.campaign.marketplace },
        destinationAdGroup: { id: dest.id, name: dest.name, campaign: dest.campaign.name, why: destWhy },
        campaign: { id: dest.campaign.id, name: dest.campaign.name, marketplace: dest.campaign.marketplace },
        changes: [
          { label: `${created} · ${placeWords(dest)}`, fromLabel: 'none', toLabel: `at ${amountLabel(bidCents, currency)}` },
          ...(negate === 'add' ? [{ label: `negative exact "${query}" · ${placeWords(source)}`, fromLabel: 'none', toLabel: product ? 'negative product target' : 'negative exact' }] : []),
        ],
        bidCents,
        record,
        negateSource: negate,
        // As graduate-keyword: a new keyword is a raise the kit counts, approved without a code (the money family rule).
        raises: [`${created} at ${amountLabel(bidCents, currency)}`],
        alsoChangedBy: bound.automations,
        ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
        basis: fingerprint({ query: normaliseNegTerm(query), match, source: source.id, dest: dest.id, bidCents, negate }),
        reach: stored,
        reachNote: reachNote(stored),
        effect,
        undoNote: 'Undo (undo-change) asks this tool for op undo: the keyword lowered to the stop bid (it stays at Amazon) and the source negative retired, so the term runs there again.',
        ...(rule ?? {}),
      },
    },
  }
}

/**
 * By rule — graduate-keyword's facts (AA-W2-7) for the keyword, create-negative-keyword's for the source negative: the
 * kit's facts of both, the gate as a rule's write, and the term's record where it ran against the ads strategy's
 * "Harvest a search term when" group there.
 */
async function harvestRuleFacts(plan: HarvestPlan, writes: RuleWrite[], approvalId: string | null) {
  const items: KitItem[] = [
    { entity: termEntity(plan.query, plan.dest), change: { field: 'bid', fromCents: null, toCents: plan.bidCents } },
    ...(plan.negate === 'add' ? [{ entity: termEntity(plan.query, plan.source), change: { field: 'negative' as const, term: plan.query, matchType: plan.product ? null : 'NEGATIVE_EXACT' } }] : []),
  ]
  const facts = await ruleFactsFor({ tool: TOOL.harvest, limits: HARVEST_LIMITS, items, writes, approvalId })
  const harvest = plan.source.campaign.marketplace ? await harvestForScope(plan.source.campaign.marketplace, { adGroupId: plan.source.id }) : null
  const ruleHarvest = harvest
    ? { harvestMinOrders: harvest.group.minOrders, harvestMinClicks: harvest.group.minClicks, harvestMaxAcosPct: harvest.group.maxAcosPct, harvestWindowDays: harvest.group.windowDays, from: strategyWords(harvest.source) }
    : null
  const ruleRecord = harvest ? await sourceRecord(plan.query, plan.source, harvest.group.windowDays) : null
  return { ...facts, ruleHarvest, ruleRecord }
}

/** harvest-search-term's own checks after the common ones (pure): the bid within its limit, the strategy's harvest bar. */
function harvestRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as {
    action?: string; op?: string; query?: string; bidCents?: number; currency?: string; campaign?: { marketplace?: string | null }
    ruleHarvest?: { harvestMinOrders: number; harvestMinClicks: number; harvestMaxAcosPct: number | null; harvestWindowDays: number; from: string } | null
    ruleRecord?: { windowDays: number; clicks: number; spendCents: number; orders: number; salesCents: number } | null
  }
  if (p.action !== TOOL.harvest) return 'there is no preview of this harvest to check; a person decides'
  if (p.op === 'undo') return 'an undo of a harvest lifts the negative it made, which no run by rule judges; a person decides'
  const markets = (limits.markets as string[] | undefined) ?? []
  if (!markets.length) return 'this business names no market where a harvest may run by rule (markets is empty); a person decides'
  if (!p.campaign?.marketplace || !markets.includes(p.campaign.marketplace)) return `this business lets a harvest run by rule only in ${markets.join(', ')}; a person decides`
  const currency = p.currency ?? 'EUR'
  const max = typeof limits.maxStartBidCents === 'number' ? limits.maxStartBidCents : 0
  if (!((p.bidCents ?? Number.POSITIVE_INFINITY) <= max)) return `its starting bid ${amountLabel(p.bidCents ?? 0, currency)} is above the ${amountLabel(max, currency)} this tool's limits let a harvested keyword start at by rule${max === 0 ? ' (0: every harvest waits for a person)' : ''}; a person decides`
  const h = p.ruleHarvest
  if (!h) return `the ads strategy sets no "Harvest a search term when" group where "${p.query}" ran: a harvest runs by rule only for a term that meets one; a person decides`
  const r = p.ruleRecord
  if (!r || r.windowDays !== h.harvestWindowDays) return `the term's record over the strategy's ${h.harvestWindowDays} days was not read for this preview; a person decides`
  if (!meetsHarvest({ orders: r.orders, clicks: r.clicks, costCents: r.spendCents, salesCents: r.salesCents }, { minOrders: h.harvestMinOrders, minClicks: h.harvestMinClicks, maxAcosPct: h.harvestMaxAcosPct })) {
    return `"${p.query}" has ${r.clicks} clicks and ${r.orders} orders on ${amountLabel(r.spendCents, currency)} over ${r.windowDays} days, which does not meet "Harvest a search term when" (${h.from}); a person decides`
  }
  return null
}

/** The undo of a harvest, judged: what is left of what it made, as its preview. */
async function undoPreview(a: HarvestArgs, ctx: Pick<ToolContext, 'approvalId'>, opts: { rule: boolean }): Promise<ToolResult> {
  if (!a.changeSetId || !a.keywordId) return { ok: false, error: 'Name the harvest to put back: changeSetId (its approvalId) and keywordId (and negativeId, when it made one) — undo-change fills them in.' }
  const ids = [a.keywordId, ...(a.negativeId ? [a.negativeId] : [])]
  const [rows, made] = await Promise.all([
    prisma.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, isNegative: true, status: true, bidCents: true, kind: true, expressionValue: true, suppressedFromBidCents: true, adGroup: { select: { id: true, name: true, campaign: { select: TARGETING_CAMPAIGN_SELECT } } } } }),
    // Only what that harvest made: its own create rows carry its change set.
    prisma.advertisingActionLog.findMany({ where: { executionId: a.changeSetId, entityType: 'AD_TARGET', entityId: { in: ids } }, select: { entityId: true } }),
  ])
  const byId = new Map(rows.map((r) => [r.id, r]))
  const ours = new Set(made.map((m) => m.entityId))
  const keyword = byId.get(a.keywordId)
  if (!keyword || keyword.isNegative || !ours.has(keyword.id)) return { ok: false, error: `Not queued: harvest ${a.changeSetId} did not make the keyword ${a.keywordId} in this business.` }
  const negative = a.negativeId ? byId.get(a.negativeId) : undefined
  if (a.negativeId && (!negative || !negative.isNegative || !ours.has(negative.id))) return { ok: false, error: `Not queued: harvest ${a.changeSetId} did not make the negative ${a.negativeId} in this business.` }
  const lower = keyword.bidCents > FLOOR_CENTS && keyword.suppressedFromBidCents == null && String(keyword.status) !== 'ARCHIVED'
  const lift = !!negative && String(negative.status) !== 'ARCHIVED'
  if (!lower && !lift) return { ok: false, error: `Nothing of harvest ${a.changeSetId} is left to put back: its keyword sits at or below the ${FLOOR_CENTS}-cent floor (or is archived) and ${negative ? 'its negative is retired' : 'it made no negative'}.` }
  const campaignOfKeyword = keyword.adGroup.campaign
  const writes: Array<RuleWrite & { label: string }> = [
    ...(lower ? [{ campaignId: campaignOfKeyword.id, adGroupId: keyword.adGroup.id, marketplace: campaignOfKeyword.marketplace, changes: [{ field: 'bid', valueCents: FLOOR_CENTS }], isSuppression: true, label: `campaign "${campaignOfKeyword.name}"` }] : []),
    ...(lift ? [{ campaignId: negative!.adGroup.campaign.id, marketplace: negative!.adGroup.campaign.marketplace, changes: [{ field: 'status', valueCents: null }], label: `campaign "${negative!.adGroup.campaign.name}"` }] : []),
  ]
  const reached = await reachOver(writes)
  if ('refused' in reached) return { ok: false, error: `Not queued: ${reached.label}: ${gateRefusal(reached.refused)}` }
  const currency = campaignCurrency(campaignOfKeyword)
  const facts = opts.rule
    ? await ruleFactsFor({
      tool: TOOL.harvest, limits: HARVEST_LIMITS, writes, approvalId: ctx.approvalId ?? null,
      items: [
        ...(lower ? [{ entity: { kind: 'target' as const, id: keyword.id }, change: { field: 'bid' as const, fromCents: keyword.bidCents, toCents: FLOOR_CENTS } }] : []),
        ...(lift ? [{ entity: { kind: 'target' as const, id: negative!.id }, change: { field: 'retire' as const, term: negative!.expressionValue } }] : []),
      ],
    })
    : null
  const effect = `Puts back harvest ${a.changeSetId}: `
    + [lower ? `"${keyword.expressionValue}" in ${placeWords(keyword.adGroup)} from ${amountLabel(keyword.bidCents, currency)} to the stop bid (at least ${amountLabel(FLOOR_CENTS, currency)}; it stays at Amazon)` : '',
      lift ? `the negative "${negative!.expressionValue}" in ${placeWords(negative!.adGroup)} retired, so the term runs there again` : ''].filter(Boolean).join(', and ')
    + '.'
  return {
    ok: true,
    preview: {
      action: TOOL.harvest,
      op: 'undo',
      undoes: a.changeSetId,
      campaign: { id: campaignOfKeyword.id, name: campaignOfKeyword.name, marketplace: campaignOfKeyword.marketplace },
      currency,
      changes: [
        ...(lower ? [{ label: `"${keyword.expressionValue}" · ${placeWords(keyword.adGroup)}`, fromLabel: amountLabel(keyword.bidCents, currency), toLabel: 'the stop bid' }] : []),
        ...(lift ? [{ label: `negative "${negative!.expressionValue}" · ${placeWords(negative!.adGroup)}`, fromLabel: 'Standing', toLabel: 'Retired' }] : []),
      ],
      // It only puts back what this tool's harvest made: the negative it lifts did not exist before that harvest.
      raises: [],
      basis: fingerprint({ keyword: [keyword.id, keyword.bidCents, String(keyword.status)], negative: negative ? [negative.id, String(negative.status)] : null }),
      reach: reached.reach,
      reachNote: reachNote(reached.reach),
      effect,
      ...(facts ?? {}),
    },
  }
}

/** What a harvest's record holds now (the undo guard compares it with `after`). */
async function harvestNow(change: ToolChange): Promise<unknown> {
  const after = (change.after ?? {}) as { op?: unknown; keyword?: { targetId?: unknown }; negative?: { targetId?: unknown } | null }
  if (after.op === 'undo') return change.after
  const ids = [after.keyword?.targetId, after.negative?.targetId].filter((id): id is string => typeof id === 'string')
  const rows = ids.length ? await prisma.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, bidCents: true, status: true } }) : []
  const of = (id: unknown) => rows.find((r) => r.id === id)
  return {
    op: 'harvest',
    keyword: after.keyword ? { targetId: after.keyword.targetId, bidCents: of(after.keyword.targetId)?.bidCents ?? null } : null,
    negative: after.negative ? { targetId: after.negative.targetId, standing: !!of(after.negative.targetId) && String(of(after.negative.targetId)!.status) !== 'ARCHIVED' } : null,
  }
}

/** C2 — undo of a harvest: this tool's own op undo (the keyword to the stop bid, the source negative retired). */
export const HARVEST_UNDO: ToolUndo = {
  current: harvestNow,
  request(change) {
    const after = (change.after ?? {}) as { op?: unknown; keyword?: { targetId?: unknown }; negative?: { targetId?: unknown } | null }
    const before = (change.before ?? {}) as { changeSetId?: unknown }
    if (after.op === 'undo') return { refusal: 'An undo of a harvest is not put back: ask harvest-search-term for the harvest again.' }
    if (typeof before.changeSetId !== 'string' || typeof after.keyword?.targetId !== 'string') return { refusal: 'This change does not name the harvest it made.' }
    return {
      tool: TOOL.harvest,
      args: {
        op: 'undo', changeSetId: before.changeSetId, keywordId: after.keyword.targetId,
        ...(typeof after.negative?.targetId === 'string' ? { negativeId: after.negative.targetId } : {}),
        why: 'undo of a harvest: its keyword to the stop bid, its source negative retired',
      },
    }
  },
}

const harvestSearchTerm: AgentTool = {
  name: TOOL.harvest,
  title: 'Harvest a search term',
  input: HARVEST_INPUT,
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  restrictedFields: LIMIT_FACTS_MONEY as Readonly<Record<string, FieldPermission>>,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  // Undo lowers the keyword to the stop bid (it stays at Amazon, and it served meanwhile) and retires the negative.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: HARVEST_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits) ?? harvestRefusal(preview, limits),
  undo: HARVEST_UNDO,
  description:
    'Harvest an Amazon Sponsored Products search term in ONE step: a keyword (EXACT by default; an ASIN becomes a product '
    + 'target) in its destination ad group — the one named, else the harvest destination stored for its source '
    + '(set-harvest-destination), else the only one the harvest resolver offers — and, once that keyword stands, an exact '
    + 'negative of the term in the ad group it ran in, so that ad group stops bidding for it (negateSource, default true). '
    + 'graduate-keyword and create-negative-keyword are the same two moves alone. A term that converts in its source is '
    + 'never negated there (the Owner\'s rule: winners stay where they win): ask with negateSource false, and once the new '
    + 'keyword wins, add-negative-targets closes the old place. A term already at home for the same product is not created '
    + 'again; a source negative that would stop another product from a term it buys is refused. The starting bid is the '
    + 'term\'s cost per click in its source unless named; like graduate-keyword it needs no authenticator code. '
    + `${BY_RULE_WORDS} (by default it does not: maxItems 0, no market; then only for a term that meets the ads strategy's `
    + '"Harvest a search term when" group). Refused, and not queued, when the term did not run in its source, no '
    + 'destination is decided, the keyword is there already, or Amazon\'s write gate would refuse it. Undo (undo-change, or '
    + 'op undo) lowers the keyword to the stop bid and retires the source negative.',
  async handler(args, ctx) {
    return (await decideHarvest(args, ctx, { rule: true })).result
  },
  async execute(args, ctx) {
    const { result: fresh, plan } = await decideHarvest(args, ctx, { rule: false })
    const refusal = recheck(ctx, fresh, HARVEST_MATERIAL)
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { op: 'harvest' | 'undo'; reach: StoredReach; effect: string; undoes?: string }
    if (p.op === 'undo') {
      // Lifting the negative a harvest made is a person's decision, never a rule's (withinLimits refuses it; the last door).
      if (ctx.decidedVia === 'auto') return notRun('Not run: an undo of a harvest lifts the negative it made, which a person decides, never a rule. Ask for it again; a person approves it.')
      return runUndo(args as HarvestArgs, ctx, p)
    }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const h = plan!
    // 1 — the keyword, through the destination ad group's own create (nothing written unless Amazon took it).
    const common = { adGroupId: h.dest.id, bidEur: h.bidCents / 100, userId: run.actor, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId, requireAmazon: true }
    const kw = h.product
      ? await createTargetLocal({ ...common, kind: 'PRODUCT', value: h.query })
      : await createKeywordLocal({ ...common, keywordText: h.query, matchType: h.match, evidence: { metric: 'claudeRequest', note: run.reason } })
    if (!kw.id || (kw.outcome !== 'created' && kw.outcome !== 'local')) {
      return notRun(`Not run: the ${h.product ? 'product target' : 'keyword'} was not created — ${kw.reason ?? kw.outcome ?? 'refused'}. The source was not negated. Nothing changed.`)
    }
    // 2 — the source negative, only once the keyword stands.
    let negative: { targetId: string } | null = null
    let negativeProblem: string | null = null
    if (h.negate === 'add') {
      const evidence = { metric: 'claudeRequest', note: run.reason }
      const out = h.product
        ? await writeNegativeProductTarget({ adGroupId: h.source.id, asin: h.query, userId: run.actor, evidence, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId })
        : await writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: h.source.id, keywordText: h.query, matchType: 'NEGATIVE_EXACT', userId: run.actor, evidence, manual: run.manual, changeSetId: run.changeSetId })
      if ((out.outcome === 'created' || out.outcome === 'local') && out.adTargetId) negative = { targetId: out.adTargetId }
      else if (out.outcome !== 'already_existed') negativeProblem = out.refusal?.reason ?? out.error ?? 'refused'
    }
    const data = {
      keyword: { targetId: kw.id, bidCents: h.bidCents, reachedAmazon: kw.externalTargetId != null },
      sourceNegative: negative ? { targetId: negative.targetId } : h.negate === 'standing' ? 'already there' : h.negate === 'none' ? 'not asked' : null,
      ...(negativeProblem ? { partial: true, problem: `The keyword was added, but the source negative was not: ${negativeProblem}. The term keeps running in its source; ask add-negative-targets for it once that is fixed.` } : {}),
      reach: p.reach,
      changeSetId: run.changeSetId,
      note: p.reach.reach === 'live' ? 'Created at Amazon at once (no cancel window).' : 'Sandbox: recorded in Nexus only; nothing reached Amazon.',
    }
    const change = { before: { changeSetId: run.changeSetId, op: 'harvest', query: h.query, sourceAdGroupId: h.source.id, destAdGroupId: h.dest.id, keyword: null, negative: null }, after: { op: 'harvest', keyword: { targetId: kw.id }, negative } }
    return { ok: true, data, change: { before: change.before, after: await harvestNow(change) } }
  },
}

/** The undo op, run as the approver: the keyword lowered to the stop bid, the negative retired — both on this change set. */
async function runUndo(a: HarvestArgs, ctx: ToolContext, p: { reach: StoredReach; effect: string; undoes?: string }): Promise<ToolResult> {
  const run = approvedRun(ctx, String(a.why ?? '') || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const keyword = await prisma.adTarget.findUnique({ where: { id: a.keywordId! }, select: { id: true, bidCents: true, status: true, suppressedFromBidCents: true } })
  const problems: string[] = []
  let lowered = false
  if (keyword && keyword.bidCents > FLOOR_CENTS && keyword.suppressedFromBidCents == null && String(keyword.status) !== 'ARCHIVED') {
    // A stop: one lowering move to the floor (the largest change per action does not apply), never a raise.
    const out = await updateAdTargetWithSync({ adTargetId: keyword.id, patch: { bidCents: FLOOR_CENTS }, stop: true, actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits })
    if (out.ok) lowered = true
    else problems.push(`the keyword's bid (${out.error ?? 'refused'})`)
  }
  let retired = false
  if (a.negativeId) {
    const { retireNegatives } = await import('../../advertising/negatives-retire.service.js')
    const out = await retireNegatives({ adTargetIds: [a.negativeId], actor: run.actor, retireReason: run.reason, changeSetId: run.changeSetId, manual: run.manual })
    const o = out.outcomes[0]
    if (o && (o.kind === 'retired' || o.kind === 'removed_local')) retired = true
    else if (o && o.kind !== 'skipped') problems.push(`the source negative (${o.reason ?? o.kind})`)
  }
  if (!lowered && !retired) return notRun(`Not run: nothing was put back — ${problems.join('; ') || 'nothing was left to put back'}.`)
  return {
    ok: true,
    data: { lowered, retired, ...(problems.length ? { partial: true, problem: `Not put back: ${problems.join('; ')}.` } : {}), reach: p.reach, changeSetId: run.changeSetId },
    change: { before: { changeSetId: run.changeSetId, op: 'undo', undoes: p.undoes ?? null }, after: { op: 'undo', undoes: p.undoes ?? null, lowered, retired } },
  }
}

/** harvest-search-term's material fields: the term, its source and destination, the bid and the negative plan, where it lands. */
const HARVEST_MATERIAL = ['basis', 'reach'] as const

// ── set-harvest-destination ───────────────────────────────────────────────────────────────────────

const GRAINS = ['adGroup', 'campaign', 'portfolio', 'line', 'market', 'account'] as const
const DESTINATION_INPUT = z.object({
  scope: z.enum(GRAINS).describe('where it applies: a source ad group, its campaign, a portfolio, a product line, a market, or the whole account (the most exact one wins)'),
  scopeId: z.string().trim().min(1).max(64).optional().describe('the source ad group or campaign (Nexus id), the portfolio (Amazon id), the product line, or the market code; none for the account'),
  matchType: z.enum(['EXACT', 'PHRASE', 'BROAD', 'PRODUCT']).default('EXACT').describe('the kind of target a harvest creates there (default EXACT; PRODUCT: an ASIN)'),
  adGroupId: ID.optional().describe('the destination ad group (Nexus id) of a manual campaign; leave out with remove'),
  negateAtSource: z.boolean().optional().describe('whether a harvest landing there negates the term in its source (default true; a converting term is never negated by harvest-search-term)'),
  remove: z.boolean().optional().describe('true: remove the stored destination at this scope (the harvest then resolves one, or asks)'),
  why: whyArg,
})
type DestinationArgs = z.infer<typeof DESTINATION_INPUT>

/** set-harvest-destination's Claude limits: by default nothing runs alone (maxItems 0, no market). */
const DESTINATION_LIMITS = adKitLimits({ maxItems: 0 }, { markets: marketsLimit })

type StoredRow = { adGroupId: string; negateAtSource: boolean; updatedBy: string } | null

async function decideDestination(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>, opts: { rule: boolean }): Promise<ToolResult> {
  const parsed = DESTINATION_INPUT.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') }
  const a: DestinationArgs = parsed.data
  const grain: HvDestGrain = a.scope
  if (grain !== 'account' && !a.scopeId) return { ok: false, error: `Name the ${a.scope} it applies to (scopeId).` }
  if (a.remove && a.adGroupId) return { ok: false, error: 'Name a destination (adGroupId) or remove: true — not both.' }
  if (!a.remove && !a.adGroupId) return { ok: false, error: 'Name the destination ad group (adGroupId), or remove: true.' }
  // The scope, as Nexus holds it (an ad group or a campaign of this business; a market code).
  let scopeWords: string
  let market: string | null = null
  if (grain === 'adGroup') {
    const g = await groupById(a.scopeId!)
    if (!g) return { ok: false, error: `Not queued: ad group ${a.scopeId} was not found in this business.` }
    scopeWords = `source ${placeWords(g)}`
    market = g.campaign.marketplace
  } else if (grain === 'campaign') {
    const c = await prisma.campaign.findFirst({ where: { id: a.scopeId }, select: { name: true, marketplace: true } })
    if (!c) return { ok: false, error: `Not queued: campaign ${a.scopeId} was not found in this business.` }
    scopeWords = `every ad group of campaign "${c.name}"`
    market = c.marketplace
  } else if (grain === 'market') {
    market = a.scopeId!.toUpperCase()
    if (market === 'ALL') return { ok: false, error: '"all" is not a market: use scope account.' }
    scopeWords = `market ${market}`
  } else scopeWords = grain === 'account' ? 'the whole account' : `${grain} ${a.scopeId}`
  const scopeId = grain === 'account' ? HV_DEST_ACCOUNT : grain === 'market' ? market! : a.scopeId!
  const row: StoredRow = await storedHarvestDestination(grain, scopeId, a.matchType)
  if (a.remove && !row) return { ok: false, error: `Nothing would change: no ${a.matchType.toLowerCase()} harvest destination is stored for ${scopeWords}.` }
  const groupWords = async (id: string) => {
    const g = await groupById(id)
    return g ? placeWords(g) : `ad group ${id} (no longer in Nexus)`
  }
  let to: { adGroupId: string; negateAtSource: boolean; words: string } | null = null
  if (a.adGroupId) {
    const g = await groupById(a.adGroupId)
    if (!g) return { ok: false, error: `Not queued: ad group ${a.adGroupId} was not found in this business.` }
    const notSp = spOnlyRefusal({ type: g.campaign.type == null ? null : String(g.campaign.type), adProduct: g.campaign.adProduct, name: g.campaign.name })
    if (notSp) return { ok: false, error: `Not queued: ${placeWords(g)}: ${notSp}.` }
    // The page's own rule (saveHarvestDestination): only a manual campaign can hold a harvested keyword.
    if (g.campaign.targetingType !== 'MANUAL') return { ok: false, error: `Not queued: ${placeWords(g)} is not in a manual campaign (Amazon reports it as ${g.campaign.targetingType ?? 'unknown'}): a destination must be a manual, keyword-targeted ad group.` }
    if (String(g.status) === 'ARCHIVED' || String(g.campaign.status) === 'ARCHIVED') return { ok: false, error: `Not queued: ${placeWords(g)} is archived.` }
    if (market && g.campaign.marketplace && market !== g.campaign.marketplace) return { ok: false, error: `Not queued: ${placeWords(g)} is in ${g.campaign.marketplace}, not ${market}: a harvest lands in its source's market.` }
    to = { adGroupId: g.id, negateAtSource: a.negateAtSource !== false, words: placeWords(g) }
    market ??= g.campaign.marketplace
  }
  if (to && row && row.adGroupId === to.adGroupId && row.negateAtSource === to.negateAtSource) {
    return { ok: false, error: `Nothing would change: ${scopeWords} already harvests ${a.matchType.toLowerCase()} targets into ${to.words}${to.negateAtSource ? ', negating the source' : ', keeping the source'}.` }
  }
  const from = row ? { adGroupId: row.adGroupId, negateAtSource: row.negateAtSource, words: await groupWords(row.adGroupId), setBy: row.updatedBy } : null
  const describe = (d: { words: string; negateAtSource: boolean } | null) => (d ? `${d.words}${d.negateAtSource ? ' (the source is negated once it lands)' : ' (the source keeps running)'}` : 'none stored (the harvest resolves one, or asks)')
  const destinationId = to?.adGroupId ?? from?.adGroupId ?? null
  const kit: KitItem[] = destinationId ? [{ entity: { kind: 'adGroup', id: destinationId }, change: { field: 'automation' }, nexusOnly: true }] : []
  // Nexus only: no write for the gate to judge (the harvests that read it are judged when they write).
  const facts = opts.rule && kit.length ? await ruleFactsFor({ tool: TOOL.destination, limits: DESTINATION_LIMITS, items: kit, writes: [], approvalId: ctx.approvalId ?? null }) : null
  const effect = `${a.remove ? 'Removes' : from ? 'Changes' : 'Sets'} where a harvested ${a.matchType === 'PRODUCT' ? 'product target' : `${a.matchType.toLowerCase()} keyword`} lands for ${scopeWords}: ${describe(from)} → ${describe(to)}. `
    + 'Nexus only: nothing is sent to Amazon. The harvest rules, harvest-search-term and graduate-keyword read it the next time they harvest from there.'
  return {
    ok: true,
    preview: {
      action: TOOL.destination,
      scope: { grain, scopeId: grain === 'account' ? null : scopeId, words: scopeWords },
      ...(market ? { market } : {}),
      matchType: a.matchType,
      from,
      to,
      changes: [{ label: `Harvest destination (${a.matchType.toLowerCase()}) · ${scopeWords}`, fromLabel: describe(from), toLabel: describe(to) }],
      raises: [],
      basis: fingerprint({ grain, scopeId, matchType: a.matchType, from: from ? [from.adGroupId, from.negateAtSource] : null, to: to ? [to.adGroupId, to.negateAtSource] : null }),
      reachesAmazon: false,
      reachNote: 'Nexus only: nothing is sent to Amazon by this change.',
      effect,
      undoNote: from ? 'Undo sets the destination it replaced again.' : 'Undo removes the destination it set.',
      ...(facts ?? {}),
    },
  }
}

/** set-harvest-destination's own check after the common ones (pure): the markets. */
function destinationRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { action?: string; market?: string }
  if (p.action !== TOOL.destination) return 'there is no preview of this harvest destination to check; a person decides'
  const markets = (limits.markets as string[] | undefined) ?? []
  if (!markets.length) return 'this business names no market where a harvest destination may change by rule (markets is empty); a person decides'
  if (!p.market || !markets.includes(p.market)) return `this business lets a harvest destination change by rule only in ${markets.join(', ')}; a person decides`
  return null
}

/** What is stored NOW at the scope a change set (the undo guard compares it with `after`). */
async function destinationNow(change: ToolChange): Promise<unknown> {
  const after = (change.after ?? {}) as { grain?: HvDestGrain; scopeId?: string; matchType?: HvCreateType }
  if (!after.grain || !after.scopeId || !after.matchType) return change.after
  const row = await storedHarvestDestination(after.grain, after.scopeId, after.matchType)
  return { grain: after.grain, scopeId: after.scopeId, matchType: after.matchType, destination: row ? { adGroupId: row.adGroupId, negateAtSource: row.negateAtSource } : null }
}

/** C2 — undo of a destination change: the one it replaced, set again through this tool (or the one it set, removed). */
export const DESTINATION_UNDO: ToolUndo = {
  current: destinationNow,
  request(change) {
    const before = (change.before ?? {}) as { grain?: string; scopeId?: string; matchType?: string; destination?: { adGroupId?: string; negateAtSource?: boolean } | null }
    if (!before.grain || !before.scopeId || !before.matchType) return { refusal: 'This change does not record the scope it changed.' }
    const scopeId = before.grain === 'account' ? undefined : before.scopeId
    return {
      tool: TOOL.destination,
      args: before.destination?.adGroupId
        ? { scope: before.grain, ...(scopeId ? { scopeId } : {}), matchType: before.matchType, adGroupId: before.destination.adGroupId, negateAtSource: before.destination.negateAtSource !== false, why: 'undo: the harvest destination it replaced, set again' }
        : { scope: before.grain, ...(scopeId ? { scopeId } : {}), matchType: before.matchType, remove: true, why: 'undo: the harvest destination it set, removed' },
    }
  },
}

const setHarvestDestination: AgentTool = {
  name: TOOL.destination,
  title: 'Set a harvest destination',
  input: DESTINATION_INPUT,
  requires: [F.adsCampaignsManage],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  // Nexus only: nothing is sent to Amazon by it (the harvests that read it write through their own tools and the gate).
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: DESTINATION_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits) ?? destinationRefusal(preview, limits),
  undo: DESTINATION_UNDO,
  description:
    'Set where a harvested search term lands for a scope — a source ad group, its campaign, a portfolio, a product line, a '
    + 'market or the whole account (the most exact one wins) — and a match type (EXACT, PHRASE, BROAD, or PRODUCT for '
    + 'ASINs): the destination ad group of a manual campaign, and whether the source is negated once it lands; or remove '
    + 'the one stored there. The Keyword Harvest page\'s own stored destination. Nexus only: nothing is sent to Amazon; the '
    + `harvest rules, harvest-search-term and graduate-keyword read it the next time they harvest. ${BY_RULE_WORDS} (by `
    + 'default it does not: maxItems 0, no market). The preview shows the destination from → to. Undo (undo-change) sets '
    + 'the one it replaced again.',
  async handler(args, ctx) {
    return decideDestination(args, ctx, { rule: true })
  },
  async execute(args, ctx) {
    const fresh = await decideDestination(args, ctx, { rule: false })
    if (!fresh.ok) return notRun(`Not run: ${fresh.error}`)
    const p = fresh.preview as { basis: string; effect: string; scope: { grain: HvDestGrain; scopeId: string | null }; matchType: HvCreateType; from: { adGroupId: string; negateAtSource: boolean } | null; to: { adGroupId: string; negateAtSource: boolean } | null }
    const approved = (ctx.approvedPreview as { basis?: unknown } | undefined)?.basis
    if (approved !== undefined && approved !== p.basis) return notRun('Not run: what you approved has moved since — the destination stored at that scope changed. Ask for it again with it as it is now.')
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const scopeId = p.scope.grain === 'account' ? HV_DEST_ACCOUNT : p.scope.scopeId!
    try {
      // The Keyword Harvest page's own writes (the stored override): who set it is the approver, the request in the reason.
      if (p.to) await saveHarvestDestination({ scopeGrain: p.scope.grain, scopeId: p.scope.scopeId, matchType: p.matchType, adGroupId: p.to.adGroupId, negateAtSource: p.to.negateAtSource, updatedBy: run.actor })
      else await deleteHarvestDestination(p.scope.grain, p.scope.scopeId, p.matchType)
    } catch (e) {
      return notRun(`Not run: ${(e as Error).message}. Nothing changed.`)
    }
    await prisma.advertisingActionLog.create({
      data: {
        userId: run.actor, actionType: 'set_harvest_destination', entityType: 'AD_GROUP', entityId: p.to?.adGroupId ?? p.from?.adGroupId ?? scopeId,
        payloadBefore: { scope: p.scope, matchType: p.matchType, destination: p.from }, payloadAfter: { scope: p.scope, matchType: p.matchType, destination: p.to, note: `${run.reason} — Nexus only: never sent to Amazon.` },
        amazonResponseStatus: 'SUCCESS', executionId: run.changeSetId,
      },
    }).catch(() => {})
    const record = (d: { adGroupId: string; negateAtSource: boolean } | null) => ({ grain: p.scope.grain, scopeId, matchType: p.matchType, destination: d ? { adGroupId: d.adGroupId, negateAtSource: d.negateAtSource } : null })
    return {
      ok: true,
      data: { set: !!p.to, removed: !p.to, destination: p.to, changeSetId: run.changeSetId, note: 'Nexus only: nothing was sent to Amazon.' },
      change: { before: record(p.from), after: record(p.to) },
    }
  },
}

export const ADS_TARGET_TOOLS: AgentTool[] = [addAdTargets, harvestSearchTerm, setHarvestDestination]
