/**
 * ADS AUTONOMY W4-5 (design 6 §4 "W3-4a") — Amazon Sponsored Products negatives in the list form:
 *
 *   add-negative-targets  negative keywords (NEGATIVE_EXACT, NEGATIVE_PHRASE) and negative product targets (ASINs), in
 *                         ad groups (AD_GROUP) or whole campaigns (CAMPAIGN: keywords only) — one set of terms into many
 *                         places (the n-gram form), or each negative with its own place; up to 250 in one request, one
 *                         step. Through the one negative write service only (ads-negative-kw.service.ts
 *                         writeNegativeKeyword, writeNegativeProductTarget: the write gate with the campaign's
 *                         allowlist, protected terms, Amazon's text limits, the own-keyword lock L1). The Owner's rules
 *                         (ads-targeting-kit.ts): rule 2 — never a term that converts where it lands (but the proven
 *                         handover); rule 3 — another product's ad group that buys the term is listed and needs
 *                         allowOtherProducts, a person's word, never a rule. A negative only lowers spend: no code. Undo:
 *                         undo-ad-change retires exactly what it made. create-negative-keyword stays the one-term tool.
 *   retire-negatives      standing negatives — any, not only Claude's — by id, or by their place and text: archived at
 *                         Amazon through the Negatives page's own retire (negatives-retire.service.ts retireNegatives),
 *                         or removed from Nexus when Amazon never had one. Lifting a block lets the searches it blocked
 *                         show the ads again (it can add spend): a person approves it with the approver's authenticator
 *                         code (stepUp); by the business's rule only where it allows that (allowRetire). Undo adds the
 *                         same negatives again (new ones: Amazon never switches an archived one on again).
 *
 * Both follow ads-change-kit.ts — previewed first; refused, and not queued, when the write gate would refuse it; run only
 * as an approved request, as the approver, with changeSetId = the approval on every write and every row it makes;
 * re-checked in `execute` — and both are strategy-bound (ads-autonomy-kit.ts): by default nothing runs alone (maxItems 0,
 * no market listed).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { writeNegativeKeyword, writeNegativeProductTarget } from '../../advertising/ads-negative-kw.service.js'
import { isAsin, negativeKeywordTextProblem, protectedNegativeRefusal } from '../../advertising/ads-negation-policy.js'
import { blockedPositive, blockedWords, positivesIn } from '../../advertising/ads-winner-lock.js'
import { normaliseNegTerm } from '../../advertising/ads-protect-converting.js'
import { searchTermTotals } from '../../advertising/ads-harvest.service.js'
import { adGroupPlaces, targetingAdGroups } from '../../advertising/ads-targeting-lookup.service.js'
import { adGroupExternalIds } from '../../advertising/ads-entity-lookup.service.js'
import { entityKey } from '../../advertising/ads-strategy/autonomy.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import { STEP_UP_NEEDS } from '../step-up-approval.js'
import { alsoChangedBy, approvedRun, BY_RULE_WORDS, gateRefusal, notRun, reachNote, recheck, ruleFactsFor, ruleRefusal, spOnlyRefusal, type RuleWrite, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, LIMIT_FACTS_MONEY, limitFactsOf, type KitItem } from './ads-autonomy-kit.js'
import { amountLabel, campaignCurrency, type BoundAutomation } from './ads-tool-guards.js'
import {
  blocks, convertingWords, fingerprint, named, otherProductWords, placeWords, plural, productRootOf, reachOver, spendGate, termRulesFor,
  type NegativePlacement,
} from './ads-targeting-kit.js'
import type { AgentTool, FieldPermission, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = { add: 'add-negative-targets', retire: 'retire-negatives' } as const
/** The most negatives one add request makes (the tool contract's bound for a list), as ONE step. */
const MAX_NEGATIVES = 250
/** The most negatives one retire asks for: the Negatives page's own request bound (advertising-intel.routes.ts). */
const MAX_RETIRE = 200
/** At most this many lines are listed in a preview; the rest are counted. */
const LINES_SHOWN = 20

const ID = z.string().trim().min(1).max(64)
const ASIN = z.string().trim().toUpperCase().regex(/^B0[A-Z0-9]{8}$/, 'an ASIN is B0 and 8 letters or digits')
const TEXT = z.string().trim().min(1).max(80)
const NEG_MATCH = z.enum(['NEGATIVE_EXACT', 'NEGATIVE_PHRASE'])
type NegMatch = z.infer<typeof NEG_MATCH>
type Level = 'AD_GROUP' | 'CAMPAIGN'
const whyArg = z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit')

/** How a negative reads on a card. */
const negativeWords = (n: { kind: 'KEYWORD' | 'PRODUCT'; text: string; match: NegMatch | null }) =>
  n.kind === 'PRODUCT' ? `negative product target ${n.text}` : `negative ${n.match === 'NEGATIVE_PHRASE' ? 'phrase' : 'exact'} "${n.text}"`

interface Campaign { id: string; name: string; marketplace: string | null; currency: string; externalCampaignId: string }

/** One negative a request adds, where it lands and the ad groups it blocks in. */
interface NegItem {
  key: string
  level: Level
  /** The ad group (AD_GROUP) or the campaign (CAMPAIGN) it goes into. */
  placeId: string
  place: string
  kind: 'KEYWORD' | 'PRODUCT'
  text: string
  match: NegMatch | null
  campaign: Campaign
  /** The ad groups it blocks in: its own, or every ad group of its campaign. */
  adGroupIds: string[]
  externalAdGroupId: string | null
}

// ── add-negative-targets ──────────────────────────────────────────────────────────────────────────

const ADD_INPUT = z.object({
  scope: z.enum(['AD_GROUP', 'CAMPAIGN']).default('AD_GROUP')
    .describe('where adGroupIds or campaignIds put the keywords and ASINs below: AD_GROUP (default: each ad group named) or CAMPAIGN (a campaign negative, in every ad group of each campaign; keywords only)'),
  adGroupIds: z.array(ID).max(MAX_NEGATIVES).optional().describe('AD_GROUP scope: the ad groups (Nexus adGroupId in ad-targets or ad-search-terms) every keyword and ASIN below goes into'),
  campaignIds: z.array(ID).max(MAX_NEGATIVES).optional().describe('CAMPAIGN scope: the campaigns (Nexus campaignId) every keyword below goes into'),
  keywords: z.array(z.object({
    text: TEXT.describe('the search words to block'),
    matchType: NEG_MATCH.default('NEGATIVE_EXACT').describe('NEGATIVE_EXACT (default: that search only) or NEGATIVE_PHRASE (every search holding the words, in order)'),
  })).max(MAX_NEGATIVES).optional().describe('negative keywords, each into every place named above'),
  asins: z.array(ASIN).max(MAX_NEGATIVES).optional().describe('negative product targets: ASINs whose product pages stop showing these ads (AD_GROUP scope), each into every ad group named above'),
  negatives: z.array(z.object({
    adGroupId: ID.optional().describe('the ad group it goes into (Nexus id)'),
    campaignId: ID.optional().describe('or the campaign: a campaign negative (keywords only)'),
    text: TEXT.optional().describe('a negative keyword: the search words'),
    matchType: NEG_MATCH.optional().describe('its match: NEGATIVE_EXACT (default) or NEGATIVE_PHRASE'),
    asin: ASIN.optional().describe('or a negative product target: the ASIN (an ad group only)'),
  })).max(MAX_NEGATIVES).optional().describe('or each negative with its own place (how a retire is put back)'),
  product: z.string().trim().min(1).max(64).optional()
    .describe('the product whose own campaigns these negatives keep apart: its SKU or Nexus id (default: the one product every place advertises)'),
  allowOtherProducts: z.boolean().optional()
    .describe("true: also where another product's ad group buys the term (each such place is listed in the preview). Isolation is per product: a person's word, never a rule"),
  why: whyArg,
})
type AddArgs = z.infer<typeof ADD_INPUT>

