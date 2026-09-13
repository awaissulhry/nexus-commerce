/** Presence wire: one parser at the boundary, unions owned by the design system. */
import { z } from 'zod'
import { PRESENCE_INTENTS, CHANNEL_FACTS, PRESENCE_VERDICTS } from '@/design-system/grid/renderers/presence'
import type { PresenceIntent, ChannelFact, PresenceVerdict } from '@/design-system/grid/renderers/presence'
import type { Reach, ActionReversal, ActionHandoff } from '@/design-system/grid/actions/registry'
import type { ListingCoordinate } from '../../../../../../../../api/src/lib/listing-coordinate'
export type { PresenceIntent, ChannelFact, PresenceVerdict, ListingCoordinate }

const text = z.string()
const maybeText = text.nullable()
const timestamp = z.iso.datetime({ offset: true })
const maybeTime = timestamp.nullable()
const detail = z.record(text, z.unknown()).nullable()
const whole = z.number().int().nonnegative()
const nonblank = text.refine(value => value.trim().length > 0, 'A named coordinate level is required')
export const coordinateSchema: z.ZodType<ListingCoordinate> = z.object({
  productId: nonblank, channel: nonblank, marketplace: nonblank,
  channelConnectionId: nonblank.nullable(), aliasKey: text,
})
export const namedCoordinateSchema = z.object({
  coordinate: coordinateSchema, label: nonblank, sku: maybeText,
  sellerSku: maybeText, sellerSkuSource: maybeText, accountLabel: maybeText, aliasLabel: maybeText,
})
export const intentSchema = z.object({
  value: z.enum(PRESENCE_INTENTS).nullable(), at: maybeTime, by: maybeText, reason: maybeText,
  provisional: z.object({ value: z.enum(PRESENCE_INTENTS), source: z.literal('legacy-columns'),
    fields: z.array(z.object({ name: text, value: z.unknown() })), sentence: text }).nullable(),
})
export const factSchema = z.object({ value: z.enum(CHANNEL_FACTS), asOf: maybeTime, via: maybeText, detail })
const reaches = { local: true, 'local-destructive': true, channel: true } satisfies Record<Reach, true>
const reachSchema = z.custom<Reach>(value => typeof value === 'string' && Object.prototype.hasOwnProperty.call(reaches, value))
const reversalSchema: z.ZodType<ActionReversal> = z.object({ verb: text, fidelity: z.enum(['exact', 'lossy', 'none']) })
const handoffSchema: z.ZodType<ActionHandoff> = z.object({ label: text, reason: text, href: text.optional() })
export const verbSchema = z.object({ available: z.boolean(), reach: reachSchema,
  reversal: reversalSchema.nullable(), refusal: maybeText, errorCode: maybeText,
  handoffs: z.array(handoffSchema), fanOut: z.array(namedCoordinateSchema),
})
export const presenceRowSchema = namedCoordinateSchema.extend({
  kind: z.enum(['listing', 'opening', 'retired']), listingId: maybeText, aliasId: maybeText,
  version: whole.nullable(), productVersion: whole.nullable(), externalListingId: maybeText,
  lastChange: z.object({ eventId: text, at: timestamp, actorUserId: maybeText, summary: text }).nullable(),
  intent: intentSchema, fact: factSchema, verdict: z.enum(PRESENCE_VERDICTS), inFlight: z.boolean(),
  gate: z.object({ mode: maybeText, sentence: maybeText, canVerify: z.boolean() }),
  connection: z.object({ state: z.enum(['connected', 'not-connected', 'unknown']), asOf: maybeTime, via: maybeText, refusal: maybeText,
    authStatus: maybeText, accessTokenExpiresAt: maybeTime, lastErrorAt: maybeTime, lastError: maybeText }),
  participation: z.object({ isParticipating: z.boolean().nullable(), participationStatus: maybeText, checkedAt: maybeTime }),
  local: z.object({ syncPaused: z.boolean().nullable(), variationExcluded: z.boolean().nullable(),
    offerActive: z.boolean().nullable(), offerActiveHonoured: z.boolean().nullable(),
    offerClosedAt: maybeTime, offerClosedBy: maybeText, offerCloseReason: maybeText, lastSyncedAt: maybeTime,
    presenceEffectiveFrom: maybeTime, presenceUntil: maybeTime, scheduleSentence: text }),
  verbs: z.record(text, verbSchema),
})
const verifyPolicySchema = z.object({ maxCoordinatesPerCall: whole, maxAttemptsPerWorkspaceHour: whole, sentence: text })
const readSchema = z.object({ readAt: timestamp, freshnessMs: whole, verifyPolicy: verifyPolicySchema })
const productSchema = z.object({ id: nonblank, sku: text, version: whole, deletedAt: maybeTime })
export const presencePageSchema = readSchema.extend({
  product: productSchema,
  coverage: z.object({ scope: z.enum(['product', 'family']), requestedProductId: nonblank,
    rootProductId: nonblank, products: z.array(productSchema).min(1).max(200), complete: z.literal(true) }),
  rows: z.array(presenceRowSchema), sources: z.array(z.object({ source: text,
    status: z.enum(['ok', 'unavailable']), asOf: maybeTime, refusal: maybeText })),
}).superRefine((page, ctx) => {
  const ids = new Set(page.coverage.products.map(product => product.id))
  const problem = (message: string) => ctx.addIssue({ code: 'custom', path: ['coverage'], message })
  if (ids.size !== page.coverage.products.length) problem('Coverage repeats a product')
  if (page.product.id !== page.coverage.requestedProductId || !ids.has(page.product.id)) problem('Coverage does not name the requested product')
  if (page.coverage.scope === 'product' && ids.size !== 1) problem('Product coverage must name one product')
  if (page.coverage.scope === 'family' && !ids.has(page.coverage.rootProductId)) problem('Family coverage must name its root')
  if (page.rows.some(row => !ids.has(row.coordinate.productId))) problem('A row is outside the reported coverage')
})
export const presenceOneSchema = readSchema.extend({ row: presenceRowSchema })
export const historySchema = z.object({ coordinate: coordinateSchema, readAt: timestamp,
  events: z.array(z.object({ id: text, aggregateId: text, aggregateType: z.literal('ChannelListing'),
    eventType: text, createdAt: timestamp, data: detail, actor: z.object({ userId: maybeText, source: maybeText }) })),
  identities: z.array(z.object({ id: text, coordinate: coordinateSchema, sku: text, externalListingId: text,
    externalParentId: maybeText, firstSeenAt: timestamp, lastSeenAt: timestamp, retiredAt: maybeTime,
    retiredReason: maybeText, retiredBy: maybeText, doNotRecreate: z.boolean(), lastSnapshotId: maybeText })),
  nextCursor: maybeText,
})
export const impactCheckSchema = z.object({
  status: z.enum(['ok', 'unavailable']), scope: z.enum(['product', 'coordinate']), dimensions: z.array(text),
  asOf: maybeTime, provenance: z.array(text), blocking: z.boolean(), refusal: maybeText,
  rows: z.array(z.record(text, z.unknown())),
})
export const amazonPostureSchema = z.object({ coordinate: coordinateSchema, readAt: timestamp,
  offers: z.array(z.object({ id: text, sellerSku: text, fulfillmentMethod: text, isActive: z.boolean(),
    quantity: z.number().nullable(), lastSyncedAt: maybeTime })),
  fbaInventory: z.array(z.object({ id: text, productId: maybeText, sellerSku: text, asin: maybeText,
    marketplaceId: text, fulfillmentCenterId: text, condition: text, quantity: z.number(),
    lastSyncedAt: timestamp, matchedBy: z.enum(['productId', 'sku', 'asin']) })),
  suppressions: z.array(z.object({ id: text, listingId: text, suppressedAt: timestamp, resolvedAt: maybeTime,
    reasonCode: maybeText, reasonText: text, severity: text, source: text })),
  gate: presenceRowSchema.shape.gate,
  sharedQuantityIntent: z.array(namedCoordinateSchema.extend({ intent: intentSchema,
    offerClosedAt: maybeTime, offerActive: z.boolean().nullable() })),
  checks: z.object({ offers: impactCheckSchema, fbaPosture: impactCheckSchema,
    suppressions: impactCheckSchema, sharedQuantityIntent: impactCheckSchema }),
})
export const syncQueueSourceSchema = z.object({
  source: z.enum(['OutboundSyncQueue', 'ListingIssue', 'AmazonSuppression', 'ChannelListing.validationStatus']),
  queried: z.boolean(), status: z.enum(['ok', 'unavailable', 'not-queried']), sentence: text,
})
export type SyncQueueSource = z.infer<typeof syncQueueSourceSchema>
export const verifyResponseSchema = z.object({ readAt: timestamp, results: z.array(z.object({
  coordinate: coordinateSchema, outcome: z.enum(['selling', 'not-selling', 'absent', 'could-not-ask']),
  fact: factSchema, persisted: z.boolean(), refusal: maybeText, errorCode: maybeText,
})) })
export type NamedCoordinate = z.infer<typeof namedCoordinateSchema>
export type IntentRead = z.infer<typeof intentSchema>
export type FactRead = z.infer<typeof factSchema>
export type VerbAvailability = z.infer<typeof verbSchema>
export type PresenceRow = z.infer<typeof presenceRowSchema>
export type PresencePage = z.infer<typeof presencePageSchema>
export type PresenceOne = z.infer<typeof presenceOneSchema>
export type PresenceHistory = z.infer<typeof historySchema>
export type AmazonPosture = z.infer<typeof amazonPostureSchema>
export type VerifyResponse = z.infer<typeof verifyResponseSchema>
