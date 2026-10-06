/**
 * ADS PLAYBOOK PB-7 — isolation per product, pure: the rule a product's playbook compiles in one market, and the
 * negatives one run would write (spec PB-6-7 §3).
 *
 * The Owner's rule 3: "our own campaigns should stop bidding against each other for that specific product … it must
 * not affect" the other products that buy the same keywords. So isolation keeps apart ONE product's own campaigns
 * only: its linked slot campaigns in one market that advertise nothing but this product (the run's loader decides
 * that). Two products buying "x" stay allowed; another product's "x" is never an owner here and never gets a negative.
 *
 *   exact into research   each live exact keyword of the product's Exact slots (and heroes) → negative exact in its
 *                         Auto, Broad and Phrase slots, so its searches go to the exact keyword
 *   brand phrase          the product's name token and brand terms → negative phrase in its category and competitor
 *                         slots (an Exact one too, unless the phrase would block a keyword there), while a live keyword
 *                         of its brand slots holds the term
 *   phrase into broad     each live phrase keyword of its Phrase slots → negative phrase in its Broad slots of the SAME
 *                         intent (category into Broad | Category, never Broad | Brand) and its Auto slots
 *
 * A negative is planned into an ad group only when ALL hold: the ad group is in scope; it blocks no keyword of that ad
 * group (the lock, L1); its owner keyword is live and not waiting for its bid (PB-10: one a sync added at the floor,
 * before START); it blocks no search term that WINS there (meets the ads strategy's
 * harvest bar for that ad group) unless that term's LIVE exact home wins too — the Owner's handover choice "proven" (lead
 * decision B): a winner keeps running where it wins until its own exact keyword has proved itself; it does not hit a
 * protected term (a protected term is never isolated); Amazon accepts its text. The lock, the protected terms and the
 * text limits are the negative write service's own checks (ownKeywordRefusal, protectedTermHit, the text limits),
 * asked here on the loaded facts so a card lists only what the write would take; the write service still decides each
 * one. Thresholds are never here: the loader marks the winners with the strategy's own bar.
 *
 * Nothing here reads a database or calls Amazon. Every planned ad group is asserted in scope (a violation throws).
 */
import { z } from 'zod'
import { negativeKeywordTextProblem, protectedTermHit, protectedTermRefusal, type ProtectedTerm } from '../ads-negation-policy.js'
import { normaliseNegTerm } from '../ads-protect-converting.js'
import { blockedPositive, blockedWords, negativeBlocksTerm, negativeKey, type Positive } from '../ads-winner-lock.js'
import { INTENTS, MATCH_TYPES, type ProductTerms, type TemplateDoc } from './doc.js'

/** Lead decision B (spec §6): a discovery winner is negated in its source only once its exact home meets the bar. */
export const ISOLATION_HANDOVER = 'proven' as const
/** The most negatives one card lists (and one run without a card writes); the rest come on the next run. */
export const MAX_ISOLATION_ITEMS = 200

export const ISOLATION_ROLES = ['exact', 'research', 'pat'] as const
export type IsolationRole = (typeof ISOLATION_ROLES)[number]
const ISOLATION_SLOT = z.object({ role: z.enum(ISOLATION_ROLES), match: z.enum(MATCH_TYPES).optional(), intent: z.enum(INTENTS) }).strict()
export type IsolationSlot = z.infer<typeof ISOLATION_SLOT>

/** The stored action (AutomationRule.actions[0]). A card's accept adds `items` (the dry run's output, merged). */
export const ISOLATION_ACTION = z.object({
  type: z.literal('isolate_product_terms'),
  v: z.literal(1),
  control: z.literal('manual'),
  playbookId: z.string().min(1),
  market: z.string().min(1),
  cadenceDays: z.number().int().min(1).max(30),
  slots: z.record(z.string(), ISOLATION_SLOT),
  exactIntoResearch: z.boolean(),
  phraseIntoBroadAndAuto: z.boolean(),
  brandPhrase: z.object({ terms: z.array(z.string().min(1)).max(260) }).strict().nullable(),
  handover: z.enum(['landed', 'proven']),
})
export type IsolationAction = z.infer<typeof ISOLATION_ACTION>

// ── Compile ─────────────────────────────────────────────────────────────────────────────────────