/** add-negative-targets' Claude limits: the kit's, and what may run by rule — by default nothing (maxItems 0, no market). */
const ADD_LIMITS = adKitLimits({ maxItems: 0 }, {
  matchTypes: z.array(NEG_MATCH).max(2).default(['NEGATIVE_EXACT'])
    .describe('the keyword match types that may run by rule (a phrase negative blocks every search holding its words)'),
  minWastedSpendCents: z.number().int().min(0).max(10_000_000).default(0)
    .describe("the least a negative's blocked searches must have spent where it lands over the last 60 days (minor units of the campaign's currency) to run by rule; 0 = no floor of its own"),
  allowCampaignScope: z.boolean().default(false).describe('let a campaign negative (every ad group of the campaign) run by rule'),
  allowAsinNegatives: z.boolean().default(false).describe('let a negative product target (an ASIN) run by rule'),
  markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([])
    .describe('the markets where it may run by rule; empty = none: every request waits for a person'),
})

type PlaceRow = {
  id: string; name: string; status: unknown; externalAdGroupId: string | null; orphanedAt: Date | null
  campaign: { id: string; name: string; type: unknown; adProduct: string | null; status: unknown; marketplace: string | null; externalCampaignId: string | null; dailyBudgetCurrency: string | null }
}
const CAMPAIGN_SELECT = { id: true, name: true, type: true, adProduct: true, status: true, marketplace: true, externalCampaignId: true, dailyBudgetCurrency: true } as const

/** Why Nexus may not add a negative to this campaign at all, or null. */
function campaignRefusal(c: PlaceRow['campaign']): string | null {
  const notSp = spOnlyRefusal({ type: c.type == null ? null : String(c.type), adProduct: c.adProduct, name: c.name })
  if (notSp) return notSp
  if (String(c.status) === 'ARCHIVED') return 'it is archived: an archived campaign serves no more'
  if (!c.externalCampaignId) return 'Nexus holds no Amazon id for it: it is not at Amazon'
  return null
}

const campaignOf = (c: PlaceRow['campaign']): Campaign => ({ id: c.id, name: c.name, marketplace: c.marketplace, currency: campaignCurrency(c), externalCampaignId: c.externalCampaignId ?? '' })

/** The request as a list of negatives, each in its place — or why it cannot be one. */
async function itemsOf(a: AddArgs): Promise<{ items: NegItem[] } | { refusal: string }> {
  type Asked = { level: Level; placeId: string; kind: 'KEYWORD' | 'PRODUCT'; text: string; match: NegMatch | null }
  const asked: Asked[] = []
  const problems: string[] = []
  const places = a.scope === 'CAMPAIGN' ? (a.campaignIds ?? []) : (a.adGroupIds ?? [])
  if (a.scope === 'CAMPAIGN' && a.adGroupIds?.length) problems.push('adGroupIds is for AD_GROUP scope: with CAMPAIGN scope, name campaignIds')
  if (a.scope === 'AD_GROUP' && a.campaignIds?.length) problems.push('campaignIds is for CAMPAIGN scope (a campaign negative): ask with scope CAMPAIGN')
  if (a.scope === 'CAMPAIGN' && a.asins?.length) problems.push('a negative product target goes into an ad group, not a whole campaign: name adGroupIds with scope AD_GROUP')
  if ((a.keywords?.length || a.asins?.length) && !places.length) problems.push(`name the places the keywords and ASINs go into (${a.scope === 'CAMPAIGN' ? 'campaignIds' : 'adGroupIds'})`)
  if (places.length && !a.keywords?.length && !a.asins?.length) problems.push('name the keywords or ASINs that go into those places')
  for (const placeId of places) {
    for (const k of a.keywords ?? []) asked.push({ level: a.scope, placeId, kind: 'KEYWORD', text: k.text, match: k.matchType })
    for (const asin of a.asins ?? []) asked.push({ level: 'AD_GROUP', placeId, kind: 'PRODUCT', text: asin, match: null })
  }
  for (const [i, n] of (a.negatives ?? []).entries()) {
    const where = n.adGroupId && n.campaignId ? 'both' : n.adGroupId ? 'AD_GROUP' : n.campaignId ? 'CAMPAIGN' : null
    if (where === 'both' || !where) { problems.push(`negatives[${i}] names ${where ? 'an ad group and a campaign' : 'no place'}: name one (adGroupId or campaignId)`); continue }
    if (!!n.text === !!n.asin) { problems.push(`negatives[${i}] names ${n.text ? 'a keyword and an ASIN' : 'no keyword and no ASIN'}: name one (text or asin)`); continue }
    if (n.asin && where === 'CAMPAIGN') { problems.push(`negatives[${i}]: a negative product target goes into an ad group, not a whole campaign`); continue }
    asked.push(n.asin
      ? { level: 'AD_GROUP', placeId: n.adGroupId!, kind: 'PRODUCT', text: n.asin, match: null }
      : { level: where, placeId: (n.adGroupId ?? n.campaignId)!, kind: 'KEYWORD', text: n.text!, match: n.matchType ?? 'NEGATIVE_EXACT' })
  }
  if (problems.length) return { refusal: `Not queued: ${problems.join('; ')}.` }
  if (!asked.length) return { refusal: 'Name the negatives: keywords or asins with adGroupIds (or campaignIds with scope CAMPAIGN), or negatives each with its own place.' }
  if (asked.length > MAX_NEGATIVES) return { refusal: `${asked.length} negatives asked for: at most ${MAX_NEGATIVES} in one request. Split them.` }

  // Where each lands, as Nexus holds it now.
  const groupIds = [...new Set(asked.filter((x) => x.level === 'AD_GROUP').map((x) => x.placeId))]
  const campaignIds = [...new Set(asked.filter((x) => x.level === 'CAMPAIGN').map((x) => x.placeId))]
  const [groups, campaigns] = await Promise.all([
    targetingAdGroups(groupIds),
    campaignIds.length ? prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { ...CAMPAIGN_SELECT, adGroups: { where: { status: { not: 'ARCHIVED' } }, select: { id: true }, orderBy: { id: 'asc' } } } }) : [],
  ])
  const groupById = new Map<string, PlaceRow>((groups as PlaceRow[]).map((g) => [g.id, g] as const))
  const campaignById = new Map<string, PlaceRow['campaign'] & { adGroups: Array<{ id: string }> }>(
    (campaigns as Array<PlaceRow['campaign'] & { adGroups: Array<{ id: string }> }>).map((c) => [c.id, c] as const))
  const missing = [...groupIds.filter((id) => !groupById.has(id)).map((id) => `ad group ${id}`), ...campaignIds.filter((id) => !campaignById.has(id)).map((id) => `campaign ${id}`)]
  if (missing.length) return { refusal: `Not queued: ${named(missing)} ${missing.length === 1 ? 'was' : 'were'} not found in this business.` }
  const cannot: string[] = []
  for (const g of groupById.values()) {
    const why = campaignRefusal(g.campaign)
      ?? (String(g.status) === 'ARCHIVED' ? 'it is archived: an archived ad group serves no more' : null)
      ?? (!g.externalAdGroupId ? 'Nexus holds no Amazon id for it: it is not at Amazon' : null)
      ?? (g.orphanedAt ? 'Amazon no longer has it (Nexus marked it gone)' : null)
    if (why) cannot.push(`${placeWords(g)}: ${why}`)
  }
  for (const c of campaignById.values()) {
    const why = campaignRefusal(c) ?? (!c.adGroups.length ? 'it has no ad group to hold Nexus\'s copy of a campaign negative' : null)
    if (why) cannot.push(`campaign "${c.name}": ${why}`)
  }
  if (cannot.length) return { refusal: `Not queued: ${named(cannot)}.` }

  const items: NegItem[] = []
  const seen = new Set<string>()
  const twice: string[] = []
  for (const x of asked) {
    const norm = x.kind === 'PRODUCT' ? x.text.toUpperCase() : normaliseNegTerm(x.text)
    const key = `${x.level}:${x.placeId}:${x.kind === 'PRODUCT' ? 'PRODUCT' : x.match}:${norm}`
    if (seen.has(key)) { twice.push(negativeWords(x)); continue }
    seen.add(key)
    if (x.level === 'AD_GROUP') {
      const g = groupById.get(x.placeId)!
      items.push({ ...x, key, place: placeWords(g), campaign: campaignOf(g.campaign), adGroupIds: [g.id], externalAdGroupId: g.externalAdGroupId })
    } else {
      const c = campaignById.get(x.placeId)!
      items.push({ ...x, key, place: `campaign "${c.name}" (every ad group)`, campaign: campaignOf(c), adGroupIds: c.adGroups.map((g) => g.id), externalAdGroupId: null })
    }
  }
  if (twice.length) return { refusal: `Not queued: asked for twice in the same place — ${named([...new Set(twice)])}. Name each once.` }
  return { items }
}

