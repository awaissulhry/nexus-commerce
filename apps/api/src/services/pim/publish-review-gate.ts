/**
 * D7 in ONE place (R-LX-7, on LX.R's P0-2).
 *
 * Before this module the review verdict existed only inside the Amazon payload
 * builder, so eBay, Shopify, Woo and the queue drain published an unreviewed
 * machine draft without ever consulting it (measured: 0 hits of
 * `publishReviewIssues` in five non-Amazon publish files). Everything D7 needs
 * lives here now — the resolution every publisher shares, the review verdict,
 * the untranslated verdict (R-LX-6) and the `requireReviewed` setting — and the
 * publish paths call it rather than re-deriving it. One definition, zero copies.
 *
 * The sentence a preflight shows and the sentence a refusal throws are the same
 * string, produced once by `publishReviewIssues`.
 */
import prisma from '../../db.js'
import { contentListing } from './content-read.js'
import { resolveContent, translationMissing, type ContentProduct, type ResolvedContent } from './content-resolver.js'
import { marketLanguages } from './market-languages.js'

export interface PublishContentInput {
  product: ContentProduct
  parent?: ContentProduct | null
  listing?: Record<string, any> | null
  marketplace: string
  channel?: string
  fields?: readonly string[]
}

export const PUBLISH_CONTENT_FIELDS = ['title', 'description', 'bulletPoints', 'keywords'] as const
export type PublishContentRow = { language: string; fields: Record<string, ResolvedContent> }
export type PublishContentIssue = { language: string; field: string; severity: 'ERROR' | 'WARNING'; message: string }

/**
 * D7's switch, with a definition and a reader (it had neither — the one
 * occurrence in the tree was a literal `requireReviewed: true` in a response
 * body). Default ON, exactly as D7 says; `NEXUS_REQUIRE_REVIEWED_CONTENT=0`
 * is the only way to publish machine copy, and the preflight reports the value
 * it actually read.
 */
export const requireReviewedContent = () => (process.env.NEXUS_REQUIRE_REVIEWED_CONTENT ?? '1') !== '0'

const languageName = (language: string) => new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ?? language

/** Publish and preflight consume the exact same resolved values and review verdict. */
export async function resolvePublishContent(input: PublishContentInput): Promise<PublishContentRow[]> {
  const channel = input.channel ?? 'AMAZON'
  const languages = await marketLanguages(channel, input.marketplace)
  const coordinate = { channel, market: input.marketplace,
    ...(input.listing?.channelConnectionId ? { accountId: input.listing.channelConnectionId } : {}),
    ...(input.listing?.aliasKey ? { aliasId: input.listing.aliasKey } : {}) }
  const listing = contentListing(input.product, input.listing, coordinate, languages)
  return languages.map(language => ({ language, fields: Object.fromEntries((input.fields ?? PUBLISH_CONTENT_FIELDS).map(field => {
    const args = { product: input.product, parent: input.parent, listing, field, address: { requested: language, coordinate } }
    const resolved = resolveContent(args)
    // A following legacy snapshot must not conceal an unreviewed shared draft
    // from publish preflight. Approved writes already update these snapshots.
    if (resolved.drift && resolved.follows) {
      const shared = resolveContent({ ...args, listing: null })
      if (shared.translation && shared.translation.source !== 'manual' && !shared.translation.reviewedAt) return [field, shared]
    }
    return [field, resolved]
  })) as Record<string, ResolvedContent> }))
}

/** An unreviewed machine draft — the one predicate, so a second reader cannot re-derive it differently. */
export const unreviewedMachineDraft = (resolved: Pick<ResolvedContent, 'translation'>) =>
  !!resolved.translation && resolved.translation.source !== 'manual' && !resolved.translation.reviewedAt

export function publishReviewIssues(content: readonly PublishContentRow[]): PublishContentIssue[] {
  return content.flatMap(row => Object.entries(row.fields).filter(([, value]) => unreviewedMachineDraft(value))
    .map(([field]) => ({ language: row.language, field, severity: 'ERROR' as const,
      message: `Review the ${languageName(row.language)} (${row.language}) ${field} before publishing.` })))
}

