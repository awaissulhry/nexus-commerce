/**
 * ADS PLAYBOOK PB-6c — a winner's own campaign (a "hero"), planned, pure: the Owner's "maybe we can create a separate
 * campaign each time to have more control". ONE campaign with ONE exact keyword for the term, the product's own product
 * ads and its own negatives, compiled by the playbook's own compiler (compile.ts `compilePlaybook`) from a one-slot doc:
 * the product's Exact slot of the term's intent (the intent router, ads-harvest-route.ts — brand, competitor, category),
 * so the naming, the least budget per slot, the strategy's bid band, the product's negatives and the name check are the
 * playbook's own. It is built by the playbook's build (build.ts → the SP Super Wizard's launch: Owner rule 1, no new
 * create path), born at the 2¢ floor and off the live-write allowlist, and linked as a slot of its own (key
 * `hero:<term>`), so START, STOP, the harvest's home scope and the isolation treat it like the other slots.
 *
 *   keyword     the term, exact (a hero holds one exact keyword; an ASIN is never one)
 *   bid         the term's cost per click where it runs now (the harvest's own start for a winner: it holds the place the
 *               term has), else the model slot's ladder bid — clamped to the strategy's band; START puts it back
 *   budget      the term's own daily spend where it runs now, at least the playbook's least budget per slot, at most the
 *               product's daily budget (a product budget below the least per slot is the hero's budget: never above it)
 *   approved    `frozen`: the bid and budget a person approved, planned again as they were (the term's CPC and spend
 *               move every day); only the strategy's band is asked again here (and the caps by the build's gate)
 *   placements  the model slot's
 *   negatives   the product's own, and the isolation the template sets for the slot's intent — never one that would
 *               block the hero's own keyword (L1, ads-winner-lock.ts)
 *   one         at most one hero per term per product per market (its link key)
 *
 * What it does NOT do (Owner rule 2): the term keeps running where it runs now — nothing is negated there, no bid is
 * lowered; only once the hero itself meets the harvest bar (handover B, `proven`) are its old places closed, each by a
 * request a person decides: its old exact keyword lowered to low bids (the winners view proposes it — the Owner's
 * temporary stop, undone in about a minute; never a negative over his own keyword, L1), and in the research slots a
 * negative exact (the playbook's isolation rule). Rule 3: another product buying the same term is never a reason to
 * refuse, and is never touched.
 */
import { z } from 'zod'
import { campaignNameProblem } from '@nexus/shared/ads-campaign-name'
import type { PlannedCampaign } from '../../ads-core/ads-blueprint-apply.js'
import { routeIntent, type Intent } from '../ads-harvest-route.js'
import { normaliseNegTerm } from '../ads-protect-converting.js'
import { blockedPositive, type Positive } from '../ads-winner-lock.js'
import { compilePlaybook, type CompiledSlot } from './compile.js'
import type { ProductTerms, Slot, TemplateDoc } from './doc.js'

/** The link key of a term's hero: `hero:` and the term as the harvest normalises it. */
export const HERO_PREFIX = 'hero:'
export const heroKey = (term: string): string => `${HERO_PREFIX}${normaliseNegTerm(term)}`
export const isHeroKey = (key: string): boolean => key.startsWith(HERO_PREFIX)
/** A hero's link key, as a tool names it (START / STOP of one hero). */
export const HERO_KEY = z.string().trim().regex(/^hero:\S.{0,99}$/, 'a hero key is "hero:" and its term')

/** Amazon's least daily budget for a Sponsored Products campaign (compile.ts holds the same). */
const MIN_BUDGET_CENTS = 100
/** The slot key of the one-slot doc (the plan's campaign is renamed to the hero's link key after the compile). */
const ONE = 'hero'
const isAsin = (term: string) => /^b0[a-z0-9]{8}$/i.test(term.trim())

/** The brand and competitor words the router reads for this product (the harvest rule's own lists, harvest-rule.ts). */
export function heroIntentLists(nameToken: string | null, terms: Pick<ProductTerms, 'brand' | 'competitor'>): { brand: string[]; competitor: string[] } {
  return {
    brand: [...new Set([nameToken ?? '', ...terms.brand].map((t) => t.trim()).filter(Boolean))],
    competitor: [...new Set(terms.competitor.map((t) => t.trim()).filter(Boolean))],
  }
}

/**
 * The Exact slot a hero of this intent is modelled on: the intent's own, else one for any intent, else the Category one
 * (the router's own fallback for a missing slot), else any Exact slot. Null: the playbook has no Exact slot.
 */
export function modelSlotFor(doc: TemplateDoc, intent: Intent): { slot: Slot; own: boolean } | null {
  const exact = doc.structure.slots.filter((s) => s.targeting === 'KEYWORD' && s.match === 'EXACT')
  const own = exact.find((s) => s.intent === intent)
  if (own) return { slot: own, own: true }
  const other = exact.find((s) => s.intent === 'ANY') ?? exact.find((s) => s.intent === 'CATEGORY') ?? exact[0]
  return other ? { slot: other, own: false } : null
}