/** Every check the write service would make, asked first so a refusal is never queued: text, protection, L1, standing. */
async function checksOf(items: NegItem[]): Promise<{ refusal: string } | { warnings: string[] }> {
  const problems: string[] = []
  const warnings: string[] = []
  // Amazon's text limits, and an ASIN typed as a keyword.
  for (const i of items.filter((x) => x.kind === 'KEYWORD')) {
    if (isAsin(i.text)) { problems.push(`"${i.text}" is an ASIN, a product: name it in asins (a negative product target)`); continue }
    const text = negativeKeywordTextProblem(i.text, i.match)
    if (text) problems.push(text.replace(/\.$/, ''))
  }
  if (problems.length) return { refusal: `Not queued: ${named(problems)}.` }
  // Protected terms refuse everyone; a protected product's ASIN is the person's own limit (warned, his approval sends it).
  const asked = new Map<string, ReturnType<typeof protectedNegativeRefusal>>()
  for (const i of items) {
    const k = `${i.campaign.id}|${i.match ?? 'PRODUCT'}|${i.text.toLowerCase()}`
    if (!asked.has(k)) asked.set(k, protectedNegativeRefusal({ text: i.text, matchType: i.match, marketplace: i.campaign.marketplace, campaignId: i.campaign.id }))
    const hit = await asked.get(k)!
    if (hit && !hit.protectedProduct) problems.push(hit.reason.replace(/\.$/, ''))
    else if (hit?.protectedProduct) warnings.push(`${negativeWords(i)} in ${i.place}: ${hit.warning ?? hit.reason}`)
  }
  if (problems.length) return { refusal: `Not queued: ${named([...new Set(problems)])}.` }
  // L1 — a negative never blocks a keyword or product target of its own place (the write service refuses it too).
  const allGroups = [...new Set(items.flatMap((i) => i.adGroupIds))]
  const positives = await positivesIn(allGroups)
  const places = await adGroupPlaces(allGroups)
  const groupNames = new Map([...places.values()].map((g) => [g.id, g.name]))
  for (const i of items) {
    const own = blockedPositive({ text: i.text, match: i.kind === 'PRODUCT' ? 'PRODUCT' : i.match === 'NEGATIVE_PHRASE' ? 'PHRASE' : 'EXACT' }, i.adGroupIds.flatMap((id) => positives.get(id) ?? []))
    if (own) problems.push(`${negativeWords(i)}: ${blockedWords(own, groupNames.get(own.adGroupId)).replace(/\.$/, '')}`)
  }
  // Already standing where it lands (both match-type spellings; an archived one is not standing: it can be added again).
  const standing = await prisma.adTarget.findMany({
    where: {
      isNegative: true, status: { not: 'ARCHIVED' },
      OR: [
        { adGroupId: { in: items.filter((i) => i.level === 'AD_GROUP').map((i) => i.placeId) }, OR: [{ negativeLevel: 'AD_GROUP' }, { negativeLevel: null }] },
        { negativeLevel: 'CAMPAIGN', adGroup: { campaignId: { in: items.filter((i) => i.level === 'CAMPAIGN').map((i) => i.placeId) } } },
      ],
    },
    select: { kind: true, expressionType: true, expressionValue: true, negativeLevel: true, adGroupId: true, adGroup: { select: { campaignId: true } } },
  })
  const there = new Set(standing.map((s) => {
    const level: Level = s.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP'
    const match = s.kind === 'PRODUCT' ? 'PRODUCT' : /PHRASE/.test(s.expressionType) ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT'
    return `${level}:${level === 'CAMPAIGN' ? s.adGroup.campaignId : s.adGroupId}:${match}:${s.kind === 'PRODUCT' ? s.expressionValue.trim().toUpperCase() : normaliseNegTerm(s.expressionValue)}`
  }))
  for (const i of items) if (there.has(i.key)) problems.push(`${negativeWords(i)} is already negated in ${i.place}`)
  if (problems.length) return { refusal: `Not queued: ${named(problems)}.` }
  return { warnings }
}

/**
 * By rule only — each negative's record over the window of the ads strategy's "Negate a search term when" group where it
 * lands (create-negative-keyword's rule, AA-W2-7, for every item): what the pure check of its limits reads.
 */
async function negateRecords(items: NegItem[], facts: { entityScopes: Record<string, string>; scopes: Record<string, { limits: { negateWindowDays?: number | null } }> }): Promise<Record<string, { windowDays: number; clicks: number; spendCents: number; orders: number }>> {
  const windowOf = (i: NegItem) => facts.scopes[facts.entityScopes[entityKey(entityOf(i))] ?? '']?.limits.negateWindowDays ?? null
  const byWindow = new Map<number, NegItem[]>()
  for (const i of items) {
    const w = windowOf(i)
    if (w) byWindow.set(w, [...(byWindow.get(w) ?? []), i])
  }
  const out: Record<string, { windowDays: number; clicks: number; spendCents: number; orders: number }> = {}
  for (const [windowDays, list] of byWindow) {
    const ext = await adGroupExternalIds([...new Set(list.flatMap((i) => i.adGroupIds))])
    const totals = [...(await searchTermTotals(windowDays, [...ext.values()].filter((id): id is string => !!id))).values()]
    for (const i of list) {
      const exts = new Set(i.adGroupIds.map((id) => ext.get(id)).filter(Boolean))
      const hit = totals.filter((t) => exts.has(t.externalAdGroupId) && blocks(placementOf(i), t.query))
      const r = { windowDays, clicks: hit.reduce((n, t) => n + t.clicks, 0), spendCents: hit.reduce((n, t) => n + t.costCents, 0), orders: hit.reduce((n, t) => n + t.orders, 0) }
      // Keyed as the kit places it (the term in its ad group, or its campaign). An exact and a phrase negative of the same
      // words in one place share that key: the record that meets the group less well is kept (the safer).
      const key = entityKey(entityOf(i))
      const had = out[key]
      out[key] = had ? { windowDays, clicks: Math.min(had.clicks, r.clicks), spendCents: Math.min(had.spendCents, r.spendCents), orders: Math.max(had.orders, r.orders) } : r
    }
  }
  return out
}

/** The negative as the ads strategy places it: the term in its ad group, or in its campaign (a campaign negative). */
const entityOf = (i: NegItem) => ({ kind: 'searchTerm' as const, query: i.text, externalCampaignId: i.campaign.externalCampaignId, externalAdGroupId: i.level === 'AD_GROUP' ? i.externalAdGroupId : null })

const placementOf = (i: NegItem): NegativePlacement => ({ key: i.key, text: i.text, match: i.kind === 'PRODUCT' ? 'PRODUCT' : i.match === 'NEGATIVE_PHRASE' ? 'PHRASE' : 'EXACT', adGroupIds: i.adGroupIds })

/** The writes of a request, one per campaign it touches (sorted): what the gate judges, as a person's and as a rule's. */
function negativeWrites(items: NegItem[]): Array<RuleWrite & { label: string }> {
  const byCampaign = new Map<string, NegItem[]>()
  for (const i of items) byCampaign.set(i.campaign.id, [...(byCampaign.get(i.campaign.id) ?? []), i])
  return [...byCampaign].sort(([x], [y]) => (x < y ? -1 : 1)).map(([campaignId, list]) => ({
    campaignId, marketplace: list[0].campaign.marketplace, changes: [{ field: 'negativeKeyword', valueCents: null }], isNegation: true, keywordText: list[0].text,
    label: `campaign "${list[0].campaign.name}"`,
  }))
}

