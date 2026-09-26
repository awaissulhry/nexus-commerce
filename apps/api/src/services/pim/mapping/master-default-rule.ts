import type { ChannelFieldSpec } from '../channel-specs/types.js'
import type { FieldMappingRule } from '../schema-mapping.service.js'
import type { AttributeChannel } from '@nexus/shared/attributes'
import { conceptForChannelField } from '@nexus/shared/attribute-concepts'

/**
 * P5 (docs/attributes/PLAN.md §4.3) — the business's concept links: concept key → the master source that holds it
 * (a master field such as `brand`, or the code of the business attribute whose `semanticKey` is the concept).
 */
export interface ConceptLinks { channel: AttributeChannel; sourceFor: ReadonlyMap<string, string> }

type DefaultRuleField = Pick<ChannelFieldSpec, 'key' | 'masterKey' | 'channelStore' | 'defaultRule' | 'shopifyField' | 'readOnlyReason'>
  & Partial<Pick<ChannelFieldSpec, 'label' | 'englishLabel' | 'mode' | 'options' | 'shape'>>

/** Shopify metafield types whose value is plain text, so a Master text value can feed them as it is. */
const SHOPIFY_TEXT_TYPES = new Set(['single_line_text_field', 'multi_line_text_field', 'list.single_line_text_field'])

/**
 * Only declared semantic matches inherit automatically; labels and package/item measures are not interchangeable.
 *
 * P5 — when none of the existing rules link a field (no default rule, no `masterKey`, no Master key of the same
 * name), the concept catalogue may: a field the channel names as a concept's (`aspect_Colore`, `department`,
 * `shopify.color-pattern`) inherits the business attribute linked to that concept. Existing links keep their source.
 * Any automatic link into a STRICT channel list gets a value-map step (miss = keep the value; the channel validator
 * flags it), so one value-map row maps a value for every product.
 */
export function masterDefaultRule(field: DefaultRuleField | undefined, masterKeys: ReadonlySet<string>, concepts?: ConceptLinks): FieldMappingRule | null {
  if (!field || (!field.masterKey && ['productType', 'categoryId', 'taxonomy_id', 'type'].includes(field.key))) return null
  if (field.defaultRule) return field.defaultRule
  if (field.readOnlyReason) return null
  const followSource = field.channelStore?.kind === 'listingColumn'
    ? ({ followMasterPrice: 'basePrice', followMasterQuantity: 'totalStock' } as Record<string, string>)[field.channelStore.followFlag ?? ''] : undefined
  const key = field.masterKey ?? followSource ?? (field.key === 'country_of_origin' ? 'countryOfOrigin' : field.key)
  const direct = !(field.shopifyField && !field.masterKey) && masterKeys.has(key)
  const linked = direct ? null : conceptSource(field, masterKeys, concepts)
  const source = direct ? key : linked?.source
  if (!source) return null
  const strict = field.mode === 'strict' && !!field.options?.length
  const transforms = [
    ...(field.key === 'generic_keyword' ? [{ type: 'expr' as const, expr: 'replace(text($keywords), ", ", " ")' }] : []),
    // PLAN §4.3 — any automatic link into a STRICT channel list reads the value maps, so one row maps a value for
    // every product. With no row for a value, `keep` sends it as it is (what happened before) and the channel
    // validator flags an off-list value.
    ...(strict ? [{ type: 'valueMap' as const, attribute: source }] : []),
  ]
  return {
    source: source === 'name' ? 'title' : source,
    ...(source === 'name' ? { fallback: 'name' } : {}),
    ...(transforms.length ? { transforms } : {}),
    notes: linked
      ? `Inherits the Master attribute linked to the "${linked.concept}" concept. A channel mapping or listing override can replace it.`
      : 'Inherits the corresponding Master attribute. A channel mapping or listing override can replace it.',
  }
}

/** The master source the concept catalogue links this channel field to, or null. */
function conceptSource(field: DefaultRuleField, masterKeys: ReadonlySet<string>, concepts?: ConceptLinks): { source: string; concept: string } | null {
  // A measure (value + unit) cannot take a bare Master value; it needs an explicit rule.
  if (!concepts || field.masterKey || field.shape === 'measure') return null
  const shopify = field.shopifyField
  if (shopify && (!shopify.definition || !SHOPIFY_TEXT_TYPES.has(shopify.type))) return null
  const names = [field.key, shopify?.source, field.englishLabel, field.label].filter((n): n is string => !!n)
  for (const name of names) {
    const concept = conceptForChannelField(concepts.channel, name)
    if (!concept) continue
    const source = concepts.sourceFor.get(concept.key)
    return source && masterKeys.has(source) ? { source, concept: concept.key } : null
  }
  return null
}
