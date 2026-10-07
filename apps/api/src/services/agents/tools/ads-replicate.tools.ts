/**
 * ADS AUTONOMY B-1 (Owner 10-07: Claude builds with every one of Nexus's own builders) — replicate-ad-structure: Claude
 * asks to copy the structure of campaigns that run onto another product, with the Replicate Structure builder's own run
 * (ads-blueprint-apply.service.ts: `planFromSource` plans it, `startBlueprintRun` runs it, detached). No create path of
 * its own: the plan, the self-competition gate and every create are the screen's.
 *
 * Born safe whatever the screen chooses (the run's `bornSafe`):
 *   floor      every bid above the 2-cent floor is created AT it, the planned bid remembered; each campaign is flagged
 *              suppressed by the person who asked (`bidsSuppressedBy`) the moment it exists. ENABLED, never paused.
 *   allowlist  born OFF the live-write allowlist: no engine, rule or approved change writes it live until a person
 *              approves set-campaign-live-writes; restore-campaign then gives the planned bids back (each its own kind).
 *   placements not written (a campaign off the allowlist is refused them): kept on the run and listed per campaign, for
 *              set-placement-multipliers once it is live. Replicate creates no rules or hourly plans.
 *   undo       every create carries the approval's change set: archive-ads buildRunId archives what the run made
 *              (permanent at Amazon; a run a deploy killed is found by its change set and marked FAILED first).
 *
 * The Owner's rule 3: the gate keeps only the product's OWN campaigns apart (`evaluatePlan`, PB-5.0) — a keyword the
 * product already buys is skipped or accepted by name (skipTerms / acceptTerms); one another product buys is listed
 * (sharedWithOtherProducts), never blocked, never negated. Rule 2: it creates only; it never moves, lowers or negates a
 * term anywhere else.
 *
 * W4-10 — into another market: Claude translates (no Nexus AI spend). Every keyword and negative keyword the copy carries
 * needs a translation or an explicit keep (a brand term): the plan itself refuses one with neither, at the preview AND in
 * the run (`options.translations`, planned again when it runs), so a keyword the source gains after the approval is never
 * created in the source's language. The preview shows each term from → to. Every keyword of the copy, translated or kept,
 * brand terms too, is checked against what the product's own campaigns in the target market already buy (rule 3, per
 * product: refused until skipped or accepted; another product's is listed, never blocked). A copy into another market
 * NEVER runs by rule (lead decision B): a person always reads Claude's translations — `withinLimits` refuses it and
 * `execute` refuses a rule's decision. Refused, not queued: a market without Amazon limits Nexus has checked,
 * without a production Amazon Ads connection with writes, without a spend ceiling; a product not ACTIVE there with an
 * ASIN; a name taken; category targets (Amazon's category ids are its own in each market). Money in the target market's
 * currency, stated, never converted (another currency needs fixed bids and budgets).
 *
 * Like every ad change tool (ads-change-kit.ts): the preview says where it lands and a refusal is not queued; it runs only
 * as an approved request, as the approver, and refuses when the plan, the market's spend ceiling or where it lands moved.
 * Strategy-bound (create kind): it may run by the business's rule only inside the ads strategy where its products are and
 * this tool's limits — by default it does not (maxCampaigns 0: every copy waits for a person).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { ADS_LIMIT_MARKETS, marketLimitsOf } from '@nexus/shared/ads-market-limits'
import prisma from '../../../db.js'
import { checkAdsWriteGate } from '../../advertising/ads-write-gate.js'
import { SUPPRESSION_FLOOR_CENTS } from '../../advertising/ads-bid-suppression.service.js'
import { adGroupsOutside, marketContext, planFromSource, replicateInFlight, replicateRunCampaigns, startBlueprintRun, type ApplyRequest } from '../../advertising/ads-blueprint-apply.service.js'
import type { ApplyPlan, CopyScope, PlannedCampaign, PlannedTarget, TranslationReport, TranslationRules, ValuePolicy } from '../../ads-core/ads-blueprint-apply.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import { marketCurrency } from '../../pim/market-currency.js'
import { amountLabel, liveReachOf } from './ads-tool-guards.js'
import { approvedRun, canonical, notRun, reachNote, reachRefusal, recheck, requesterOf, storedReach, strategyFactsMoney, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, buildLimitFacts, commonRefusal, limitFactsOf, limitsNote } from './ads-autonomy-kit.js'
import type { AgentTool, FieldPermission, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = 'replicate-ad-structure'
const MAX_SOURCE = 30
const MAX_AD_GROUPS = 100
const MAX_PRODUCTS = 50
const MAX_TERMS = 250
const BID_MAX_CENTS = 10_000
const ID = z.string().trim().min(1).max(64)
const MARKET = z.string().trim().toUpperCase().min(2).max(20)
const TOKEN = z.string().trim().min(1).max(60)
const TERM = z.string().trim().min(1).max(80)

/** W4-10 — one term of a copy into another market: its translation, or keep. */
const translationArg = (what: string) => z.object({
  from: TERM.describe(`the ${what} as the source campaigns hold it (ad-targets shows it)`),
  to: TERM.optional().describe(`the ${what} in market's language, your translation; the source product's name may stay in it: it becomes productToken, as in every copied term`),
  keep: z.literal(true).optional().describe('copy it as it is: a brand or model name shoppers there search for unchanged'),
}).refine((t) => (t.to != null) !== (t.keep === true), { message: 'give to (the translation) or keep: true, one of the two' })

const policyArg = (fixed: string) => z.object({
  mode: z.enum(['copy', 'scale', 'fixed']).describe(`copy: as the source; scale: value is a percent of the source (100 = unchanged); fixed: value is ${fixed}`),
  value: z.number().int().min(1).max(1_000_000).optional().describe('scale: the percent (1–1000); fixed: the amount in minor units'),
})