/**
 * The slot a playbook link plays in the phase table (PB-9: a phase floors or runs slots by key). A hero plays the Exact
 * slot it is modelled on — its term's intent, as the router picks it — so a phase that floors that slot floors the hero
 * too, and START leaves it floored. Any other link plays its own key.
 */
export function phaseSlotOf(key: string, doc: TemplateDoc, nameToken: string | null, terms: Pick<ProductTerms, 'brand' | 'competitor'> | null): string {
  if (!isHeroKey(key)) return key
  const intent = routeIntent(key.slice(HERO_PREFIX.length), heroIntentLists(nameToken, terms ?? { brand: [], competitor: [] }))
  return modelSlotFor(doc, intent)?.slot.key ?? key
}

/** Why a term cannot have a hero (pure), or null when it can. */
export function heroRefusal(term: string, doc: TemplateDoc | null, heroKeys: ReadonlySet<string>): string | null {
  if (!normaliseNegTerm(term)) return 'name the term'
  if (isAsin(term)) return 'it is an ASIN: a hero holds one exact keyword (an ASIN stays a product target where it runs)'
  if (heroKeys.has(heroKey(term))) return 'it has its own campaign already (one hero per term per product per market)'
  if (!doc) return 'the playbook does not compile'
  if (!doc.structure.slots.some((s) => s.targeting === 'KEYWORD' && s.match === 'EXACT')) return 'the playbook has no Exact keyword slot to model its campaign on'
  return null
}

export interface HeroInput {
  market: string
  /** The product's resolved doc (resolve.ts); null: it does not compile (refused). */
  doc: TemplateDoc | null
  nameToken: string
  term: string
  /** The product's own lists: brand and competitor (the router, the brand phrase), negatives. */
  terms: ProductTerms
  /** The ASINs it advertises (the product's children listed in the market). */
  asins: readonly string[]
  /** The strategy's bid band at this product. */
  band: { minBidCents: number | null; maxBidCents: number | null }
  /** The product row's base bid and daily budget. */
  baseBidCents: number | null
  dailyBudgetCents: number | null
  /** Where the term runs now: its cost per click and its daily spend there (null: no clicks, no spend). */
  cpcCents: number | null
  dailySpendCents: number | null
  /** The hero keys the product's playbook already holds (campaign not archived). */
  heroKeys: ReadonlySet<string>
  /** The bid and daily budget a person approved: planned as they are (only the strategy's band asked again). */
  frozen?: { bidCents: number; dailyBudgetCents: number } | null
}

export interface HeroPlan {
  /** The link key, `hero:<term>`. */
  key: string
  term: string
  intent: Intent
  /** The Exact slot it is modelled on; `ownIntent` false when the intent's own slot is missing. */
  modelSlot: string | null
  ownIntent: boolean
  /** The one campaign (its `role` is the link key). Null when it cannot be planned. */
  campaign: PlannedCampaign | null
  slot: CompiledSlot | null
  /** Where the planned bid comes from: the term's cost per click, the model slot's ladder (then the band), or the approval. */
  bidFrom: 'cpc' | 'ladder' | 'approved'
  /** Where the daily budget comes from: the term's own daily spend, the least budget per slot, the product's, or the approval. */
  budgetFrom: 'spend' | 'least' | 'productBudget' | 'approved'
  dailyBudgetCents: number
  negatives: number
  problems: string[]
  warnings: string[]
}

