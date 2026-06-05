/**
 * MA.3 — Import from Amazon parent (reverse-map bootstrap).
 *
 * The master starts empty; the Amazon parent listing is already rich. This
 * INVERTS the mapping rules: for each rule (channelField ← masterSource), it
 * reads the channel listing's value for channelField and proposes writing it
 * UP to the master at masterSource. Composes with BM auto-map — map the
 * channel fields first, then pull their published values into the master.
 *
 * Only invertible transforms pass; valueMap/sizeScale/template/translate/unit
 * are lossy and SKIPPED + flagged. Master targets are limited to what
 * `PATCH /global` writes (categoryAttributes + localizedContent) — the rest
 * (brand/price/identifiers) live in the identity card and are flagged skipped.
 *
 * Read-only PROPOSE: the caller reviews + applies the accepted proposals via
 * the existing `PATCH /products/:id/global` (skip-by-default on conflicts).
 */

import prisma from '../../db.js'
import { getResolvedRules } from './schema-mapping.service.js'

// Transforms whose output can't be reliably reversed to the master value.
const NON_INVERTIBLE = new Set(['valueMap', 'sizeScale', 'template', 'translate', 'unit', 'numberFormat'])

// Master content sources → the localizedContent slot field.
const CONTENT_SOURCES: Record<string, string> = {
  title: 'title',
  description: 'description',
  bulletPoints: 'bulletPoints',
  keywords: 'keywords',
}

export interface ReverseProposal {
  masterPath: string // categoryAttributes.<key> | localizedContent.<locale>.<field>
  group: 'attribute' | 'content'
  label: string
  sourceField: string
  value: unknown
  conflict: boolean // master already has a value here
}
export interface SkippedField {
  sourceField: string
  reason: string
}

/** Pull the editable value out of Amazon's wrapped attribute shape:
 *  `field: [{ value, marketplace_id, language_tag }]` (single) or multiple
 *  (bullets/keywords). Returns a scalar, an array, or null. Exposed for tests. */
export function readChannelValue(attrs: Record<string, unknown>, field: string): unknown {
  const raw = attrs?.[field]
  if (raw == null) return null
  if (Array.isArray(raw)) {
    const values = raw
      .map((r) => (r && typeof r === 'object' && 'value' in (r as object) ? (r as { value: unknown }).value : r))
      .filter((v) => v != null && v !== '')
    if (values.length === 0) return null
    return values.length === 1 ? values[0] : values
  }
  if (typeof raw === 'object' && 'value' in (raw as object)) return (raw as { value: unknown }).value
  return raw
}

function localeForMarket(marketplace: string): 'en' | 'it' {
  return marketplace.toUpperCase() === 'IT' ? 'it' : 'en'
}

function hasValue(v: unknown): boolean {
  if (v == null || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  return true
}

export async function proposeImportFromChannel(input: {
  productId: string
  channel: string
  marketplace: string
}): Promise<{ productType: string | null; locale: string; proposals: ReverseProposal[]; skipped: SkippedField[] }> {
  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: {
      id: true,
      productType: true,
      categoryAttributes: true,
      localizedContent: true,
      channelListings: {
        where: { channel: input.channel, marketplace: input.marketplace },
        select: { platformAttributes: true },
      },
    },
  })
  if (!product) throw new Error(`Product ${input.productId} not found`)
  const listing = product.channelListings[0]
  if (!listing) throw new Error(`No ${input.channel} ${input.marketplace} listing on this product`)

  const attrs = (((listing.platformAttributes as Record<string, unknown> | null)?.attributes ?? {}) as Record<string, unknown>)
  const productType = product.productType ?? null
  const locale = localeForMarket(input.marketplace)

  const rules = await getResolvedRules(input.channel, input.marketplace, productType)
  const currentAttrs = (product.categoryAttributes as Record<string, unknown> | null) ?? {}
  const currentContent = (product.localizedContent as Record<string, Record<string, unknown>> | null) ?? {}

  const proposals: ReverseProposal[] = []
  const skipped: SkippedField[] = []

  for (const [channelField, rule] of Object.entries(rules)) {
    const value = readChannelValue(attrs, channelField)
    if (!hasValue(value)) continue

    const transforms = Array.isArray(rule.transforms) ? rule.transforms : []
    const bad = transforms.find((t) => NON_INVERTIBLE.has((t as { type?: string })?.type ?? ''))
    if (bad) {
      skipped.push({ sourceField: channelField, reason: `non-invertible transform: ${(bad as { type: string }).type}` })
      continue
    }

    const source = rule.source
    if (typeof source !== 'string') continue

    if (source.startsWith('categoryAttributes.')) {
      const key = source.slice('categoryAttributes.'.length)
      if (!key) continue
      proposals.push({
        masterPath: `categoryAttributes.${key}`,
        group: 'attribute',
        label: key,
        sourceField: channelField,
        value,
        conflict: hasValue(currentAttrs[key]),
      })
    } else if (CONTENT_SOURCES[source]) {
      const field = CONTENT_SOURCES[source]
      proposals.push({
        masterPath: `localizedContent.${locale}.${field}`,
        group: 'content',
        label: `${field} (${locale})`,
        sourceField: channelField,
        value,
        conflict: hasValue(currentContent?.[locale]?.[field]),
      })
    } else {
      skipped.push({ sourceField: channelField, reason: `master target "${source}" is edited in the identity card, not imported here` })
    }
  }

  return { productType, locale, proposals, skipped }
}