const input = z.object({
  sourceMarket: MARKET.describe('the Amazon market the source campaigns run in (IT, DE, FR, ES, UK; business-overview lists them)'),
  campaignIds: z.array(ID).min(1).max(MAX_SOURCE).describe('the source: the campaigns whose structure is copied, by Nexus id (campaignId in ad-campaigns), at most 30, all of sourceMarket'),
  adGroupIds: z.array(ID).max(MAX_AD_GROUPS).optional().describe('only these ad groups of the source campaigns (adGroupId in ad-targets); default: every ad group'),
  sourceProductToken: TOKEN.describe("the source product's name as it is written in the source campaigns' names and brand keywords; in the copy it becomes productToken"),
  competitorTokens: z.array(TOKEN).max(20).optional().describe("competitors' brand names in the source keywords: their keywords are gated like category terms"),
  market: MARKET.describe('the Amazon market the copy is created in: the same as sourceMarket, or another (then every keyword and negative keyword needs translations / negativeTranslations)'),
  productToken: TOKEN.describe('what sourceProductToken becomes in the copy: the new product\'s name in names and brand keywords'),
  skus: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_PRODUCTS).describe('the products the copy advertises, by Nexus SKU (one product ad each per ad group), each listed on Amazon in market with an ASIN; a parent is named by its variations'),
  naming: z.object({
    prefix: z.string().max(40).optional().describe('put before every campaign and ad group name'),
    suffix: z.string().max(40).optional().describe('put after every campaign and ad group name'),
    replacements: z.array(z.object({
      from: z.string().min(1).max(60).describe('text in the names (case-insensitive)'),
      to: z.string().max(60).describe('what it becomes'),
    })).max(20).optional().describe('find-and-replace in the names, in order'),
  }).optional().describe('the names of the copy, after productToken is put in: a name already used in market is refused'),
  copy: z.object({
    keywords: z.boolean().optional().describe('copy the keywords (default yes)'),
    negatives: z.boolean().optional().describe('copy the negative keywords and products (default yes)'),
    productTargets: z.boolean().optional().describe('copy the product and category targets (default yes)'),
    autoClauses: z.boolean().optional().describe('copy the auto groups of an Auto campaign (default yes)'),
    bids: z.boolean().optional().describe("copy each keyword's own bid (default yes; no: each keyword takes its ad group's default bid as the source has it, and no bidPolicy applies)"),
    budgets: z.boolean().optional().describe('copy the daily budgets (default yes; no: budgetPolicy fixed gives them)'),
    placements: z.boolean().optional().describe('copy the placement adjustments (default yes): never set at birth, listed for once the copy is live'),
  }).optional().describe('what comes across; default everything'),
  bidPolicy: policyArg("the bid of every keyword, target and ad group, in minor units of market's currency (2–10000)").optional()
    .describe("the copied bids: copy (default), scale or fixed; bids are never converted between currencies: a copy into a market of another currency needs fixed"),
  budgetPolicy: policyArg("each campaign's daily budget, in minor units of market's currency").optional()
    .describe('the copied daily budgets: copy (default), scale or fixed; never converted between currencies: a copy into a market of another currency needs fixed'),
  skipTerms: z.array(TERM).max(MAX_TERMS).optional().describe("keywords the product's own campaigns already buy (the conflicts a refusal names) to leave out of the copy"),
  acceptTerms: z.array(TERM).max(MAX_TERMS).optional().describe('such keywords to create anyway, on the record: the product then bids against itself on them'),
  translations: z.array(translationArg('keyword')).max(MAX_TERMS).optional()
    .describe("a copy into another market: EVERY keyword of the copy, translated by you into market's language ({ from, to }) or kept ({ from, keep: true }); one missing or naming a term the source does not have refuses the copy; at most 250 (copy fewer campaigns at a time when the source has more). Not for a copy in the same market"),
  negativeTranslations: z.array(translationArg('negative keyword')).max(MAX_TERMS).optional()
    .describe('a copy into another market: EVERY negative keyword of the copy, translated or kept, as translations'),
  portfolioId: z.string().trim().min(1).max(64).optional().describe("the Amazon portfolio the copies join (its Amazon portfolio id, of market's Amazon Ads profile); default: none"),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})
type Args = z.infer<typeof input>

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const unique = (values: readonly string[] | undefined) => [...new Set(values ?? [])]
const quoted = (names: readonly string[], max = 5) => `${names.slice(0, max).map((n) => `"${n}"`).join(', ')}${names.length > max ? ` and ${names.length - max} more` : ''}`
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)
const cents = (major: number | null | undefined) => Math.round(Number(major ?? 0) * 100)

const UNDO_WORDS = 'Undo archives every campaign the copy made (archive-ads buildRunId): permanent at Amazon, an archived campaign never comes back.'

/** Every bid a campaign of the plan is created to restore: each ad group's default and each positive's own (the run's fallbacks). */
function plannedBids(c: PlannedCampaign): number[] {
  return c.adGroups.flatMap((g) => [g.defaultBidCents ?? 50, ...g.targets.filter((t) => !t.isNegative).map((t) => t.bidCents ?? g.defaultBidCents ?? 50)])
}

/** What the preview says of each campaign the copy makes (counts; the bids and budget are money). */
function campaignLines(plan: ApplyPlan, renames: Array<{ from: string }>) {
  return plan.campaigns.map((c) => {
    const targets = c.adGroups.flatMap((g) => g.targets)
    const positive = targets.filter((t) => !t.isNegative)
    const kind = (t: { kind: string }) => (t.kind ?? '').toUpperCase()
    return {
      name: c.name,
      from: renames[Number(c.id.slice(1))]?.from ?? null,
      targeting: c.targetingType,
      adGroups: c.adGroups.length,
      dailyBudgetCents: cents(c.dailyBudget),
      startBidCents: Math.max(0, ...plannedBids(c)),
      keywords: positive.filter((t) => kind(t) === 'KEYWORD').length,
      productTargets: positive.filter((t) => kind(t) === 'PRODUCT' || kind(t) === 'CATEGORY').length,
      autoGroups: positive.filter((t) => kind(t) === 'AUTO').length,
      negatives: targets.length - positive.length,
      placementsOnceLive: c.placementBidding.map((p) => ({ placement: p.placement, percentage: p.percentage })),
    }
  })
}

/**
 * The basis a person approves: the source, the products and every campaign the copy makes, in an order the rows' order
 * cannot move. The plan's ids are positions in the source as it was read (its ad groups and targets come back in no fixed
 * order), so they are left out and every list is sorted: a sync that reorders rows changes nothing here; a bid, a budget,
 * a name, a keyword or a clash that changes does. Exported for the tests.
 */