/**
 * R-LX-6: a requested language that resolves to the source tier is OMITTED from
 * the payload (never duplicated, never stamped with the destination's tag), and
 * the preflight says so by name. WARNING, not ERROR: the other languages and
 * attributes still publish, and required-ness is readiness's verdict — this
 * builder cannot see the channel schema.
 */
export function publishUntranslatedIssues(content: readonly PublishContentRow[]): PublishContentIssue[] {
  return content.flatMap(row => Object.entries(row.fields)
    .filter(([, value]) => value.value != null && value.value !== '' && translationMissing(value, row.language))
    .map(([field, value]) => ({ language: row.language, field, severity: 'WARNING' as const,
      message: `The ${languageName(row.language)} (${row.language}) ${field} is not translated — the ${languageName(value.language)} text is shown in the studio but is omitted from the payload.` })))
}

/** Everything a preflight shows for one coordinate, in one call. */
export function publishContentIssues(content: readonly PublishContentRow[]): PublishContentIssue[] {
  return [...publishReviewIssues(content), ...publishUntranslatedIssues(content)]
}

export class ContentReviewRequired extends Error {
  statusCode = 422
  code = 'content_review_required'
  constructor(public issues: PublishContentIssue[]) { super(issues.map(issue => issue.message).join(' ')) }
}

/** D7 for a caller that already resolved the content (the Amazon builder). */
export function assertContentReviewed(content: readonly PublishContentRow[]): void {
  if (!requireReviewedContent()) return
  const issues = publishReviewIssues(content)
  if (issues.length) throw new ContentReviewRequired(issues)
}

/**
 * D7 for a publisher that holds a coordinate rather than resolved rows — the
 * `assertLegacyPresentationPublishAllowed` idiom, so every path can consult the
 * one verdict with the identifiers it already has. A product that does not
 * exist publishes nothing and is not refused.
 */
export async function assertListingContentReviewed(input: {
  productId?: string | null
  sku?: string | null
  channel: string
  marketplace?: string | null
  listingId?: string | null
  accountId?: string | null
  fields?: readonly string[]
}): Promise<void> {
  if (!requireReviewedContent()) return
  const where = input.productId ? { id: input.productId } : { sku: input.sku ?? '__missing__' }
  const product = await prisma.product.findFirst({ where: { ...where, deletedAt: null },
    include: { translations: true, parent: { include: { translations: true } } } })
  if (!product) return
  const listing = input.listingId
    ? await prisma.channelListing.findUnique({ where: { id: input.listingId }, include: { translations: true } })
    : input.marketplace
      ? await prisma.channelListing.findFirst({ where: { productId: product.id, channel: input.channel, marketplace: input.marketplace,
        ...(input.accountId ? { channelConnectionId: input.accountId } : {}) }, include: { translations: true } })
      : null
  // eBay's own marketplace ids arrive as `EBAY_IT`; the authority is keyed by
  // the bare market code (the same strip `assertLegacyPresentationPublishAllowed`
  // applies). The listing row's own code wins when there is one.
  const marketplace = listing?.marketplace ?? input.marketplace?.toUpperCase().replace(/^(EBAY|AMAZON|SHOPIFY)_/, '') ?? null
  let languages: string[] | null = null
  if (marketplace) try { languages = await marketLanguages(input.channel, marketplace) } catch { languages = null }
  if (!marketplace || !languages) {
    // The authority cannot name this destination's languages, so the gate cannot
    // pick one. Fail CLOSED on what it can still see rather than going quiet.
    const family = [product.id, ...(product.parentId ? [product.parentId] : [])]
    const drafts = await prisma.productTranslation.findMany({ where: { productId: { in: family }, reviewedAt: null, NOT: { source: 'manual' } }, select: { language: true } })
    if (drafts.length) throw new ContentReviewRequired(drafts.map(row => ({ language: row.language, field: 'content', severity: 'ERROR' as const,
      message: `Review the ${languageName(row.language)} (${row.language}) content before publishing.` })))
    return
  }
  const content = await resolvePublishContent({ product: product as any, parent: product.parent as any, listing,
    marketplace, channel: input.channel, fields: input.fields })
  assertContentReviewed(content)
}