/** The rules and schedules bound to the campaigns it touches (at most 10 named). */
async function boundTo(campaignIds: string[]): Promise<{ automations: BoundAutomation[]; note: string | null }> {
  const all: BoundAutomation[] = []
  for (const id of campaignIds.slice(0, 20)) all.push(...(await alsoChangedBy(id)).automations)
  const automations = [...new Map(all.map((a) => [JSON.stringify(a), a])).values()].slice(0, 10)
  return { automations, note: automations.length ? `${plural(automations.length, 'enabled rule or schedule', 'enabled rules or schedules')} bound to these campaigns may change them again.` : null }
}

async function decideAdd(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>, opts: { rule: boolean }): Promise<{ result: ToolResult; items: NegItem[] }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult, items: [] as NegItem[] })
  const parsed = ADD_INPUT.safeParse(raw)
  if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '))
  const a = parsed.data
  const built = await itemsOf(a)
  if ('refusal' in built) return refuse(built.refusal)
  const items = built.items
  const checked = await checksOf(items)
  if ('refusal' in checked) return refuse(checked.refusal)

  // The Owner's rules 2 and 3, on the search-term report of the ad groups the negatives land in.
  const product = a.product ? await productRootOf(a.product) : null
  if (a.product && !product) return refuse(`Not queued: product ${a.product} was not found in this business.`)
  const rules = await termRulesFor(items.map(placementOf), { product })
  if (rules.converting.length) {
    return refuse(`Not queued: a negative there would block a search term that converts — ${convertingWords(rules.converting)} over the last ${rules.windowDays} days. `
      + 'Winners stay where they win (the Owner\'s rule 2): leave it out, and lower its bid or placement there instead; once its own exact keyword elsewhere wins, its old place can be closed.')
  }
  if (rules.otherProducts.length && a.allowOtherProducts !== true) {
    return refuse(`Not queued: isolation is per product (the Owner's rule 3) — ${otherProductWords(rules.otherProducts)}: the negative would stop that product from a term it buys. `
      + 'Leave those places out, name the product these negatives are for (product), or ask with allowOtherProducts: true (a person decides it, never a rule).')
  }

  const writes = negativeWrites(items)
  const reached = await reachOver(writes)
  if ('refused' in reached) return refuse(`Not queued: ${reached.label}: ${gateRefusal(reached.refused)}`)
  const stored = reached.reach
  const bound = await boundTo([...new Set(items.map((i) => i.campaign.id))])

  const kit: KitItem[] = items.map((i) => ({ entity: entityOf(i), change: { field: 'negative', term: i.text, matchType: i.match } }))
  const facts = opts.rule
    ? await ruleFactsFor({ tool: TOOL.add, limits: ADD_LIMITS, items: kit, writes, approvalId: ctx.approvalId ?? null })
    : null
  const ruleRecords = facts ? await negateRecords(items, facts.limitFacts) : null

  const currencyOf = new Map(items.map((i) => [i.key, i.campaign.currency]))
  const lines = items.map((i) => {
    const r = rules.records[i.key]
    return {
      label: `${negativeWords(i)} · ${i.place}`, level: i.level, marketplace: i.campaign.marketplace, fromLabel: 'none', toLabel: negativeWords(i),
      // What it blocks of what ran there over the window, in the campaign's currency.
      blocked: { searchTerms: r?.terms ?? 0, clicks: r?.clicks ?? 0, orders: r?.orders ?? 0, spendCents: r?.spendCents ?? 0, currency: currencyOf.get(i.key) },
    }
  })
  const counts = { keywords: items.filter((i) => i.kind === 'KEYWORD').length, asins: items.filter((i) => i.kind === 'PRODUCT').length }
  const places = new Set(items.map((i) => `${i.level}:${i.placeId}`)).size
  const markets = [...new Set(items.map((i) => i.campaign.marketplace).filter((m): m is string => !!m))].sort()
  const what = [counts.keywords ? plural(counts.keywords, 'negative keyword') : '', counts.asins ? plural(counts.asins, 'negative product target') : ''].filter(Boolean).join(' and ')
  const effect = `Adds ${what} at Amazon in ${plural(places, 'place')}: ${named(lines.map((l) => l.label))}. A negative only lowers spend: the searches it blocks stop showing these ads there.`
    + (rules.handovers.length ? ` ${plural(rules.handovers.length, 'converting term')} ${rules.handovers.length === 1 ? 'is' : 'are'} closed in an old place because its own exact keyword wins elsewhere (the proven handover): ${named(rules.handovers.map((h) => `"${h.term}" in ${h.place} (it wins in ${h.home})`))}.` : '')
    + (rules.otherProducts.length ? ` As asked (allowOtherProducts), ${plural(rules.otherProducts.length, 'place')} of another product ${rules.otherProducts.length === 1 ? 'is' : 'are'} blocked too: ${otherProductWords(rules.otherProducts)}.` : '')
  return {
    items,
    result: {
      ok: true,
      preview: {
        action: TOOL.add,
        ...(markets.length === 1 ? { market: markets[0] } : { markets }),
        totals: { negatives: items.length, ...counts, places, campaigns: new Set(items.map((i) => i.campaign.id)).size },
        changes: lines.slice(0, LINES_SHOWN),
        ...(lines.length > LINES_SHOWN ? { moreChanges: lines.length - LINES_SHOWN } : {}),
        // A negative only lowers spend: nothing here raises it.
        raises: [],
        windowDays: rules.windowDays,
        ...(rules.productFor ? { productFor: rules.productFor } : {}),
        // Rule 3 — the places of another product it blocks (only with allowOtherProducts); frozen: a product that starts
        // buying the term before it runs stops the run.
        otherProducts: rules.otherProducts,
        handovers: rules.handovers,
        ...(checked.warnings.length ? { warnings: checked.warnings } : {}),
        alsoChangedBy: bound.automations,
        ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
        // Every negative and the ad groups it blocks in: a change of any of them after approval is caught.
        basis: fingerprint(items.map((i) => [i.key, i.adGroupIds])),
        reach: stored,
        reachNote: reachNote(stored),
        effect,
        undoNote: 'Undo retires exactly the negatives this request made (undo-ad-change): archived at Amazon, so the searches they blocked show these ads again.',
        ...(facts ?? {}),
        ...(ruleRecords ? { ruleRecords } : {}),
      },
    },
  }
}

/**
 * add-negative-targets' own checks, before the common ones (pure, on the preview): never another product's place by rule
 * (rule 3: a person's word) nor a proven handover (a winner's old place: a person decides), the markets, the match types,
 * campaign negatives and ASIN negatives.
 */
function addRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as {
    action?: string; otherProducts?: unknown[]; handovers?: unknown[]; market?: string; markets?: string[]
    ruleRecords?: Record<string, { windowDays: number; clicks: number; spendCents: number; orders: number }>
  }
  if (p.action !== TOOL.add) return 'there is no preview of these negatives to check; a person decides'
  if (!Array.isArray(p.otherProducts)) return 'the preview does not say whether another product buys these terms; a person decides'
  if (p.otherProducts.length) return 'it blocks a term in another product\'s ad group (allowOtherProducts): isolation is per product, a person\'s word, never a rule; a person decides'
  if (Array.isArray(p.handovers) && p.handovers.length) return 'it closes a converting term\'s old place (the proven handover): a person decides a winner\'s move'
  const markets = (limits.markets as string[] | undefined) ?? []
  const where = p.market ? [p.market] : p.markets ?? []
  if (!markets.length) return 'this business names no market where these negatives may run by rule (markets is empty); a person decides'
  const outside = where.filter((m) => !markets.includes(m))
  if (outside.length || !where.length) return `this business lets them run by rule only in ${markets.join(', ')}; a person decides`
  const facts = limitFactsOf(preview)
  if (!facts) return null // ruleRefusal says it
  const matchTypes = new Set((limits.matchTypes as string[] | undefined) ?? ['NEGATIVE_EXACT'])
  const items = facts.wanted ?? []
  for (const w of items) {
    if (w.matchType == null) {
      if (limits.allowAsinNegatives !== true) return 'it adds a negative product target (an ASIN); this tool\'s limits do not let one run by rule (allowAsinNegatives is off); a person decides'
    } else if (!matchTypes.has(w.matchType)) {
      return `it adds a ${w.matchType === 'NEGATIVE_PHRASE' ? 'phrase' : 'exact'} negative, which this tool's limits do not let run by rule (matchTypes); a person decides`
    }
    if (w.entity.split(':')[2] === '*' && limits.allowCampaignScope !== true) return 'it adds a campaign negative (every ad group of a campaign); this tool\'s limits do not let one run by rule (allowCampaignScope is off); a person decides'
  }
  return null
}