export function planBasis(input: {
  campaignIds: readonly string[]; adGroupIds: readonly string[]; plan: Pick<ApplyPlan, 'campaigns' | 'conflicts'>
  asins: readonly string[]; portfolioId: string | null; currency: string
}): string {
  const sorted = (items: readonly unknown[]) => items.map((x) => canonical(x)).sort()
  const target = (t: PlannedTarget) => ({
    expression: t.expression.toLowerCase(), expressionType: (t.expressionType ?? '').toUpperCase(), kind: (t.kind ?? '').toUpperCase(),
    bidCents: t.bidCents ?? null, isNegative: t.isNegative, negativeLevel: t.negativeLevel ?? null, autoClause: t.autoClause ?? null,
  })
  const campaigns = input.plan.campaigns.map((c) => ({
    name: c.name, role: c.role, targetingType: c.targetingType, dailyBudget: c.dailyBudget, biddingStrategy: c.biddingStrategy,
    placementBidding: sorted(c.placementBidding.map((p) => ({ placement: p.placement, percentage: p.percentage }))),
    adGroups: sorted(c.adGroups.map((g) => ({ name: g.name, defaultBidCents: g.defaultBidCents, asins: [...g.asins].sort(), targets: sorted(g.targets.map(target)) }))),
  }))
  const conflicts = input.plan.conflicts.map((c) => ({ expression: c.expression.toLowerCase(), resolution: c.resolution, existing: c.existing.map((e) => e.campaignId).sort() }))
  return hash({
    source: [[...input.campaignIds].sort(), [...input.adGroupIds].sort()], campaigns: sorted(campaigns), conflicts: sorted(conflicts),
    asins: [...input.asins].sort(), portfolio: input.portfolioId, currency: input.currency,
  })
}

/**
 * W4-10 — why a copy into another market is refused for its words: every term with neither a translation nor a keep, and
 * every translation that names no term of the source, all of them listed (up to 60 a side), so one answer fixes them.
 */
function translationRefusal(t: TranslationReport, market: string): string {
  const list = (xs: Array<{ term: string }>) => `${xs.slice(0, 60).map((x) => `"${x.term}"`).join(', ')}${xs.length > 60 ? ` and ${xs.length - 60} more` : ''}`
  const sides = (xs: Array<{ term: string; negative: boolean }>) => [
    ...(xs.some((x) => !x.negative) ? [`keywords ${list(xs.filter((x) => !x.negative))}`] : []),
    ...(xs.some((x) => x.negative) ? [`negative keywords ${list(xs.filter((x) => x.negative))}`] : []),
  ].join('; ')
  const parts = [`Not queued: a copy into ${market} needs every keyword and negative keyword in ${market}'s language.`]
  if (t.missing.length) {
    parts.push(`${plural(t.missing.length, 'term')} ${t.missing.length === 1 ? 'has' : 'have'} neither a translation nor a keep (${sides(t.missing)}): add each to translations (keywords) or negativeTranslations, as { from, to } with your translation or { from, keep: true } for a brand or model name shoppers there search for unchanged.`)
  }
  if (t.unused.length) {
    parts.push(`${plural(t.unused.length, 'translation')} ${t.unused.length === 1 ? 'names a term' : 'name terms'} the source does not have (${sides(t.unused)}): check each against the source's own text (ad-targets).`)
  }
  return parts.join(' ')
}

/** W4-10 — the preview's words of a copy into another market: each term from → to, the keywords apart from the negatives. */
function translationLines(t: TranslationReport, sourceMarket: string, market: string) {
  const side = (negative: boolean) => t.terms.filter((x) => x.negative === negative).map((x) => ({ from: x.from, to: x.to, ...(x.kept ? { kept: true } : {}) }))
  const count = (negative: boolean) => {
    const of = t.terms.filter((x) => x.negative === negative)
    return { translated: of.filter((x) => !x.kept).length, kept: of.filter((x) => x.kept).length }
  }
  return {
    from: sourceMarket,
    to: market,
    counts: { keywords: count(false), negatives: count(true) },
    keywords: side(false),
    negatives: side(true),
    ...(t.merged.length ? { merged: t.merged } : {}),
    note: `Every keyword and negative keyword as you translated it into ${market}'s language (kept: copied as you spelled it, the product's name swapped in where it is a word of its own). `
      + `Every keyword of the copy, translated or kept, brand terms too, was checked against what the product's own campaigns in ${market} already buy. `
      + 'A copy into another market never runs by rule: a person always reads these translations.',
  }
}

/** W4-10 — the counts in words: "3 keywords translated, 1 kept; 1 negative keyword translated". */
function countWords(c: ReturnType<typeof translationLines>['counts']): string {
  const side = (n: { translated: number; kept: number }, word: string) =>
    `${plural(n.translated, word)} translated${n.kept ? `, ${n.kept} kept` : ''}`
  return `${side(c.keywords, 'keyword')}; ${side(c.negatives, 'negative keyword')}`
}

/** A value policy as the run takes it: a scaled one in percent, a fixed bid in cents, a fixed budget in major units; or why not. */
function policyOf(p: Args['bidPolicy'], kind: 'bid' | 'budget'): ValuePolicy | { refusal: string } | undefined {
  if (!p || p.mode === 'copy') return p ? { mode: 'copy' } : undefined
  if (p.value == null) return { refusal: `${kind}Policy ${p.mode} needs a value.` }
  if (p.mode === 'scale') return p.value <= 1000 ? { mode: 'scale', value: p.value } : { refusal: `${kind}Policy scale is a percent from 1 to 1000.` }
  if (kind === 'bid') return p.value >= SUPPRESSION_FLOOR_CENTS && p.value <= BID_MAX_CENTS ? { mode: 'fixed', value: p.value } : { refusal: `bidPolicy fixed is a bid from ${SUPPRESSION_FLOOR_CENTS} to ${BID_MAX_CENTS} minor units.` }
  return { mode: 'fixed', value: p.value / 100 }
}

/** The copy scope as the run takes it: only what was said (an unsaid part is copied, as on the screen). */
function scopeOf(copy: NonNullable<Args['copy']>): Partial<CopyScope> {
  const said: Partial<CopyScope> = {
    keywords: copy.keywords, negatives: copy.negatives, productTargets: copy.productTargets, autoClauses: copy.autoClauses,
    bids: copy.bids, budgets: copy.budgets, placementBidding: copy.placements,
  }
  return Object.fromEntries(Object.entries(said).filter(([, v]) => typeof v === 'boolean')) as Partial<CopyScope>
}

