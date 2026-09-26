/**
 * P3b S6 (docs/attributes/PLAN.md §10.9) — which connected channels use each business attribute, and which are dormant.
 *
 * A channel DECLARES an attribute when:
 *   · the attribute is linked to a concept (`semanticKey`, P3) whose catalogue entry binds a field of that channel;
 *   · a mapping rule of one of the channel's markets reads it (`Marketplace.schemaMapping`, the rule's source or
 *     fallback);
 *   · the channel's own cached schema has a field with the same key (Amazon: an attribute of a cached product type);
 *   · the attribute is placed on that channel (S3).
 * It is USED BY the declaring channels that are in the business's footprint (S1: an active account). An attribute is
 * DORMANT when no connected channel uses it and no family requires it: the Shared view hides it by default
 * (`defaultVisible = false`), and the "Show hidden" section of the Customise dialog shows it again. Nothing is deleted.
 */
import prisma from '../../db.js'
import { ATTRIBUTE_CONCEPTS } from '@nexus/shared/attribute-concepts'
import { channelFootprint } from '../channel-footprint.service.js'
import { amazonSchemaKeys } from './family-sheet-schema.js'

export interface AttributeUsage {
  code: string
  /** Every channel that declares the attribute, connected or not. */
  declaredBy: string[]
  /** The declaring channels the business has connected (its footprint). */
  usedBy: string[]
  /** Channels a family requires it on; `'*'` = required everywhere. */
  requiredBy: string[]
  /** No connected channel uses it and no family requires it. */
  dormant: boolean
}

type Rule = { source?: unknown; fallback?: unknown }
type Mapping = { fields?: Record<string, Rule>; byProductType?: Record<string, Record<string, Rule>> } | null

/** The attribute key a mapping path reads (`categoryAttributes.color`, `localizedContent.it.material`, `size.0` …). */
export function mappedAttributeKey(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null
  const key = path.replace(/\{locale\}/g, '').replace(/^(categoryAttributes|variantAttributes)\./, '').replace(/^localizedContent\.[^.]*\./, '').split('.')[0]
  return key || null
}

/** Pure: the usage of every attribute from what declares it. */
export function usageFrom(input: {
  attributes: Array<{ code: string; semanticKey: string | null; placement: string; placementChannels: string[]; requirements: string[][] }>
  connected: ReadonlySet<string>
  conceptChannels: ReadonlyMap<string, readonly string[]>
  ruleChannels: ReadonlyMap<string, ReadonlySet<string>>
  amazonKeys: ReadonlySet<string>
}): Map<string, AttributeUsage> {
  const out = new Map<string, AttributeUsage>()
  for (const a of input.attributes) {
    const declared = new Set<string>([
      ...(a.semanticKey ? input.conceptChannels.get(a.semanticKey) ?? [] : []),
      ...(input.ruleChannels.get(a.code) ?? []),
      ...(input.amazonKeys.has(a.code) ? ['AMAZON'] : []),
      ...(a.placement === 'channel' ? a.placementChannels : []),
    ])
    const requiredBy = [...new Set(a.requirements.flatMap(channels => channels.length ? channels : ['*']))].sort()
    const declaredBy = [...declared].sort()
    const usedBy = declaredBy.filter(channel => input.connected.has(channel))
    out.set(a.code, { code: a.code, declaredBy, usedBy, requiredBy, dormant: usedBy.length === 0 && requiredBy.length === 0 })
  }
  return out
}

export async function attributeUsages(): Promise<Map<string, AttributeUsage>> {
  const [attributes, footprint, markets, amazonKeys] = await Promise.all([
    prisma.customAttribute.findMany({ where: { archivedAt: null }, select: { code: true, semanticKey: true, placement: true, placementChannels: true,
      familyAttributes: { where: { required: true }, select: { channels: true } } } }),
    channelFootprint(),
    prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, schemaMapping: true } }),
    amazonSchemaKeys(),
  ])
  const ruleChannels = new Map<string, Set<string>>()
  const note = (path: unknown, channel: string) => {
    const key = mappedAttributeKey(path)
    if (key) ruleChannels.set(key, (ruleChannels.get(key) ?? new Set()).add(channel))
  }
  for (const market of markets) {
    const mapping = market.schemaMapping as Mapping
    const rules = [...Object.values(mapping?.fields ?? {}), ...Object.values(mapping?.byProductType ?? {}).flatMap(r => Object.values(r ?? {}))]
    for (const rule of rules) { note(rule?.source, market.channel); note(rule?.fallback, market.channel) }
  }
  const conceptChannels = new Map(ATTRIBUTE_CONCEPTS.map(c => [c.key, Object.entries(c.bindings).filter(([, fields]) => fields?.length).map(([channel]) => channel)]))
  return usageFrom({
    attributes: attributes.map(a => ({ code: a.code, semanticKey: a.semanticKey, placement: a.placement, placementChannels: a.placementChannels, requirements: a.familyAttributes.map(fa => fa.channels) })),
    connected: new Set(footprint.channels.map(c => c.channel)),
    conceptChannels, ruleChannels, amazonKeys,
  })
}