export interface IsolationRuleInput {
  playbookId: string
  market: string
  nameToken: string | null
  /** The product's resolved doc (resolve.ts). */
  doc: TemplateDoc
  terms: ProductTerms | null
  handover: 'landed' | 'proven'
}

export interface CompiledIsolationRule {
  name: string
  /** False when the template turns every isolation switch off: the rule is saved, and stays off. */
  enabled: boolean
  action: IsolationAction
  problems: string[]
  warnings: string[]
}

const roleOf = (slot: TemplateDoc['structure']['slots'][number]): IsolationRole =>
  slot.targeting === 'PRODUCT' ? 'pat' : slot.targeting === 'KEYWORD' && slot.match === 'EXACT' ? 'exact' : 'research'

export function compileIsolationRule(input: IsolationRuleInput): CompiledIsolationRule {
  const { doc, market } = input
  const problems: string[] = []
  const warnings: string[] = []
  if (!input.nameToken) problems.push('The product row names no name token: the rule\'s name and the brand phrase need it')
  const slots: Record<string, IsolationSlot> = {}
  for (const s of doc.structure.slots) slots[s.key] = { role: roleOf(s), ...(s.targeting === 'KEYWORD' && s.match ? { match: s.match } : {}), intent: s.intent }
  const list = Object.values(slots)
  const on = doc.isolation
  if (on.exactIntoResearch && !list.some((s) => s.role === 'exact')) warnings.push('No Exact slot: no exact keyword owns a term, so nothing is negated exact')
  if (on.phraseIntoBroadAndAuto && !list.some((s) => s.role === 'research' && s.match === 'PHRASE')) warnings.push('No Phrase slot: no phrase keyword owns a term, so nothing is negated as a phrase in Broad and Auto')
  let brandPhrase: IsolationAction['brandPhrase'] = null
  if (on.brandPhraseIntoCategoryAndCompetitor) {
    const seen = new Map<string, string>()
    for (const t of [input.nameToken ?? '', ...(input.terms?.brand ?? [])]) if (normaliseNegTerm(t) && !seen.has(normaliseNegTerm(t))) seen.set(normaliseNegTerm(t), t.trim())
    brandPhrase = { terms: [...seen.values()] }
    if (!list.some((s) => s.intent === 'BRAND' && s.role !== 'pat')) warnings.push('No brand slot: brand searches would have nowhere to go, so no brand phrase is negated')
    if (!list.some((s) => (s.intent === 'CATEGORY' || s.intent === 'COMPETITOR') && s.role !== 'pat')) warnings.push('No category or competitor slot: the brand phrase has nowhere to be negated')
  }
  const enabled = on.exactIntoResearch || on.phraseIntoBroadAndAuto || on.brandPhraseIntoCategoryAndCompetitor
  if (!enabled) warnings.push('The template turns every isolation switch off: the rule is saved and stays off')
  return {
    name: `${input.nameToken ?? input.playbookId} (${market}) — isolation`,
    enabled,
    action: {
      type: 'isolate_product_terms', v: 1, control: 'manual', playbookId: input.playbookId, market, cadenceDays: 1, slots,
      exactIntoResearch: on.exactIntoResearch, phraseIntoBroadAndAuto: on.phraseIntoBroadAndAuto, brandPhrase, handover: input.handover,
    },
    problems,
    warnings,
  }
}

// ── Plan ────────────────────────────────────────────────────────────────────────────────────────

/** One ad group of the product's own scope: a linked slot campaign's, in the market, advertising only this product. */
export interface ScopeGroup {
  adGroupId: string
  campaignId: string
  /** The slot key ('exact-category', 'hero:<term>'). */
  slot: string
  role: IsolationRole
  match?: (typeof MATCH_TYPES)[number]
  intent: (typeof INTENTS)[number]
  name?: string
}