/** The copy, planned and judged: its preview, and the request `execute` hands to the run. */
async function replicatePreview(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'> = {}): Promise<{ result: ToolResult; request?: ApplyRequest }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult })
  const parsed = input.safeParse(raw)
  if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '))
  const a: Args = parsed.data

  // The source first: a campaign of another business reads as not found, before anything else is said.
  const named = await prisma.campaign.findMany({
    where: { id: { in: unique(a.campaignIds) } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, marketplace: true, adProduct: true, status: true, bidsSuppressedAt: true },
  })
  const missing = unique(a.campaignIds).filter((id) => !named.some((s) => s.id === id))
  if (missing.length) return refuse(`Source campaign${missing.length === 1 ? '' : 's'} not found in this business: ${missing.slice(0, 10).join(', ')}.`)
  // An archived campaign serves nothing: it is left out of the copy (said), as its archived keywords and targets are.
  const archived = named.filter((s) => String(s.status) === 'ARCHIVED').map((s) => s.name)
  const sources = named.filter((s) => String(s.status) !== 'ARCHIVED')
  if (!sources.length) return refuse(`Not queued: ${quoted(archived)} ${archived.length === 1 ? 'is' : 'are'} archived: name campaigns that run (an archived campaign's structure is not copied).`)
  const ids = sources.map((s) => s.id)
  const names = sources.map((s) => s.name)
  const elsewhere = sources.filter((s) => s.marketplace !== a.sourceMarket)
  if (elsewhere.length) return refuse(`Not queued: ${quoted(elsewhere.map((s) => `${s.name} (${s.marketplace ?? 'no market'})`))} ${elsewhere.length === 1 ? 'does' : 'do'} not run in ${a.sourceMarket} (sourceMarket): name campaigns of one market.`)
  const notSp = sources.filter((s) => (s.adProduct ?? 'SPONSORED_PRODUCTS') !== 'SPONSORED_PRODUCTS')
  if (notSp.length) return refuse(`Not queued: Replicate copies Sponsored Products campaigns only; ${quoted(notSp.map((s) => s.name))} ${notSp.length === 1 ? 'is' : 'are'} not.`)
  const adGroupIds = unique(a.adGroupIds)
  const lost = await adGroupsOutside(ids, adGroupIds)
  if (lost.length) return refuse(`Ad group${lost.length === 1 ? '' : 's'} not found in the source campaigns: ${lost.slice(0, 10).join(', ')}.`)

  // W4-10 — another market's language: the translations are Claude's, one per term; in the same market there are none.
  const crossMarket = a.market !== a.sourceMarket
  const translations: TranslationRules = { keywords: a.translations ?? [], negatives: a.negativeTranslations ?? [] }
  if (!crossMarket && translations.keywords.length + translations.negatives.length) {
    return refuse(`Not queued: translations are for a copy into another market; in ${a.market} the source's keywords are copied as they are (leave translations and negativeTranslations out).`)
  }
  // A term is one term whatever its case and spacing ("Moto  Jacket" is "moto jacket"), as the planner matches it.
  const termKey = (term: string) => term.trim().replace(/\s+/g, ' ').toLowerCase()
  for (const [name, list] of [['translations', translations.keywords], ['negativeTranslations', translations.negatives]] as const) {
    const said = new Map<string, number>()
    for (const t of list) said.set(termKey(t.from), (said.get(termKey(t.from)) ?? 0) + 1)
    const twice = [...new Map(list.filter((t) => (said.get(termKey(t.from)) ?? 0) > 1).map((t) => [termKey(t.from), t.from])).values()]
    if (twice.length) return refuse(`Not queued: ${name} names ${quoted(twice)} more than once: give each term one translation.`)
  }

  // W4-10 — the market itself takes the copy: Amazon's limits there are checked in Nexus, and its Amazon Ads connection
  // is a production one with writes on (else every campaign would be made in Nexus only and never reach Amazon).
  if (!marketLimitsOf(a.market)) {
    return refuse(`Not queued: ${quoted(names)} cannot be copied into ${a.market}: Nexus has no checked Amazon limits there (the lowest and highest bid and budget Amazon takes), so no copy is made there. Markets with checked limits: ${ADS_LIMIT_MARKETS.join(', ')}.`)
  }
  if (!(await marketContext(a.market)).writable) {
    return refuse(`Not queued: ${quoted(names)} cannot be copied into ${a.market}: it has no production Amazon Ads connection with writes switched on, so the copy would be made in Nexus only and never reach Amazon. Connecting a profile there and switching its writes on stays with a person in Nexus (Amazon Ads connections).`)
  }

  // The products: each by SKU, listed on Amazon in the market with an ASIN (a product ad advertises an ASIN).
  const skus = unique(a.skus)
  const products = await prisma.product.findMany({ where: { sku: { in: skus }, deletedAt: null }, select: { id: true, sku: true, amazonAsin: true, isParent: true } })
  const unknown = skus.filter((sku) => !products.some((p) => p.sku === sku))
  if (unknown.length) return refuse(`SKU not found: ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? ` and ${unknown.length - 10} more` : ''}.`)
  const listings = await prisma.channelListing.findMany({
    where: { productId: { in: products.map((p) => p.id) }, channel: 'AMAZON', marketplace: a.market, listingStatus: { not: 'ENDED' } },
    select: { productId: true, listingStatus: true },
  })
  const problems = products.flatMap((p) => {
    if (p.isParent) return [`${p.sku} is a parent: name its variations (a parent ASIN is not advertised)`]
    if (!p.amazonAsin) return [`${p.sku} has no ASIN`]
    const statuses = unique(listings.filter((l) => l.productId === p.id).map((l) => l.listingStatus))
    if (!statuses.length) return [`${p.sku} is not listed on Amazon in ${a.market}`]
    // W4-10 — a copy into another market advertises only what sells there now.
    if (crossMarket && !statuses.includes('ACTIVE')) return [`${p.sku} is listed on Amazon in ${a.market} but not active there (${statuses.join(', ').toLowerCase()})`]
    return []
  })
  if (problems.length) return refuse(`Not queued: the copy of ${quoted(names)} would have nothing to advertise for ${problems.length === 1 ? 'one product' : plural(problems.length, 'product')} — ${problems.join('; ')}.`)
  const asins = unique(products.map((p) => p.amazonAsin!))

  // Money: in the destination market's own currency, never converted; inside the market's spend ceiling.
  let currency: string, sourceCurrency: string
  try {
    currency = await marketCurrency('AMAZON', a.market)
    sourceCurrency = await marketCurrency('AMAZON', a.sourceMarket)
  } catch (e) { return refuse((e as Error).message) }
  const bidPolicy = policyOf(a.bidPolicy, 'bid')
  const budgetPolicy = policyOf(a.budgetPolicy, 'budget')
  for (const p of [bidPolicy, budgetPolicy]) if (p && 'refusal' in p) return refuse(p.refusal)
  // Replicate's own rule: with copy.bids off every keyword takes its ad group's default AS THE SOURCE HAS IT — a bid
  // policy is not applied — so the two are never asked together (one of them would be silently ignored).
  if (a.copy?.bids === false && a.bidPolicy && a.bidPolicy.mode !== 'copy') {
    return refuse('Not queued: copy.bids false keeps each ad group\'s default bid as the source has it and applies no bidPolicy: give one or the other.')
  }
  if (a.copy?.budgets === false && a.budgetPolicy?.mode !== 'fixed') {
    return refuse('Not queued: copy.budgets false needs budgetPolicy fixed (each campaign\'s own daily budget); without it the source\'s budgets would be copied anyway.')
  }
  if (currency !== sourceCurrency && (a.bidPolicy?.mode !== 'fixed' || a.budgetPolicy?.mode !== 'fixed' || a.copy?.bids === false)) {
    return refuse(`Not queued: the source campaigns are in ${sourceCurrency} (${a.sourceMarket}) and the copy would be in ${currency} (${a.market}): bids and budgets are never converted. Give the copy its own in ${currency} (bidPolicy and budgetPolicy fixed, copy.bids not off).`)
  }
  const ceiling = await prisma.adSpendCeiling.findFirst({
    where: { grain: 'MARKET', scopeId: a.market, enabled: true, dailyCapCents: { not: null } },
    select: { label: true, dailyCapCents: true },
  })
  if (!ceiling) return refuse(`Set a spend ceiling for this market first: ${a.market} has no daily spend ceiling, and Claude copies campaigns only into a market that has one (Ads → spend ceilings).`)

  // The portfolio the copies join: one of the market's own Amazon Ads profile (a Nexus-only portfolio Amazon never holds is refused).
  let portfolio: { portfolioId: string; name: string } | null = null
  if (a.portfolioId) {
    const profiles = (await prisma.amazonAdsConnection.findMany({ where: { marketplace: a.market, isActive: true }, select: { profileId: true } })).map((c) => c.profileId)
    const row = a.portfolioId.startsWith('local-pf-') ? null
      : await prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: a.portfolioId, profileId: { in: profiles } }, select: { externalPortfolioId: true, name: true } })
    if (!row) return refuse(`Portfolio ${a.portfolioId} not found in ${a.market}'s Amazon Ads profile: name one Amazon holds there, or none.`)
    portfolio = { portfolioId: row.externalPortfolioId, name: row.name }
  }

  // The plan: Replicate's own, from the source as it is now, judged by its gate (rule 3: only the product's own campaigns block).
  const request: ApplyRequest = {
    // Archived keywords and targets of the source serve nothing: they are not copied.
    source: { campaignIds: ids, ...(adGroupIds.length ? { adGroupIds } : {}), marketplace: a.sourceMarket, excludeArchivedTargets: true },
    sourceProductToken: a.sourceProductToken,
    ...(a.competitorTokens?.length ? { competitorTokens: a.competitorTokens } : {}),
    target: { productToken: a.productToken, asins },
    marketplace: a.market,
    ...(portfolio ? { portfolioId: portfolio.portfolioId } : {}),
    options: {
      skipSharedTargets: unique(a.skipTerms), acceptSharedTargets: unique(a.acceptTerms),
      ...(a.naming ? { naming: a.naming } : {}),
      ...(a.copy ? { include: scopeOf(a.copy) } : {}),
      ...(bidPolicy ? { bidPolicy: bidPolicy as ValuePolicy } : {}),
      ...(budgetPolicy ? { budgetPolicy: budgetPolicy as ValuePolicy } : {}),
      // W4-10 — into another market: always given (an empty list refuses every term), so the run plans them again too.
      ...(crossMarket ? { translations } : {}),
    },
    launchMode: 'floor',
  }
  let planned: Awaited<ReturnType<typeof planFromSource>>
  try {
    planned = await planFromSource({ source: request.source!, sourceProductToken: a.sourceProductToken, competitorTokens: request.competitorTokens, target: request.target, marketplace: a.market, options: request.options })
  } catch (e) { return refuse(`Not queued: ${(e as Error).message}.`) }
  const plan = planned.plan
  // W4-10 — translations first: the clashes are judged on the translated text, so a missing one is said before them.
  if (plan.translation && (plan.translation.missing.length || plan.translation.unused.length)) return refuse(translationRefusal(plan.translation, a.market))
  if (!plan.allowed) {
    const own = plan.conflicts.filter((c) => c.resolution === 'UNRESOLVED')
    const hint = own.length
      ? ` The product's own campaigns already buy ${own.slice(0, 10).map((c) => `"${c.expression}" (${c.existing.map((e) => `"${e.campaignName}"`).join(', ')})`).join('; ')}`
        + `${own.length > 10 ? ` and ${own.length - 10} more` : ''}: name each in skipTerms (left out of the copy) or acceptTerms (created anyway, on the record).`
      : ''
    return refuse(`Not queued: Replicate's gate refuses this copy — ${plan.blockers.join(' ')}${hint}`)
  }
  if (!plan.campaigns.length) return refuse(`Nothing to copy: with what you left out, no campaign of ${quoted(names)} keeps an ad group with targeting.`)
  // W4-10 — Amazon's category ids are its own in each market: one of the source's names nothing (or something else) there.
  const categories = crossMarket ? plan.campaigns.flatMap((c) => c.adGroups.flatMap((g) => g.targets.filter((t) => !t.isNegative && (t.kind ?? '').toUpperCase() === 'CATEGORY'))) : []
  if (categories.length) {
    return refuse(`Not queued: the copy carries ${plural(categories.length, 'category target')}, and Amazon's category ids are its own in each market: ${a.sourceMarket}'s mean nothing in ${a.market}. Leave product and category targets out (copy.productTargets false) and target ${a.market}'s own categories once the copy runs.`)
  }

  const dailyBudgetCents = cents(plan.totals.dailyBudgetTotal)
  const cap = ceiling.dailyCapCents as number
  if (dailyBudgetCents > cap) return refuse(`Its daily budgets add up to ${amountLabel(dailyBudgetCents, currency)}, above ${ceiling.label}'s spend ceiling of ${amountLabel(cap, currency)} a day.`)
  const highestPlannedBidCents = Math.max(0, ...plan.campaigns.flatMap(plannedBids))

  // Amazon's own range in the market, names and bids above a budget: the checks every builder's launch runs (CC-13/14).
  const { launchChecks } = await import('../../advertising/ads-launch-checks.service.js')
  const checks = await launchChecks({
    market: a.market, portfolioId: portfolio?.portfolioId ?? null, productCount: asins.length,
    campaigns: plan.campaigns.map((c) => ({ name: c.name, budgetCents: cents(c.dailyBudget), bidsCents: plannedBids(c) })),
  })
  if (checks.refusals.length) return refuse(`Not queued: ${checks.refusals.join(' ')}`)

  // One run per product per market: one still running answers for it (a run of Claude's that stopped is settled at execute).
  const flying = await replicateInFlight(a.market, a.productToken)
  if (flying && !flying.stopped) return refuse(`A copy for ${a.productToken} in ${a.market} is running (run ${flying.applicationId}): follow it with approval-status, then ask again.`)

  // Where it lands: a creation names no campaign yet, so the gate is asked as the launch asks it, against the largest budget.
  const largestBudgetCents = Math.max(0, ...plan.campaigns.map((c) => cents(c.dailyBudget)))
  const reach = liveReachOf(await checkAdsWriteGate({ marketplace: a.market, payloadValueCents: largestBudgetCents }))
  if (reach.reach === 'refused') return refuse(reachRefusal(reach))
  const stored = storedReach(reach)
  // The facts the business's rule is judged on: the new daily budgets, where its products are in the strategy (create kind).
  const facts = await buildLimitFacts({
    tool: TOOL,
    items: [{ entity: { kind: 'products', market: a.market, productIds: products.map((p) => p.id) }, change: { field: 'dailyBudget', fromCents: null, toCents: dailyBudgetCents } }],
    approvalId: ctx.approvalId ?? null,
  })
  const newMarket = !(await prisma.campaign.findFirst({ where: { marketplace: a.market }, select: { id: true } }))
  const floored = sources.filter((s) => s.bidsSuppressedAt).map((s) => s.name)
  const accepted = plan.conflicts.filter((c) => c.resolution === 'ACCEPTED').map((c) => c.expression)
  const campaigns = campaignLines(plan, planned.renames)
  const placements = campaigns.filter((c) => c.placementsOnceLive.length).length
  const floor = SUPPRESSION_FLOOR_CENTS
  const t = plan.totals
  const words = plan.translation ? translationLines(plan.translation, a.sourceMarket, a.market) : null
  // W4-10 — the money's currency, said: the target market's own, never a conversion of the source's.
  const currencyNote = currency === sourceCurrency
    ? `Every bid and budget is in ${currency}, the currency of ${a.market}: the source's ${sourceCurrency} amounts carry over as numbers (as bidPolicy and budgetPolicy say), never converted.`
    : `Every bid and budget is in ${currency}, the currency of ${a.market}, as you gave them (bidPolicy and budgetPolicy fixed): the source's ${sourceCurrency} amounts are not used, and nothing is converted.`
  // W4-10 — names that still say the source market, and product targets (ASINs) picked in the source market.
  const sourceCode = a.sourceMarket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const saysSource = new RegExp(`(^|[^A-Za-z])${sourceCode}([^A-Za-z]|$)`)
  const marked = crossMarket ? campaigns.filter((c) => saysSource.test(c.name)).map((c) => c.name) : []
  const asinTargets = crossMarket ? plan.campaigns.reduce((n, c) => n + c.adGroups.reduce((m, g) => m + g.targets.filter((x) => (x.kind ?? '').toUpperCase() === 'PRODUCT').length, 0), 0) : 0
  const effect = `Copies the structure of ${quoted(names)} (${a.sourceMarket}) onto ${a.productToken} in ${a.market} with Replicate Structure's own run`
    + `${words ? `, every keyword and negative keyword in ${a.market}'s language as you translated it (${countWords(words.counts)})` : ''}: `
    + `${plural(t.campaigns, 'Sponsored Products campaign')}, ${plural(t.adGroups, 'ad group')}, ${plural(t.positives, 'keyword or target')} and ${plural(t.negatives, 'negative')}, `
    + `advertising ${plural(asins.length, 'ASIN')}, ${amountLabel(dailyBudgetCents, currency)} of daily budget in all. `
    + `Each is born ENABLED with every bid at the ${floor}-cent floor (the planned bids remembered; suppressed by the person who asked, never paused), off the live-write allowlist`
    + `${placements ? `, without its placements (${plural(placements, 'campaign')} ${placements === 1 ? 'has' : 'have'} some: set once it is live)` : ''} and with no rules: `
    + 'it serves next to nothing (not nothing) until a person approves set-campaign-live-writes and restore-campaign for it, each a request of its own.'
  const warnings = [
    ...(archived.length ? [`${quoted(archived)} ${archived.length === 1 ? 'is' : 'are'} archived: left out of the copy.`] : []),
    ...plan.warnings,
    ...checks.warnings,
    ...(floored.length ? [`${quoted(floored)} ${floored.length === 1 ? 'is' : 'are'} at the floor now: the copy plans the bids ${floored.length === 1 ? 'it holds' : 'they hold'} (the floor), not the ones ${floored.length === 1 ? 'it' : 'they'} had before; bidPolicy fixed plans others.`] : []),
    ...(marked.length ? [`${quoted(marked)} still ${marked.length === 1 ? 'says' : 'say'} ${a.sourceMarket} in ${marked.length === 1 ? 'its name' : 'their names'}: naming (prefix, suffix or replacements) renames ${marked.length === 1 ? 'it' : 'them'} if ${marked.length === 1 ? 'it' : 'they'} should say ${a.market}.`] : []),
    ...(asinTargets ? [`${plural(asinTargets, 'product target')} (ASINs, negative ones included) ${asinTargets === 1 ? 'was' : 'were'} picked in ${a.sourceMarket}: Amazon refuses one that is not sold in ${a.market}, and the run lists it.`] : []),
    ...(flying?.stopped ? [`An earlier copy for ${a.productToken} in ${a.market} (run ${flying.applicationId}) stopped without finishing: this one marks it FAILED. What it made can be archived (archive-ads buildRunId ${flying.applicationId}).`] : []),
  ]
  return {
    request,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        builder: 'Replicate Structure',
        source: { market: a.sourceMarket, campaigns: sources.map((s) => ({ campaignId: s.id, name: s.name })), adGroups: adGroupIds.length || null, productToken: a.sourceProductToken },
        market: a.market,
        currency,
        currencyNote,
        productToken: a.productToken,
        products: products.map((p) => ({ sku: p.sku, productId: p.id, asin: p.amazonAsin })),
        campaigns,
        totals: { campaigns: t.campaigns, adGroups: t.adGroups, positives: t.positives, negatives: t.negatives, productAds: t.productAds },
        dailyBudgetCents,
        highestPlannedBidCents,
        excluded: plan.excluded,
        ...(words ? { translation: words } : {}),
        ...(accepted.length ? { acceptedTerms: accepted, acceptedNote: `${plural(accepted.length, 'keyword')} the product's own campaigns already buy ${accepted.length === 1 ? 'is' : 'are'} created anyway: the product bids against itself on ${accepted.length === 1 ? 'it' : 'them'}.` } : {}),
        sharedWithOtherProducts: plan.sharedWithOtherProducts.slice(0, 25),
        ...(plan.sharedWithOtherProducts.length ? { sharedNote: `${plural(plan.sharedWithOtherProducts.length, 'keyword')} of the copy ${plan.sharedWithOtherProducts.length === 1 ? 'is' : 'are'} also bought by other products' campaigns: allowed, never negated across products.` } : {}),
        portfolio,
        startsSuppressed: { floorCents: floor, by: 'the person who asked', note: `Every bid above ${floor} cents starts at the ${floor}-cent floor and the bid planned is remembered: restore-campaign puts them back.` },
        liveWrites: false,
        placements: 'not set at birth (a campaign off the live-write allowlist is refused them): each campaign\'s are listed (placementsOnceLive) for set-placement-multipliers once it is live',
        rules: 'none: Replicate creates no rules or hourly plans',
        ceiling: { label: ceiling.label, dailyCapCents: cap },
        ...(newMarket ? { newMarket: true, newMarketNote: `NEW MARKET: the first campaign in ${a.market}.` } : {}),
        warnings,
        basis: planBasis({ campaignIds: ids, adGroupIds, plan, asins, portfolioId: portfolio?.portfolioId ?? null, currency }),
        reach: stored,
        reachNote: reachNote(stored),
        effect,
        nextSteps: [
          'approval-status (approvalId): follow the run; it answers its id at once and runs on its own',
          'set-campaign-live-writes (enabled: true), per campaign: only an allowlisted campaign takes an approved change live',
          'restore-campaign, per campaign: puts the planned bids back — the campaign starts spending',
          'set-placement-multipliers: the placements listed per campaign, once it is live',
        ],
        undoNote: UNDO_WORDS,
        limitFacts: facts,
        limitsNote: limitsNote(facts),
      },
    },
  }
}

