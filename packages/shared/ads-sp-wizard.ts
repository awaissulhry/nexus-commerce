/**
 * ads-sp-wizard.ts — THE SP Super Wizard's campaign structures and its negative-keyword funnel, one copy for every
 * caller: the wizard's screen (apps/web/…/campaign-builder/sp-super-wizard: StructureSelection.tsx, CampaignSetup.tsx)
 * and Claude's one-off build (build-sp-wizard-campaigns, B-3). Moved here from the screen without a change; pure.
 *
 *   Standard   Auto · Keyword × {Brand, Competitor, Category} at "Broad & Phrase & Exact" · PAT   (5 campaigns)
 *   Advanced   Auto · Keyword × {Broad, Phrase, Exact} × {Brand, Competitor, Category} · PAT       (11 campaigns)
 *   Custom     Auto (if chosen) · each keyword type × each of its match types · PAT (if chosen), named by tokens
 */

export type StructureMode = 'standard' | 'advanced' | 'custom'
/** One row of the structure diagram: campaign, ad group, match type, keyword type. */
export type StructureRow = { c: string; a: string; m: string; k: string }
export type SpwMatchType = 'BROAD' | 'PHRASE' | 'EXACT'
export type SpwTargetingKind = 'auto' | 'keyword' | 'product'
export type SpwKind = 'auto' | 'keyword' | 'pat'
/** A Custom scheme keyword type: its name, the match types it is built at, and its keywords. */
export type SpwKeywordType = { name: string; matchTypes: SpwMatchType[]; keywords: string[] }

const KW = ['Brand', 'Competitor', 'Category']

export function standardRows(): StructureRow[] {
  const base = [{ m: 'Auto', k: '-' }, ...KW.map((k) => ({ m: 'Broad & Phrase & Exact', k })), { m: 'PAT', k: '-' }]
  return base.map((r, i) => ({ ...r, c: `Campaign ${i + 1}`, a: `AdGroup ${i + 1}` }))
}
export function advancedRows(): StructureRow[] {
  const rows: Array<{ m: string; k: string }> = [{ m: 'Auto', k: '-' }]
  for (const m of ['Broad', 'Phrase', 'Exact']) for (const k of KW) rows.push({ m, k })
  rows.push({ m: 'PAT', k: '-' })
  return rows.map((r, i) => ({ ...r, c: `Campaign ${i + 1}`, a: `AdGroup ${i + 1}` }))
}

// ── The generated campaigns (SPW.4 step 2) ───────────────────────────────

/** A generated campaign, before the caller's bids, budgets and targeting. */
export interface SpwGeneratedCampaign {
  id: string; name: string; adGroupName: string
  matchType: string; keywordType: string; kind: SpwKind
  keywords: string[]
}

const matchTok = (m: string) => (m === 'Broad & Phrase & Exact' ? '' : m)
function campaignName(grp: string, kind: SpwKind, m: string, k: string): string {
  const g = grp.trim() || 'Campaign'
  if (kind === 'auto') return `${g}-SP-Auto`
  if (kind === 'pat') return `${g}-SP-PAT`
  const tok = matchTok(m)
  return `${g}-SP-Keyword-${k}${tok ? `-${tok}` : ''}`
}

const matchLabel = (m: SpwMatchType): string => (m === 'PHRASE' ? 'Phrase' : m === 'EXACT' ? 'Exact' : 'Broad')
/** Custom-scheme cross-product: Auto + PAT (if chosen) + each keyword type × each of its match types. */
type GenRow = { m: string; k: string; keywords?: string[]; name?: string }
const TARGETING_LABEL: Record<SpwKind, string> = { auto: 'Auto', keyword: 'Keyword', pat: 'PAT' }
/** Token-driven custom name: walk the Campaign-Name tokens, resolve each to this
 *  campaign's value, then dash-join after the product-group prefix. */
