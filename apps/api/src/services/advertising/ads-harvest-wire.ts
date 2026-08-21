/**
 * HP1 (2026-08-21) — the harvest rule WIRE: everything the builder's Keyword Harvesting form
 * collects, normalised into what the engine actually honours.
 *
 * Until HP1, `promote_to_exact` created EXACT-only in the term's own SOURCE ad group, scanning
 * account-wide — while the builder collected an ad-group mapping matrix (look ✓/✗ + create-types
 * P/E/ASIN per group), a Search Terms contains/does-not-contain step, brand filters and a Dedupe
 * toggle that NOTHING read (docs/2026-08-21-hp-keyword-harvest-perfection.md §3). This module is
 * the single normaliser + the pure predicates, so the adapter, the handler and the tests read one
 * definition. All ad-group ids here are LOCAL `AdGroup.id`s (the builder stores local ids; the
 * evaluation context carries external ids and the handler resolves once).
 */

export type HarvestTargetType = 'PHRASE' | 'EXACT' | 'ASIN'

export interface HarvestCreateTarget {
  adGroupId: string
  types: HarvestTargetType[]
}

/** One "Ad Group Mapping" block: read terms from `look`, create targets in `create`. */
export interface HarvestMappingBlock {
  look: string[]
  create: HarvestCreateTarget[]
}

export interface HarvestTermFilters {
  /** non-empty ⇒ a term must contain at least one of these (H10's "Contains") */
  containsAny: string[]
  /** a term must contain none of these (H10's "Does Not Contain") */
  notContains: string[]
  /** brand tokens never to harvest (the builder's brand-protect textarea) */
  brandExclude: string[]
  /** skip ASIN-shaped terms that are OUR OWN catalogue's ASINs */
  competitorOnly: boolean
}

export interface HarvestWire {
  /** null = the rule maps nothing ⇒ account-wide, create-in-source (the pre-HP1 behaviour) */
  blocks: HarvestMappingBlock[] | null
  filters: HarvestTermFilters
  dedupe: boolean
}

export type HarvestBidMode = 'cpc' | 'cpcPlus' | 'adGroupDefault' | 'fixed'

/** The builder's stored mapping group shape (actions[0].mappings[].groups[]). */
interface StoredMappingGroup {
  id?: unknown
  look?: unknown
  types?: { P?: unknown; E?: unknown; product?: unknown }
  /** HP2 — the Ad Group View's per-pathway pause: a paused entry neither sources nor receives. */
  paused?: unknown
}

const toTokens = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).map((t) => String(t ?? '').trim().toLowerCase()).filter(Boolean)

/**
 * The builder action → the wire. Pure; the adapter calls it at translation and the shape is
 * pinned by tests so a builder field can no longer be silently dropped.
 */
export function normalizeHarvestWire(a0: Record<string, unknown>): HarvestWire {
  const mappings = Array.isArray(a0.mappings) ? (a0.mappings as Array<{ groups?: StoredMappingGroup[] }>) : []
  const blocks: HarvestMappingBlock[] = []
  for (const m of mappings) {
    const allGroups = Array.isArray(m?.groups) ? m.groups : []
    if (!allGroups.length) continue
    // HP2 — a paused pathway is out of BOTH sides: it neither sources terms nor receives targets.
    // The mapping entry stays on the rule (one click to resume); only the engine's read skips it.
    const groups = allGroups.filter((g) => g.paused !== true)
    const look = groups.filter((g) => g.look !== false && g.id != null).map((g) => String(g.id))
    const create: HarvestCreateTarget[] = groups
      .map((g) => {
        const types: HarvestTargetType[] = []
        if (g.types?.P) types.push('PHRASE')
        if (g.types?.E) types.push('EXACT')
        if (g.types?.product) types.push('ASIN')
        return { adGroupId: String(g.id ?? ''), types }
      })
      .filter((c) => c.adGroupId && c.types.length > 0)
    blocks.push({ look, create })
  }
  const st = Array.isArray(a0.searchTerms) ? (a0.searchTerms as Array<{ term?: unknown; op?: unknown }>) : []
  const filters: HarvestTermFilters = {
    containsAny: toTokens(st.filter((s) => s?.op === 'contains').map((s) => s.term)),
    notContains: toTokens(st.filter((s) => s?.op === 'not').map((s) => s.term)),
    brandExclude: toTokens((a0.filters as { brandExclude?: unknown } | undefined)?.brandExclude),
    competitorOnly: (a0.filters as { competitorOnly?: unknown } | undefined)?.competitorOnly === true,
  }
  return {
    blocks: blocks.length ? blocks : null,
    filters,
    // H10's Control toggle defaults ON ("do NOT suggest terms that already exist…").
    dedupe: a0.dedupe !== false,
  }
}