/**
 * Claude's limits for a copy run by rule: the kit's (one request), and the most campaigns, daily budget and highest planned
 * bid one copy may create without a person — 0 by default: every copy waits for a person until he types a number — and
 * the markets.
 */
const REPLICATE_LIMITS = adKitLimits({ maxItems: 1 }, {
  maxCampaigns: z.number().int().min(0).max(MAX_SOURCE).default(0).describe('the most campaigns one copy may create by rule; 0 = every copy waits for a person'),
  maxDailyBudgetCents: z.number().int().min(0).default(0).describe("the most daily budget (all its campaigns, minor units of the market's currency) one copy may create by rule; 0 = every copy waits for a person"),
  maxBidCents: z.number().int().min(0).default(0).describe("the highest planned bid (given back by restore-campaign) a copy created by rule may hold, in minor units of the market's currency"),
  markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([]).describe('the markets a copy may be created in by rule (empty = every market)'),
})

/** W4-10 — a copy into another market than its source's (its preview carries the translations); false for any other preview. */
function crossMarketCopy(preview: unknown): boolean {
  const p = (preview ?? {}) as { source?: { market?: unknown }; market?: unknown; translation?: unknown }
  return !!p.translation || (typeof p.source?.market === 'string' && typeof p.market === 'string' && p.source.market !== p.market)
}

