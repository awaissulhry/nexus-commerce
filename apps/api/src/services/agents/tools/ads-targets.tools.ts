/**
 * ADS AUTONOMY W4-5 (design 6 §4 "W3-4a") — targeting for Amazon Sponsored Products, in Claude's hands:
 *
 *   add-ad-targets           keywords (EXACT, PHRASE, BROAD), product targets (ASINs) and category targets (browse-node
 *                            ids) into ONE ad group of a manual campaign, up to 250 in one request, one step. Through the
 *                            ad group's own create services (ads-create.service.ts createKeywordLocal, createTargetLocal)
 *                            with `requireAmazon`: nothing is written unless Amazon took it. Each at the bid asked for —
 *                            it adds spend, listed in raises and said in the effect; the Owner's code rule
 *                            (ads-code-rule.ts) makes it a day-to-day change, so a person's approval sends it with no
 *                            authenticator code — or, with startAtFloor, born at the 5-cent floor with its planned bid
 *                            remembered in the change (set-target-bid or bulk-ad-bid-change raises it later). A keyword or ASIN this
 *                            product already buys in another of its ad groups (the winners lock's "same product") is not
 *                            queued until the person says skip (it stays where it runs: the Owner's rule 2) or accept
 *                            (both buy it), never by rule once accepted — as build-sp-wizard-campaigns. Another
 *                            product buying the same words is allowed (rule 3). Undo: bulk-ad-bid-change lowers each to
 *                            the stop bid (they stay at Amazon: Nexus never archives in an undo).
 *   harvest-search-term      (Keyword Harvest page rebuild, lane HMCP, 2026-10-11) one search term harvested by the ONE
 *                            harvest engine, named by where it ran (or its candidateId): the same change set, preview,
 *                            approval, run and undo as apply-harvest (ads-harvest-alias.ts) — the keyword, the negative in
 *                            every ad group of the product where it ran, the funnel blocks; always a person (ceiling ask).
 *                            Its own older rules (one source, never negating a converting source, the 60-day CPC bid, the
 *                            stop-bid undo) are gone. Undo: the engine's (blocks lifted, then the keyword paused).
 *   set-harvest-destination  where a harvest lands for a scope (an ad group, a campaign, a portfolio, a line, a market or the
 *                            account) and a match type — the Keyword Harvest page's own stored destination
 *                            (harvest-destination.service.ts saveHarvestDestination, deleteHarvestDestination). Nexus only:
 *                            nothing is sent to Amazon; the harvest engine reads it for every harvest (the page,
 *                            apply-harvest, harvest-search-term, graduate-keyword, the rules, the brain). Undo: the
 *                            destination it replaced, set again (or removed).
 *
 * add-ad-targets and set-harvest-destination follow ads-change-kit.ts — previewed first; refused, and not queued, when the
 * write gate would refuse it (set-harvest-destination is Nexus only: no gate is asked, its basis is compared again in
 * `execute`); run only as an approved request, as the approver, with changeSetId = the approval on every write and every
 * row it makes; re-checked in `execute` — and are strategy-bound (ads-autonomy-kit.ts): by default nothing runs alone
 * (maxItems 0, no market). harvest-search-term follows the harvest engine (harvest/tool.ts).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { createKeywordLocal, createTargetLocal } from '../../advertising/ads-create.service.js'
import { adGroupPlaces, targetingAdGroups, type TargetingGroup } from '../../advertising/ads-targeting-lookup.service.js'
import { isAsin } from '../../advertising/ads-negation-policy.js'
import { normaliseNegTerm } from '../../advertising/ads-protect-converting.js'
import { familyAdGroups, negativeBlocksTerm, positivesIn, productFamilyOf } from '../../advertising/ads-winner-lock.js'
import {
  HV_DEST_ACCOUNT, deleteHarvestDestination, saveHarvestDestination, storedHarvestDestination,
  type HvCreateType, type HvDestGrain,
} from '../../advertising/harvest-destination.service.js'
import { HARVEST_MONEY } from '../../advertising/harvest/constants.js'
import { STEP_UP_NEEDS, type StepUp } from '../step-up-approval.js'
import { addsSpendWords, DAY_TO_DAY_NO_CODE, needsCode } from './ads-code-rule.js'
import { alsoChangedBy, approvedRun, BY_RULE_WORDS, gateRefusal, notRun, reachNote, recheck, ruleFactsFor, ruleRefusal, spOnlyRefusal, STOP_MIN_CENTS, type RuleWrite, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, LIMIT_FACTS_MONEY, type KitItem } from './ads-autonomy-kit.js'
import { amountLabel, campaignCurrency } from './ads-tool-guards.js'
import { fingerprint, named, placeWords, plural, reachOver, spendGate } from './ads-targeting-kit.js'
import { aliasExecute, aliasPreview, aliasUndo, aliasUndoExecute, aliasUndoPreview, candidateInAdGroup, namedCandidate, type EngineItem } from './ads-harvest-alias.js'
import type { AgentTool, FieldPermission, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = { add: 'add-ad-targets', harvest: 'harvest-search-term', destination: 'set-harvest-destination' } as const
/** The most targets one request adds (the tool contract's bound for a list), as ONE step. */
const MAX_TARGETS = 250
/** At most this many lines are listed in a preview; the rest are counted. */
const LINES_SHOWN = 20
/**
 * The floor a target born at the floor starts at: the lowest bid a Claude bid change takes (set-target-bid), so set-target-bid or bulk-ad-bid-change can raise it later (a bid at 3 cents or less without
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
    .describe(`true: every target is born at the ${FLOOR_CENTS}-cent floor with its planned bid remembered in the change (it spends next to nothing); set-target-bid raises it later. Default false: at its bid, which adds spend (listed in raises; a person's approval sends it, no authenticator code)`),
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

/**
 * add-ad-targets' code decision, in ONE place: the Owner's code rule (ads-code-rule.ts) makes a target that starts
 * spending at its bid in an existing ad group a day-to-day change — listed in raises and said in the effect, and a
 * person's approval sends it (no stepUp); one born at the floor spends next to nothing (the raise to its planned bid is a
 * set-target-bid of its own). Every new target is in `raises` either way.
 */