function tokenName(grp: string, tokens: string[], kind: SpwKind, match: string, keywordType: string, asin: string): string {
  const g = grp.trim() || 'Campaign'
  const resolve = (t: string): string =>
    t === 'campaignType' ? 'SP'
      : t === 'targetingType' ? TARGETING_LABEL[kind]
        : t === 'matchType' ? (kind === 'keyword' ? match : '')
          : t === 'keywordType' ? (kind === 'keyword' ? keywordType : '')
            : t === 'asin' ? asin : '' // 'customize' free-text deferred
  const parts = tokens.map(resolve).filter(Boolean)
  return parts.length ? [g, ...parts].join('-') : g
}
function customRows(keywordTypes: SpwKeywordType[], targeting: SpwTargetingKind[], tokens: string[], grp: string, asin: string): GenRow[] {
  const rows: GenRow[] = []
  const add = (kind: SpwKind, match: string, kwt: string, keywords: string[]) =>
    rows.push({ m: kind === 'auto' ? 'Auto' : kind === 'pat' ? 'PAT' : match, k: kwt || '-', keywords, name: tokenName(grp, tokens, kind, match, kwt, asin) })
  if (targeting.includes('auto')) add('auto', '', '', [])
  if (targeting.includes('keyword')) for (const kt of keywordTypes) for (const mt of kt.matchTypes) add('keyword', matchLabel(mt), kt.name, kt.keywords)
  if (targeting.includes('product')) add('pat', '', '', [])
  return rows
}

/** The Custom scheme's campaign-name tokens until a person picks others: SP · targeting · match type · keyword type. */
export const DEFAULT_CUSTOM_NAME_TOKENS: readonly string[] = ['campaignType', 'targetingType', 'matchType', 'keywordType']

/** The campaigns a structure generates, in the screen's order and with its names (`cmp-<i>` ids). */
export function generateCampaignRows(grp: string, mode: StructureMode, customKeywordTypes: SpwKeywordType[], customTargetingTypes: SpwTargetingKind[], customNameTokens: string[] = [], asin = ''): SpwGeneratedCampaign[] {
  const rows: GenRow[] =
    mode === 'advanced' ? advancedRows()
    : mode === 'custom' ? customRows(customKeywordTypes, customTargetingTypes, customNameTokens, grp, asin)
    : standardRows()
  return rows.map((r, i) => {
    const kind: SpwKind = r.m === 'Auto' ? 'auto' : r.m === 'PAT' ? 'pat' : 'keyword'
    const name = r.name ?? campaignName(grp, kind, r.m, r.k)
    return { id: `cmp-${i}`, name, adGroupName: `${name} Ad Group`, matchType: r.m, keywordType: r.k, kind, keywords: r.keywords ?? [] }
  })
}

// ── AT.1 / AT.2 — the four Auto groups ───────────────────────────────────

export type AutoGroupKey = 'CLOSE_MATCH' | 'LOOSE_MATCH' | 'SUBSTITUTES' | 'COMPLEMENTS'
/** Intent-based smart default bids (× the campaign default): Close & Substitutes lean higher (buy intent /
 *  conquesting), Loose & Complements lower (discovery / cross-sell). */
export const AUTO_GROUP_MULT: Readonly<Record<AutoGroupKey, number>> = { CLOSE_MATCH: 1.0, SUBSTITUTES: 1.1, LOOSE_MATCH: 0.65, COMPLEMENTS: 0.6 }

// ── NT.1 — Negative-keyword funnel (campaign isolation) ──────────────────
// Two mechanisms, both writing ad-group-level negatives that carry a match type:
//  ① Match-type funnel — within a keyword group, a looser campaign ALWAYS negates the
//     group's keyword set at every tighter match type so each search term serves from one
//     campaign: Exact = none · Phrase = neg-exact · Broad = neg-exact + neg-phrase.
//  ② Auto-isolation — the Auto campaign neg-exacts every manual keyword so it only
//     discovers NEW search terms.
// `auto:true` negatives are derived (recomputed here); manual ones are preserved.
// Every negative goes into a campaign of the build and names a keyword of the build: one set's own campaigns are
// kept apart, never anything else (the Owner's rule 3).