/** replicate-ad-structure's own checks around the kit's (C1–C7, the month). Pure. */
function replicateRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as {
    action?: string; market?: string; currency?: string; newMarket?: boolean; campaigns?: unknown[]; dailyBudgetCents?: number; highestPlannedBidCents?: number; acceptedTerms?: string[]
    source?: { market?: string }
  }
  if (p.action !== TOOL) return 'there is no preview of this copy to check; a person decides'
  // W4-10, lead decision B — a copy into another market carries Claude's translations: a person always reads them.
  if (crossMarketCopy(preview)) return `it copies into another market (${p.source?.market ?? '?'} → ${p.market ?? '?'}) with Claude's translations: a person always reads them, so it never runs by rule`
  const markets = (limits.markets as string[] | undefined) ?? []
  if (p.market && markets.length && !markets.includes(p.market)) return `this business lets a copy run by rule only in ${markets.join(', ')}`
  // Rule 3 — a clash with the product's own campaigns, accepted on the record, is a person's decision.
  if (p.acceptedTerms?.length) return `it creates ${plural(p.acceptedTerms.length, 'keyword')} the product's own campaigns already buy (accepted): the product would bid against itself; a person decides`
  const common = commonRefusal(preview, limits)
  if (common) return common
  if (p.newMarket) return `it creates the first campaigns in ${p.market}: a person decides a new market`
  const currency = p.currency ?? 'EUR'
  const n = p.campaigns?.length ?? 0
  const maxCampaigns = typeof limits.maxCampaigns === 'number' ? limits.maxCampaigns : 0
  if (n > maxCampaigns) return `it creates ${plural(n, 'campaign')}, more than the ${maxCampaigns} this tool's limits let a copy create by rule${maxCampaigns === 0 ? ' (0: every copy waits for a person)' : ''}; a person decides`
  const budget = typeof limits.maxDailyBudgetCents === 'number' ? limits.maxDailyBudgetCents : 0
  if ((p.dailyBudgetCents ?? 0) > budget) return `its daily budgets add up to ${amountLabel(p.dailyBudgetCents ?? 0, currency)}, more than the ${amountLabel(budget, currency)} this tool's limits let a copy create by rule; a person decides`
  const highest = p.highestPlannedBidCents ?? 0
  const bid = typeof limits.maxBidCents === 'number' ? limits.maxBidCents : 0
  if (highest > bid) return `its highest planned bid ${amountLabel(highest, currency)} is above the ${amountLabel(bid, currency)} this tool's limits allow by rule; a person decides`
  for (const scope of Object.values(limitFactsOf(preview)?.scopes ?? {})) {
    const max = scope.limits.maxBidCents
    if (max == null || !scope.sources.maxBid || highest <= max) continue
    return `its highest planned bid ${amountLabel(highest, currency)} is above the highest bid ${amountLabel(max, currency)} (${strategyWords(scope.sources.maxBid)}); a person decides`
  }
  return null
}

