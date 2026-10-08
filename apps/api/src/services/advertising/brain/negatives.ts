/**
 * ONE BRAIN AB-10 — the negatives module of one product in one market (design 2026-10-08-ads-one-brain/DESIGN.md §2.7,
 * §2.8, §3, §4 step 4, §5, §8 row AB-10, §10; IND §2.5, §3 #16-17). Pure: no database and no clock (the run hands `now`).
 * brain/negatives-run.ts loads the facts, stores the decision log and writes; this module decides WHAT to negate, WHERE,
 * at which LEVEL, and what to retire or revive — one plan per product × market per day.
 *
 *   input      the term ledger's decisions (brain/terms.ts, AB-9: one state per term), the product's own campaigns and ad
 *              groups with the negatives lever resolved PER CAMPAIGN (brain/settings.ts: the Owner's campaign choice beats
 *              the product's), the negatives that stand there (who made each), every term's evidence per ad group, and the
 *              playbook's product negative set (terms.negatives).
 *   adds       productSet  the playbook's own negatives, into every own keyword or auto ad group (ad-group level, as the
 *                          playbook's own build places them: compile.ts); a product-targeting ad group takes none
 *              waste       a term the ledger negates (NEGATE_CANDIDATE: 0 orders after n ≈ 3 ÷ CR̂ clicks and spend past 1.5
 *                          target CPAs; or NEGATED in one place and still serving in another, with the same test passing)
 *                          → negative exact where it served: one campaign negative where it served in two ad groups or
 *                          more of a campaign (one slot, every ad group of it), else in its ad group; an ASIN → a negative
 *                          product target in each ad group
 *              ngram       a 1-3 word piece that wastes ACROSS terms (§2.7, [TEC-5]): in two terms or more, 0 orders,
 *                          and its summed clicks pass the same pooled test (at least NGRAM_MIN_CLICKS, Scale Insights'
 *                          "Trojan Defender" floor) and spend gate → negative phrase where those terms served. Never when
 *                          the piece is in a term that converted, is protected, is the product's brand, is targeted or led
 *                          by the product, or is locked by the Owner — a phrase blocks every search holding its words
 *              isolation   a term with a live exact home in the product (PB-7, "keep the product's own campaigns apart")
 *                          → negative exact in the product's other ad groups where it still served, so its searches go to
 *                          the home. The Owner's handover rule (PB-7 lead decision B, "proven"): where it converts in the
 *                          source, only once its home converts too — a winner keeps running where it wins until then
 *              consolidate an entity at its warning level (§2.7): a word recurring in 3 or more of its exact negatives
 *                          becomes one negative phrase there; the exacts it covers retire on a later day, once it is live
 *   retires    duplicate   at the warning level: a negative another live negative covers in the same place (a phrase
 *                          holding its words, a campaign negative over an ad group one, the same negative twice)
 *              revive      a negative that blocks the product's own keyword in its place (the ledger's self-blocking clash),
 *                          a protected term or brand word (the ledger's protected-negated clash), a term the product now
 *                          LEADS in the market (the arbiter) while negated, or a term that CONVERTED where it is blocked
 *                          (evidence improved; never an isolation negative: the term has no home elsewhere, and never a
 *                          harvest candidate's source: AB-11 graduates it)
 *   guards     never a protected term, the brand, a winner, a term with an order (waste and n-gram), a term the product
 *              leads, a positive where it lands (the write service's L1, asked here on the loaded facts), a locked term or
 *              ad group, a shared campaign (no product's, D2), an excluded or locked campaign, a campaign whose lever is OFF
 *              or that is not running. A person's negative (or one Nexus cannot attribute) is never retired alone: a
 *              revive of it asks a person; a duplicate of it is left.
 *   budget     per campaign and per ad group (§2.7; Amazon's 1,000, sources conflict → design for 1,000): never above the
 *              maximum (950), a warning from 800 — both the Owner's settings per product or campaign. Retires first (they
 *              free room at once in Nexus), then adds by priority; an add with no room is held, named.
 *   caps       ≤ negativesPerDay new negatives per product per day (each one Amazon holds counts: one term in three ad
 *              groups is three), today's already written or asked counted; ≤ REVIVES_PER_DAY revives; ≤ RETIRES_PER_RUN
 *              duplicate retires. Priority: the Owner's set, waste, n-gram, isolation, consolidation (§4: negatives
 *              first, isolation after the harvest).
 *   levels     per campaign: OBSERVE logs (shadow); PROPOSE asks a person (one change plan a day); AUTO writes as the
 *              brain's own actor (BRAIN_NEGATIVES_ACTOR) through the one negative write service and the retire queue.
 *              §2.7: a negative on a term with an order, and a revive of a person's negative, ask first even at AUTO.
 *              PROPOSE and AUTO act only under the live server switch and after the shadow days (§10: 14 for negatives,
 *              the Owner's `negativesShadowDays` wins); before that they log as shadow, with the reason.
 *   words      no money in a `why` (amounts live under `money` keys the read tool hides without the ad-spend permission).
 */
import { isAsin, negativeKeywordTextProblem, normaliseTerm, protectedTermHit, type ProtectedTerm } from '../ads-negation-policy.js'
import { blockedPositive, type Positive } from '../ads-winner-lock.js'
import { SIZE_RE } from '../negatives-ngrams.service.js'
import { addEvidence, brandWordIn, negateClicksNeeded, NO_TERM_EVIDENCE, SPEND_GATE_CPAS, termKey, type LeverEffective, type TermDecision, type TermEvidence } from './terms.js'

/** The brain's own actor on the negatives lever (the gate's PRODUCT_BRAIN_ACTOR `-<what>` form: it passes an owned lever only). */
export { BRAIN_NEGATIVES_ACTOR } from '../ads-write-gate.js'
/** Amazon's negatives per campaign and per ad group the design plans for (sources conflict: 1,000 vs 10,000, §2.7). */
export const AMAZON_ENTITY_LIMIT = 1000
/** The fewest clicks a wasted word needs across terms, whatever the pooled test asks (Scale Insights' floor, §2.7). */
export const NGRAM_MIN_CLICKS = 25
/** A wasted word is a theme only across this many terms or more (one term is the exact negative's job). */
export const NGRAM_MIN_TERMS = 2
/** Pieces of 1 to 3 words (IND §2.5). Amazon takes at most 4 in a negative phrase. */
export const NGRAM_MAX_WORDS = 3
/** At the warning level, a word in this many exact negatives of one entity or more becomes one phrase there. */
export const CONSOLIDATE_MIN_EXACTS = 3
export const CONSOLIDATE_PER_ENTITY = 5
/** Revives a day per product (each lifts a block: it can add spend). */
export const REVIVES_PER_DAY = 10
/** Duplicate retires a run per product (the Negatives page's own bound for one retire request is 200). */
export const RETIRES_PER_RUN = 200
/** A proposal the Owner rejected is not asked again for this long. */
export const REJECTED_HOLD_DAYS = 30
const DAY_MS = 86_400_000

