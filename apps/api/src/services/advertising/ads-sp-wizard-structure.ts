/**
 * B-3 (builders for Claude, Owner 10-07) — the SP Super Wizard's campaign structures, server side, for Claude's one-off
 * build (build-sp-wizard-campaigns): the campaigns the wizard's step 1 generates (Standard 5, Advanced 11, Custom) and
 * its negative-keyword funnel, exactly as the screen computes them in the browser
 * (apps/web/src/app/marketing/ads/campaign-builder/sp-super-wizard: StructureSelection.tsx `standardRows` /
 * `advancedRows`, CampaignSetup.tsx `generateCampaigns` / `applyAutoNegatives`, CustomScheme.tsx's default name tokens).
 * Pure: nothing here reads a database or creates anything — the launch is the wizard's own
 * (ads-sp-wizard-launch.service.ts). The screen keeps its own copy, unchanged; ads-sp-wizard-structure.vitest.test.ts
 * pins this one to the names and negatives the screen makes.
 *
 *   Standard   Auto · Keyword × {Brand, Competitor, Category} at Broad & Phrase & Exact · PAT          (5 campaigns)
 *   Advanced   Auto · Keyword × {Broad, Phrase, Exact} × {Brand, Competitor, Category} · PAT              (11 campaigns)
 *   Custom     Auto (if chosen) · each keyword type × each of its match types · PAT (if chosen)
 *
 * The funnel (NT.1, the screen's "auto negate", on by default) — the Owner's rule 3: it keeps ONE set's own campaigns
 * apart and nothing else. Every negative it plans goes into a campaign of this set and names a keyword of this set:
 *   ① a keyword campaign of one match type negates its keyword type's whole keyword set at every tighter match type
 *      (Broad → negative exact + negative phrase, Phrase → negative exact, Exact → none);
 *   ② the Auto campaign negates every keyword of the set as negative exact, so it only finds new search terms.
 */

export type WizardStructure = 'standard' | 'advanced' | 'custom'
export type WizardMatch = 'BROAD' | 'PHRASE' | 'EXACT'
export type WizardTargeting = 'auto' | 'keyword' | 'product'
export type WizardKind = 'auto' | 'keyword' | 'pat'

/** The Standard and Advanced keyword types, in the screen's order. */
export const WIZARD_KEYWORD_TYPES = ['Brand', 'Competitor', 'Category'] as const

/** A Custom keyword type (CustomScheme.tsx): its name, the match types it is built at, and its keywords. */
export interface WizardKeywordType { name: string; matchTypes: WizardMatch[]; keywords: string[] }

/** The Custom scheme's default campaign-name tokens (SpSuperWizard.tsx `customNameTokens`). */
const CUSTOM_NAME_TOKENS = ['campaignType', 'targetingType', 'matchType', 'keywordType'] as const

export interface WizardNegative { text: string; matchType: 'EXACT' | 'PHRASE'; funnel?: true }

/** One campaign the wizard generates, before its bids and budget (the tool sets those). */
export interface WizardCampaign {
  /** `cmp-<i>`, as the screen numbers them: the launch's `slots` answer maps it to the campaign and ad group made. */
  id: string
  name: string
  adGroupName: string
  kind: WizardKind
  /** The screen's match label: Auto, PAT, `Broad & Phrase & Exact` (Standard), Broad, Phrase or Exact. */
  matchType: string
  /** Brand, Competitor, Category, a Custom keyword type's name, or `-` (Auto, PAT). */
  keywordType: string
  keywords: string[]
  negKeywords: WizardNegative[]
}

const matchLabel = (m: WizardMatch): string => (m === 'PHRASE' ? 'Phrase' : m === 'EXACT' ? 'Exact' : 'Broad')
const matchTok = (m: string) => (m === 'Broad & Phrase & Exact' ? '' : m)
const TARGETING_LABEL: Record<WizardKind, string> = { auto: 'Auto', keyword: 'Keyword', pat: 'PAT' }

