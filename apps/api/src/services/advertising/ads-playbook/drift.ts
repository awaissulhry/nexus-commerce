/**
 * ADS PLAYBOOK PB-10 — drift, pure: where what is live differs from what one product's playbook compiles to in one
 * market (design report 9 §5.5). Nothing here reads a database or calls Amazon; drift-load.ts reads the facts.
 *
 *   counts as drift                                                       how sync fixes it (add-only)
 *   a slot with no campaign, or whose campaign was archived               builds the slot (the SP Super Wizard's launch,
 *                                                                         at the floor, off the allowlist) — adds spend
 *   a slot's campaign paused at Amazon                                    none: enable-ads (W2) — adds spend
 *   a slot's campaign of the wrong targeting (Auto ↔ manual)              none: Amazon never changes it (archive + build)
 *   a campaign advertising the product outside every slot                 none: listed, never adopted by itself
 *   a child listed in the market but not advertised in a slot             adds its product ad — adds spend
 *   a keyword or competitor ASIN the product's terms feed into a slot,    adds it at the floor, its planned bid
 *   missing there                                                         remembered — adds spend
 *   a keyword in a slot of the wrong match type or intent                 adds it in its right slot (the misplaced one
 *                                                                         stays: sync never removes) — adds spend; a
 *                                                                         term that WINS where it is stays (Owner rule 2)
 *   a missing isolation, source or product negative                       adds it through the negative write service —
 *                                                                         lowers spend
 *   a placement that differs from the baseline in a slot the hourly       none: set-placement-multipliers (W2)
 *   plans do not own (never a performance slot: rank owns those). A
 *   built slot's baseline is the playbook's placements; an adopted one's
 *   is what its campaign held when it was adopted (adoptedPlacements) —
 *   one adopted before that is listed once: no baseline yet, keep it
 *   a compiled artifact (harvest rule, isolation rule, rank group)        re-saves it (Nexus only)
 *   missing or changed against its compiled version (artifacts.ts)
 *   portfolio membership                                                  none: named
 *   a name that differs                                                   warn only
 *
 * NOT drift: bids and budgets moved by the engines, Claude or a person (value drift), auto groups (Amazon makes them),
 * keywords the harvest added in their own home. Rule 3: only the product's OWN ad groups (advertising nothing but this
 * product) get a write; a term another product buys is never drift here.
 *
 * A change a person made himself (the ads audit names `user:` and it is not one of the playbook's own applies) is
 * marked `byPerson` and offered as KEEP (written into the product row: its overrides or its terms, through
 * set-ads-playbook) or REVERT (sync, only when the request names it) — never put back silently.
 */
import { routeIntent } from '../ads-harvest-route.js'
import { negativeKeywordTextProblem, protectedTermHit, type ProtectedTerm } from '../ads-negation-policy.js'
import { normaliseNegTerm } from '../ads-protect-converting.js'
import { blockedPositive, negativeBlocksTerm, negativeKey, type Positive } from '../ads-winner-lock.js'
import type { KindExpectation } from './artifacts.js'
import type { ProductTerms, Slot, TemplateDoc } from './doc.js'
import type { IsolationKind, PlannedNegative } from './isolation.js'
import { canonical } from './rules.js'

export const DRIFT_KINDS = [
  'slot_missing', 'slot_paused', 'targeting_wrong', 'outside_campaign', 'product_ad_missing', 'product_ad_archived',
  'positive_missing', 'positive_archived', 'positive_misplaced', 'negative_missing', 'placement_differs', 'placement_baseline_missing',
  'portfolio_membership', 'name_differs', 'artifact_missing', 'artifact_changed',
] as const
export type DriftKind = (typeof DRIFT_KINDS)[number]

/** What a sync writes, part by part: negatives lower spend; positives, product ads and slots add it; artifacts are Nexus only. */
export const SYNC_PARTS = ['negatives', 'positives', 'productAds', 'slots', 'artifacts'] as const
export type SyncPart = (typeof SYNC_PARTS)[number]
export const SPEND_PARTS: ReadonlySet<SyncPart> = new Set(['positives', 'productAds', 'slots'])

export type DriftFix =
  | { by: 'sync'; part: SyncPart; addsSpend: boolean }
  | { by: 'tool'; tool: string; args: Record<string, unknown>; addsSpend: boolean; note: string }
  | { by: 'none'; note: string }

/**
 * A change a person made himself (the ads audit, never one of Claude's approved or by-rule requests): who, when, its
 * action, and `changed` — the keys whose value differs between its before and after (a full snapshot that also holds an
 * unchanged status is no status change). `unknownAuthor`: it was undone and no record says who (at Amazon, or in Nexus
 * without a row) — treated as a person's, never put back by rule.
 */
export interface PersonChange { userId: string; at: string; action: string; changed?: string[]; unknownAuthor?: true }
/** Someone lifted it and nothing says who. */
export const UNKNOWN_AUTHOR: PersonChange = { userId: 'unknown', at: '', action: 'lifted', unknownAuthor: true }