/**
 * The blocks whose `look` set admits this source ad group.
 * 'account-wide' = the rule maps nothing (pre-HP1 behaviour, still legal);
 * [] = the rule maps ad groups and this term's source is not among them ⇒ skip, named.
 */
export function matchedBlocks(
  blocks: HarvestMappingBlock[] | null,
  sourceLocalAdGroupId: string,
): HarvestMappingBlock[] | 'account-wide' {
  if (!blocks || blocks.length === 0) return 'account-wide'
  return blocks.filter((b) => b.look.includes(sourceLocalAdGroupId))
}

const ASIN_RE = /^b0[a-z0-9]{8}$/i

/**
 * The term filters, applied in the order the builder states them. `isOwnAsin` is precomputed by
 * the caller (it is a catalogue lookup) so this stays pure and testable.
 */
export function termPassesFilters(
  term: string,
  filters: HarvestTermFilters,
  isOwnAsin: boolean,
): { pass: true } | { pass: false; reason: string } {
  const t = term.trim().toLowerCase()
  if (filters.containsAny.length && !filters.containsAny.some((c) => t.includes(c))) {
    return { pass: false, reason: `term does not contain any of the rule's "contains" filters` }
  }
  const hit = filters.notContains.find((c) => t.includes(c))
  if (hit) return { pass: false, reason: `term contains the excluded text "${hit}"` }
  const brand = filters.brandExclude.find((c) => t.includes(c))
  if (brand) return { pass: false, reason: `term contains the protected brand text "${brand}"` }
  if (filters.competitorOnly && ASIN_RE.test(t) && isOwnAsin) {
    return { pass: false, reason: 'competitor-only is on and this ASIN is in our own catalogue' }
  }
  return { pass: true }
}

/**
 * The new-target bid, per the builder's four modes (H10's list). Every mode either produces a
 * number or REFUSES with the missing signal named — a bid must never be a silent constant again
 * (the pre-HP1 "Suggested bid" was €0.75 flat).
 */
export function resolveHarvestBidEur(
  mode: HarvestBidMode,
  value: number | null,
  termCpcEur: number | null,
  adGroupDefaultEur: number | null,
): { bidEur: number } | { refuse: string } {
  const clamp = (x: number) => Math.max(0.02, Math.round(x * 100) / 100)
  switch (mode) {
    case 'cpc':
      return termCpcEur != null && termCpcEur > 0
        ? { bidEur: clamp(termCpcEur) }
        : { refuse: 'the term has no measured CPC in the window — there is nothing to set the bid to' }
    case 'cpcPlus': {
      if (termCpcEur == null || termCpcEur <= 0) return { refuse: 'the term has no measured CPC in the window — there is nothing to scale' }
      const pct = value ?? 0
      return { bidEur: clamp(termCpcEur * (1 + pct / 100)) }
    }
    case 'adGroupDefault':
      return adGroupDefaultEur != null && adGroupDefaultEur > 0
        ? { bidEur: clamp(adGroupDefaultEur) }
        : { refuse: 'the destination ad group has no default bid to inherit' }
    case 'fixed':
      return value != null && value > 0
        ? { bidEur: clamp(value) }
        : { refuse: 'fixed-bid mode with no bid amount stored' }
  }
}

/** Legacy stored modes → the honest vocabulary ('suggested' was a €0.75 constant; it becomes CPC). */
export function normalizeHarvestBidMode(raw: unknown): HarvestBidMode {
  return raw === 'fixed' ? 'fixed'
    : raw === 'cpcPlus' ? 'cpcPlus'
      : raw === 'adGroupDefault' ? 'adGroupDefault'
        : 'cpc'
}
