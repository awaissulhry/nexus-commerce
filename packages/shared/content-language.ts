/** LX.4: internal content addresses are language-only. Regional delivery tags belong to languageTag(). */
export type ContentLanguage = string

export interface ContentCoordinate { channel: string; market: string; accountId?: string; aliasId?: string }
export type ContentAddress =
  | { tier: 'source' }
  | { tier: 'language'; language: ContentLanguage }
  | { tier: 'pin'; language: ContentLanguage; coordinate: ContentCoordinate }

/** Validate the address, never guess a write destination from the current value. */
export function contentAddress(value: unknown, label: string): ContentAddress {
  const fail = () => { throw Object.assign(new Error(`${label} needs a ContentAddress before it can be saved.`), { statusCode: 400 }) }
  if (!value || typeof value !== 'object') return fail()
  const address = value as ContentAddress
  if (address.tier === 'source') return { tier: 'source' }
  if (address.tier !== 'language' && address.tier !== 'pin') return fail()
  let language: string
  try { language = normalizeLanguage(address.language) } catch { return fail() }
  if (address.tier === 'language') return { tier: 'language', language }
  const c = address.coordinate
  if (!c || typeof c.channel !== 'string' || !c.channel || typeof c.market !== 'string' || !c.market ||
    c.accountId !== undefined && typeof c.accountId !== 'string' || c.aliasId !== undefined && typeof c.aliasId !== 'string') return fail()
  return { tier: 'pin', language, coordinate: { ...c, channel: c.channel.toUpperCase(), market: c.market.toUpperCase() } }
}

/**
 * LX.FIN (R-LX-25) — the address a SHARED (non-coordinate) content write carries, derived from the
 * language and nothing else, so the four catalogue surfaces cannot each invent their own literal.
 *
 * 🔴 It exists because the opposite was measured: the `/products` drawer's Translations tab and the
 * Translations lens both sent NO address at all, and every one of their verbs answered 400
 * ("Translation needs a ContentAddress before it can be saved.", "Content needs a ContentAddress…")
 * from the moment the router landed. A two-field object copied into five call sites is how the next
 * surface gets it subtly wrong; this is the one place that knows the rule.
 *
 * The rule: the PRIMARY language's shared text is the SOURCE tier (it lives on the product's own
 * columns, not in a translation row), every other language is the `language` tier. A caller that
 * does not know the primary language omits it and gets the `language` tier — which the server then
 * refuses by name if the language happens to be the primary, rather than writing to the wrong home.
 */
export function sharedContentAddress(language: string, primaryLanguage?: string | null): ContentAddress {
  const normalized = normalizeLanguage(language)
  if (primaryLanguage && normalizeLanguage(primaryLanguage) === normalized) return { tier: 'source' }
  return { tier: 'language', language: normalized }
}

export function normalizeLanguage(tag: string): ContentLanguage {
  if (typeof tag !== 'string') throw new Error('Content language must be a language tag.')
  const language = tag.toLowerCase().split(/[-_]/, 1)[0]
  if (!/^[a-z]{2,3}$/.test(language)) throw new Error(`Invalid content language: ${tag}`)
  return language
}

/** Read existing regional addresses without rewriting any stored key. */
export function languageEntry<T>(entries: Iterable<readonly [string, T]>, requested: string): T | undefined {
  const language = normalizeLanguage(requested)
  const matches = [...entries].filter(([tag]) => normalizeLanguage(tag) === language)
  const canonical = matches.find(([tag]) => tag === language)
  if (canonical) return canonical[1]
  if (matches.length > 1) throw new Error(`Ambiguous content addresses for ${language}`)
  return matches[0]?.[1]
}

/** Server-owned destination and acknowledgement, echoed by both sheet wire mirrors. */
export interface ContentWriteFacts {
  contentAddress?: ContentAddress | null
  contentVersion?: number
  contentAcknowledged?: boolean
  contentAcknowledgement?: {
    shared: { label: string; address: ContentAddress }
    pin: { label: string; address: ContentAddress }
    reach: string[]
  }
}

/** LX.12: the resolver's answer, independent of its write destination. */
export interface ResolvedContent {
  value: unknown
  tier: 'pin' | 'language' | 'source' | 'computed'
  language: ContentLanguage
  requested: ContentLanguage
  provenance: { member: import('./cell-provenance').CellProvenance; from: string | null }
  translation?: { source: 'manual' | 'ai' | 'translated'; reviewedAt: string | null; outdated: boolean }
}