/** Which of a person's changes explains which drift: a status change, a placement, a rule's own settings (not its switch). */
const STATUS_CHANGE = (c: PersonChange) => (c.changed ? c.changed.some((k) => k === 'status' || k === 'state') : /archive|retire|pause|delete/i.test(c.action))
const PLACEMENT_CHANGE = (c: PersonChange) => c.action === 'update_placement_bidding'
const RULE_EDIT = (c: PersonChange) => c.action === 'update_rule' && (c.changed ?? []).some((k) => k !== 'enabled' && k !== 'autonomyLevel')

export interface DriftItem {
  /** Stable while the drift stands: what `fix` and `revert` of apply-ads-playbook op sync name. */
  key: string
  kind: DriftKind
  slot: string | null
  says: string
  fix: DriftFix
  campaignId?: string
  adGroupId?: string
  term?: string
  match?: string
  targetKind?: 'KEYWORD' | 'PRODUCT'
  asin?: string
  sku?: string
  /** A missing product ad: the product its SKU is (the ad sync adds names it). */
  productId?: string
  /** A positive's planned bid (born at the floor; this is the bid remembered for it). */
  startBidCents?: number
  /** A misplaced keyword: where sync adds it (its right slot); the item's own slot is where it was found. */
  into?: { slot: string; campaignId: string; adGroupId: string }
  negative?: { of: 'isolation' | 'source' | 'product'; kind?: IsolationKind; ownerTargetId?: string; owner?: string }
  artifact?: { kind: string; refId: string | null; parts: string[] }
  byPerson?: PersonChange
  keep?: { tool: 'set-ads-playbook'; args: Record<string, unknown>; note: string } | { note: string }
  revert?: DriftFix
  warnOnly?: true
}

export interface DriftReport {
  items: DriftItem[]
  /** What the playbook expects but is left alone on purpose (the lock, a protected term, a winner, a term held elsewhere). */
  heldBack: Array<{ slot: string | null; what: string; why: string }>
  notChecked: string[]
  counts: { items: number; bySync: number; addsSpend: number; byPerson: number; viaTool: number; none: number; warnOnly: number }
}

export interface DriftSlotFacts {
  slot: Slot
  /** The live link: its campaign and ad group. */
  link: { campaignId: string; adGroupId: string | null; origin: 'built' | 'adopted' } | null
  /** A link whose campaign is archived or gone: the slot is missing again. */
  lost: { campaignId: string; status: string } | null
}

export interface DriftCampaign {
  id: string
  name: string
  status: string
  targetingType: string | null
  portfolioId: string | null
  liveWrites: boolean
  placements: { top: number; productPage: number; restOfSearch: number }
}

export interface ExpectedSlot {
  /** The slot's start bid (the ladder clamped to the strategy's band): a keyword added there is planned at it. */
  startBidCents: number
  keywords: Array<{ text: string; match: 'BROAD' | 'PHRASE' | 'EXACT'; bidCents: number; gated: boolean }>
  productTargets: Array<{ asin: string; bidCents: number }>
}

export interface DriftFacts {
  market: string
  product: { productId: string; sku: string }
  /** The PRODUCT row that holds the playbook: keep writes there. */
  playbook: { id: string; version: number; state: string | null; scopeId: string }
  doc: TemplateDoc
  nameToken: string
  terms: ProductTerms
  skipSlots: readonly string[]
  /** Each adopted slot's placements as its campaign held them when adopted (the product row's overrides): its baseline. */
  adoptedPlacements: Readonly<Record<string, { top: number; productPage: number; restOfSearch: number }>>
  slots: readonly DriftSlotFacts[]
  campaigns: ReadonlyMap<string, DriftCampaign>
  /** Rule 3: the ad groups of the product's own scope (advertising nothing but this product). Only these get a write. */
  scope: ReadonlySet<string>
  /** Slot ad groups that advertise no product at all: the product's own ads may be added there (nothing else). */
  empty: ReadonlySet<string>
  positives: ReadonlyMap<string, readonly Positive[]>
  archived: {
    positives: ReadonlyMap<string, ReadonlyArray<{ id: string; text: string; match: string }>>
    /** negativeKey → the archived negative's AdTarget.id. */
    negatives: ReadonlyMap<string, string>
    /** Ad group → the ASINs whose product ad there is archived (upper case). */
    productAds: ReadonlyMap<string, ReadonlySet<string>>
  }
  standing: ReadonlySet<string>
  winners: ReadonlyMap<string, ReadonlySet<string>>
  protections: ReadonlyMap<string, readonly ProtectedTerm[]>
  /** Ad group → the ASINs it advertises now (upper case). */
  productAds: ReadonlyMap<string, ReadonlySet<string>>
  expectedAds: ReadonlyArray<{ asin: string; skus: string[]; productIds?: string[] }>
  /** The compiled expectation per slot (compile.ts, every slot as if none were built); null when it does not compile. */
  expected: ReadonlyMap<string, ExpectedSlot> | null
  isolation: { adds: readonly PlannedNegative[] } | null
  source: readonly PlannedNegative[]
  /** Terms (normalised) the product's own campaigns outside the playbook already buy: rule 2, they stay there. */
  heldOutside: ReadonlySet<string>
  outside: ReadonlyArray<{ campaignId: string; name: string; status: string; inPlaybook: boolean }>
  portfolioId: string | null
  /** The changes people made themselves, newest first, by entity id (not one of the playbook's own applies). */
  personal: ReadonlyMap<string, readonly PersonChange[]>
  /**
   * Negatives the playbook made that were removed outright (a Nexus-only one retired is deleted, not archived), by
   * `MATCH|term`: who did it when a row says, else null (unknown author).
   */
  liftedElsewhere: ReadonlyMap<string, PersonChange | null>
  /** Slot campaigns an enabled hourly plan holds (the playbook's or the Owner's), with its name: rank owns their placements. */
  hourlyPlans: ReadonlyMap<string, string>
  artifacts: {
    expectations: readonly KindExpectation[]
    notChecked: ReadonlyArray<{ kind: string; why: string }>
    /** Campaigns an hourly plan the playbook did not make holds (the Owner's own): listed as held, never drift. */
    held: ReadonlyArray<{ kind: string; campaignId: string; name: string; by: string }>
  }
  notChecked: readonly string[]
}