/**
 * After the common checks — as create-negative-keyword (AA-W2-7), for every item: its record meets the ads strategy's
 * "Negate a search term when" group where it lands, over that group's window, and this tool's least wasted spend.
 */
function negateGroupRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { ruleRecords?: Record<string, { windowDays: number; clicks: number; spendCents: number; orders: number }> }
  const facts = limitFactsOf(preview)
  if (!facts) return null // ruleRefusal says it
  // Each negative against the strategy's negate group where it lands, over that group's window (the kit's facts place it).
  const records = p.ruleRecords
  if (!records) return 'the terms\' records over the strategy\'s windows were not read for this preview; a person decides'
  for (const [entity, scopeKey] of Object.entries(facts.entityScopes)) {
    const scope = facts.scopes[scopeKey]
    const l = scope?.limits
    const source = scope?.sources.negate
    if (!l || !source || l.negateMinClicks == null || l.negateMinSpendCents == null || l.negateMaxOrders == null || !l.negateWindowDays) {
      return `the ads strategy sets no "Negate a search term when" group at ${scope?.label ?? facts.labels[entity] ?? 'where it lands'}: a negative runs by rule only for a term that meets one; a person decides`
    }
  }
  const min = typeof limits.minWastedSpendCents === 'number' ? limits.minWastedSpendCents : 0
  const currency = Object.values(facts.markets)[0]?.currency ?? 'EUR'
  for (const r of Object.values(records)) {
    if (r.spendCents < min) return `a negative's blocked searches spent ${amountLabel(r.spendCents, currency)} over ${r.windowDays} days, less than the ${amountLabel(min, currency)} this tool's limits ask before one runs by rule (minWastedSpendCents); a person decides`
  }
  for (const [entity, scopeKey] of Object.entries(facts.entityScopes)) {
    const scope = facts.scopes[scopeKey]
    const l = scope.limits
    const r = records[entity]
    if (!r) return `the record of ${facts.labels[entity] ?? 'a term'} over the strategy's ${l.negateWindowDays} days was not read for this preview; a person decides`
    const short = [
      r.clicks < (l.negateMinClicks as number) ? `fewer than ${l.negateMinClicks} clicks` : null,
      r.spendCents < (l.negateMinSpendCents as number) ? `less than ${amountLabel(l.negateMinSpendCents as number, currency)} spent` : null,
      r.orders > (l.negateMaxOrders as number) ? `more than ${l.negateMaxOrders} orders` : null,
    ].filter((x): x is string => !!x)
    if (short.length) return `${facts.labels[entity] ?? 'a term'}: ${short.join(', ')} over ${r.windowDays} days, so it does not meet "Negate a search term when" at ${scope.label} (${strategyWords(scope.sources.negate!)}); a person decides`
  }
  return null
}

/** add-negative-targets' material fields: every negative and where it blocks, where it lands, the other products it blocks. */
const ADD_MATERIAL = ['basis', 'reach', 'otherProducts', 'handovers'] as const
/** retire-negatives' material fields: every negative it lifts, with who made it, and where it lands. */
const RETIRE_MATERIAL = ['basis', 'reach'] as const

/** C2 — undo of the negatives a request added: undo-ad-change retires exactly those (named by this change). */
export const ADD_NEGATIVES_UNDO: ToolUndo = {
  async current(change) {
    const listed = ((change.after as { negatives?: Array<{ targetId?: unknown }> } | null)?.negatives ?? []).map((n) => String(n.targetId ?? ''))
    // 5f — status decides, as in retireNegatives.
    const standing = listed.length ? await prisma.adTarget.findMany({ where: { id: { in: listed }, isNegative: true, status: { not: 'ARCHIVED' } }, select: { id: true } }) : []
    const ids = new Set(standing.map((t) => t.id))
    return { negatives: listed.filter((id) => ids.has(id)).map((targetId) => ({ targetId })) }
  },
  request(change) {
    const changeSetId = (change.before as { changeSetId?: unknown } | null)?.changeSetId
    if (typeof changeSetId !== 'string' || !changeSetId) return { refusal: 'This change does not name the request that made it.' }
    return { tool: 'undo-ad-change', args: { changeSetId, ...(change.id ? { changeId: change.id } : {}), why: 'undo of add-negative-targets: the negatives it added are retired' } }
  },
}