export interface IsolationPlanInput {
  action: Pick<IsolationAction, 'exactIntoResearch' | 'phraseIntoBroadAndAuto' | 'brandPhrase' | 'handover'>
  scope: readonly ScopeGroup[]
  /** The positives of the scope's ad groups, by AdGroup.id (ads-winner-lock positivesIn). */
  positives: ReadonlyMap<string, readonly Positive[]>
  /** The search terms (normalised) that meet the ads strategy's harvest bar in each ad group, by AdGroup.id. */
  winners: ReadonlyMap<string, ReadonlySet<string>>
  /** The negatives already standing in the scope (ads-winner-lock negativeKey). */
  standing: ReadonlySet<string>
  /** The protected terms that bind a negative in each campaign, by Campaign.id (ads-negation-policy loadProtectedTerms). */
  protections: ReadonlyMap<string, readonly ProtectedTerm[]>
}

export type IsolationKind = 'exactIntoResearch' | 'brandPhrase' | 'phraseIntoBroadAndAuto'

export interface PlannedNegative {
  kind: IsolationKind
  text: string
  match: 'EXACT' | 'PHRASE'
  adGroupId: string
  campaignId: string
  slot: string
  /** The keyword whose searches this negative sends home: the product's own, live. */
  owner: { adTargetId: string; adGroupId: string; slot: string; text: string }
  why: string
}

export interface LeftAlone {
  kind: IsolationKind
  text: string
  /** Null when the term is left alone everywhere (no owner). */
  adGroupId: string | null
  slot: string | null
  why: string
}

export interface IsolationPlan {
  adds: PlannedNegative[]
  leftAlone: LeftAlone[]
  /** Negatives already standing where they would land: not planned again. */
  alreadyStanding: number
}

/** The key one planned negative is found by again (a card's items, the write). */
export const isolationItemKey = (i: { match: string; text: string; adGroupId: string }) => `${i.match}|${normaliseNegTerm(i.text)}|${i.adGroupId}`

/** Throws when a planned negative or its owner lies outside the product's scope (rule 3's second layer). */
export function assertInScope(adds: readonly Pick<PlannedNegative, 'adGroupId' | 'owner' | 'text'>[], scope: readonly Pick<ScopeGroup, 'adGroupId'>[]): void {
  const ids = new Set(scope.map((g) => g.adGroupId))
  for (const a of adds) {
    if (!ids.has(a.adGroupId) || !ids.has(a.owner.adGroupId)) {
      throw new Error(`isolation planned "${a.text}" into ad group ${a.adGroupId} (owner in ${a.owner.adGroupId}) outside this product's own campaigns; nothing is written`)
    }
  }
}

/** The sentence a planned negative carries (its evidence note, the card's line). */
function whyOf(kind: IsolationKind, text: string, owner: { slot: string; text: string }, into: string): string {
  if (kind === 'brandPhrase') return `Kept apart: "${text}" is this product's brand, and its searches go to its brand slot "${owner.slot}" (keyword "${owner.text}"), not to "${into}".`
  return `Kept apart: "${text}" is this product's own ${kind === 'exactIntoResearch' ? 'exact' : 'phrase'} keyword in the slot "${owner.slot}", so its searches go there, not to "${into}".`
}

/**
 * PB-10 — a keyword a search can be sent to: live, and not waiting for its bid (a sync added it at the floor and START
 * has not given it its planned bid yet). Negating its term elsewhere would send the searches to 2¢.
 */
const isHome = (p: { live: boolean; waiting?: boolean }) => p.live && !p.waiting