const norm = (s: string) => normaliseNegTerm(s)
const keyOf = (...parts: Array<string | null | undefined>) => parts.map((p) => (p ?? '').toString().trim().toLowerCase().replace(/\s+/g, ' ')).join('|').slice(0, 200)
const PLACEMENT_KEYS = ['top', 'productPage', 'restOfSearch'] as const
const ISOLATION_SWITCH: Record<IsolationKind, keyof TemplateDoc['isolation']> = {
  exactIntoResearch: 'exactIntoResearch',
  brandPhrase: 'brandPhraseIntoCategoryAndCompetitor',
  phraseIntoBroadAndAuto: 'phraseIntoBroadAndAuto',
}

/** The name the playbook gives a slot's campaign (compile.ts, adopt.ts: the same pattern). */
export function slotNameOf(doc: TemplateDoc, slot: Slot, nameToken: string, market: string): string {
  return doc.structure.naming.pattern
    .split('{product}').join(nameToken)
    .split('{market}').join(market)
    .split('{parts}').join(slot.nameParts.join(doc.structure.naming.partSeparator))
    .trim()
}

/** A term's intent for this product: its own lists first, then the harvest router's words (brand, competitor, else category). */
function intentOf(term: string, terms: ProductTerms, nameToken: string): 'BRAND' | 'COMPETITOR' | 'CATEGORY' {
  const t = norm(term)
  if (terms.brand.some((b) => norm(b) === t)) return 'BRAND'
  if (terms.competitor.some((c) => norm(c) === t)) return 'COMPETITOR'
  if (terms.category.some((c) => norm(c.text) === t)) return 'CATEGORY'
  return routeIntent(term, { brand: [nameToken, ...terms.brand], competitor: terms.competitor })
}