const addNegativeTargets: AgentTool = {
  name: TOOL.add,
  title: 'Add negative keywords and ASINs',
  input: ADD_INPUT,
  requires: [F.adsBidsEdit, FIELDS.financialsAdspendView],
  restrictedFields: LIMIT_FACTS_MONEY as Readonly<Record<string, FieldPermission>>,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  // Created at Amazon once approved (no cancel window): the approval is the brake.
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: ADD_LIMITS,
  withinLimits: (preview, limits) => addRefusal(preview, limits) ?? ruleRefusal(preview, limits) ?? negateGroupRefusal(preview, limits),
  undo: ADD_NEGATIVES_UNDO,
  description:
    `Add negatives to Amazon Sponsored Products campaigns in one request (up to ${MAX_NEGATIVES}, one step): negative keywords `
    + '(NEGATIVE_EXACT or NEGATIVE_PHRASE) and negative product targets (ASINs), into ad groups — one set of terms into many '
    + 'ad groups, the n-gram way — or as campaign negatives (every ad group of a campaign; keywords only), or each with its '
    + 'own place. create-negative-keyword stays the one-term form. Never a search term that converts where it lands (an '
    + 'order over the last 60 days; the Owner\'s rule: winners stay where they win) — unless its own exact keyword wins '
    + 'elsewhere for the same product (the proven handover, said on the card). Isolation is per product: a place of another '
    + 'product that buys the term is listed and refused unless allowOtherProducts: true, a person\'s word that never runs by '
    + 'rule. Refused, and not queued, for a protected term, a negative already there, one that would block a keyword of its '
    + 'own place, or when Amazon\'s write gate would refuse it; a protected product\'s ASIN is warned. A negative only lowers '
    + `spend, so it needs no authenticator code. ${BY_RULE_WORDS} (by default it does not: maxItems 0, no market; then only exact `
    + 'negatives of terms that meet the ads strategy\'s "Negate a search term when" group where they land). The preview lists '
    + 'each negative with what it blocks of what ran there, where it lands (live at Amazon or sandbox) and each limit. '
    + 'Undo (undo-change) retires exactly what it made.',
  async handler(args, ctx) {
    return (await decideAdd(args, ctx, { rule: true })).result
  },
  async execute(args, ctx) {
    const { result: fresh, items } = await decideAdd(args, ctx, { rule: false })
    const refusal = recheck(ctx, fresh, ADD_MATERIAL)
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { reach: StoredReach; effect: string; otherProducts: unknown[]; handovers: unknown[] }
    // Rule 3 and a winner's move are a person's word: never a run the business's rule decided (withinLimits refuses it;
    // this is the last door).
    if (ctx.decidedVia === 'auto' && (p.otherProducts.length || p.handovers.length)) {
      return notRun(`Not run: it ${p.otherProducts.length ? 'blocks a term in another product\'s ad group' : 'closes a converting term\'s old place'}, which a person decides, never a rule. Ask for it again; a person approves it.`)
    }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const made: Array<{ targetId: string; item: NegItem; reachedAmazon: boolean }> = []
    const already: string[] = []
    const failed: string[] = []
    const evidence = { metric: 'claudeRequest', note: run.reason }
    for (const i of items) {
      // The one negative write service: it asks the gate (the campaign's allowlist binds a rule's run; a person's approval
      // is his own click, 4A), checks protection and the own-keyword lock, pushes, and records the row with its audit row
      // on this change set — only for a negative that stands.
      const out = i.kind === 'PRODUCT'
        ? await writeNegativeProductTarget({ adGroupId: i.placeId, asin: i.text, userId: run.actor, evidence, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId })
        : await writeNegativeKeyword({
          scope: i.level, ...(i.level === 'AD_GROUP' ? { adGroupId: i.placeId } : { campaignId: i.placeId }), keywordText: i.text, matchType: i.match!,
          userId: run.actor, evidence, manual: run.manual, changeSetId: run.changeSetId,
        })
      if ((out.outcome === 'created' || out.outcome === 'local') && out.adTargetId) made.push({ targetId: out.adTargetId, item: i, reachedAmazon: out.reachedAmazon })
      else if (out.outcome === 'already_existed') already.push(`${negativeWords(i)} in ${i.place}`)
      else failed.push(`${negativeWords(i)} in ${i.place} (${out.refusal?.reason ?? out.error ?? 'refused'})`)
    }
    if (!made.length) {
      return notRun(failed.length
        ? `Not run: no negative was added — ${named(failed)}. Nothing changed.`
        : `Not run: every negative was already there (${named(already)}). Nothing changed.`)
    }
    const data = {
      added: made.length,
      reachedAmazon: made.filter((m) => m.reachedAmazon).length,
      ...(already.length ? { alreadyThere: already.length } : {}),
      ...(failed.length ? { partial: true, failed: failed.length, problems: failed.slice(0, LINES_SHOWN) } : {}),
      negatives: made.slice(0, LINES_SHOWN).map((m) => ({ targetId: m.targetId, negative: negativeWords(m.item), place: m.item.place })),
      reach: p.reach,
      changeSetId: run.changeSetId,
      note: p.reach.reach === 'live' ? 'Created at Amazon at once (no cancel window).' : 'Sandbox: recorded in Nexus only; nothing reached Amazon.',
      ...(failed.length ? { problem: `Added ${made.length} of ${items.length}: ${named(failed)}. The rest was not added; ask for it again once that is fixed.` } : {}),
    }
    return {
      ok: true,
      data,
      change: {
        // What each negative was, for a person reading the record; `after` is what undo compares (the ids only).
        before: { changeSetId: run.changeSetId, negatives: [], added: made.map((m) => ({ targetId: m.targetId, level: m.item.level, placeId: m.item.placeId, kind: m.item.kind, text: m.item.text, match: m.item.match })) },
        after: { negatives: made.map((m) => ({ targetId: m.targetId })) },
      },
    }
  },
}

// ── retire-negatives ──────────────────────────────────────────────────────────────────────────────

const RETIRE_INPUT = z.object({
  negativeIds: z.array(ID).max(MAX_RETIRE).optional()
    .describe('the negatives to retire, by their Nexus id (what add-negative-targets or create-negative-keyword made: approval-status names them)'),
  negatives: z.array(z.object({
    adGroupId: ID.optional().describe('the ad group it stands in (Nexus id)'),
    campaignId: ID.optional().describe('or the campaign: a campaign negative'),
    text: TEXT.optional().describe('a negative keyword: its words'),
    matchType: NEG_MATCH.optional().describe('its match (default: either)'),
    asin: ASIN.optional().describe('or a negative product target: its ASIN'),
  })).max(MAX_RETIRE).optional().describe('or each by its place and text: the negative standing there'),
  why: whyArg,
})
type RetireArgs = z.infer<typeof RETIRE_INPUT>

/** retire-negatives' Claude limits: by default nothing runs alone (maxItems 0, allowRetire off, no market). */
const RETIRE_LIMITS = adKitLimits({ maxItems: 0 }, {
  allowRetire: z.boolean().default(false).describe('let a retire run by rule: lifting a block lets the searches it blocked show the ads again (it can add spend)'),
  markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([])
    .describe('the markets where it may run by rule; empty = none: every request waits for a person'),
})

const NEGATIVE_SELECT = {
  id: true, kind: true, isNegative: true, status: true, expressionType: true, expressionValue: true, negativeLevel: true, externalTargetId: true, createdAt: true, adGroupId: true,
  adGroup: { select: { id: true, name: true, campaign: { select: CAMPAIGN_SELECT } } },
} as const
type NegRow = { id: string; kind: unknown; isNegative: boolean; status: unknown; expressionType: string; expressionValue: string; negativeLevel: string | null; externalTargetId: string | null; createdAt: Date; adGroupId: string; adGroup: { id: string; name: string; campaign: PlaceRow['campaign'] } }

/** One standing negative a retire lifts, as a card and its record read it. */
interface Retiring {
  id: string
  kind: 'KEYWORD' | 'PRODUCT'
  text: string
  match: NegMatch | null
  level: Level
  adGroupId: string
  campaign: Campaign
  place: string
  atAmazon: boolean
  madeBy: string
}

const retiringOf = (r: NegRow, madeBy: string): Retiring => {
  const kind = String(r.kind) === 'PRODUCT' ? 'PRODUCT' : 'KEYWORD'
  const level: Level = r.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP'
  return {
    id: r.id, kind, text: r.expressionValue, match: kind === 'PRODUCT' ? null : /PHRASE/.test(r.expressionType) ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT',
    level, adGroupId: r.adGroupId, campaign: campaignOf(r.adGroup.campaign),
    place: level === 'CAMPAIGN' ? `campaign "${r.adGroup.campaign.name}" (every ad group)` : placeWords(r.adGroup),
    atAmazon: !!r.externalTargetId, madeBy,
  }
}