/** Undo: archive-ads of every campaign the run made (buildRunId), a new request a person approves; permanent at Amazon. */
export const REPLICATE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { applicationId?: string }
    if (!after.applicationId) return change.after
    // It stands while a campaign it made is not archived (one still running stands too: archive-ads waits for it).
    const run = await replicateRunCampaigns(after.applicationId)
    const standing = !!run && ('refusal' in run ? /still running/.test(run.refusal) : run.campaignIds.length > 0)
    return standing ? { applicationId: after.applicationId } : { applicationId: after.applicationId, archived: true }
  },
  request(change) {
    const applicationId = (change.after as { applicationId?: unknown } | null)?.applicationId
    return typeof applicationId === 'string' && applicationId
      ? { tool: 'archive-ads', args: { buildRunId: applicationId, why: 'undo of a Replicate copy Claude asked for: archived for good' } }
      : { refusal: 'This change does not name the run it started.' }
  },
}

const MONEY_KEYS = ['dailyBudgetCents', 'highestPlannedBidCents', 'startBidCents', 'dailyCapCents']

const replicateAdStructure: AgentTool = {
  name: TOOL,
  title: 'Replicate an ad structure',
  input,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  restrictedFields: {
    ...strategyFactsMoney(),
    ...Object.fromEntries(MONEY_KEYS.map((key) => [key, FIELDS.financialsAdspendView])),
  } as Readonly<Record<string, FieldPermission>>,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  // Undo archives what it made: the campaigns stop for good, what they spent stays spent.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: REPLICATE_LIMITS,
  withinLimits: replicateRefusal,
  undo: REPLICATE_UNDO,
  description:
    'Copy the structure of Amazon Sponsored Products campaigns that run (campaignIds in sourceMarket) onto another product '
    + '(skus; productToken replaces sourceProductToken in names and brand keywords), in the same market or another (the '
    + 'same product into another market too: productToken as sourceProductToken), with '
    + "Nexus's Replicate Structure builder: its own plan and run, the same campaigns, ad groups, keywords, targets, auto "
    + 'groups and negatives (naming, copy, bidPolicy and budgetPolicy shape them). A person approves it in Nexus, unless the '
    + 'business lets it run by its rule inside its limits and the ads strategy (by default it does not: maxCampaigns 0; '
    + 'into another market it never does). '
    + 'It is born safe: every campaign ENABLED with every bid at the 2-cent floor (the planned bids remembered; suppressed '
    + 'by the person who asked, never paused), off the live-write allowlist, without its placements and with no rules, so '
    + 'it spends next to nothing until set-campaign-live-writes and restore-campaign are approved for it, each a kind of '
    + 'its own; its placements are listed for set-placement-multipliers once it is live. Only the product\'s own '
    + 'campaigns are kept apart: a keyword it already buys is refused until it is named in skipTerms or acceptTerms; one '
    + 'another product buys is listed, never blocked. Into another market you translate: every keyword (translations) and '
    + 'negative keyword (negativeTranslations) needs { from, to } or { from, keep: true } for a brand term; the preview '
    + 'shows each term from → to; every keyword of the copy, translated or kept, is checked against what the product\'s '
    + 'own campaigns in that market already buy; and a copy into another market never runs by rule (a person always reads '
    + 'the translations). Refused, and '
    + 'not queued, when a source campaign or SKU is not found, the market has no Amazon limits Nexus has checked or no '
    + 'production Amazon Ads connection with writes, a product is not listed on Amazon there with an ASIN (ACTIVE, for '
    + 'another market), the market has no spend ceiling or the budgets are above it, a term has no translation, a copy into '
    + 'another market carries category targets (Amazon\'s category ids differ per market), a name is taken, the currencies '
    + 'differ without fixed bids and budgets (never converted), Amazon would refuse a bid or budget, a copy for the product '
    + 'is running, or Amazon\'s write gate would refuse it. It runs on its own once approved: approval-status follows it. '
    + 'Undo archives every campaign it made (archive-ads buildRunId): permanent at Amazon.',
  async handler(args, ctx) {
    return (await replicatePreview(args, ctx)).result
  },
  async execute(args, ctx) {
    const fresh = await replicatePreview(args, ctx)
    if (!fresh.result.ok || !fresh.request) return notRun(`Not run: ${fresh.result.error ?? 'it is no longer a valid copy'}`)
    const refusal = recheck(ctx, fresh.result, ['basis', 'ceiling', 'reach'])
    if (refusal) return notRun(refusal)
    // W4-10, lead decision B — whatever the limits say: a rule never decides a copy into another market.
    if (ctx.decidedVia === 'auto' && crossMarketCopy(fresh.result.preview)) {
      return notRun("Not run: a copy into another market carries Claude's translations, and a person always reads them: it never runs by rule. Ask for it again; a person approves it.")
    }
    const preview = fresh.result.preview as { reach: StoredReach; effect: string; market: string; productToken: string }
    const run = approvedRun(ctx, String(args.why ?? '') || preview.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const requester = await requesterOf(ctx, run.actor)
    let started: Awaited<ReturnType<typeof startBlueprintRun>>
    try {
      started = await startBlueprintRun({ ...fresh.request, launchMode: 'floor', actor: run.actor, bornSafe: { by: requester, changeSetId: run.changeSetId } })
    } catch (e) { return notRun(`Not run: ${(e as Error).message}`) }
    if (started.alreadyRunning) return notRun(`Not run: a copy for ${preview.productToken} in ${preview.market} is already running (run ${started.applicationId}): follow it, then ask again.`)
    return {
      ok: true,
      data: {
        applicationId: started.applicationId,
        status: 'RUNNING',
        reach: preview.reach,
        changeSetId: run.changeSetId,
        note: `Runs on its own; approval-status follows it (run ${started.applicationId}). Born at the ${SUPPRESSION_FLOOR_CENTS}-cent floor and off the live-write allowlist: it serves next to nothing (not nothing) until set-campaign-live-writes and restore-campaign are approved for it.`,
      },
      change: {
        before: { applicationId: null, market: preview.market, productToken: preview.productToken },
        after: { applicationId: started.applicationId },
      },
    }
  },
}

export const ADS_REPLICATE_TOOLS: AgentTool[] = [replicateAdStructure]
