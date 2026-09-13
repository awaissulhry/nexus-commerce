import { translationMissing, type ContentProduct } from './content-resolver.js'
import { languageTag } from './market-languages.js'
import { assertContentReviewed, resolvePublishContent, type PublishContentRow } from './publish-review-gate.js'

// D7's verdict, the shared resolution and the `requireReviewed` setting live in
// `publish-review-gate.ts` (R-LX-7) so every publisher consults one definition.
// Re-exported here for the callers that already import them from this module.
export { resolvePublishContent, publishReviewIssues, publishUntranslatedIssues, publishContentIssues, requireReviewedContent } from './publish-review-gate.js'

export interface AmazonContentInput {
  product: ContentProduct
  parent?: ContentProduct | null
  listing?: Record<string, any> | null
  marketplace: string
  marketplaceId: string
  fields?: readonly string[]
}

const AMAZON_CONTENT_KEYS: Record<string, string> = { title: 'item_name', description: 'product_description', bulletPoints: 'bullet_point', keywords: 'generic_keyword' }

/**
 * R-LX-6 — the payload's shape rule, pure and separately testable.
 *
 * 1. A requested language answered by another language (an untranslated market)
 *    is OMITTED: the source text never goes out under the destination's tag and
 *    never under a foreign one. The preflight names it (`publishUntranslatedIssues`).
 *    A PATCH that omits an attribute does not delete it on Amazon.
 * 2. Exactly one contribution per `(attribute, marketplace_id, language_tag)`:
 *    two requested languages collapsing onto one resolved language emit one set
 *    of entries, not two identical ones. A field whose value is an array (bullet
 *    points) keeps every element — the tuple is the contribution, not the entry.
 */
export function buildAmazonContentEntries(content: readonly PublishContentRow[], input: Pick<AmazonContentInput, 'marketplace' | 'marketplaceId'>): Record<string, any[]> {
  const attributes: Record<string, any[]> = {}
  const emitted = new Set<string>()
  for (const row of content) for (const [field, resolved] of Object.entries(row.fields)) {
    const key = AMAZON_CONTENT_KEYS[field]
    if (!key || resolved.value == null || resolved.value === '') continue
    if (translationMissing(resolved, row.language)) continue
    const language_tag = languageTag(resolved.language, input.marketplace)
    // The delimiter is PRINTABLE on purpose: a literal NUL byte here (the first
    // spelling of this line) makes the shell’s `grep` skip the whole file, so every
    // repo-wide set claim silently omits a publish path (memory:
    // reference_nul_byte_in_source_blinds_grep). `|` cannot occur in an attribute
    // key, a marketplace id or a language tag, all of which are validated.
    const tuple = `${key}|${input.marketplaceId}|${language_tag}`
    if (emitted.has(tuple)) continue
    emitted.add(tuple)
    const values = Array.isArray(resolved.value) ? resolved.value : [resolved.value]
    for (const value of values.filter(value => value !== '' && value != null)) {
      (attributes[key] ??= []).push({ value: String(value), marketplace_id: input.marketplaceId, language_tag })
    }
  }
  return attributes
}

/** Pure payload construction after database reads; never invokes a publisher or provider. */
export async function buildAmazonContentAttributes(input: AmazonContentInput): Promise<Record<string, any[]>> {
  const content = await resolvePublishContent(input)
  assertContentReviewed(content)
  return buildAmazonContentEntries(content, input)
}