function addTargetsStepUp(atBid: number): { stepUp?: StepUp; noCode?: string } {
  if (!atBid) return {}
  if (!needsCode('add-ad-targets: at a bid')) return { noCode: DAY_TO_DAY_NO_CODE }
  return { stepUp: { what: `adds ${plural(atBid, 'target')} that ${atBid === 1 ? 'starts' : 'start'} spending at ${atBid === 1 ? 'its bid' : 'their bids'}`, raises: ['Bids', 'Spend'], needs: STEP_UP_NEEDS, how: ADD_HOW } }
}

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
  // The ad group's default bid, when it is one a bid change can work from (a floored default is no bid to plan with).
  const fallback = a.bidCents ?? (g.defaultBidCents >= FLOOR_CENTS ? g.defaultBidCents : null)
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
      : ` They start spending at their bids (the highest ${amountLabel(highest, currency)}).${addsSpendWords(atBid.length ? [`${plural(atBid.length, 'new target')} at ${atBid.length === 1 ? 'its bid' : 'their bids'}`] : [], !!addTargetsStepUp(atBid.length).stepUp)}`)
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
        // Every new target adds spend (one born at the floor a little): each is listed; the code is addTargetsStepUp's.
        raises: targets.map((t) => `${targetWords(t)} at ${amountLabel(t.writtenCents, currency)}${t.writtenCents < t.plannedCents ? ` (the floor; planned ${amountLabel(t.plannedCents, currency)})` : ''}`),
        ...addTargetsStepUp(atBid.length),
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

/** add-ad-targets' own checks, before the common ones (pure, on the preview): never accepted clashes by rule, markets, campaigns, kinds. */
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
  const matchTypes = new Set((limits.matchTypes as string[] | undefined) ?? ['EXACT'])
  for (const line of Array.isArray(p.changes) ? (p.changes as Array<{ kind?: string; match?: string | null }>) : []) {
    if (line.kind === 'KEYWORD' && line.match && !matchTypes.has(line.match)) return `it adds a ${line.match.toLowerCase()} keyword, which this tool's limits do not let be added by rule (matchTypes); a person decides`
  }
  return null
}