export function findDrift(f: DriftFacts): DriftReport {
  const items: DriftItem[] = []
  const heldBack: DriftReport['heldBack'] = []
  const notChecked = [...f.notChecked]
  const doc = f.doc
  const keepArgs = (values: Record<string, unknown>, note: string, reason: string) => ({
    tool: 'set-ads-playbook' as const,
    args: { kind: 'playbook', market: f.market, level: 'product', productId: f.playbook.scopeId, values, expectVersion: f.playbook.version, reason },
    note,
  })
  const latest = (id: string | undefined | null, explains: (c: PersonChange) => boolean) => (id ? (f.personal.get(id) ?? []).find(explains) : undefined)
  const groupOf = (s: DriftSlotFacts) => s.link?.adGroupId ?? null
  const live = f.slots.filter((s) => s.link && f.campaigns.has(s.link.campaignId))
  const placementsDeferred = new Set<string>()
  const noBaseline: Array<{ slot: string; live: DriftCampaign['placements'] }> = []

  // ── The slots and their campaigns ──────────────────────────────────────────────────────────
  for (const s of f.slots) {
    const slot = s.slot
    if (!s.link) {
      const person = s.lost ? latest(s.lost.campaignId, STATUS_CHANGE) : undefined
      const fix: DriftFix = { by: 'sync', part: 'slots', addsSpend: true }
      items.push({
        key: keyOf('slot_missing', slot.key), kind: 'slot_missing', slot: slot.key,
        says: s.lost
          ? `The slot "${slot.key}" has no live campaign: the one it held is ${s.lost.status === 'ARCHIVED' ? 'archived' : 'gone from Nexus'}. Sync builds it again (born at the floor, off the live-write allowlist).`
          : `The slot "${slot.key}" has no campaign. Sync builds it (born at the floor, off the live-write allowlist).`,
        fix,
        ...(s.lost ? { campaignId: s.lost.campaignId } : {}),
        ...(person ? {
          byPerson: person,
          keep: slot.optional
            ? keepArgs({ overrides: { skipSlots: [...new Set([...f.skipSlots, slot.key])] } }, `Leaves the optional slot "${slot.key}" out of this product's playbook (skipSlots): it is never built again.`, `keep: ${slot.key} left out, as archived by a person`)
            : { note: `"${slot.key}" is not an optional slot of the template, so it cannot be left out for one product: keeping it archived means the template changes (set-ads-playbook kind template).` },
          revert: fix,
        } : {}),
      })
      continue
    }
    const c = f.campaigns.get(s.link.campaignId)
    if (!c) continue
    const base = { slot: slot.key, campaignId: c.id, ...(groupOf(s) ? { adGroupId: groupOf(s)! } : {}) }
    if (c.status === 'PAUSED') {
      const person = latest(c.id, STATUS_CHANGE)
      // W4-2 — paused at Amazon or by a person: enable-ads lifts it only asked so, with the approver's code (a Claude pause needs neither).
      const fix: DriftFix = { by: 'tool', tool: 'enable-ads', args: { campaignIds: [c.id], includePeoplesPauses: true, why: `the playbook's slot ${slot.key} runs` }, addsSpend: true, note: 'A real pause is lifted by enable-ads (its own approval; when no Claude request paused it, a person approves it with their authenticator code, never by rule); sync never switches a campaign on.' }
      items.push({
        key: keyOf('slot_paused', slot.key), kind: 'slot_paused', ...base,
        says: `"${c.name}" (slot "${slot.key}") is paused at Amazon; the playbook never pauses (a slot "off" is low bids).`,
        fix,
        ...(person ? { byPerson: person, keep: { note: 'Nothing to write: it stays paused as you set it, listed here (the playbook holds no paused state).' }, revert: fix } : {}),
      })
    }
    const auto = (c.targetingType ?? '').toUpperCase() === 'AUTO'
    if ((slot.targeting === 'AUTO') !== auto) {
      items.push({
        key: keyOf('targeting_wrong', slot.key), kind: 'targeting_wrong', ...base,
        says: `"${c.name}" is a ${auto ? 'automatic' : 'manual'}-targeting campaign; the slot "${slot.key}" is ${slot.targeting === 'AUTO' ? 'Auto' : slot.targeting === 'PRODUCT' ? 'product targeting (manual)' : 'keywords (manual)'}.`,
        fix: { by: 'none', note: 'Amazon never changes a campaign\'s targeting: archive it (archive-ads, permanent) and let sync build the slot again — each its own approval.' },
      })
    }
    const name = slotNameOf(doc, slot, f.nameToken, f.market)
    if (norm(c.name) !== norm(name)) {
      items.push({ key: keyOf('name_differs', slot.key), kind: 'name_differs', ...base, says: `"${c.name}" plays the slot "${slot.key}", which the playbook names "${name}".`, fix: { by: 'none', note: 'A warning only: a name is never changed by the playbook.' }, warnOnly: true })
    }
    if (f.portfolioId && c.portfolioId !== f.portfolioId) {
      items.push({
        key: keyOf('portfolio_membership', slot.key), kind: 'portfolio_membership', ...base,
        says: `"${c.name}" is ${c.portfolioId ? `in portfolio ${c.portfolioId}` : 'in no portfolio'}; the playbook's portfolio is ${f.portfolioId}.`,
        fix: { by: 'none', note: 'Sync never moves a campaign between portfolios: assign it at Amazon (the Campaigns page) or adopt the portfolio it is in.' },
      })
    }
    // Placements: a slot the hourly plans do not own. A built slot holds none until START puts them on. A campaign an
    // enabled hourly plan holds is that plan's (the Owner's own, or the playbook's): never compared, never set back.
    const plan = f.hourlyPlans.get(c.id)
    if (slot.rankRole !== 'performance' && plan) heldBack.push({ slot: slot.key, what: c.name, why: `Its placements are held by ${plan}: an hourly plan owns them, so they are never compared or set back here.` })
    else if (slot.rankRole !== 'performance' && s.link.origin === 'built' && !c.liveWrites) placementsDeferred.add(slot.key)
    else if (slot.rankRole !== 'performance') {
      // A built slot is held to the playbook's placements; an adopted one to what its campaign held when adopted.
      const adopted = s.link.origin === 'adopted'
      const want = adopted ? f.adoptedPlacements[slot.key] : doc.placements[slot.key] ?? { top: 0, productPage: 0, restOfSearch: 0 }
      const differs = want ? PLACEMENT_KEYS.filter((k) => (want[k] ?? 0) !== (c.placements[k] ?? 0)) : []
      if (!want) noBaseline.push({ slot: slot.key, live: { ...c.placements } })
      else if (differs.length) {
        const person = latest(c.id, PLACEMENT_CHANGE)
        const fix: DriftFix = {
          by: 'tool', tool: 'set-placement-multipliers',
          args: { campaignId: c.id, topOfSearchPct: want.top, productPagesPct: want.productPage, restOfSearchPct: want.restOfSearch, why: `the playbook's placements for slot ${slot.key}` },
          addsSpend: differs.some((k) => (want[k] ?? 0) > (c.placements[k] ?? 0)),
          note: 'Placements are set back by set-placement-multipliers (its own approval, inside its limits); sync never changes them.',
        }
        items.push({
          key: keyOf('placement_differs', slot.key), kind: 'placement_differs', ...base,
          says: `"${c.name}" (slot "${slot.key}", ${slot.rankRole === 'research' ? 'research' : 'no rank role'}) has placements ${c.placements.top}/${c.placements.productPage}/${c.placements.restOfSearch} % (top of search / product pages / rest of search); ${adopted ? 'when it was adopted they were' : 'the playbook says'} ${want.top}/${want.productPage}/${want.restOfSearch} %.`,
          fix,
          ...(person ? {
            byPerson: person,
            keep: adopted
              ? keepArgs({ overrides: { adoptedPlacements: { ...f.adoptedPlacements, [slot.key]: { ...c.placements } } } }, 'Writes these placements as this adopted campaign\'s baseline (overrides.adoptedPlacements), so they are not drift from now on.', `keep: placements of ${slot.key} as set by a person`)
              : keepArgs({ overrides: { placements: { ...doc.placements, [slot.key]: { ...c.placements } } } }, `Writes these placements into this product's playbook (overrides.placements), so they are the playbook's from now on.`, `keep: placements of ${slot.key} as set by a person`),
            revert: fix,
          } : {}),
        })
      }
    }
  }
  if (placementsDeferred.size) notChecked.push(`Placements of ${[...placementsDeferred].map((k) => `"${k}"`).join(', ')}: a built campaign holds none until START puts them on.`)
  // Adopted before the playbook kept a baseline: ONE item, one keep for all of them — never an alarm per slot.
  if (noBaseline.length) {
    items.push({
      key: keyOf('placement_baseline_missing'), kind: 'placement_baseline_missing', slot: null,
      says: `${noBaseline.length === 1 ? 'An adopted slot' : `${noBaseline.length} adopted slots`} (${noBaseline.map((x) => `"${x.slot}"`).join(', ')}) ${noBaseline.length === 1 ? 'has' : 'have'} no placement baseline yet (adopted before the playbook kept one), so ${noBaseline.length === 1 ? 'its placements are' : 'their placements are'} not compared. Keep sets it from what each campaign holds now.`,
      fix: { by: 'none', note: 'Nothing to sync: keep sets the baseline, in Nexus only.' },
      keep: keepArgs({ overrides: { adoptedPlacements: { ...f.adoptedPlacements, ...Object.fromEntries(noBaseline.map((x) => [x.slot, x.live])) } } }, 'Writes each adopted campaign\'s placements as they are now as its baseline (overrides.adoptedPlacements): only what changes after is drift.', 'keep: placement baselines of the adopted slots'),
    })
  }

  // ── Outside the playbook ────────────────────────────────────────────────────────────────────
  for (const o of f.outside) {
    items.push({
      key: keyOf('outside_campaign', o.campaignId), kind: 'outside_campaign', slot: null, campaignId: o.campaignId,
      says: `"${o.name}" (${o.status.toLowerCase()}) advertises this product but plays no slot of its playbook${o.inPlaybook ? ' (it is in another product\'s playbook)' : ''}.`,
      fix: o.inPlaybook
        ? { by: 'none', note: 'It belongs to another product\'s playbook: left as it is.' }
        : { by: 'tool', tool: 'apply-ads-playbook', args: { op: 'adopt', market: f.market, productId: f.product.productId }, addsSpend: false, note: 'Never adopted by itself: adopt it into a free slot (Nexus only), or leave it.' },
    })
  }

  // ── Product ads, positives, misplaced keywords: only the product's own ad groups ─────────────
  const inScope = (s: DriftSlotFacts) => { const g = groupOf(s); return g != null && f.scope.has(g) }
  for (const s of live) {
    const g = groupOf(s)
    if (!g || (!inScope(s) && !f.empty.has(g))) continue
    const c = f.campaigns.get(s.link!.campaignId)!
    const base = { slot: s.slot.key, campaignId: c.id, adGroupId: g }
    // Product ads: every child listed in the market (also into a slot ad group that advertises nothing yet).
    const ads = f.productAds.get(g) ?? new Set<string>()
    const gone = f.archived.productAds.get(g) ?? new Set<string>()
    for (const ad of f.expectedAds) {
      const asin = ad.asin.toUpperCase()
      if (ads.has(asin)) continue
      if (gone.has(asin)) {
        items.push({ key: keyOf('product_ad_archived', s.slot.key, asin), kind: 'product_ad_archived', ...base, asin, says: `${asin} is listed in ${f.market}, and its product ad in "${c.name}" is archived.`, fix: { by: 'none', note: 'An archived product ad never comes back at Amazon, and Nexus holds one ad per ASIN and ad group: it stays out of this slot.' } })
        continue
      }
      items.push({ key: keyOf('product_ad_missing', s.slot.key, asin), kind: 'product_ad_missing', ...base, asin, ...(ad.skus[0] ? { sku: ad.skus[0] } : {}), ...(ad.productIds?.[0] ? { productId: ad.productIds[0] } : {}), says: `${asin} (${ad.skus[0] ?? 'no SKU'}) is listed in ${f.market} but not advertised in "${c.name}".`, fix: { by: 'sync', part: 'productAds', addsSpend: true } })
    }

    if (!inScope(s)) continue
    // Positives the product's terms feed into this slot.
    const positives = f.positives.get(g) ?? []
    const archived = f.archived.positives.get(g) ?? []
    const exp = f.expected?.get(s.slot.key)
    const has = (text: string, match: string) => positives.some((p) => norm(p.text) === norm(text) && p.match === match)
    const archivedOf = (text: string, match: string) => archived.find((a) => norm(a.text) === norm(text) && a.match === match)
    for (const k of exp?.keywords ?? []) {
      if (has(k.text, k.match)) continue
      if (k.gated && f.heldOutside.has(norm(k.text))) { heldBack.push({ slot: s.slot.key, what: k.text, why: 'This product\'s own campaign outside the playbook already buys it: it stays where it is (Owner rule 2).' }); continue }
      const gone = archivedOf(k.text, k.match)
      if (gone) {
        const person = latest(gone.id, STATUS_CHANGE)
        const list = f.terms.brand.some((b) => norm(b) === norm(k.text)) ? 'brand' : f.terms.competitor.some((x) => norm(x) === norm(k.text)) ? 'competitor' : 'category'
        const terms = list === 'brand' ? { ...f.terms, brand: f.terms.brand.filter((b) => norm(b) !== norm(k.text)) }
          : list === 'competitor' ? { ...f.terms, competitor: f.terms.competitor.filter((x) => norm(x) !== norm(k.text)) }
            : { ...f.terms, category: f.terms.category.filter((x) => norm(x.text) !== norm(k.text)) }
        items.push({
          key: keyOf('positive_archived', s.slot.key, `${k.match}:${k.text}`), kind: 'positive_archived', ...base, term: k.text, match: k.match, targetKind: 'KEYWORD',
          says: `The ${k.match.toLowerCase()} keyword "${k.text}" the product's terms feed into "${c.name}" is archived there.`,
          fix: { by: 'none', note: 'An archived keyword never comes back at Amazon (and Nexus finds the archived one again): it is not added by sync.' },
          ...(person ? { byPerson: person } : {}),
          keep: keepArgs({ terms }, `Takes "${k.text}" out of this product's ${list} terms: no slot of this product is built with it again.`, `keep: ${k.text} archived`),
        })
        continue
      }
      items.push({ key: keyOf('positive_missing', s.slot.key, `${k.match}:${k.text}`), kind: 'positive_missing', ...base, term: k.text, match: k.match, targetKind: 'KEYWORD', startBidCents: k.bidCents, says: `The ${k.match.toLowerCase()} keyword "${k.text}" the product's terms feed into "${c.name}" is not there.`, fix: { by: 'sync', part: 'positives', addsSpend: true } })
    }
    for (const t of exp?.productTargets ?? []) {
      const asin = t.asin.toUpperCase()
      if (positives.some((p) => p.match === 'PRODUCT' && p.text.trim().toUpperCase() === asin)) continue
      if (archived.some((a) => a.match === 'PRODUCT' && a.text.trim().toUpperCase() === asin)) {
        items.push({ key: keyOf('positive_archived', s.slot.key, `PRODUCT:${asin}`), kind: 'positive_archived', ...base, term: asin, match: 'PRODUCT', targetKind: 'PRODUCT', says: `The product target ${asin} the product's competitor ASINs feed into "${c.name}" is archived there.`, fix: { by: 'none', note: 'An archived product target never comes back at Amazon: it is not added by sync.' }, keep: keepArgs({ terms: { ...f.terms, competitorAsins: f.terms.competitorAsins.filter((a) => a.toUpperCase() !== asin) } }, `Takes ${asin} out of this product's competitor ASINs.`, `keep: ${asin} archived`) })
        continue
      }
      items.push({ key: keyOf('positive_missing', s.slot.key, `PRODUCT:${asin}`), kind: 'positive_missing', ...base, term: asin, match: 'PRODUCT', targetKind: 'PRODUCT', startBidCents: t.bidCents, says: `The product target ${asin} the product's competitor ASINs feed into "${c.name}" is not there.`, fix: { by: 'sync', part: 'positives', addsSpend: true } })
    }

    // Misplaced keywords: a live keyword of another match type, or of another intent, than its slot plays.
    if (s.slot.targeting === 'AUTO') continue
    const fed = new Set((exp?.keywords ?? []).map((k) => `${k.match}|${norm(k.text)}`))
    for (const p of positives) {
      if (p.match === 'PRODUCT' || !p.live || fed.has(`${p.match}|${norm(p.text)}`)) continue
      const intent = intentOf(p.text, f.terms, f.nameToken)
      const fits = s.slot.targeting === 'KEYWORD' && s.slot.match === p.match && (s.slot.intent === 'ANY' || s.slot.intent === intent)
      if (fits) continue
      const right = live.find((r) => r.slot.targeting === 'KEYWORD' && r.slot.match === p.match && (r.slot.intent === intent || r.slot.intent === 'ANY') && inScope(r))
      const where = `"${c.name}" (slot "${s.slot.key}")`
      const what = `The ${p.match.toLowerCase()} keyword "${p.text}" — ${intent.toLowerCase()} by its words — is in ${where}`
      const itemBase = { key: keyOf('positive_misplaced', s.slot.key, `${p.match}:${p.text}`), kind: 'positive_misplaced' as const, ...base, term: p.text, match: p.match, targetKind: 'KEYWORD' as const }
      if ((f.winners.get(g) ?? new Set()).has(norm(p.text))) {
        items.push({ ...itemBase, says: `${what}, and it wins there.`, fix: { by: 'none', note: 'It wins where it is (it meets the ads strategy\'s harvest bar there): winning search terms stay where they are (Owner rule 2). Tune its bid or the placement instead.' } })
        continue
      }
      if (!right) {
        items.push({ ...itemBase, says: `${what}; no slot of this playbook plays a ${p.match.toLowerCase()} ${intent.toLowerCase()} keyword.`, fix: { by: 'none', note: 'There is no right slot to add it to: leave it, or archive it (archive-ads).' } })
        continue
      }
      const rg = groupOf(right)!
      if ((f.positives.get(rg) ?? []).some((q) => q.match === p.match && norm(q.text) === norm(p.text))) {
        items.push({ ...itemBase, says: `${what}; its right slot "${right.slot.key}" holds it too.`, fix: { by: 'none', note: 'Both stand: sync never removes one. Archive the misplaced one (archive-ads) once its home serves.' } })
        continue
      }
      const bid = f.expected?.get(right.slot.key)?.startBidCents
      items.push({
        ...itemBase, says: `${what}; its right slot is "${right.slot.key}". Sync adds it there; the misplaced one stays live until a person archives it (sync never removes).`,
        fix: { by: 'sync', part: 'positives', addsSpend: true },
        ...(bid ? { startBidCents: bid } : {}),
        into: { slot: right.slot.key, campaignId: right.link!.campaignId, adGroupId: rg },
      })
    }
  }

  // ── Negatives: isolation, source, the product's own ──────────────────────────────────────────
  const seen = new Set<string>()
  const negativeItem = (of: 'isolation' | 'source' | 'product', n: { text: string; match: 'EXACT' | 'PHRASE'; adGroupId: string; campaignId: string; slot: string; kind?: IsolationKind; owner?: { adTargetId: string; text: string }; why: string }) => {
    const k = negativeKey(n.adGroupId, n.match, n.text)
    if (seen.has(k)) return
    seen.add(k)
    const goneId = f.archived.negatives.get(k)
    const elsewhere = f.liftedElsewhere.get(`${n.match}|${norm(n.text)}`)
    const lifted = !!goneId || elsewhere !== undefined
    // Lifted: by the person a record names, else by someone nothing names — his change either way, never put back by rule.
    const person = lifted ? (goneId ? latest(goneId, STATUS_CHANGE) : undefined) ?? elsewhere ?? UNKNOWN_AUTHOR : undefined
    const fix: DriftFix = { by: 'sync', part: 'negatives', addsSpend: false }
    const keep: DriftItem['keep'] = of === 'product'
      ? keepArgs({ terms: { ...f.terms, negatives: f.terms.negatives.filter((x) => !(norm(x.text) === norm(n.text) && x.match === n.match)) } }, `Takes "${n.text}" (${n.match.toLowerCase()}) out of this product's negatives: no slot of it gets it again.`, `keep: negative ${n.text} lifted by a person`)
      : of === 'isolation' && n.kind
        ? keepArgs({ overrides: { isolation: { ...doc.isolation, [ISOLATION_SWITCH[n.kind]]: false } } }, `No playbook part holds one isolation negative: keeping it out turns this kind of isolation (${ISOLATION_SWITCH[n.kind]}) off for every term of this product — a raise, so the approver's code.`, `keep: isolation ${n.kind} off`)
        : { note: 'No playbook part holds one source negative: the harvest edge\'s negateSource (overrides.harvest) decides it for every term from that slot. Left out, it stays listed here.' }
    items.push({
      key: keyOf('negative_missing', n.slot, `${of}:${n.match}:${n.text}`), kind: 'negative_missing', slot: n.slot, campaignId: n.campaignId, adGroupId: n.adGroupId,
      term: n.text, match: n.match,
      negative: { of, ...(n.kind ? { kind: n.kind } : {}), ...(n.owner ? { ownerTargetId: n.owner.adTargetId, owner: n.owner.text } : {}) },
      says: `${n.why}${lifted ? ` It was there and was lifted${person?.unknownAuthor ? ' (by whom Nexus cannot tell: at Amazon, or in Nexus without a record)' : ''}.` : ''}`,
      fix,
      ...(person ? { byPerson: person, keep, revert: fix } : {}),
    })
  }
  for (const a of f.isolation?.adds ?? []) negativeItem('isolation', { ...a, owner: a.owner })
  for (const a of f.source) negativeItem('source', { ...a, owner: a.owner, why: `Graduated: "${a.text}" has its own live exact keyword in "${a.owner.slot}", so the harvest negates it (exact) in its source "${a.slot}".` })
  for (const s of live) {
    const g = groupOf(s)
    if (!g || !inScope(s) || s.slot.targeting === 'PRODUCT') continue
    const c = f.campaigns.get(s.link!.campaignId)!
    const positives = f.positives.get(g) ?? []
    for (const n of f.terms.negatives) {
      if (f.standing.has(negativeKey(g, n.match, n.text))) continue
      const tooLong = negativeKeywordTextProblem(n.text, n.match === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT')
      if (tooLong) { heldBack.push({ slot: s.slot.key, what: n.text, why: tooLong }); continue }
      const blocked = blockedPositive({ text: n.text, match: n.match }, positives)
      if (blocked) { heldBack.push({ slot: s.slot.key, what: n.text, why: `It would block this slot's own keyword "${blocked.text}" (the lock): not negated here.` }); continue }
      if (protectedTermHit(n.text, n.match === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT', f.protections.get(c.id) ?? [])) { heldBack.push({ slot: s.slot.key, what: n.text, why: 'A protected term: never negated.' }); continue }
      const winner = [...(f.winners.get(g) ?? [])].find((t) => negativeBlocksTerm({ text: n.text, match: n.match }, t))
      if (winner) { heldBack.push({ slot: s.slot.key, what: n.text, why: `The search "${winner}" wins here (it meets the ads strategy's harvest bar): winners stay (Owner rule 2), so a person decides this negative.` }); continue }
      negativeItem('product', { text: n.text, match: n.match, adGroupId: g, campaignId: c.id, slot: s.slot.key, why: `The product's negative "${n.text}" (${n.match.toLowerCase()}) is not in "${c.name}".` })
    }
  }

  // ── Compiled artifacts ───────────────────────────────────────────────────────────────────────
  const ARTIFACT_WORDS: Record<string, string> = { harvestRule: 'harvest rule', isolationRule: 'isolation rule', rankGroup: 'hourly plan' }
  for (const e of f.artifacts.expectations) {
    const words = ARTIFACT_WORDS[e.kind] ?? e.kind
    const resave: DriftFix = { by: 'sync', part: 'artifacts', addsSpend: false }
    if (!e.refId) {
      items.push({ key: keyOf('artifact_missing', e.kind, e.key), kind: 'artifact_missing', slot: null, artifact: { kind: e.kind, refId: null, parts: Object.keys(e.parts) }, says: `The playbook's ${words} "${e.key}" is missing (never made, or deleted since). Sync makes it again, switched off (Nexus only).`, fix: resave })
      continue
    }
    const differing = Object.entries(e.parts).filter(([, p]) => canonical(p.expected) !== canonical(p.actual))
    if (!differing.length) continue
    const parts = differing.map(([name]) => name)
    const resaved = differing.some(([, p]) => p.resave !== false)
    const notes = [...new Set(differing.filter(([, p]) => p.resave === false && p.note).map(([, p]) => p.note!))]
    const fix: DriftFix = resaved ? resave : { by: 'none', note: notes.join(' ') || 'A re-save does not set it back.' }
    const person = e.changedBy ?? latest(e.refId, RULE_EDIT)
    // A plan's hours a person painted can be kept as the playbook's own: written into the product row's rank section.
    const role = e.kind === 'rankGroup' ? (e.key.split(':')[1] as 'performance' | 'research' | undefined) : undefined
    const hours = role && doc.rank.roles[role] && (e.parts.windows || e.parts.baseline) && differing.some(([n]) => n === 'windows' || n === 'baseline')
      ? keepArgs({ overrides: { rank: { ...doc.rank, roles: { ...doc.rank.roles, [role]: { ...doc.rank.roles[role]!, windows: e.parts.windows?.actual ?? doc.rank.roles[role]!.windows, baseline: e.parts.baseline?.actual ?? doc.rank.roles[role]!.baseline } } } } }, `Writes the plan's hours as they are into this product's playbook (overrides.rank, the ${role} role), so they are the playbook's from now on.`, `keep: ${role} hours as painted`)
      : null
    items.push({
      key: keyOf('artifact_changed', e.kind, e.key), kind: 'artifact_changed', slot: null, artifact: { kind: e.kind, refId: e.refId, parts },
      says: `The playbook's ${words} "${e.key}" differs from what the playbook compiles now: ${parts.join(', ')}.${resaved ? '' : ` ${fix.by === 'none' ? fix.note : ''}`}`,
      fix,
      ...(person ? { byPerson: person, ...(resaved ? { revert: resave } : {}) } : {}),
      ...(hours ? { keep: hours } : person ? { keep: { note: 'Nothing to write: this artifact\'s own settings are no playbook part. It stays as you set it until a build, an adopt, a START or a sync that names it in revert compiles it again.' } } : {}),
    })
  }
  for (const n of f.artifacts.notChecked) notChecked.push(`${n.kind}: ${n.why}`)
  for (const h of f.artifacts.held) heldBack.push({ slot: f.slots.find((x) => x.link?.campaignId === h.campaignId)?.slot.key ?? null, what: h.name, why: `Held by the Owner's plan — ${h.by}: his own hourly plan, never drift here; the playbook's plan for it is compared once he adopts it.` })

  const counts = {
    items: items.length,
    bySync: items.filter((i) => i.fix.by === 'sync').length,
    addsSpend: items.filter((i) => (i.fix.by === 'sync' || i.fix.by === 'tool') && i.fix.addsSpend).length,
    byPerson: items.filter((i) => i.byPerson).length,
    viaTool: items.filter((i) => i.fix.by === 'tool').length,
    none: items.filter((i) => i.fix.by === 'none').length,
    warnOnly: items.filter((i) => i.warnOnly).length,
  }
  return { items, heldBack, notChecked, counts }
}