/** Who made each negative, in words: the first audit row Nexus kept of it (none: Amazon's sync brought it in). */
async function madeByOf(ids: string[]): Promise<Map<string, string>> {
  const logs = ids.length
    ? await prisma.advertisingActionLog.findMany({ where: { entityType: 'AD_TARGET', entityId: { in: ids } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { entityId: true, userId: true, executionId: true, createdAt: true } })
    : []
  const first = new Map<string, (typeof logs)[number]>()
  for (const l of logs) if (!first.has(l.entityId)) first.set(l.entityId, l)
  const sets = [...new Set([...first.values()].map((l) => l.executionId).filter((id): id is string => !!id))]
  const approvals = new Set(sets.length ? (await prisma.agentApproval.findMany({ where: { id: { in: sets } }, select: { id: true } })).map((a) => a.id) : [])
  const at = (d: Date) => `${d.toISOString().slice(0, 10)}`
  return new Map(ids.map((id) => {
    const l = first.get(id)
    if (!l) return [id, 'no record in Nexus of who added it: Amazon\'s sync brought it in, or it predates Nexus\'s records']
    if (l.executionId && approvals.has(l.executionId)) return [id, `Claude request ${l.executionId} added it (${at(l.createdAt)})`]
    if (l.userId?.startsWith('user:')) return [id, `a person added it in Nexus (${l.userId}, ${at(l.createdAt)})`]
    if (l.userId?.startsWith('automation:')) return [id, `a Nexus rule or engine added it (${l.userId}, ${at(l.createdAt)})`]
    return [id, `added in Nexus by a writer it did not record (${at(l.createdAt)})`]
  }))
}

/** The negatives a retire names, as Nexus holds them now — or why not. */
async function retiringFor(a: RetireArgs): Promise<{ list: Retiring[] } | { refusal: string }> {
  const ids = [...new Set((a.negativeIds ?? []).map((id) => id.trim()).filter(Boolean))]
  const selectors = a.negatives ?? []
  if (!ids.length && !selectors.length) return { refusal: 'Name the negatives to retire: negativeIds, or negatives each by its place (adGroupId or campaignId) and its text or ASIN.' }
  if (ids.length + selectors.length > MAX_RETIRE) return { refusal: `${ids.length + selectors.length} negatives named: at most ${MAX_RETIRE} retire in one request. Split them.` }
  const problems: string[] = []
  const rows: NegRow[] = []
  if (ids.length) {
    const found = await prisma.adTarget.findMany({ where: { id: { in: ids } }, select: NEGATIVE_SELECT }) as unknown as NegRow[]
    const byId = new Map(found.map((r) => [r.id, r]))
    for (const id of ids) {
      const r = byId.get(id)
      if (!r) problems.push(`negative ${id} was not found in this business`)
      else if (!r.isNegative) problems.push(`target ${id} ("${r.expressionValue}") is a keyword or target, not a negative: pause-ads or archive-ads change those`)
      else rows.push(r)
    }
  }
  for (const [i, s] of selectors.entries()) {
    const where = s.adGroupId && s.campaignId ? null : s.adGroupId ? 'AD_GROUP' : s.campaignId ? 'CAMPAIGN' : null
    if (!where) { problems.push(`negatives[${i}]: name one place (adGroupId or campaignId)`); continue }
    if (!!s.text === !!s.asin) { problems.push(`negatives[${i}]: name one negative (text or asin)`); continue }
    const found = await prisma.adTarget.findMany({
      where: {
        isNegative: true, status: { not: 'ARCHIVED' },
        ...(s.asin ? { kind: 'PRODUCT', expressionValue: { equals: s.asin, mode: 'insensitive' } } : { kind: 'KEYWORD', expressionValue: { equals: s.text!, mode: 'insensitive' } }),
        ...(where === 'AD_GROUP' ? { adGroupId: s.adGroupId!, OR: [{ negativeLevel: 'AD_GROUP' }, { negativeLevel: null }] } : { negativeLevel: 'CAMPAIGN', adGroup: { campaignId: s.campaignId! } }),
      },
      select: NEGATIVE_SELECT,
    }) as unknown as NegRow[]
    const matching = found.filter((r) => !s.matchType || (/PHRASE/.test(r.expressionType) ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT') === s.matchType)
    if (!matching.length) problems.push(`no standing ${s.asin ? `negative product target ${s.asin}` : `negative "${s.text}"`} in ${where === 'AD_GROUP' ? `ad group ${s.adGroupId}` : `campaign ${s.campaignId}`} in this business`)
    rows.push(...matching)
  }
  if (problems.length) return { refusal: `Not queued: ${named(problems)}.` }
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()]
  const cannot: string[] = []
  for (const r of unique) {
    const label = `${negativeWords({ kind: String(r.kind) === 'PRODUCT' ? 'PRODUCT' : 'KEYWORD', text: r.expressionValue, match: /PHRASE/.test(r.expressionType) ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT' })} in ${placeWords(r.adGroup)}`
    if (String(r.status) === 'ARCHIVED') cannot.push(`${label}: it is retired already (archived)`)
    else {
      const why = spOnlyRefusal({ type: r.adGroup.campaign.type == null ? null : String(r.adGroup.campaign.type), adProduct: r.adGroup.campaign.adProduct, name: r.adGroup.campaign.name })
        ?? (String(r.adGroup.campaign.status) === 'ARCHIVED' ? 'its campaign is archived' : null)
      if (why) cannot.push(`${label}: ${why}`)
    }
  }
  if (cannot.length) return { refusal: `Not queued: ${named(cannot)}.` }
  const madeBy = await madeByOf(unique.map((r) => r.id))
  return { list: unique.map((r) => retiringOf(r, madeBy.get(r.id)!)) }
}

/** How a retire is approved, in one sentence (its stepUp). */
const RETIRE_HOW = 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms it '
  + 'in Claude with theirs when the business set retire-negatives to confirm in Claude. By rule only where the business allows a retire (allowRetire).'

async function decideRetire(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>, opts: { rule: boolean }): Promise<{ result: ToolResult; list: Retiring[] }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult, list: [] as Retiring[] })
  const parsed = RETIRE_INPUT.safeParse(raw)
  if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '))
  const found = await retiringFor(parsed.data)
  if ('refusal' in found) return refuse(found.refusal)
  const list = found.list
  const atAmazon = list.filter((r) => r.atAmazon)
  // Where it lands: only the negatives Amazon holds are archived there (a status write per negative, through the queue).
  const byCampaign = new Map<string, Retiring>()
  for (const r of atAmazon) if (!byCampaign.has(r.campaign.id)) byCampaign.set(r.campaign.id, r)
  const writes = [...byCampaign.values()].sort((x, y) => (x.campaign.id < y.campaign.id ? -1 : 1)).map((r) => ({
    campaignId: r.campaign.id, marketplace: r.campaign.marketplace, changes: [{ field: 'status', valueCents: null }], label: `campaign "${r.campaign.name}"`,
  }))
  const reached = writes.length ? await reachOver(writes) : { reach: { reach: 'sandbox' } as StoredReach }
  if ('refused' in reached) return refuse(`Not queued: ${reached.label}: ${gateRefusal(reached.refused)}`)
  const stored = reached.reach
  const kit: KitItem[] = list.map((r) => ({ entity: { kind: 'target', id: r.id }, change: { field: 'retire', term: r.text, matchType: r.match }, ...(r.atAmazon ? {} : { nexusOnly: true }) }))
  const facts = opts.rule ? await ruleFactsFor({ tool: TOOL.retire, limits: RETIRE_LIMITS, items: kit, writes, approvalId: ctx.approvalId ?? null }) : null
  const bound = await boundTo([...new Set(list.map((r) => r.campaign.id))])
  const lines = list.map((r) => ({
    targetId: r.id, label: `${negativeWords(r)} · ${r.place}`, marketplace: r.campaign.marketplace, madeBy: r.madeBy,
    fromLabel: 'Standing (blocks the search)', toLabel: r.atAmazon ? 'Retired: archived at Amazon' : 'Removed from Nexus (Amazon never had it)',
  }))
  const local = list.length - atAmazon.length
  const markets = [...new Set(list.map((r) => r.campaign.marketplace).filter((m): m is string => !!m))].sort()
  const effect = `Retires ${plural(list.length, 'negative')} (${named(lines.map((l) => l.label))}).`
    + (atAmazon.length ? ` ${plural(atAmazon.length, 'is', 'are')} archived at Amazon: the searches ${atAmazon.length === 1 ? 'it blocks' : 'they block'} can show these ads again, so spend can rise. Amazon never switches an archived negative on again: to block a search again, a new one is added.` : '')
    + (local ? ` ${plural(local, 'is', 'are')} only in Nexus (Amazon never had ${local === 1 ? 'it' : 'them'}): ${local === 1 ? 'its' : 'their'} record is removed and nothing changes at Amazon.` : '')
  return {
    list,
    result: {
      ok: true,
      preview: {
        action: TOOL.retire,
        ...(markets.length === 1 ? { market: markets[0] } : { markets }),
        totals: { retiring: list.length, atAmazon: atAmazon.length, nexusOnly: local },
        changes: lines.slice(0, LINES_SHOWN),
        ...(lines.length > LINES_SHOWN ? { moreChanges: lines.length - LINES_SHOWN } : {}),
        // Every negative lifted at Amazon can let spend rise: each is listed, and approving needs the approver's code.
        raises: atAmazon.map((r) => `${negativeWords(r)} · ${r.place}`),
        ...(atAmazon.length ? { stepUp: { what: `lifts ${plural(atAmazon.length, 'negative')} at Amazon (the searches ${atAmazon.length === 1 ? 'it blocks' : 'they block'} can show the ads again)`, raises: ['Spend'], needs: STEP_UP_NEEDS, how: RETIRE_HOW } } : {}),
        alsoChangedBy: bound.automations,
        ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
        // Every negative named, with its status, whether Amazon holds it and who made it: a move of any is caught.
        basis: fingerprint(list.map((r) => [r.id, r.atAmazon, r.madeBy])),
        reach: stored,
        reachNote: atAmazon.length ? reachNote(stored) : 'Nexus only: none of these negatives is at Amazon, so nothing is sent there.',
        warning: atAmazon.length ? 'Lifting a block lets the searches it blocked show these ads again: spend can rise. A retired negative is archived at Amazon for good; blocking the search again adds a new one.' : 'Nexus only: nothing changes at Amazon.',
        effect,
        undoNote: 'Undo adds the same negatives again where they stood (add-negative-targets: new ones at Amazon, checked again against the Owner\'s rules); the ones only in Nexus are not made again.',
        ...(facts ?? {}),
      },
    },
  }
}