/** After the common checks: the highest bid a new target starts at, within this tool's limit. */
function addBidRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { highestBidCents?: number; currency?: string }
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
  withinLimits: (preview, limits) => addRefusal(preview, limits) ?? ruleRefusal(preview, limits) ?? addBidRefusal(preview, limits),
  undo: ADD_TARGETS_UNDO,
  description:
    `Add keywords (EXACT, PHRASE, BROAD), product targets (ASINs) and category targets to ONE ad group of a manual Amazon `
    + `Sponsored Products campaign, up to ${MAX_TARGETS} in one request (one step), through the ad group's own create services: `
    + 'nothing is written unless Amazon takes it. At its bid (each its own, else bidCents, else the ad group\'s default bid) a '
    + 'target starts spending: listed in raises and said in the preview, a day-to-day change, so a person\'s approval sends '
    + 'it with no authenticator code; with startAtFloor: true every target is born at the '
    + `${FLOOR_CENTS}-cent floor with its planned bid kept in the change, and set-target-bid raises it later. A keyword or `
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
    const p = fresh.preview as { reach: StoredReach; effect: string; sameProductClashes: unknown[] }
    // Accepting what this product already buys elsewhere is a person's word: never a run the business's rule decided.
    if (ctx.decidedVia === 'auto' && p.sameProductClashes.length) return notRun('Not run: it adds what this product already buys elsewhere (accepted), which a person decides, never a rule. Ask for it again; a person approves it.')
    // The code, as addTargetsStepUp decided it on this fresh preview (none under the Owner's code rule).
    const gate = await spendGate(ctx, fresh.preview)
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
    .describe('harvest (default): the term harvested as ONE change set — the keyword, its negative in every ad group of the product where it ran, the funnel blocks; undo: put back a harvest this tool made before the harvest engine (its negative retired, then its keyword paused). A harvest of the engine is put back by apply-harvest op undo'),
  query: z.string().trim().min(1).max(80).optional().describe('harvest: the search term (query in ad-search-terms); an ASIN becomes a product target'),
  sourceAdGroupId: ID.optional().describe('harvest: an ad group it ran in (adGroupId in ad-search-terms): it names the product whose own campaigns the term goes into; every ad group of that product where it ran is a source'),
  candidateId: z.string().trim().min(5).max(300).optional().describe('harvest: the term as harvest-candidates names it (market|productId|term), instead of query and sourceAdGroupId'),
  destAdGroupId: ID.optional().describe('harvest: the ad group the keyword goes into (Nexus id, one of the product\'s own: harvest-destinations); default: the suggested place'),
  matchType: z.enum(['EXACT', 'PHRASE']).optional().describe('harvest: the keyword\'s match type (default EXACT; an ASIN is a product target)'),
  bidCents: BID.optional().describe("harvest: its start bid in minor units of the market's currency (default: the bid brain's goal bid, else the term's cost per click inside the strategy's bid limits)"),
  negateSource: z.boolean().optional()
    .describe('harvest: false leaves the sources running; true blocks them even where the Owner\'s saved harvest place says not to (default: the negative in every source, unless his saved place says not to)'),
  funnel: z.boolean().optional().describe('harvest: false leaves the funnel blocks out (default: exact → negative exact in the product\'s phrase, broad and auto ad groups; phrase → negative phrase in broad and auto)'),
  changeSetId: ID.optional().describe('undo: the approvalId of the harvest to put back (undo-change fills it in)'),
  keywordId: ID.optional().describe('undo: the keyword (or product target) that harvest made'),
  negativeId: ID.optional().describe('undo: a harvest made before the harvest engine — the one source negative it made'),
  why: whyArg,
})
type HarvestArgs = z.infer<typeof HARVEST_INPUT>

/** The engine's change set this request is: the candidate it names, and the choices it makes. */
async function harvestEngineArgs(a: HarvestArgs): Promise<{ args: { op: 'harvest'; items: EngineItem[]; why?: string } } | { refusal: string }> {
  const cand = a.candidateId
    ? namedCandidate(a.candidateId)
    : a.query && a.sourceAdGroupId
      ? await candidateInAdGroup(a.sourceAdGroupId, a.query)
      : { refusal: 'name the term: candidateId (harvest-candidates), or query and sourceAdGroupId (ad-search-terms)' }
  if ('refusal' in cand) return cand
  const item: EngineItem = {
    candidateId: cand.candidateId,
    ...(a.destAdGroupId ? { to: { adGroupId: a.destAdGroupId } } : {}),
    ...(a.matchType ? { match: a.matchType } : {}),
    ...(a.bidCents != null ? { bidCents: a.bidCents } : {}),
    ...(a.negateSource != null ? { negateSource: a.negateSource } : {}),
    ...(a.funnel != null ? { funnel: a.funnel } : {}),
  }
  return { args: { op: 'harvest', items: [item], ...(a.why ? { why: a.why } : {}) } }
}