/** Words a piece never starts or ends with, and never is alone (IT, DE, FR, ES, EN — the brain's markets). */
const STOPWORDS = new Set([
  'per', 'con', 'da', 'di', 'del', 'della', 'dei', 'il', 'lo', 'la', 'le', 'gli', 'un', 'una', 'uno', 'e', 'o', 'in', 'su', 'a', 'al', 'alla',
  'für', 'fur', 'mit', 'und', 'der', 'die', 'das', 'den', 'dem', 'ein', 'eine', 'von', 'zu', 'im', 'am', 'auf',
  'pour', 'avec', 'et', 'les', 'des', 'du', 'de', 'au', 'aux', 'en', 'sur', 'une',
  'para', 'y', 'el', 'los', 'las', 'por', 'sin',
  'for', 'with', 'and', 'the', 'of', 'to', 'on', 'an', 'or', 'by',
])

export type NegMatch = 'EXACT' | 'PHRASE' | 'PRODUCT'
export type NegLevel = 'CAMPAIGN' | 'AD_GROUP'
export type NegAction = 'ADD' | 'RETIRE'
export const NEG_REASONS = ['productSet', 'waste', 'ngram', 'isolation', 'consolidate', 'duplicate', 'reviveSelfBlocking', 'reviveProtected', 'reviveLead', 'reviveConverts'] as const
export type NegReason = (typeof NEG_REASONS)[number]
export type NegMode = 'OBSERVE' | 'PROPOSE' | 'AUTO'
/** Who made a standing negative, from its create record: the brain, another engine or rule, a person, or nobody known. */
export type Origin = 'brain' | 'automation' | 'person' | 'unknown'

const ADD_PRIORITY: Record<NegReason, number> = { productSet: 0, waste: 1, ngram: 2, isolation: 3, consolidate: 4, duplicate: 9, reviveSelfBlocking: 9, reviveProtected: 9, reviveLead: 9, reviveConverts: 9 }
const REVIVES: ReadonlySet<NegReason> = new Set(['reviveSelfBlocking', 'reviveProtected', 'reviveLead', 'reviveConverts'])

// ── The facts (the run builds them) ─────────────────────────────────────────────────────────────────────────────

export interface NegCampaign {
  id: string
  name: string
  /** ENABLED | PAUSED | … — only a running campaign takes a negative. */
  status: string
  targetingType: string | null
  /** The negatives lever resolved for this campaign (brain/settings.ts, the campaign's override over the product's). */
  lever: LeverEffective
  leverWhy: string
  /** Ad groups the Owner locked on the negatives lever (lock ref "adGroup:<id>"). */
  lockedAdGroups: ReadonlySet<string>
  /** The Owner's per-entity budget for this campaign and its ad groups (settings negativesPerEntityWarn / Max). */
  warn: number
  max: number
}

export interface NegAdGroup {
  id: string
  campaignId: string
  name: string
  status: string
  /** Its positives (keywords and product targets, not archived) — the lock L1 is asked on them. */
  positives: readonly Positive[]
}

export interface StandingNegative {
  id: string
  campaignId: string
  adGroupId: string
  level: NegLevel
  match: NegMatch
  /** Normalised (lower case, single spaces; an ASIN in lower case). */
  text: string
  externalTargetId: string | null
  /** ENABLED with Amazon's id: Amazon holds it. */
  live: boolean
  origin: Origin
  createdAt: Date
}

export interface NegativesInput {
  productId: string
  market: string
  now: Date
  /** The ledger's decisions for the product (brain/terms-shadow.ts decideMarket). */
  decisions: readonly TermDecision[]
  protections: readonly ProtectedTerm[]
  /** The product's brand and hero words (playbook terms.brand), normalised. */
  brand: readonly string[]
  /** Terms the Owner locked on the negatives lever (lock refs "term:<text>"), normalised. */
  lockedTerms: ReadonlySet<string>
  /** The product's pooled conversion rate (product → category → market) and order value; the target ACoS (fraction). */
  cr: number
  aovCents: number | null
  targetAcos: { value: number; source: string } | null
  /** Every own campaign of the product in the market (the run passes the not-running and held ones too: named). */
  campaigns: readonly NegCampaign[]
  adGroups: readonly NegAdGroup[]
  standing: readonly StandingNegative[]
  /** Each term's evidence per ad group of the product, over the ledger's window. */
  places: ReadonlyMap<string, ReadonlyMap<string, TermEvidence>>
  /** The playbook's product negative set (terms.negatives). */
  productSet: ReadonlyArray<{ text: string; match: 'EXACT' | 'PHRASE' }>
  /** The day's caps, and what the log holds already today (asked or written): `actedKeys` are counted in it, never twice. */
  caps: { perDay: number; usedToday: number; revivedToday: number; actedKeys?: ReadonlySet<string> }
  /** §10 — PROPOSE and AUTO act only under the live server switch, after the shadow days. */
  gates: { ceilingLive: boolean; shadowSince: Date | null; shadowDays: number }
}

// ── The plan ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NegItem {
  key: string
  action: NegAction
  reasons: NegReason[]
  kind: 'KEYWORD' | 'PRODUCT'
  match: NegMatch
  /** The negative's text (an ASIN upper-cased, as Amazon takes it). */
  text: string
  level: NegLevel
  campaignId: string
  /** The ad group it goes into; for a campaign negative, null. */
  adGroupId: string | null
  /** RETIRE: the standing negative (AdTarget.id), who made it, and the negative that covers it (a duplicate). */
  negativeId?: string
  origin?: Origin
  coverId?: string
  mode: NegMode
  /** §2.7: a term with an order, or a person's negative: a person decides, whatever the level. */
  askFirst: boolean
  /** Why it is not done even at its level (the entity is full, past the cap, the shadow, a guard on its place); null: nothing. */
  heldBy: string | null
  why: string
  evidence: {
    clicks: number
    orders: number
    /** The place's own record (its ad group, or its campaign's ad groups). */
    placeClicks?: number
    placeOrders?: number
    /** n-gram: the terms it would block (at most 10) and how many. */
    terms?: string[]
    termCount?: number
    clicksNeeded?: number
    money: { spendCents: number; salesCents: number; placeSpendCents?: number; spendGateCents?: number | null }
  }
}

export interface EntityBudget {
  kind: 'CAMPAIGN' | 'AD_GROUP'
  id: string
  campaignId: string
  name: string
  standing: number
  adds: number
  retires: number
  after: number
  warn: number
  max: number
  state: 'ok' | 'warn' | 'full'
}

export interface NegativesPlan {
  items: NegItem[]
  entities: EntityBudget[]
  /** Own campaigns the brain leaves, and why (the Owner's exclusion or lock, the lever OFF, not running). */
  skipped: Array<{ campaignId: string; name: string; why: string }>
  shadow: { inShadow: boolean; why: string | null; daysRun: number | null; days: number; ceilingLive: boolean }
  counts: { adds: number; retires: number; held: number; byReason: Partial<Record<NegReason, number>>; byMode: Partial<Record<NegMode, number>> }
}

// ── Words and small helpers ──────────────────────────────────────────────────────────────────────────────────────

