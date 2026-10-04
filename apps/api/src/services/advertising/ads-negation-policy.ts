/**
 * 5a — the one negation policy: which terms may never be negated, and what Amazon accepts as a negative.
 *
 * Every place that asks "may this negative go to Amazon?" asks here: the write gate
 * (`checkAdsWriteGate`, before its sandbox return), the wire (`liveCall` refuses a negative create or
 * re-enable it carries), the client's sandbox branches, and the MCP preview. Before this the gate held
 * the matcher and the MCP tool held a copy, and only callers that passed `isNegation` + `keywordText`
 * were checked: launches, bulk negatives, the bulk sheet, AI goals, blueprints, launch-repair and a
 * re-enabled negative reached Amazon without it (review 7.1).
 *
 * Protected terms (AdKeywordProtection, mode WHITELIST):
 *   EXACT     the negative's text is the term
 *   PREFIX    the negative's text starts with the term
 *   CONTAINS  the negative's text contains the term anywhere ("giacca moto xavia" ⊃ "xavia")
 *   A null matchType falls back to isPrefix, so rows written before that column behave unchanged.
 * A NEGATIVE_PHRASE also blocks every search that contains its words in order, so it is refused when a
 * protected term contains it as a run of whole words: phrase "gale" would block "xavia gale" (review 7.9).
 *
 * Text limits (G.10): Amazon accepts a negative exact keyword of at most 10 words and 80 characters and
 * a negative phrase of at most 4 words and 80 characters — Amazon Ads, "A guide to targeting with
 * Sponsored Products" (advertising.amazon.com/library/guides/targeting-with-sponsored-products); the
 * ad-group negatives modal states the 4-word phrase cap too (AddNegativeKeywordsAgModal.tsx).
 *
 * The module top level stays free of the database: the client imports it, and its pure half is
 * unit-testable without a connection (the same reason ads-write-reconcile.service.ts loads db lazily).
 */

import type { Prisma } from '@prisma/client'
import { logger } from '../../utils/logger.js'

export type ProtectionMatchType = 'EXACT' | 'PREFIX' | 'CONTAINS'

/** An AdKeywordProtection row, as far as matching needs it. */
export interface ProtectedTerm {
  term: string
  matchType?: string | null
  isPrefix?: boolean | null
  reason?: string | null
}

/** What a negative would block: the protected term, and whether its own text or its phrase reach hit it. */
export interface ProtectedTermHit {
  protection: ProtectedTerm
  via: 'text' | 'phrase'
}

/** Thrown where a negative is refused below the gate (the wire, the client's sandbox branches). The message is the sentence. */
export class NegativeRefusedError extends Error {
  readonly code = 'negative_refused'
  constructor(message: string) {
    super(message)
    this.name = 'NegativeRefusedError'
  }
}