export function planIsolation(input: IsolationPlanInput): IsolationPlan {
  const { action, scope } = input
  const plan: IsolationPlan = { adds: [], leftAlone: [], alreadyStanding: 0 }
  const seen = new Set<string>()
  const positivesOf = (g: ScopeGroup) => input.positives.get(g.adGroupId) ?? []
  const allPositives = scope.flatMap(positivesOf)
  const winnersIn = (adGroupId: string) => input.winners.get(adGroupId) ?? new Set<string>()
  /** A term's LIVE exact home in scope that meets the harvest bar there: it has proved itself where it belongs. */
  const proven = (term: string, notIn: string) => allPositives.some((p) =>
    p.match === 'EXACT' && isHome(p) && p.adGroupId !== notIn && normaliseNegTerm(p.text) === normaliseNegTerm(term) && winnersIn(p.adGroupId).has(normaliseNegTerm(term)))

  const consider = (kind: IsolationKind, text: string, match: 'EXACT' | 'PHRASE', g: ScopeGroup, owner: Positive & { slot: string }) => {
    const key = isolationItemKey({ match, text, adGroupId: g.adGroupId })
    if (seen.has(key)) return
    seen.add(key)
    const leave = (why: string) => plan.leftAlone.push({ kind, text, adGroupId: g.adGroupId, slot: g.slot, why })
    if (input.standing.has(negativeKey(g.adGroupId, match, text))) { plan.alreadyStanding++; return }
    const tooLong = negativeKeywordTextProblem(text, match === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT')
    if (tooLong) return leave(`Not negated: ${tooLong}`)
    const blocked = blockedPositive({ text, match }, positivesOf(g))
    if (blocked) {
      return leave(g.role === 'exact'
        ? `Not negated: it would block your own keyword "${blocked.text}" in this Exact slot; move that keyword to its brand slot first (the playbook's drift list names it).`
        : `Not negated: ${blockedWords(blocked, g.name)}`)
    }
    const hit = protectedTermHit(text, match === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT', input.protections.get(g.campaignId) ?? [])
    if (hit) return leave(`Protected, never isolated: ${protectedTermRefusal(text, hit)}`)
    if (action.handover !== 'landed') {
      const holding = [...winnersIn(g.adGroupId)].find((t) => negativeBlocksTerm({ text, match }, t) && !proven(t, g.adGroupId))
      if (holding) return leave(`Not negated yet: the search "${holding}" wins here (it meets the ads strategy's harvest bar in this ad group), and its exact keyword has not met that bar yet, so it keeps running where it wins.`)
    }
    plan.adds.push({
      kind, text, match, adGroupId: g.adGroupId, campaignId: g.campaignId, slot: g.slot,
      owner: { adTargetId: owner.adTargetId, adGroupId: owner.adGroupId, slot: owner.slot, text: owner.text },
      why: whyOf(kind, text, owner, g.slot),
    })
  }

  const slotOf = new Map(scope.map((g) => [g.adGroupId, g.slot]))
  const ownersIn = (groups: readonly ScopeGroup[], match: Positive['match']) =>
    groups.flatMap((g) => positivesOf(g).filter((p) => isHome(p) && p.match === match).map((p) => ({ ...p, slot: slotOf.get(p.adGroupId)! })))
  const research = scope.filter((g) => g.role === 'research')

  if (action.exactIntoResearch) {
    for (const owner of ownersIn(scope.filter((g) => g.role === 'exact'), 'EXACT')) {
      for (const g of research) consider('exactIntoResearch', owner.text, 'EXACT', g, owner)
    }
  }

  if (action.brandPhrase) {
    const brandGroups = scope.filter((g) => g.intent === 'BRAND' && g.role !== 'pat')
    const targets = scope.filter((g) => (g.intent === 'CATEGORY' || g.intent === 'COMPETITOR') && g.role !== 'pat')
    for (const term of action.brandPhrase.terms) {
      const owner = brandGroups.flatMap((g) => positivesOf(g).filter((p) => isHome(p) && p.match !== 'PRODUCT').map((p) => ({ ...p, slot: g.slot })))
        .find((p) => negativeBlocksTerm({ text: term, match: 'PHRASE' }, p.text))
      if (!owner) {
        plan.leftAlone.push({ kind: 'brandPhrase', text: term, adGroupId: null, slot: null, why: 'Not negated anywhere: no live keyword of this product\'s brand slots holds it, so its searches would have nowhere to go.' })
        continue
      }
      for (const g of targets) consider('brandPhrase', term, 'PHRASE', g, owner)
    }
  }

  if (action.phraseIntoBroadAndAuto) {
    // Only the Broad slots of the owner's own intent, and Auto: a category phrase negated in Broad | Brand (beside the
    // brand phrase negated in the category slots) would leave "brand + category" searches nowhere to go.
    const intentOf = new Map(scope.map((g) => [g.adGroupId, g.intent]))
    for (const owner of ownersIn(research.filter((g) => g.match === 'PHRASE'), 'PHRASE')) {
      const intent = intentOf.get(owner.adGroupId)
      for (const g of research.filter((r) => !r.match || (r.match === 'BROAD' && r.intent === intent))) consider('phraseIntoBroadAndAuto', owner.text, 'PHRASE', g, owner)
    }
  }

  assertInScope(plan.adds, scope)
  return plan
}