/** CampaignSetup.tsx `campaignName`: the Standard and Advanced names. */
function campaignName(grp: string, kind: WizardKind, m: string, k: string): string {
  const g = grp.trim() || 'Campaign'
  if (kind === 'auto') return `${g}-SP-Auto`
  if (kind === 'pat') return `${g}-SP-PAT`
  const tok = matchTok(m)
  return `${g}-SP-Keyword-${k}${tok ? `-${tok}` : ''}`
}

/** CampaignSetup.tsx `tokenName` with the default tokens: the Custom names. */
function tokenName(grp: string, kind: WizardKind, match: string, keywordType: string): string {
  const g = grp.trim() || 'Campaign'
  const resolve = (t: (typeof CUSTOM_NAME_TOKENS)[number]): string =>
    t === 'campaignType' ? 'SP'
      : t === 'targetingType' ? TARGETING_LABEL[kind]
        : t === 'matchType' ? (kind === 'keyword' ? match : '')
          : kind === 'keyword' ? keywordType : ''
  const parts = CUSTOM_NAME_TOKENS.map(resolve).filter(Boolean)
  return parts.length ? [g, ...parts].join('-') : g
}

type Row = { m: string; k: string; keywords?: string[]; name?: string }

function standardRows(): Row[] {
  return [{ m: 'Auto', k: '-' }, ...WIZARD_KEYWORD_TYPES.map((k) => ({ m: 'Broad & Phrase & Exact', k })), { m: 'PAT', k: '-' }]
}
function advancedRows(): Row[] {
  const rows: Row[] = [{ m: 'Auto', k: '-' }]
  for (const m of ['Broad', 'Phrase', 'Exact']) for (const k of WIZARD_KEYWORD_TYPES) rows.push({ m, k })
  rows.push({ m: 'PAT', k: '-' })
  return rows
}
function customRows(types: readonly WizardKeywordType[], targeting: readonly WizardTargeting[], grp: string): Row[] {
  const rows: Row[] = []
  const add = (kind: WizardKind, match: string, kwt: string, keywords: string[]) =>
    rows.push({ m: kind === 'auto' ? 'Auto' : kind === 'pat' ? 'PAT' : match, k: kwt || '-', keywords, name: tokenName(grp, kind, match, kwt) })
  if (targeting.includes('auto')) add('auto', '', '', [])
  if (targeting.includes('keyword')) for (const kt of types) for (const mt of kt.matchTypes) add('keyword', matchLabel(mt), kt.name, kt.keywords)
  if (targeting.includes('product')) add('pat', '', '', [])
  return rows
}

/** Each keyword once (case-insensitive, trimmed), first spelling kept. */
export function dedupeKeywords(xs: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of xs) {
    const k = x.trim().toLowerCase()
    if (x.trim() && !seen.has(k)) { seen.add(k); out.push(x.trim()) }
  }
  return out
}

/**
 * The campaigns of a structure (CampaignSetup.tsx `generateCampaigns`), each keyword campaign holding its keyword
 * type's keywords: for Standard and Advanced from `keywords` by type (Brand, Competitor, Category), for Custom from
 * each type's own list.
 */
export function generateWizardCampaigns(input: {
  productGroupName: string
  structure: WizardStructure
  keywords?: Partial<Record<(typeof WIZARD_KEYWORD_TYPES)[number], readonly string[]>>
  customKeywordTypes?: readonly WizardKeywordType[]
  customTargeting?: readonly WizardTargeting[]
}): WizardCampaign[] {
  const grp = input.productGroupName
  const rows = input.structure === 'advanced' ? advancedRows()
    : input.structure === 'custom' ? customRows(input.customKeywordTypes ?? [], input.customTargeting ?? ['auto', 'keyword', 'product'], grp)
      : standardRows()
  return rows.map((r, i) => {
    const kind: WizardKind = r.m === 'Auto' ? 'auto' : r.m === 'PAT' ? 'pat' : 'keyword'
    const name = r.name ?? campaignName(grp, kind, r.m, r.k)
    const own = r.keywords ?? (kind === 'keyword' ? [...(input.keywords?.[r.k as (typeof WIZARD_KEYWORD_TYPES)[number]] ?? [])] : [])
    return { id: `cmp-${i}`, name, adGroupName: `${name} Ad Group`, matchType: r.m, keywordType: r.k, kind, keywords: dedupeKeywords(own), negKeywords: [] }
  })
}