/** The hero of one term for one product, as a one-campaign plan for the playbook's build. Pure. */
export function heroPlan(input: HeroInput): HeroPlan {
  const term = input.term.trim().replace(/\s+/g, ' ')
  const key = heroKey(term)
  const intent = routeIntent(term, heroIntentLists(input.nameToken, input.terms))
  const out: HeroPlan = {
    key, term, intent, modelSlot: null, ownIntent: false, campaign: null, slot: null, bidFrom: 'ladder', budgetFrom: 'least',
    dailyBudgetCents: 0, negatives: 0, problems: [], warnings: [],
  }
  const refused = heroRefusal(term, input.doc, input.heroKeys)
  if (refused) { out.problems.push(`"${term}" gets no campaign of its own: ${refused}`); return out }
  const src = input.doc!
  const model = modelSlotFor(src, intent)!
  out.modelSlot = model.slot.key
  out.ownIntent = model.own
  if (!model.own) out.warnings.push(`The playbook has no Exact slot for ${intent.toLowerCase()} terms: the hero is modelled on "${model.slot.key}"`)

  // The bid: the term's own cost per click where it runs, else the model slot's ladder bid (the band clamps either).
  const frozen = input.frozen ?? null
  const ladderCents = input.baseBidCents ? Math.round(input.baseBidCents * (src.bids.ladder[model.slot.key] ?? 1)) : null
  const bidCents = frozen ? frozen.bidCents : input.cpcCents && input.cpcCents > 0 ? input.cpcCents : ladderCents
  out.bidFrom = frozen ? 'approved' : input.cpcCents && input.cpcCents > 0 ? 'cpc' : 'ladder'
  if (!bidCents) { out.problems.push(`"${term}" has no clicks where it runs and the product row sets no base bid: there is no bid to plan`); return out }

  // The budget: the term's own daily spend, at least the least per slot, at most the product's daily budget — and
  // never above the product's daily budget, even where it is below the least per slot (Amazon's own least stays).
  const least = Math.max(MIN_BUDGET_CENTS, src.budget.minPerSlotCents)
  let budget = least
  out.budgetFrom = 'least'
  if (frozen) { budget = frozen.dailyBudgetCents; out.budgetFrom = 'approved' }
  else {
    if (input.dailySpendCents && Math.ceil(input.dailySpendCents) > least) { budget = Math.ceil(input.dailySpendCents); out.budgetFrom = 'spend' }
    if (input.dailyBudgetCents && budget > input.dailyBudgetCents) {
      budget = Math.max(MIN_BUDGET_CENTS, input.dailyBudgetCents)
      out.budgetFrom = 'productBudget'
      if (input.dailyBudgetCents < least) out.warnings.push("The product's daily budget is below the playbook's least budget per slot: the hero gets the product's daily budget")
    }
  }

  // The one-slot doc: the model slot, fed by the term alone, with the slot's own placements and the template's isolation.
  const slot: Slot = { ...model.slot, key: ONE, feeds: ['category'], nameParts: [...model.slot.nameParts, 'Hero', term], rankRole: 'none', optional: false }
  const placement = src.placements[model.slot.key]
  const doc: TemplateDoc = {
    ...src,
    structure: { ...src.structure, slots: [slot] },
    // The least per slot is the hero's own budget at most (a product budget below it, an approved budget).
    budget: { weights: { [ONE]: 1 }, minPerSlotCents: Math.min(src.budget.minPerSlotCents, budget) },
    bids: { ...src.bids, ladder: { [ONE]: 1 } },
    placements: placement ? { [ONE]: placement } : {},
    harvest: { edges: [] },
  }
  const compiled = compilePlaybook({
    market: input.market, doc,
    product: {
      nameToken: input.nameToken, dailyBudgetCents: budget, baseBidCents: bidCents,
      terms: { brand: input.terms.brand, category: [{ text: term, exactAtStart: true }], competitor: [], competitorAsins: [], negatives: input.terms.negatives },
    },
    asins: input.asins,
    band: input.band,
  })
  if (compiled.problems.length) { out.problems.push(...compiled.problems); return out }
  const campaign = compiled.campaigns[0]
  const compiledSlot = compiled.slots[0]
  if (!campaign || !compiledSlot) { out.problems.push(`"${term}" compiles to no campaign`); return out }
  const nameProblem = campaignNameProblem(campaign.name)
  if (nameProblem) { out.problems.push(`its campaign name cannot be used: ${nameProblem}`); return out }
  out.warnings.push(...compiled.warnings.filter((w) => !w.startsWith(`${ONE}: `) && !/clamps the start bid of/.test(w)))
  if (compiledSlot.ladderBidCents != null) {
    // An approved bid is planned as approved: one the band would move now is not built (a person asks again).
    if (frozen) { out.problems.push("the bid approved for it is outside the ads strategy's bid band at this product now, so it is not built as approved: ask again"); return out }
    out.warnings.push(`The strategy's bid band clamps the hero's planned bid`)
  }

  // L1 — no negative of the hero blocks its own keyword (the product's own negatives, a brand phrase).
  const own: Positive[] = [{ adTargetId: ONE, adGroupId: ONE, text: term, match: 'EXACT', live: false }]
  const group = campaign.adGroups[0]
  const kept = group.targets.filter((t) => {
    if (!t.isNegative || (t.kind ?? '').toUpperCase() !== 'KEYWORD') return true
    const blocks = blockedPositive({ text: t.expression, match: t.expressionType === 'PHRASE' ? 'PHRASE' : 'EXACT' }, own)
    if (blocks) out.warnings.push(`The negative ${t.expressionType.toLowerCase()} "${t.expression}" would block the hero's own keyword: left out of it`)
    return !blocks
  })
  const hero: PlannedCampaign = { ...campaign, role: key, adGroups: [{ ...group, targets: kept }] }
  out.campaign = hero
  out.negatives = kept.filter((t) => t.isNegative).length
  out.slot = { ...compiledSlot, key, negatives: out.negatives }
  out.dailyBudgetCents = Math.round(Number(hero.dailyBudget ?? 0) * 100)
  return out
}