const parseHarvest = (raw: Record<string, unknown>): HarvestArgs | { error: string } => {
  const parsed = HARVEST_INPUT.safeParse(raw)
  return parsed.success ? parsed.data : { error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') }
}

/** What an older harvest (made before the engine) holds now, in the shape of its `after` (its undo guard). */
async function legacyHarvestNow(change: ToolChange): Promise<unknown> {
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

/** C2 — undo of a harvest: the engine's (apply-harvest op undo); one made before the engine, this tool's op undo. */
export const HARVEST_UNDO: ToolUndo = aliasUndo(legacyHarvestNow)

const harvestSearchTerm: AgentTool = {
  name: TOOL.harvest,
  title: 'Harvest a search term',
  input: HARVEST_INPUT,
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  restrictedFields: HARVEST_MONEY as Readonly<Record<string, FieldPermission>>,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Undo lifts the blocks and pauses the keyword (it served meanwhile; it stays at Amazon).
  reversibility: 'partial',
  // The harvest engine's ceiling (apply-harvest): always a person.
  maxClaudeTrust: 'ask',
  undo: HARVEST_UNDO,
  description:
    'Harvest ONE Amazon Sponsored Products search term by where it ran (query and sourceAdGroupId from ad-search-terms) '
    + 'or by its candidateId (harvest-candidates) — the same change set as apply-harvest, from the same harvest engine as '
    + 'the Keyword Harvest page: the keyword (EXACT by default, or PHRASE; an ASIN becomes a product target) in the ad group '
    + 'named (destAdGroupId, one of the product\'s own: harvest-destinations) or its suggested place, at the start bid named '
    + 'or the bid brain\'s goal bid; AND the negative in EVERY ad group of the product where the term ran (negateSource '
    + 'false leaves them running; the Owner\'s saved negateAtSource=false wins unless the request says true); AND the '
    + 'funnel blocks (exact → negative exact in the product\'s phrase, broad and auto ad groups; phrase → negative phrase '
    + 'in broad and auto; funnel false leaves them out) — one approval; the negatives are written only once the keyword '
    + 'stands. For several terms, a new campaign or a new portfolio, ask apply-harvest (one change set for all of them). '
    + 'Nothing changes until a person approves it in Nexus; it never runs by rule, and Claude cannot approve it. Refused, '
    + 'and not queued, when the term has no product of its own there, is harvested or waiting already, the place cannot '
    + 'take it, or Amazon\'s write gate would refuse it. Judged after the attribution window + 72 hours (harvest-history). '
    + 'Undo (undo-change, or apply-harvest op undo with its harvestIds) lifts the blocks it added, then pauses its keyword (never archived).',
  async handler(args, ctx) {
    const a = parseHarvest(args)
    if ('error' in a) return { ok: false, error: a.error }
    if (a.op === 'undo') return aliasUndoPreview(a, ctx)
    const e = await harvestEngineArgs(a)
    if ('refusal' in e) return { ok: false, error: `Not queued: ${e.refusal}.` }
    return aliasPreview(TOOL.harvest, e.args, ctx, { query: a.query ?? null, sourceAdGroupId: a.sourceAdGroupId ?? null, candidateId: e.args.items[0].candidateId })
  },
  async execute(args, ctx) {
    const a = parseHarvest(args)
    if ('error' in a) return notRun(`Not run: ${a.error}.`)
    if (a.op === 'undo') return aliasUndoExecute(a, ctx)
    const e = await harvestEngineArgs(a)
    if ('refusal' in e) return notRun(`Not run: ${e.refusal}.`)
    return aliasExecute(e.args, ctx)
  },
}

// ── set-harvest-destination ───────────────────────────────────────────────────────────────────────

const GRAINS = ['adGroup', 'campaign', 'portfolio', 'line', 'market', 'account'] as const
const DESTINATION_INPUT = z.object({
  scope: z.enum(GRAINS).describe('where it applies: a source ad group, its campaign, a portfolio, a product line, a market, or the whole account (the most exact one wins)'),
  scopeId: z.string().trim().min(1).max(64).optional().describe('the source ad group or campaign (Nexus id), the portfolio (Amazon id), the product line, or the market code; none for the account'),
  matchType: z.enum(['EXACT', 'PHRASE', 'BROAD', 'PRODUCT']).default('EXACT').describe('the kind of target a harvest creates there (default EXACT; PRODUCT: an ASIN)'),
  adGroupId: ID.optional().describe('the destination ad group (Nexus id) of a manual campaign; leave out with remove'),
  negateAtSource: z.boolean().optional().describe('whether a harvest landing there negates the term in every source of the product (default true, the Owner\'s 10-08 standard; false keeps the sources running — a harvest request may still switch it)'),
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
    + 'Nexus only: nothing is sent to Amazon. The harvest engine reads it the next time a harvest from there is planned (apply-harvest, the Keyword Harvest page, the rules, the brain).'
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

/** set-harvest-destination's own check, before the common ones (pure): the markets. */
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
  withinLimits: (preview, limits) => destinationRefusal(preview, limits) ?? ruleRefusal(preview, limits),
  undo: DESTINATION_UNDO,
  description:
    'Set where a harvested search term lands for a scope — a source ad group, its campaign, a portfolio, a product line, a '
    + 'market or the whole account (the most exact one wins) — and a match type (EXACT, PHRASE, BROAD, or PRODUCT for '
    + 'ASINs): the destination ad group of a manual campaign, and whether a harvest landing there negates the term in '
    + 'every source of the product (negateAtSource, default true; false keeps the sources running); or remove the one '
    + 'stored there. The Keyword Harvest page\'s own stored destination. Nexus only: nothing is sent to Amazon; the harvest '
    + 'engine reads it for every harvest (harvest-candidates shows it as the suggested place: apply-harvest, '
    + `harvest-search-term, graduate-keyword, the rules and the brain). ${BY_RULE_WORDS} (by `
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