/** retire-negatives' own checks, before the common ones (pure): a retire runs by rule only where the business allows it. */
function retireRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { action?: string; market?: string; markets?: string[] }
  if (p.action !== TOOL.retire) return 'there is no preview of this retire to check; a person decides'
  if (limits.allowRetire !== true) return 'lifting a negative lets the searches it blocked show the ads again (spend can rise); this tool\'s limits do not let a retire run by rule (allowRetire is off); a person decides'
  const markets = (limits.markets as string[] | undefined) ?? []
  const where = p.market ? [p.market] : p.markets ?? []
  if (!markets.length) return 'this business names no market where a retire may run by rule (markets is empty); a person decides'
  if (!where.length || where.some((m) => !markets.includes(m))) return `this business lets a retire run by rule only in ${markets.join(', ')}; a person decides`
  return null
}

/** What is stored NOW for each negative a retire lifted (the undo guard compares it with `after`). */
async function retiredNow(change: ToolChange): Promise<{ negatives: Array<{ targetId: string; status: string }> }> {
  const listed = ((change.after as { negatives?: Array<{ targetId?: unknown }> } | null)?.negatives ?? []).map((n) => String(n.targetId ?? ''))
  const rows = listed.length ? await prisma.adTarget.findMany({ where: { id: { in: listed } }, select: { id: true, status: true } }) : []
  const status = new Map(rows.map((r) => [r.id, String(r.status)]))
  return { negatives: listed.map((targetId) => ({ targetId, status: status.get(targetId) ?? 'REMOVED' })) }
}

/**
 * C2 — undo of a retire: the same negatives added again where they stood (add-negative-targets, each with its own place;
 * new ones at Amazon), checked again against the Owner's rules — a term that converts there now is refused. Another
 * product's place it stood in is asked for as it stood (allowOtherProducts: listed on the card; never by rule). One only
 * in Nexus is not made again (Amazon never had it).
 */
export const RETIRE_NEGATIVES_UNDO: ToolUndo = {
  current: retiredNow,
  request(change) {
    const before = ((change.before as { negatives?: Array<Record<string, unknown>> } | null)?.negatives ?? [])
    const archived = new Set(((change.after as { negatives?: Array<{ targetId?: unknown; status?: unknown }> } | null)?.negatives ?? []).filter((n) => n.status === 'ARCHIVED').map((n) => String(n.targetId ?? '')))
    const back = before.filter((n) => n.atAmazon === true && archived.has(String(n.targetId ?? '')))
    if (!back.length) return { refusal: 'None of the negatives this retire lifted was at Amazon: there is nothing to add again there.' }
    return {
      tool: TOOL.add,
      args: {
        negatives: back.map((n) => (n.kind === 'PRODUCT'
          ? { adGroupId: String(n.adGroupId), asin: String(n.text) }
          : { ...(n.level === 'CAMPAIGN' ? { campaignId: String(n.campaignId) } : { adGroupId: String(n.adGroupId) }), text: String(n.text), matchType: n.match === 'NEGATIVE_PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT' })),
        allowOtherProducts: true,
        why: 'undo of retire-negatives: the same negatives added again where they stood',
      },
    }
  },
}

const retireNegatives: AgentTool = {
  name: TOOL.retire,
  title: 'Retire negative keywords and ASINs',
  input: RETIRE_INPUT,
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  restrictedFields: LIMIT_FACTS_MONEY as Readonly<Record<string, FieldPermission>>,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  // Amazon never switches an archived negative on again: undo adds new ones (and a Nexus-only one is not made again).
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: RETIRE_LIMITS,
  withinLimits: (preview, limits) => retireRefusal(preview, limits) ?? ruleRefusal(preview, limits),
  undo: RETIRE_NEGATIVES_UNDO,
  description:
    `Retire standing negatives of Amazon Sponsored Products campaigns — any, not only Claude's (up to ${MAX_RETIRE}): negative `
    + 'keywords and negative product targets, ad group or campaign negatives, by id or by their place and text. One Amazon '
    + 'holds is archived there, through the Negatives page\'s own retire (permanent at Amazon: blocking the search again adds a '
    + 'new one); one only in Nexus has its record removed. Lifting a block lets the searches it blocked show the ads again, '
    + 'so spend can rise: the preview lists each negative with who added it, and a person with settings.security.manage '
    + 'approves it in Nexus with their authenticator code (or the person who asked confirms it in Claude with theirs). '
    + 'It may run by the business\'s rule only where the business allows a retire (allowRetire, off by default), in a market it names, inside its limits and the ads strategy. Refused, and not queued, when a '
    + 'negative is not found, is not a negative, is retired already, or when Amazon\'s write gate would refuse it. Undo '
    + '(undo-change) adds the same negatives again where they stood.',
  async handler(args, ctx) {
    return (await decideRetire(args, ctx, { rule: true })).result
  },
  async execute(args, ctx) {
    const { result: fresh, list } = await decideRetire(args, ctx, { rule: false })
    const refusal = recheck(ctx, fresh, RETIRE_MATERIAL)
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { reach: StoredReach; effect: string; totals: { atAmazon: number } }
    const gate = await spendGate(ctx, p.totals.atAmazon > 0, `lifts ${plural(p.totals.atAmazon, 'negative')} at Amazon`)
    if ('refusal' in gate) return notRun(gate.refusal)
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    // The Negatives page's own retire: an archive at Amazon through the queue (the gate in the worker), a Nexus-only row
    // removed; every write and audit row on this change set; a person's approval is his own click (4A).
    const { retireNegatives: retire } = await import('../../advertising/negatives-retire.service.js')
    const out = await retire({ adTargetIds: list.map((r) => r.id), actor: run.actor, retireReason: run.reason, changeSetId: run.changeSetId, manual: run.manual })
    const done = out.outcomes.filter((o) => o.kind === 'retired' || o.kind === 'removed_local')
    const notDone = out.outcomes.filter((o) => o.kind === 'refused' || o.kind === 'failed')
    if (!done.length) return notRun(`Not run: no negative was retired — ${named(notDone.map((o) => `"${o.term}" (${o.reason ?? o.kind})`))}. Nothing changed.`)
    const doneIds = new Set(done.map((o) => o.adTargetId))
    const data = {
      retired: out.summary.retired,
      removedFromNexus: out.summary.removedLocal,
      ...(out.summary.skipped ? { skipped: out.summary.skipped } : {}),
      ...(notDone.length ? { partial: true, notRetired: notDone.length, problems: notDone.slice(0, LINES_SHOWN).map((o) => `"${o.term}": ${o.reason ?? o.kind}`) } : {}),
      reach: p.reach,
      changeSetId: run.changeSetId,
      note: out.summary.retired ? 'Archived in Nexus and queued for Amazon: the write gate runs in the worker. approval-status follows them.' : 'Removed from Nexus only: Amazon never had them.',
    }
    return {
      ok: true,
      data,
      change: {
        before: { changeSetId: run.changeSetId, negatives: list.filter((r) => doneIds.has(r.id)).map((r) => ({ targetId: r.id, kind: r.kind, text: r.text, match: r.match, level: r.level, adGroupId: r.adGroupId, campaignId: r.campaign.id, atAmazon: r.atAmazon })) },
        after: await retiredNow({ before: null, after: { negatives: done.map((o) => ({ targetId: o.adTargetId })) } }),
      },
    }
  },
}

export const ADS_NEGATIVE_TOOLS: AgentTool[] = [addNegativeTargets, retireNegatives]