const wordsOf = (s: string): string[] => normaliseTerm(s).split(' ').filter(Boolean)
/** `inner`'s words in `outer`'s, next to each other and in order (Amazon's phrase match). */
export function holdsRun(outer: string, inner: string): boolean {
  const o = wordsOf(outer)
  const i = wordsOf(inner)
  if (!i.length || i.length > o.length) return false
  for (let a = 0; a + i.length <= o.length; a++) if (i.every((w, b) => o[a + b] === w)) return true
  return false
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const levelWords = (level: NegLevel) => (level === 'CAMPAIGN' ? 'campaign' : 'ad group')
const negWords = (match: NegMatch, text: string) => (match === 'PRODUCT' ? `negative product target ${text}` : `negative ${match.toLowerCase()} "${text}"`)
export const itemKey = (i: Pick<NegItem, 'action' | 'level' | 'campaignId' | 'adGroupId' | 'match' | 'text' | 'negativeId'>): string =>
  i.action === 'RETIRE' ? `RETIRE|${i.negativeId}` : `ADD|${i.level}|${i.level === 'CAMPAIGN' ? i.campaignId : i.adGroupId}|${i.match}|${i.match === 'PRODUCT' ? i.text.toUpperCase() : normaliseTerm(i.text)}`

/** Does this standing negative block `term` (normalised) where it stands? Exact: the same; phrase: its words in order. */
export function standingBlocks(n: Pick<StandingNegative, 'match' | 'text'>, term: string): boolean {
  if (n.match === 'PRODUCT') return isAsin(term) && n.text === term.toLowerCase()
  if (isAsin(term)) return false
  return n.match === 'EXACT' ? n.text === term : holdsRun(term, n.text)
}

/** Every contiguous piece of 1..max words of a term. */
export function piecesOf(term: string, max = NGRAM_MAX_WORDS): string[] {
  const w = wordsOf(term)
  const out = new Set<string>()
  for (let n = 1; n <= max; n++) for (let a = 0; a + n <= w.length; a++) out.add(w.slice(a, a + n).join(' '))
  return [...out]
}

/** A piece the n-gram may weigh at all: long enough, not a stopword at its edges, not a number, a size or an ASIN. */
export function pieceAllowed(piece: string): boolean {
  const w = wordsOf(piece)
  if (!w.length || piece.length < 3) return false
  if (STOPWORDS.has(w[0]) || STOPWORDS.has(w[w.length - 1])) return false
  if (w.some((t) => t.length < 2 || /^\d+$/.test(t) || SIZE_RE.test(t) || isAsin(t))) return false
  return !negativeKeywordTextProblem(piece, 'NEGATIVE_PHRASE')
}

// ── The index over the facts ─────────────────────────────────────────────────────────────────────────────────────

type Kind = 'AUTO' | 'KEYWORD' | 'PRODUCT' | 'EMPTY'

class Facts {
  readonly campaigns = new Map<string, NegCampaign>()
  readonly groups = new Map<string, NegAdGroup>()
  readonly groupsOf = new Map<string, NegAdGroup[]>()
  /** 'C:<campaignId>' → its campaign negatives; 'G:<adGroupId>' → its ad-group negatives. */
  readonly standingIn = new Map<string, StandingNegative[]>()
  readonly standingById = new Map<string, StandingNegative>()
  readonly decisions = new Map<string, TermDecision>()
  constructor(readonly input: NegativesInput) {
    for (const c of input.campaigns) this.campaigns.set(c.id, c)
    for (const g of input.adGroups) {
      this.groups.set(g.id, g)
      this.groupsOf.set(g.campaignId, [...(this.groupsOf.get(g.campaignId) ?? []), g])
    }
    for (const n of input.standing) {
      const k = n.level === 'CAMPAIGN' ? `C:${n.campaignId}` : `G:${n.adGroupId}`
      this.standingIn.set(k, [...(this.standingIn.get(k) ?? []), n])
      this.standingById.set(n.id, n)
    }
    for (const d of input.decisions) this.decisions.set(d.term, d)
  }

  /** The campaign takes the brain's negatives: its lever OBSERVE or higher and it runs. */
  campaignOpen(id: string): boolean {
    const c = this.campaigns.get(id)
    return !!c && (c.lever === 'OBSERVE' || c.lever === 'PROPOSE' || c.lever === 'AUTO') && c.status === 'ENABLED'
  }
  /** The ad group takes them: its campaign open, it runs, and the Owner did not lock it. */
  groupOpen(id: string): boolean {
    const g = this.groups.get(id)
    if (!g || !this.campaignOpen(g.campaignId) || g.status === 'ARCHIVED' || g.status === 'PAUSED') return false
    return !this.campaigns.get(g.campaignId)!.lockedAdGroups.has(id)
  }
  kindOf(groupId: string): Kind {
    const g = this.groups.get(groupId)
    if (!g) return 'EMPTY'
    if ((this.campaigns.get(g.campaignId)?.targetingType ?? '').toUpperCase() === 'AUTO') return 'AUTO'
    if (g.positives.some((p) => p.match !== 'PRODUCT')) return 'KEYWORD'
    return g.positives.length ? 'PRODUCT' : 'EMPTY'
  }
  /** A keyword negative fits there (keywords or auto run there; a product-targeting ad group takes none, compile.ts). */
  takesKeywords(groupId: string): boolean {
    const k = this.kindOf(groupId)
    return k === 'AUTO' || k === 'KEYWORD'
  }
  standingOf(level: NegLevel, id: string): StandingNegative[] {
    return this.standingIn.get(level === 'CAMPAIGN' ? `C:${id}` : `G:${id}`) ?? []
  }
  /** The standing negative that blocks this term in this ad group (its own, or its campaign's), or null. */
  blockedIn(term: string, groupId: string): StandingNegative | null {
    const g = this.groups.get(groupId)
    if (!g) return null
    return [...this.standingOf('AD_GROUP', groupId), ...this.standingOf('CAMPAIGN', g.campaignId)].find((n) => standingBlocks(n, term)) ?? null
  }
  /** A standing negative there that already blocks everything a new one of this text and match would (or null). */
  coveredIn(text: string, match: NegMatch, groupId: string): StandingNegative | null {
    const g = this.groups.get(groupId)
    if (!g) return null
    return [...this.standingOf('AD_GROUP', groupId), ...this.standingOf('CAMPAIGN', g.campaignId)]
      .find((n) => (match === 'PHRASE' ? n.match === 'PHRASE' && holdsRun(text, n.text) : standingBlocks(n, text))) ?? null
  }
  /** Positives a negative at this level would land on (its ad group's, or every ad group's of its campaign). */
  positivesAt(level: NegLevel, campaignId: string, groupId: string | null): Positive[] {
    if (level === 'AD_GROUP') return [...(this.groups.get(groupId ?? '')?.positives ?? [])]
    return (this.groupsOf.get(campaignId) ?? []).flatMap((g) => [...g.positives])
  }
  placeOf(term: string): ReadonlyMap<string, TermEvidence> {
    return this.input.places.get(term) ?? new Map()
  }
}

// ── Building the adds ────────────────────────────────────────────────────────────────────────────────────────────

interface Draft extends Omit<NegItem, 'key' | 'mode' | 'heldBy'> { heldBy?: string | null }

function sumOver(places: ReadonlyMap<string, TermEvidence>, groupIds: Iterable<string>): TermEvidence {
  let e = NO_TERM_EVIDENCE
  for (const id of groupIds) e = addEvidence(e, places.get(id) ?? NO_TERM_EVIDENCE)
  return e
}

/**
 * Where a negative of `text` goes, given the ad groups (open ones) it should block in: an ASIN → each ad group; a keyword →
 * one campaign negative where two ad groups or more of a campaign take it (no locked ad group there, no positive blocked
 * anywhere in it), else each ad group. Places where it would block a positive come back held with the lock's words.
 */
function placements(f: Facts, text: string, match: NegMatch, groupIds: readonly string[], opts: { campaignLevel: boolean }): Array<{ level: NegLevel; campaignId: string; adGroupId: string | null; groupIds: string[]; heldBy: string | null }> {
  const out: Array<{ level: NegLevel; campaignId: string; adGroupId: string | null; groupIds: string[]; heldBy: string | null }> = []
  const byCampaign = new Map<string, string[]>()
  for (const id of groupIds) {
    const g = f.groups.get(id)
    if (!g) continue
    byCampaign.set(g.campaignId, [...(byCampaign.get(g.campaignId) ?? []), id])
  }
  for (const [campaignId, ids] of [...byCampaign].sort(([a], [b]) => a.localeCompare(b))) {
    const lockedHere = (f.campaigns.get(campaignId)?.lockedAdGroups.size ?? 0) > 0
    if (match !== 'PRODUCT' && opts.campaignLevel && ids.length >= 2 && !lockedHere && !blockedPositive({ text, match }, f.positivesAt('CAMPAIGN', campaignId, null))) {
      out.push({ level: 'CAMPAIGN', campaignId, adGroupId: null, groupIds: ids.sort(), heldBy: null })
      continue
    }
    for (const id of ids.sort()) {
      const own = blockedPositive({ text, match }, f.positivesAt('AD_GROUP', campaignId, id))
      out.push({
        level: 'AD_GROUP', campaignId, adGroupId: id, groupIds: [id],
        heldBy: own ? `it would block the product's own ${own.match === 'PRODUCT' ? `product target ${own.text}` : `${own.match.toLowerCase()} keyword "${own.text}"`} in ad group ${id} (the lock L1): never added there` : null,
      })
    }
  }
  return out
}

/** Terms a phrase may never block: converting, guarded, targeted, led, harvested, locked. Pieces of them are off limits. */
function guardedTerms(f: Facts): Set<string> {
  const out = new Set<string>()
  for (const d of f.input.decisions) {
    if (d.evidence.orders > 0 || d.protection || d.lead?.isThis || ['TARGETED', 'HARVEST_CANDIDATE', 'OWNED_BY_SIBLING', 'PROTECTED'].includes(d.state) || f.input.lockedTerms.has(d.term)) out.add(d.term)
  }
  for (const t of f.input.lockedTerms) out.add(t)
  return out
}

/** Why a phrase of this piece may not stand anywhere for the product, or null. */
function phraseRefusal(f: Facts, piece: string, guarded: ReadonlySet<string>): string | null {
  const hit = protectedTermHit(piece, 'NEGATIVE_PHRASE', f.input.protections)
  if (hit) return `it would block the protected term "${normaliseTerm(hit.protection.term)}"`
  const brand = brandWordIn(piece, f.input.brand) ?? f.input.brand.find((b) => holdsRun(b, piece)) ?? null
  if (brand) return `it would block the product's brand word "${brand}"`
  for (const t of guarded) if (holdsRun(t, piece)) return `it would block "${t}", a term the product converts on, targets, leads or protects`
  return null
}

/** A waste negative's term: the ledger negates it, or it is negated somewhere and the same test still passes. */
function wasteEligible(f: Facts, d: TermDecision): boolean {
  if (f.input.lockedTerms.has(d.term)) return false
  if (d.state === 'NEGATE_CANDIDATE') return !d.heldBy
  if (d.state !== 'NEGATED') return false
  const ownText = d.targets.some((t) => t.match === 'PHRASE' || t.match === 'BROAD')
  return d.tests.negate.pass && !d.tests.protection && d.evidence.orders === 0 && !d.lead?.isThis && !ownText
}

function spendGateCents(f: Facts): number | null {
  const t = f.input.targetAcos
  const aov = f.input.aovCents
  if (!t || aov == null || !(aov > 0)) return null
  return Math.round(SPEND_GATE_CPAS * aov * t.value)
}

function addDrafts(f: Facts): Draft[] {
  const drafts: Draft[] = []
  const termEv = (term: string) => f.decisions.get(term)?.evidence ?? NO_TERM_EVIDENCE
  const push = (d: Draft) => drafts.push(d)
  const openKeywordGroups = [...f.groups.values()].filter((g) => f.groupOpen(g.id) && f.takesKeywords(g.id)).map((g) => g.id).sort()

  // 1 — the playbook's product set (the Owner's own list), in every open keyword or auto ad group.
  for (const n of f.input.productSet) {
    const text = normaliseTerm(n.text)
    // The playbook's set is keywords (compile.ts); an ASIN belongs to its competitor list, not here.
    if (!text || isAsin(text)) continue
    const match: NegMatch = n.match === 'PHRASE' ? 'PHRASE' : 'EXACT'
    const groups = openKeywordGroups.filter((id) => !f.coveredIn(text, match, id))
    const protectedHit = protectedTermHit(text, match === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT', f.input.protections)
    const textProblem = negativeKeywordTextProblem(text, match === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT')
    for (const p of placements(f, text, match, groups, { campaignLevel: false })) {
      const places = f.placeOf(text)
      // An order where it lands (the exact term, or a term holding the phrase): a person decides (§2.7).
      const ordersThere = match === 'EXACT'
        ? (places.get(p.adGroupId!)?.orders ?? 0)
        : f.input.decisions.filter((d) => holdsRun(d.term, text)).reduce((s, d) => s + (f.placeOf(d.term).get(p.adGroupId!)?.orders ?? 0), 0)
      const ev = termEv(text)
      push({
        action: 'ADD', reasons: ['productSet'], kind: 'KEYWORD', match, text, level: p.level, campaignId: p.campaignId, adGroupId: p.adGroupId,
        askFirst: ordersThere > 0,
        heldBy: p.heldBy ?? (protectedHit ? `it would block the protected term "${normaliseTerm(protectedHit.protection.term)}"` : null) ?? (textProblem ? `Amazon would refuse it: ${textProblem}` : null),
        why: `the product's own negative set (playbook): ${negWords(match, text)} in every keyword and auto ad group of its own campaigns${ordersThere > 0 ? '; it had an order there in the window, so a person decides (§2.7)' : ''}`,
        evidence: { clicks: ev.clicks, orders: ev.orders, placeClicks: places.get(p.adGroupId!)?.clicks ?? 0, placeOrders: ordersThere, money: { spendCents: ev.spendCents, salesCents: ev.salesCents, placeSpendCents: places.get(p.adGroupId!)?.spendCents ?? 0 } },
      })
    }
  }

  // 2 — waste: the ledger's negatives, where the term still served.
  for (const d of f.input.decisions) {
    if (!wasteEligible(f, d)) continue
    const asin = d.isAsin
    const places = f.placeOf(d.term)
    const open = [...places].filter(([id, e]) => e.clicks > 0 && f.groupOpen(id) && !f.blockedIn(d.term, id) && (asin || f.takesKeywords(id))).map(([id]) => id)
    if (!open.length) continue
    const match: NegMatch = asin ? 'PRODUCT' : 'EXACT'
    for (const p of placements(f, d.term, match, open, { campaignLevel: true })) {
      const here = sumOver(places, p.groupIds)
      push({
        action: 'ADD', reasons: ['waste'], kind: asin ? 'PRODUCT' : 'KEYWORD', match, text: asin ? d.term.toUpperCase() : d.term, level: p.level, campaignId: p.campaignId, adGroupId: p.adGroupId,
        askFirst: d.askFirst || d.evidence.orders > 0, heldBy: p.heldBy,
        why: `waste: ${d.tests.negate.words}${d.state === 'NEGATED' ? ' — negated elsewhere already, still served here' : ''}; ${p.level === 'CAMPAIGN' ? `one campaign negative: it served in ${plural(p.groupIds.length, 'ad group')} of this campaign` : 'in the ad group where it served'}`,
        evidence: { clicks: d.evidence.clicks, orders: d.evidence.orders, placeClicks: here.clicks, placeOrders: here.orders, clicksNeeded: d.tests.negate.clicksNeeded, money: { spendCents: d.evidence.spendCents, salesCents: d.evidence.salesCents, placeSpendCents: here.spendCents, spendGateCents: d.tests.negate.spendGateCents } },
      })
    }
  }

  // 3 — n-grams: a piece that wastes across terms becomes one negative phrase where those terms served.
  const gate = spendGateCents(f)
  const guarded = guardedTerms(f)
  if (gate != null) {
    const need = Math.max(NGRAM_MIN_CLICKS, negateClicksNeeded(f.input.cr))
    const byPiece = new Map<string, { terms: string[]; ev: TermEvidence }>()
    for (const d of f.input.decisions) {
      if (d.isAsin || guarded.has(d.term) || d.evidence.orders > 0) continue
      for (const p of piecesOf(d.term)) {
        if (!pieceAllowed(p)) continue
        const was = byPiece.get(p) ?? { terms: [], ev: NO_TERM_EVIDENCE }
        byPiece.set(p, { terms: [...was.terms, d.term], ev: addEvidence(was.ev, d.evidence) })
      }
    }
    const passing = [...byPiece].filter(([piece, x]) => x.terms.length >= NGRAM_MIN_TERMS && x.ev.clicks >= need && x.ev.spendCents >= gate && !phraseRefusal(f, piece, guarded) && !f.input.lockedTerms.has(piece))
    // The most general piece wins: a passing piece that holds another passing piece adds nothing.
    const kept = passing.filter(([piece]) => !passing.some(([other]) => other !== piece && holdsRun(piece, other)))
    for (const [piece, x] of kept.sort(([a], [b]) => a.localeCompare(b))) {
      // Where the terms holding it served and are not blocked yet.
      const servedIn = new Set<string>()
      for (const t of x.terms) for (const [id, e] of f.placeOf(t)) if (e.clicks > 0 && f.groupOpen(id) && f.takesKeywords(id) && !f.blockedIn(t, id)) servedIn.add(id)
      if (!servedIn.size) continue
      for (const p of placements(f, piece, 'PHRASE', [...servedIn], { campaignLevel: true })) {
        const here = x.terms.reduce((e, t) => addEvidence(e, sumOver(f.placeOf(t), p.groupIds)), NO_TERM_EVIDENCE)
        push({
          action: 'ADD', reasons: ['ngram'], kind: 'KEYWORD', match: 'PHRASE', text: piece, level: p.level, campaignId: p.campaignId, adGroupId: p.adGroupId,
          askFirst: false, heldBy: p.heldBy,
          why: `a word that wastes across terms: "${piece}" is in ${plural(x.terms.length, 'search term')} with 0 orders and ${plural(x.ev.clicks, 'click')} between them; at the product's pooled conversion 0 orders in ${need} clicks is a 95 % call, and the spend is past the gate of ${SPEND_GATE_CPAS} target CPAs (${f.input.targetAcos!.source}); no term it would block converts, is targeted, led, protected or the brand`,
          evidence: { clicks: x.ev.clicks, orders: 0, placeClicks: here.clicks, placeOrders: here.orders, terms: x.terms.slice(0, 10), termCount: x.terms.length, clicksNeeded: need, money: { spendCents: x.ev.spendCents, salesCents: x.ev.salesCents, placeSpendCents: here.spendCents, spendGateCents: gate } },
        })
      }
    }
  }

  // 4 — isolation: a term with a live exact home goes there; the product's other ad groups negate it exact.
  for (const d of f.input.decisions) {
    if (d.state !== 'TARGETED' || f.input.lockedTerms.has(d.term)) continue
    const asin = d.isAsin
    const homes = [...f.groups.values()].filter((g) => f.campaigns.get(g.campaignId)?.status === 'ENABLED' && g.status === 'ENABLED'
      && g.positives.some((p) => p.live && (asin ? p.match === 'PRODUCT' && p.text.toLowerCase() === d.term : p.match === 'EXACT' && normaliseTerm(p.text) === d.term)))
    if (!homes.length) continue
    const homeIds = new Set(homes.map((g) => g.id))
    const places = f.placeOf(d.term)
    const home = sumOver(places, homeIds)
    const protectedHit = protectedTermHit(d.term, 'NEGATIVE_EXACT', f.input.protections)
    for (const [id, e] of [...places].sort(([a], [b]) => a.localeCompare(b))) {
      if (homeIds.has(id) || e.clicks <= 0 || !f.groupOpen(id) || f.blockedIn(d.term, id) || (!asin && !f.takesKeywords(id))) continue
      const proven = e.orders === 0 || home.orders > 0
      const [p] = placements(f, asin ? d.term.toUpperCase() : d.term, asin ? 'PRODUCT' : 'EXACT', [id], { campaignLevel: false })
      push({
        action: 'ADD', reasons: ['isolation'], kind: asin ? 'PRODUCT' : 'KEYWORD', match: asin ? 'PRODUCT' : 'EXACT', text: asin ? d.term.toUpperCase() : d.term,
        level: 'AD_GROUP', campaignId: p.campaignId, adGroupId: id, askFirst: false,
        heldBy: p.heldBy
          ?? (protectedHit ? `a protected term is never isolated ("${normaliseTerm(protectedHit.protection.term)}")` : null)
          ?? (proven ? null : `it converts here and its exact home has no order yet: a winner keeps running where it wins until its home proves itself (the Owner's handover rule, PB-7)`),
        why: `isolation: "${d.term}" has its exact home in ${plural(homes.length, 'ad group')} of the product (${[...homeIds].sort().join(', ')}); negated exact here so the product's own campaigns do not compete for it`,
        evidence: { clicks: d.evidence.clicks, orders: d.evidence.orders, placeClicks: e.clicks, placeOrders: e.orders, money: { spendCents: d.evidence.spendCents, salesCents: d.evidence.salesCents, placeSpendCents: e.spendCents } },
      })
    }
  }
  return drafts
}

// ── Retires: revive and duplicates ───────────────────────────────────────────────────────────────────────────────

function retireDraft(n: StandingNegative, reason: NegReason, why: string, extra: Partial<Draft> = {}, ev: TermEvidence = NO_TERM_EVIDENCE): Draft {
  return {
    action: 'RETIRE', reasons: [reason], kind: n.match === 'PRODUCT' ? 'PRODUCT' : 'KEYWORD', match: n.match, text: n.match === 'PRODUCT' ? n.text.toUpperCase() : n.text,
    level: n.level, campaignId: n.campaignId, adGroupId: n.level === 'CAMPAIGN' ? null : n.adGroupId, negativeId: n.id, origin: n.origin,
    askFirst: false, why, evidence: { clicks: ev.clicks, orders: ev.orders, money: { spendCents: ev.spendCents, salesCents: ev.salesCents } }, ...extra,
  }
}

/** The product's own standing exact / product negatives of this term in open campaigns. */
function sameTextNegatives(f: Facts, term: string): StandingNegative[] {
  return f.input.standing.filter((n) => n.match !== 'PHRASE' && n.text === term.toLowerCase() && f.campaignOpen(n.campaignId) && (n.level === 'CAMPAIGN' || !f.campaigns.get(n.campaignId)!.lockedAdGroups.has(n.adGroupId)))
}

function reviveDrafts(f: Facts): Draft[] {
  const out: Draft[] = []
  const seen = new Set<string>()
  const add = (n: StandingNegative, reason: NegReason, why: string, ev: TermEvidence) => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    const person = n.origin === 'person' || n.origin === 'unknown'
    const phrase = n.match === 'PHRASE'
    const ask = person ? `; it is ${n.origin === 'person' ? 'a person\'s negative' : 'a negative Nexus cannot attribute (made at Amazon or before its records)'}, so a person decides`
      : phrase ? '; a phrase also blocks other searches there, so a person decides' : ''
    out.push(retireDraft(n, reason, `${why}${ask}`, { askFirst: person || phrase }, ev))
  }
  for (const d of f.input.decisions) {
    if (f.input.lockedTerms.has(d.term)) continue
    // The ledger's clashes AB-9 handed over: a negative that blocks the product's own keyword in its place.
    for (const c of d.clashes) {
      if (c.kind !== 'self-blocking' || !c.negativeId) continue
      const n = f.standingById.get(c.negativeId)
      if (n && f.campaignOpen(n.campaignId)) add(n, 'reviveSelfBlocking', `revive: ${c.what} — the keyword stays (a home is never negated over)`, d.evidence)
    }
    // A protected term or the product's brand word under a negative.
    if (d.state === 'PROTECTED' && d.protection && d.protection !== 'winner') {
      for (const n of sameTextNegatives(f, d.term)) add(n, 'reviveProtected', `revive: ${d.tests.protectionWhy} is blocked by a ${negWords(n.match, n.text)} at its ${levelWords(n.level)} — a protected term is never negated`, d.evidence)
    }
    // The product now leads the term in the market, and a negative of its own blocks it.
    if (d.state === 'NEGATED' && d.lead?.isThis) {
      for (const n of sameTextNegatives(f, d.term)) add(n, 'reviveLead', `revive: the product now leads "${d.term}" in the market (${d.lead.rule}) and its own ${negWords(n.match, n.text)} blocks it`, d.evidence)
    }
    // Evidence improved: it converted where a negative blocks it now (never an isolation or a graduation's source).
    if (d.evidence.orders > 0 && d.state !== 'TARGETED' && d.state !== 'HARVEST_CANDIDATE') {
      const places = f.placeOf(d.term)
      for (const n of sameTextNegatives(f, d.term)) {
        const where = n.level === 'CAMPAIGN' ? (f.groupsOf.get(n.campaignId) ?? []).map((g) => g.id) : [n.adGroupId]
        const there = sumOver(places, where)
        if (there.orders > 0) add(n, 'reviveConverts', `revive: "${d.term}" converted where this ${negWords(n.match, n.text)} blocks it now (${plural(there.orders, 'order')} at its ${levelWords(n.level)} in the window) — evidence improved`, there)
      }
    }
  }
  return out
}

type StandingIndex = { standingOf(level: NegLevel, id: string): StandingNegative[] }

/**
 * The live negatives in the same place that block everything this one blocks: a phrase holding its words, the same
 * negative at the campaign over one at its ad group, or its older twin (a newer twin never covers an older one, so two
 * negatives never cover each other). One that shares its Amazon id is the same negative, never a cover.
 */
export function coversOf(n: StandingNegative, f: StandingIndex): StandingNegative[] {
  const pool = [...(n.level === 'AD_GROUP' ? f.standingOf('AD_GROUP', n.adGroupId) : []), ...f.standingOf('CAMPAIGN', n.campaignId)]
  const older = (a: StandingNegative, b: StandingNegative) => a.createdAt.getTime() < b.createdAt.getTime() || (a.createdAt.getTime() === b.createdAt.getTime() && a.id < b.id)
  return pool.filter((c) => {
    if (c.id === n.id || !c.live || (c.externalTargetId && c.externalTargetId === n.externalTargetId)) return false
    if (n.match === 'PRODUCT') return c.match === 'PRODUCT' && c.text === n.text && n.level === 'AD_GROUP' && c.adGroupId === n.adGroupId && (!n.live || older(c, n))
    if (c.match === 'PRODUCT') return false
    const same = c.match === n.match && c.text === n.text
    if (same) return (c.level === 'CAMPAIGN' && n.level === 'AD_GROUP') || (c.level === n.level && (!n.live || older(c, n)))
    return c.match === 'PHRASE' && holdsRun(n.text, c.text)
  })
}

/** The cover a duplicate retire names: one nothing covers itself (it stays), else the first; null: nothing covers it. */
export function coverOf(n: StandingNegative, f: StandingIndex): StandingNegative | null {
  const covers = coversOf(n, f)
  return covers.find((c) => !coversOf(c, f).length) ?? covers[0] ?? null
}

function duplicateDrafts(f: Facts, entities: Map<string, { standing: number; warn: number; level: NegLevel; id: string }>): Draft[] {
  const out: Draft[] = []
  for (const e of [...entities.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (e.standing < e.warn) continue
    for (const n of f.standingOf(e.level, e.id)) {
      if (n.origin !== 'brain' && n.origin !== 'automation') continue
      if (n.level === 'AD_GROUP' && f.campaigns.get(n.campaignId)?.lockedAdGroups.has(n.adGroupId)) continue
      const c = coverOf(n, f)
      if (!c) continue
      out.push(retireDraft(n, 'duplicate', `duplicate near the limit: ${negWords(c.match, c.text)} at its ${levelWords(c.level)} already blocks what this ${negWords(n.match, n.text)} blocks — retiring it frees a slot and changes no search (§2.7)`, { coverId: c.id }))
    }
  }
  return out
}

/** At the warning level: a word recurring in 3+ exact negatives an engine made → one phrase there (they retire later). */
function consolidateDrafts(f: Facts, entities: Map<string, { standing: number; warn: number; level: NegLevel; id: string; campaignId: string }>, guarded: ReadonlySet<string>): Draft[] {
  const out: Draft[] = []
  for (const e of [...entities.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (e.standing < e.warn) continue
    if (e.level === 'AD_GROUP' && !f.takesKeywords(e.id)) continue
    const exacts = f.standingOf(e.level, e.id).filter((n) => n.match === 'EXACT' && (n.origin === 'brain' || n.origin === 'automation'))
    const standingPhrases = f.standingOf(e.level, e.id).filter((n) => n.match === 'PHRASE')
    const count = new Map<string, string[]>()
    for (const n of exacts) for (const p of piecesOf(n.text, 2)) if (pieceAllowed(p)) count.set(p, [...(count.get(p) ?? []), n.text])
    const ranked = [...count].filter(([p, ts]) => ts.length >= CONSOLIDATE_MIN_EXACTS && !standingPhrases.some((s) => holdsRun(p, s.text)) && !phraseRefusal(f, p, guarded) && !f.input.lockedTerms.has(p)
      && !blockedPositive({ text: p, match: 'PHRASE' }, f.positivesAt(e.level, e.campaignId, e.level === 'AD_GROUP' ? e.id : null)))
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    const taken: string[] = []
    for (const [piece, ts] of ranked) {
      if (taken.length >= CONSOLIDATE_PER_ENTITY) break
      if (taken.some((t) => holdsRun(piece, t) || holdsRun(t, piece))) continue
      taken.push(piece)
      out.push({
        action: 'ADD', reasons: ['consolidate'], kind: 'KEYWORD', match: 'PHRASE', text: piece, level: e.level, campaignId: e.campaignId, adGroupId: e.level === 'AD_GROUP' ? e.id : null,
        askFirst: false,
        why: `near the limit (${plural(e.standing, 'negative')}, warning at ${e.warn}): "${piece}" recurs in ${plural(ts.length, 'exact negative')} here — one negative phrase holds them, and they retire once it is live (§2.7); no term it would block converts, is targeted, led, protected or the brand`,
        evidence: { clicks: 0, orders: 0, terms: ts.slice(0, 10), termCount: ts.length, money: { spendCents: 0, salesCents: 0 } },
      })
    }
  }
  return out
}

// ── Levels, the budget and the caps ──────────────────────────────────────────────────────────────────────────────

export function shadowState(gates: NegativesInput['gates'], now: Date): NegativesPlan['shadow'] {
  // A start after `now` (a clock between the database and this process) counts as 0 days run, never as minus.
  const daysRun = gates.shadowSince ? Math.max(0, Math.floor((now.getTime() - gates.shadowSince.getTime()) / DAY_MS)) : null
  if (!gates.ceilingLive) return { inShadow: true, why: 'the server switch NEXUS_BID_BRAIN_MODE is not live: the brain decides and logs, and writes and asks nothing', daysRun, days: gates.shadowDays, ceilingLive: false }
  if (daysRun == null || daysRun < gates.shadowDays) {
    return { inShadow: true, why: `the negatives lever runs ${plural(gates.shadowDays, 'day')} in shadow first (§10; the Owner's negativesShadowDays changes it): ${daysRun == null ? 'not started' : `${plural(daysRun, 'day')} run`}`, daysRun, days: gates.shadowDays, ceilingLive: true }
  }
  return { inShadow: false, why: null, daysRun, days: gates.shadowDays, ceilingLive: true }
}

function modeOf(c: NegCampaign, askFirst: boolean, shadow: NegativesPlan['shadow']): { mode: NegMode; note: string | null } {
  const lever = c.lever === 'AUTO' ? (askFirst ? 'PROPOSE' : 'AUTO') : c.lever === 'PROPOSE' ? 'PROPOSE' : 'OBSERVE'
  if (lever !== 'OBSERVE' && shadow.inShadow) return { mode: 'OBSERVE', note: `at ${c.lever}, shadow for now: ${shadow.why}` }
  return { mode: lever, note: null }
}

/**
 * The product's negatives plan for the day. Pure. Adds and retires merged by place (one item per negative), each with its
 * level, then the per-entity budget (retires first) and the day's caps, both in priority order.
 */
export function decideNegatives(input: NegativesInput): NegativesPlan {
  const f = new Facts(input)
  const shadow = shadowState(input.gates, input.now)
  const skipped = input.campaigns.filter((c) => !f.campaignOpen(c.id)).map((c) => ({
    campaignId: c.id, name: c.name,
    why: c.status !== 'ENABLED' && (c.lever === 'OBSERVE' || c.lever === 'PROPOSE' || c.lever === 'AUTO') ? `not running (${c.status}): a negative there blocks nothing now` : c.leverWhy,
  })).sort((a, b) => a.campaignId.localeCompare(b.campaignId))

  // Entities and what stands in them now.
  const entities = new Map<string, { kind: 'CAMPAIGN' | 'AD_GROUP'; level: NegLevel; id: string; campaignId: string; name: string; standing: number; adds: number; retires: number; warn: number; max: number }>()
  for (const c of input.campaigns) {
    if (!f.campaignOpen(c.id)) continue
    entities.set(`C:${c.id}`, { kind: 'CAMPAIGN', level: 'CAMPAIGN', id: c.id, campaignId: c.id, name: c.name, standing: f.standingOf('CAMPAIGN', c.id).length, adds: 0, retires: 0, warn: c.warn, max: c.max })
    for (const g of f.groupsOf.get(c.id) ?? []) {
      if (!f.groupOpen(g.id)) continue
      entities.set(`G:${g.id}`, { kind: 'AD_GROUP', level: 'AD_GROUP', id: g.id, campaignId: c.id, name: g.name, standing: f.standingOf('AD_GROUP', g.id).length, adds: 0, retires: 0, warn: c.warn, max: c.max })
    }
  }
  const guarded = guardedTerms(f)
  const drafts = [...reviveDrafts(f), ...duplicateDrafts(f, entities), ...addDrafts(f), ...consolidateDrafts(f, entities, guarded)]

  // One item per negative: the same negative from two reasons merges (the first reason's words lead).
  const byKey = new Map<string, NegItem>()
  for (const d of drafts) {
    const key = itemKey({ ...d })
    const was = byKey.get(key)
    if (was) {
      for (const r of d.reasons) if (!was.reasons.includes(r)) was.reasons.push(r)
      was.askFirst ||= d.askFirst
      if (!was.heldBy && d.heldBy) was.heldBy = d.heldBy
      continue
    }
    byKey.set(key, { ...d, key, mode: 'OBSERVE', heldBy: d.heldBy ?? null })
  }
  // A planned phrase covers a planned exact in the same place: the exact is not needed.
  const adds = [...byKey.values()].filter((i) => i.action === 'ADD')
  for (const i of adds) {
    if (i.match !== 'EXACT') continue
    const cover = adds.find((p) => p !== i && p.match === 'PHRASE' && !p.heldBy && holdsRun(i.text, p.text)
      && (p.level === 'CAMPAIGN' ? p.campaignId === i.campaignId : p.adGroupId === i.adGroupId))
    if (cover) byKey.delete(i.key)
  }

  const items = [...byKey.values()]
  for (const i of items) {
    const c = f.campaigns.get(i.campaignId)!
    const m = modeOf(c, i.askFirst, shadow)
    i.mode = m.mode
    if (m.note) i.why = `${i.why} (${m.note})`
  }

  // The budget and the caps: retires first (revives in their cap), then adds by priority.
  const entityOf = (i: NegItem) => entities.get(i.level === 'CAMPAIGN' ? `C:${i.campaignId}` : `G:${i.adGroupId}`)
  // By priority, then the most waste where it lands (the place's own spend, else the term's), then the key (deterministic).
  const spendOf = (i: NegItem) => i.evidence.money.placeSpendCents ?? i.evidence.money.spendCents
  const order = (a: NegItem, b: NegItem) => ADD_PRIORITY[a.reasons[0]] - ADD_PRIORITY[b.reasons[0]] || spendOf(b) - spendOf(a) || b.evidence.clicks - a.evidence.clicks || a.key.localeCompare(b.key)
  let revives = input.caps.revivedToday
  let duplicates = 0
  const counted = input.caps.actedKeys ?? new Set<string>()
  for (const i of items.filter((x) => x.action === 'RETIRE').sort(order)) {
    if (i.heldBy) continue
    const isRevive = i.reasons.some((r) => REVIVES.has(r))
    if (counted.has(i.key)) { const e = entityOf(i); if (e) e.retires++; continue }
    if (isRevive && revives >= REVIVES_PER_DAY) { i.heldBy = `past today's cap of ${REVIVES_PER_DAY} revives for this product: held for a later day`; continue }
    if (!isRevive && duplicates >= RETIRES_PER_RUN) { i.heldBy = `past this run's ${RETIRES_PER_RUN} duplicate retires: the rest on a later day`; continue }
    if (isRevive) revives++
    else duplicates++
    const e = entityOf(i)
    if (e) e.retires++
  }
  let used = input.caps.usedToday
  for (const i of items.filter((x) => x.action === 'ADD').sort(order)) {
    if (i.heldBy) continue
    const e = entityOf(i)
    if (!e) { i.heldBy = 'its place is not open to the brain'; continue }
    if (e.standing + e.adds - e.retires + 1 > e.max) {
      i.heldBy = `the ${levelWords(e.level)} "${e.name}" holds ${plural(e.standing + e.adds - e.retires, 'negative')}: never more than ${e.max} (Amazon allows ${AMAZON_ENTITY_LIMIT.toLocaleString('en-US')}; §2.7) — held until duplicates retire`
      continue
    }
    if (counted.has(i.key)) { e.adds++; continue }
    if (used >= input.caps.perDay) { i.heldBy = `past today's cap of ${plural(input.caps.perDay, 'new negative')} for this product (§5): held for a later day`; continue }
    used++
    e.adds++
  }

  const budgets: EntityBudget[] = [...entities.values()].map((e) => {
    const after = e.standing + e.adds - e.retires
    return { kind: e.kind, id: e.id, campaignId: e.campaignId, name: e.name, standing: e.standing, adds: e.adds, retires: e.retires, after, warn: e.warn, max: e.max, state: (after >= e.max || e.standing >= e.max ? 'full' : after >= e.warn || e.standing >= e.warn ? 'warn' : 'ok') as EntityBudget['state'] }
  }).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'CAMPAIGN' ? -1 : 1) || a.campaignId.localeCompare(b.campaignId) || a.id.localeCompare(b.id))

  const sorted = items.sort((a, b) => (a.action === b.action ? 0 : a.action === 'ADD' ? -1 : 1) || order(a, b))
  const byReason: Partial<Record<NegReason, number>> = {}
  const byMode: Partial<Record<NegMode, number>> = {}
  for (const i of sorted) {
    byReason[i.reasons[0]] = (byReason[i.reasons[0]] ?? 0) + 1
    if (!i.heldBy) byMode[i.mode] = (byMode[i.mode] ?? 0) + 1
  }
  return {
    items: sorted, entities: budgets, skipped, shadow,
    counts: { adds: sorted.filter((i) => i.action === 'ADD' && !i.heldBy).length, retires: sorted.filter((i) => i.action === 'RETIRE' && !i.heldBy).length, held: sorted.filter((i) => i.heldBy).length, byReason, byMode },
  }
}

// ── What the run does with each item, given the log (pure) ───────────────────────────────────────────────────────

export const NEG_STATUSES = ['SHADOW', 'HELD', 'PLANNED', 'PROPOSED', 'REJECTED', 'WRITTEN', 'QUEUED', 'REFUSED', 'FAILED'] as const
export type NegStatus = (typeof NEG_STATUSES)[number]

export interface PreviousRow { key: string; status: string; approvalId: string | null; actedAt: Date | null }
export interface ApprovalFact { status: string; decidedAt: Date | null }

export interface Reconciled { status: NegStatus; act: 'write' | 'propose' | null; approvalId: string | null; actedAt: Date | null; note: string | null }

const sameUtcDay = (a: Date, b: Date) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)
const WAITING = new Set(['pending', 'scheduled', 'executing'])

/**
 * One item against what the log holds for it: a request still waiting is not asked again; a rejected one waits
 * REJECTED_HOLD_DAYS; a write, refusal or failure today is not tried again today (idempotent reruns); else its level acts.
 */
export function reconcile(item: Pick<NegItem, 'mode' | 'heldBy'>, prev: PreviousRow | undefined, approval: ApprovalFact | undefined, now: Date): Reconciled {
  const keep = (status: NegStatus, note: string | null = null): Reconciled => ({ status, act: null, approvalId: prev?.approvalId ?? null, actedAt: prev?.actedAt ?? null, note })
  if (prev?.status === 'PROPOSED' && prev.approvalId) {
    if (!approval || WAITING.has(approval.status)) return keep('PROPOSED', 'asked already: the request waits for a person')
    if (approval.status === 'rejected') return { status: 'REJECTED', act: null, approvalId: prev.approvalId, actedAt: approval.decidedAt ?? now, note: `the Owner rejected it: not asked again for ${REJECTED_HOLD_DAYS} days` }
  }
  if (prev?.status === 'REJECTED' && prev.actedAt && now.getTime() - prev.actedAt.getTime() < REJECTED_HOLD_DAYS * DAY_MS) {
    return keep('REJECTED', `the Owner rejected it on ${prev.actedAt.toISOString().slice(0, 10)}: not asked again for ${REJECTED_HOLD_DAYS} days`)
  }
  if (prev && ['WRITTEN', 'QUEUED', 'REFUSED', 'FAILED'].includes(prev.status) && prev.actedAt && sameUtcDay(prev.actedAt, now)) {
    return keep(prev.status as NegStatus, 'done today already: not tried again before tomorrow')
  }
  if (item.heldBy) return { status: 'HELD', act: null, approvalId: null, actedAt: null, note: null }
  if (item.mode === 'OBSERVE') return { status: 'SHADOW', act: null, approvalId: null, actedAt: null, note: null }
  return { status: 'PLANNED', act: item.mode === 'AUTO' ? 'write' : 'propose', approvalId: null, actedAt: null, note: null }
}

/** When the negatives lever's shadow began: the enrollment, after the last time the Owner had the product's lever OFF. */
export function shadowSinceOf(enrolledAt: Date | null, levelRows: ReadonlyArray<{ value: unknown; createdAt: Date; endedAt: Date | null }>, now: Date): Date | null {
  if (!enrolledAt) return null
  let since = enrolledAt
  for (const r of levelRows) {
    if (r.value !== 'OFF') continue
    if (!r.endedAt) return null // OFF now: no shadow runs
    if (r.endedAt.getTime() > since.getTime() && r.endedAt.getTime() <= now.getTime()) since = r.endedAt
  }
  return since
}

/** A term's key as the ledger stores it (an ASIN in lower case). */
export const negTermKey = (s: string): string => (isAsin(s) ? s.trim().toLowerCase() : termKey(s))