/** Normalise a keyword for protection matching: lowercase, collapse whitespace. */
export function normaliseTerm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function protectionMatchType(p: ProtectedTerm): ProtectionMatchType {
  const m = (p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')).toUpperCase()
  return m === 'CONTAINS' || m === 'PREFIX' ? m : 'EXACT'
}

/** True for NEGATIVE_PHRASE and the plain PHRASE spelling the v1 sync stores. */
export function isPhraseMatch(matchType: string | null | undefined): boolean {
  return /PHRASE$/i.test(matchType ?? '')
}

/** Does `haystack` hold `needle` as a run of whole words? Both normalised. */
function hasWordRun(haystack: string, needle: string): boolean {
  return needle !== '' && ` ${haystack} `.includes(` ${needle} `)
}

/** The protected term a negative with this text and match type would block, or null. */
export function protectedTermHit(
  text: string,
  matchType: string | null | undefined,
  protections: readonly ProtectedTerm[],
): ProtectedTermHit | null {
  const term = normaliseTerm(text)
  if (!term) return null
  for (const p of protections) {
    const t = normaliseTerm(p.term)
    if (!t) continue
    const mode = protectionMatchType(p)
    const own = mode === 'CONTAINS' ? term.includes(t) : mode === 'PREFIX' ? term.startsWith(t) : term === t
    if (own) return { protection: p, via: 'text' }
  }
  if (isPhraseMatch(matchType)) {
    for (const p of protections) {
      if (hasWordRun(normaliseTerm(p.term), term)) return { protection: p, via: 'phrase' }
    }
  }
  return null
}

/** The refusal, as a sentence that names the protected term. */
export function protectedTermRefusal(text: string, hit: ProtectedTermHit): string {
  const term = normaliseTerm(text)
  const protectedTerm = normaliseTerm(hit.protection.term)
  const why = hit.protection.reason ? ` (${hit.protection.reason})` : ''
  return hit.via === 'phrase'
    ? `"${term}" cannot be a phrase negative: it would also block searches for the protected term "${protectedTerm}"${why}.`
    : `"${term}" cannot be negated: it matches the protected term "${protectedTerm}"${why}.`
}

// ── Amazon's limits for a negative keyword ───────────────────────────────────────────────────────

export const NEGATIVE_KEYWORD_LIMITS = { maxChars: 80, maxWordsExact: 10, maxWordsPhrase: 4 } as const

/** Why Amazon would not accept this negative keyword text, as a sentence; null when it would. */
export function negativeKeywordTextProblem(text: string, matchType: string | null | undefined): string | null {
  const term = normaliseTerm(text)
  if (!term) return 'A negative keyword needs some text.'
  const phrase = isPhraseMatch(matchType)
  if (term.length > NEGATIVE_KEYWORD_LIMITS.maxChars) {
    return `"${term}" has ${term.length} characters; Amazon accepts at most ${NEGATIVE_KEYWORD_LIMITS.maxChars} in a negative keyword.`
  }
  const words = term.split(' ').length
  const maxWords = phrase ? NEGATIVE_KEYWORD_LIMITS.maxWordsPhrase : NEGATIVE_KEYWORD_LIMITS.maxWordsExact
  if (words > maxWords) {
    return `"${term}" has ${words} words; Amazon accepts at most ${maxWords} in a negative ${phrase ? 'phrase' : 'exact'} keyword.`
  }
  return null
}

/** An Amazon ASIN (B0 + 8 letters or digits) — a product, not a keyword. */
export function isAsin(text: string): boolean {
  return /^b0[a-z0-9]{8}$/i.test(text.trim())
}

// ── The protected terms that bind a negative ─────────────────────────────────────────────────────

/**
 * The protected terms that bind a negative in this market and campaign (Nexus Campaign.id).
 * A scope the caller does not know binds every row: a market-only or campaign-only protection is never
 * skipped because the write could not say where it lands.
 */
export async function loadProtectedTerms(scope: { marketplace?: string | null; campaignId?: string | null }): Promise<ProtectedTerm[]> {
  const { default: prisma } = await import('../../db.js')
  const and: Prisma.AdKeywordProtectionWhereInput[] = []
  if (scope.marketplace) and.push({ OR: [{ marketplace: null }, { marketplace: scope.marketplace }] })
  if (scope.campaignId) and.push({ OR: [{ campaignId: null }, { campaignId: scope.campaignId }] })
  return prisma.adKeywordProtection.findMany({
    where: { mode: 'WHITELIST', ...(and.length ? { AND: and } : {}) },
    select: { term: true, isPrefix: true, matchType: true, reason: true },
  })
}

/** The refusal for negating this text here, or null when no protected term is in the way. */
export async function protectedNegativeRefusal(args: {
  text: string
  matchType?: string | null
  marketplace?: string | null
  campaignId?: string | null
}): Promise<{ reason: string; protectedTerm: string } | null> {
  if (!normaliseTerm(args.text)) return null
  const hit = protectedTermHit(args.text, args.matchType, await loadProtectedTerms(args))
  return hit ? { reason: protectedTermRefusal(args.text, hit), protectedTerm: normaliseTerm(hit.protection.term) } : null
}

// ── At the wire ──────────────────────────────────────────────────────────────────────────────────

/** The SP v3 negative endpoints and the body key that holds their items. Their /list and /delete are not writes of a negative. */
const NEGATIVE_ENDPOINTS: Record<string, { key: string; kind: 'keyword' | 'target' }> = {
  '/sp/negativeKeywords': { key: 'negativeKeywords', kind: 'keyword' },
  '/sp/campaignNegativeKeywords': { key: 'campaignNegativeKeywords', kind: 'keyword' },
  '/sp/negativeTargets': { key: 'negativeTargetingClauses', kind: 'target' },
}

type WireItem = Record<string, unknown>

function wireItems(body: unknown, key: string): WireItem[] {
  const list = (body as Record<string, unknown> | null | undefined)?.[key]
  return Array.isArray(list) ? list.filter((x): x is WireItem => x != null && typeof x === 'object') : []
}

/** The Nexus campaign behind an Amazon campaign id: its id and market, or nulls when Nexus does not hold it. */
async function campaignScope(externalCampaignId: unknown): Promise<{ marketplace: string | null; campaignId: string | null }> {
  if (typeof externalCampaignId !== 'string' && typeof externalCampaignId !== 'number') return { marketplace: null, campaignId: null }
  const { default: prisma } = await import('../../db.js')
  const c = await prisma.campaign.findFirst({ where: { externalCampaignId: String(externalCampaignId) }, select: { id: true, marketplace: true } })
  return { marketplace: c?.marketplace ?? null, campaignId: c?.id ?? null }
}

/** The values a negative targeting clause names (an ASIN for asinSameAs, a brand id for asinBrandSameAs). */
function clauseValues(item: WireItem): string[] {
  const expression = Array.isArray(item.expression) ? item.expression : []
  return expression
    .map((e) => (e as { value?: unknown } | null)?.value)
    .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    .map(String)
}

/**
 * Why this Amazon call must not be sent, or null. Only a negative create (POST to a negative endpoint)
 * and a negative put back to ENABLED (PUT with state ENABLED) are judged; every other call is null.
 * A re-enable is judged on the text Nexus holds for that id; an id Nexus does not hold is refused,
 * because nothing then says which term it would start blocking again.
 */
export async function negativeWireRefusal(req: { method: string; path: string; body?: unknown }): Promise<string | null> {
  const endpoint = NEGATIVE_ENDPOINTS[req.path]
  if (!endpoint) return null
  const method = req.method.toUpperCase()

  if (method === 'POST') {
    for (const item of wireItems(req.body, endpoint.key)) {
      const scope = await campaignScope(item.campaignId)
      if (endpoint.kind === 'keyword') {
        const text = String(item.keywordText ?? '')
        const matchType = typeof item.matchType === 'string' ? item.matchType : null
        const problem = negativeKeywordTextProblem(text, matchType)
        if (problem) return problem
        const refusal = await protectedNegativeRefusal({ text, matchType, ...scope })
        if (refusal) return refusal.reason
      } else {
        for (const value of clauseValues(item)) {
          const refusal = await protectedNegativeRefusal({ text: value, ...scope })
          if (refusal) return refusal.reason
        }
      }
    }
    return null
  }

  if (method === 'PUT') {
    const { default: prisma } = await import('../../db.js')
    for (const item of wireItems(req.body, endpoint.key)) {
      if (String(item.state ?? '').toUpperCase() !== 'ENABLED') continue
      const id = item.keywordId ?? item.negativeKeywordId ?? item.campaignNegativeKeywordId ?? item.targetId ?? item.negativeTargetId
      const row = id == null ? null : await prisma.adTarget.findFirst({
        where: { externalTargetId: String(id), isNegative: true },
        select: { expressionValue: true, expressionType: true, adGroup: { select: { campaign: { select: { id: true, marketplace: true } } } } },
      })
      if (!row) return `Negative ${id == null ? '(no id)' : String(id)} was not re-enabled: Nexus holds no copy of it, so it cannot check it against the protected terms.`
      const campaign = row.adGroup?.campaign
      const refusal = await protectedNegativeRefusal({
        text: row.expressionValue,
        matchType: endpoint.kind === 'keyword' ? row.expressionType : null,
        marketplace: campaign?.marketplace ?? null,
        campaignId: campaign?.id ?? null,
      })
      if (refusal) return `Not re-enabled: ${refusal.reason}`
    }
  }
  return null
}

/** Throws NegativeRefusedError when `negativeWireRefusal` refuses the call. */
export async function assertNegativeWriteAllowed(req: { method: string; path: string; body?: unknown }): Promise<void> {
  const refusal = await negativeWireRefusal(req)
  if (!refusal) return
  logger.warn('[ads-negation-policy] negative refused before it reached Amazon', { method: req.method, path: req.path, reason: refusal })
  throw new NegativeRefusedError(refusal)
}