export type NegMatch = 'EXACT' | 'PHRASE'
/** A negative keyword carries its own match type (Amazon SP only supports
 *  negative-exact / negative-phrase). `auto` marks ones the funnel created — they
 *  show read-only + badged in the drawer and are recomputed, never hand-edited. */
export type NegKeyword = { text: string; matchType: NegMatch; auto?: boolean }
/** What the funnel reads and writes of a campaign; every other field is kept as it is. */
export interface FunnelCampaign { id: string; kind: SpwKind; matchType: string; keywordType: string; keywords: string[]; negKeywords: NegKeyword[] }

const RANK: Record<'BROAD' | 'PHRASE' | 'EXACT', number> = { BROAD: 1, PHRASE: 2, EXACT: 3 }
/** Single match type for a keyword campaign, or null for combined (Standard's
 *  "Broad & Phrase & Exact") / Auto / PAT — those don't take part in the funnel. */
export function singleMatch(m: string): 'BROAD' | 'PHRASE' | 'EXACT' | null {
  const u = (m || '').toLowerCase()
  if (u.includes('&')) return null
  if (u.includes('phrase')) return 'PHRASE'
  if (u.includes('exact')) return 'EXACT'
  if (u.includes('broad')) return 'BROAD'
  return null
}
/** Each text once (case-insensitive, trimmed), the first spelling kept. */
export const dedupeCI = (xs: string[]): string[] => {
  const seen = new Set<string>(), out: string[] = []
  for (const x of xs) { const k = x.trim().toLowerCase(); if (x.trim() && !seen.has(k)) { seen.add(k); out.push(x.trim()) } }
  return out
}

export function applyAutoNegatives<C extends FunnelCampaign>(campaigns: C[], enabled: boolean): C[] {
  // Always drop prior auto negatives first (so they never accumulate / go stale).
  const base = campaigns.map((c) => ({ ...c, negKeywords: c.negKeywords.filter((n) => !n.auto) }))
  if (!enabled) return base
  const keywordCampaigns = base.filter((c) => c.kind === 'keyword')
  const allKeywords = dedupeCI(keywordCampaigns.flatMap((c) => c.keywords))
  return base.map((c) => {
    let auto: NegKeyword[] = []
    if (c.kind === 'auto') {
      // ② Auto-isolation: neg-exact every manual keyword in the build.
      auto = allKeywords.map((text) => ({ text, matchType: 'EXACT' as NegMatch, auto: true }))
    } else if (c.kind === 'keyword') {
      // ① Funnel: negate the GROUP's whole keyword set at every match type TIGHTER than this
      // campaign's own — Broad → neg-exact + neg-phrase, Phrase → neg-exact, Exact → none — ALWAYS
      // (not only when a tighter sibling campaign exists). So a Broad campaign always blocks the
      // exact + in-order-phrase forms even when the group has no dedicated Phrase/Exact tier.
      const my = singleMatch(c.matchType)
      if (my) {
        const sibs = keywordCampaigns.filter((s) => s.keywordType === c.keywordType && s.id !== c.id)
        const groupKw = dedupeCI([...c.keywords, ...sibs.flatMap((s) => s.keywords)])
        if (RANK.EXACT > RANK[my]) auto.push(...groupKw.map((text) => ({ text, matchType: 'EXACT' as NegMatch, auto: true })))
        if (RANK.PHRASE > RANK[my]) auto.push(...groupKw.map((text) => ({ text, matchType: 'PHRASE' as NegMatch, auto: true })))
      }
    }
    // Merge auto into manual; a manual negative for the same text+match wins (no dup).
    const seen = new Set(c.negKeywords.filter((n) => !n.auto).map((n) => `${n.text.toLowerCase()}|${n.matchType}`))
    const merged = [...c.negKeywords.filter((n) => !n.auto)]
    for (const a of auto) { const k = `${a.text.toLowerCase()}|${a.matchType}`; if (!seen.has(k)) { seen.add(k); merged.push(a) } }
    return { ...c, negKeywords: merged }
  })
}