const RANK: Record<WizardMatch, number> = { BROAD: 1, PHRASE: 2, EXACT: 3 }

/** A keyword campaign's single match type, or null for Standard's combined one, Auto and PAT (no part in the funnel). */
function singleMatch(m: string): WizardMatch | null {
  const u = (m || '').toLowerCase()
  if (u.includes('&')) return null
  if (u.includes('phrase')) return 'PHRASE'
  if (u.includes('exact')) return 'EXACT'
  if (u.includes('broad')) return 'BROAD'
  return null
}

/**
 * CampaignSetup.tsx `applyAutoNegatives`: the funnel's negatives added to each campaign of the set (marked `funnel`),
 * after the negatives it already holds (one of those for the same text and match wins: never twice). `enabled` false:
 * the funnel's negatives are dropped and the set's own are kept.
 */
export function applyWizardFunnel(campaigns: readonly WizardCampaign[], enabled: boolean): WizardCampaign[] {
  const base = campaigns.map((c) => ({ ...c, negKeywords: c.negKeywords.filter((n) => !n.funnel) }))
  if (!enabled) return base
  const keywordCampaigns = base.filter((c) => c.kind === 'keyword')
  const allKeywords = dedupeKeywords(keywordCampaigns.flatMap((c) => c.keywords))
  return base.map((c) => {
    const funnel: WizardNegative[] = []
    if (c.kind === 'auto') {
      funnel.push(...allKeywords.map((text) => ({ text, matchType: 'EXACT' as const, funnel: true as const })))
    } else if (c.kind === 'keyword') {
      const my = singleMatch(c.matchType)
      if (my) {
        const siblings = keywordCampaigns.filter((s) => s.keywordType === c.keywordType && s.id !== c.id)
        const groupKeywords = dedupeKeywords([...c.keywords, ...siblings.flatMap((s) => s.keywords)])
        if (RANK.EXACT > RANK[my]) funnel.push(...groupKeywords.map((text) => ({ text, matchType: 'EXACT' as const, funnel: true as const })))
        if (RANK.PHRASE > RANK[my]) funnel.push(...groupKeywords.map((text) => ({ text, matchType: 'PHRASE' as const, funnel: true as const })))
      }
    }
    const seen = new Set(c.negKeywords.map((n) => `${n.text.toLowerCase()}|${n.matchType}`))
    const merged = [...c.negKeywords]
    for (const n of funnel) {
      const key = `${n.text.toLowerCase()}|${n.matchType}`
      if (!seen.has(key)) { seen.add(key); merged.push(n) }
    }
    return { ...c, negKeywords: merged }
  })
}

/** AT.1 / AT.2 — the four Auto groups, each on, at the campaign's default bid times the screen's smart multiplier. */
export const WIZARD_AUTO_GROUPS: ReadonlyArray<{ key: 'CLOSE_MATCH' | 'LOOSE_MATCH' | 'SUBSTITUTES' | 'COMPLEMENTS'; multiplier: number }> = [
  { key: 'CLOSE_MATCH', multiplier: 1.0 },
  { key: 'LOOSE_MATCH', multiplier: 0.65 },
  { key: 'SUBSTITUTES', multiplier: 1.1 },
  { key: 'COMPLEMENTS', multiplier: 0.6 },
]

/** An Auto group's bid in minor units: the default bid times its multiplier, rounded to a cent (the screen's toFixed(2)). */
export const autoGroupBidCents = (defaultBidCents: number, multiplier: number): number => Math.round(defaultBidCents * multiplier)
