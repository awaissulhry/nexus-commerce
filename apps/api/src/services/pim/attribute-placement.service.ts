/**
 * P3b S3 (docs/attributes/PLAN.md §10.9) — an attribute's placement, archive instead of delete, and undo.
 *
 * Placement is a LABEL (Owner decision D1 = A): `shared` = the Shared scope; `channel` = only the channels in
 * `placementChannels`. No value moves — a channel scope reads the same key. What does move is the family REQUIREMENT:
 * a family that requires the attribute everywhere now requires it on those channels only. A family that requires it on
 * a channel outside the new placement blocks the move (a required attribute is never hidden, plan rule 5); the refusal
 * names each family and channel.
 *
 * Every change writes an `AuditLog` row with `before` and `after` in the SAME transaction (not the fail-open audit
 * helper: the undo reads it). `undoPlacementChange` restores `before` only while the attribute still equals `after`.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'

export const PLACEMENT_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY', 'WOOCOMMERCE'] as const
export type Placement = 'shared' | 'channel'

export class PlacementError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string, readonly details?: unknown) { super(message) }
}

export interface Actor { userId?: string | null; ip?: string | null }
/** P3b S5 — extra audit metadata, e.g. the proposal batch a change belongs to (its undo finds the rows by it). */
export interface AuditExtra { metadata?: Record<string, unknown> }

/** What a placement change reads and writes; also the shape of an audit row's `before` / `after`. */
export interface PlacementState {
  placement: Placement
  placementChannels: string[]
  requirements: Array<{ familyAttributeId: string; familyId: string; familyLabel: string; channels: string[] }>
}

const sameState = (a: PlacementState, b: PlacementState) => JSON.stringify(normal(a)) === JSON.stringify(normal(b))
const normal = (s: PlacementState) => ({ placement: s.placement, placementChannels: [...s.placementChannels].sort(),
  requirements: [...s.requirements].map(r => ({ id: r.familyAttributeId, channels: [...r.channels].sort() })).sort((x, y) => x.id.localeCompare(y.id)) })

async function stateOf(id: string): Promise<{ state: PlacementState; code: string; archivedAt: Date | null }> {
  const attribute = await prisma.customAttribute.findUnique({ where: { id }, select: { code: true, placement: true, placementChannels: true, archivedAt: true,
    familyAttributes: { where: { required: true }, select: { id: true, channels: true, family: { select: { id: true, label: true } } } } } })
  if (!attribute) throw new PlacementError(404, 'attribute not found')
  return { code: attribute.code, archivedAt: attribute.archivedAt, state: {
    placement: attribute.placement === 'channel' ? 'channel' : 'shared', placementChannels: attribute.placementChannels,
    requirements: attribute.familyAttributes.map(fa => ({ familyAttributeId: fa.id, familyId: fa.family.id, familyLabel: fa.family.label, channels: fa.channels })),
  } }
}

/** Pure: the placement asked for, checked and normalised. */
export function parsePlacement(input: { placement?: unknown; channels?: unknown }): { placement: Placement; placementChannels: string[] } {
  if (input.placement !== 'shared' && input.placement !== 'channel') throw new PlacementError(400, "placement must be 'shared' or 'channel'")
  const channels = input.channels === undefined ? [] : input.channels
  if (!Array.isArray(channels) || channels.some(c => typeof c !== 'string')) throw new PlacementError(400, 'channels must be a list of channel codes')
  const codes = [...new Set((channels as string[]).map(c => c.toUpperCase()))].sort()
  const unknown = codes.filter(c => !(PLACEMENT_CHANNELS as readonly string[]).includes(c))
  if (unknown.length) throw new PlacementError(400, `unknown channel: ${unknown.join(', ')} (use ${PLACEMENT_CHANNELS.join(', ')})`)
  if (input.placement === 'shared' && codes.length) throw new PlacementError(400, 'a Shared attribute takes no channels')
  if (input.placement === 'channel' && !codes.length) throw new PlacementError(400, 'name at least one channel for a channel attribute')
  return { placement: input.placement, placementChannels: codes }
}

/**
 * Pure: the family requirements after a move. Moving to channels restricts a requirement that holds everywhere to those
 * channels; a requirement on a channel outside them is a conflict. Moving to Shared changes no requirement.
 */
export function requirementsAfter(before: PlacementState['requirements'], next: { placement: Placement; placementChannels: string[] }) {
  if (next.placement === 'shared') return { requirements: before, conflicts: [] as Array<{ familyLabel: string; channels: string[] }> }
  const conflicts: Array<{ familyLabel: string; channels: string[] }> = []
  const requirements = before.map(r => {
    if (!r.channels.length) return { ...r, channels: [...next.placementChannels] }
    const outside = r.channels.filter(c => !next.placementChannels.includes(c))
    if (outside.length) conflicts.push({ familyLabel: r.familyLabel, channels: outside })
    return r
  })
  return { requirements, conflicts }
}

async function writeState(id: string, from: PlacementState, to: PlacementState, action: string, actor: Actor, metadata?: Prisma.InputJsonValue) {
  await prisma.customAttribute.update({ where: { id }, data: { placement: to.placement, placementChannels: to.placementChannels } })
  for (const r of to.requirements) {
    const old = from.requirements.find(x => x.familyAttributeId === r.familyAttributeId)
    if (old && JSON.stringify(old.channels) !== JSON.stringify(r.channels)) await prisma.familyAttribute.update({ where: { id: r.familyAttributeId }, data: { channels: r.channels } })
  }
  return prisma.auditLog.create({ data: { entityType: 'CustomAttribute', entityId: id, action, before: from as never, after: to as never,
    userId: actor.userId ?? null, ip: actor.ip ?? null, ...(metadata ? { metadata } : {}) } })
}

/**
 * Axis guard (asked by the variation-theme lane, 2026-09-26) — an attribute a family VARIES BY is never hidden.
 * Today a family's axes are the labels on its root product (`Product.variationAxes`, e.g. "Colore", "Taglia"); a label
 * names this attribute when its canonical axis (`canonicalVariantAxis`, the shared synonym table) equals the canonical
 * form of the attribute's code, concept or label. (When the variation-theme lane stores the attribute CODE in a family's
 * axis list, that list joins this check.)
 */
export function axesNaming(attribute: { code: string; label: string; semanticKey: string | null }, axisLabels: readonly string[]): string[] {
  const names = new Set([attribute.code, attribute.semanticKey, attribute.label].filter((v): v is string => !!v).map(canonicalVariantAxis))
  return [...new Set(axisLabels.filter(axis => names.has(canonicalVariantAxis(axis))))].sort()
}

/** Every variation-axis label on the business's live family roots — and, since VTR step 1, every axis attribute CODE
 * (`variationAxisCodes`), so an axis stored as a code is guarded exactly like one stored as a label. */
export async function familyAxisLabels(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ axis: string }>>`
    SELECT DISTINCT axis FROM (
      SELECT unnest("variationAxes") AS axis FROM "Product" WHERE "parentId" IS NULL AND "deletedAt" IS NULL
      UNION SELECT unnest("variationAxisCodes") FROM "Product" WHERE "parentId" IS NULL AND "deletedAt" IS NULL) AS axes`
  return rows.map(r => r.axis).filter(Boolean)
}

async function refuseIfAxis(id: string, what: string) {
  const attribute = await prisma.customAttribute.findUnique({ where: { id }, select: { code: true, label: true, semanticKey: true } })
  if (!attribute) return
  const axes = axesNaming(attribute, await familyAxisLabels())
  if (axes.length) {
    throw new PlacementError(409, `${attribute.code} is a variation axis (${axes.join(', ')}); a variation axis is never hidden, so it cannot be ${what}.`, { axes })
  }
}

export async function setAttributePlacement(id: string, input: { placement?: unknown; channels?: unknown }, actor: Actor = {}, extra: AuditExtra = {}) {
  const next = parsePlacement(input)
  return inDatabaseTransaction(prisma, async () => {
    const { state: before, archivedAt, code } = await stateOf(id)
    if (archivedAt) throw new PlacementError(409, `${code} is archived; restore it before moving it`)
    if (next.placement === 'channel') await refuseIfAxis(id, 'moved to a channel')
    const { requirements, conflicts } = requirementsAfter(before.requirements, next)
    if (conflicts.length) {
      throw new PlacementError(409, `${code} is required on ${conflicts.map(c => `${c.channels.join(', ')} in the family ${c.familyLabel}`).join('; ')}. `
        + 'Include those channels, or change the family requirement first — a required attribute is never hidden.', { conflicts })
    }
    const after: PlacementState = { ...next, requirements }
    if (sameState(before, after)) return { changed: false as const, before, after, auditId: null }
    const audit = await writeState(id, before, after, 'attribute.placement', actor, extra.metadata as Prisma.InputJsonValue | undefined)
    return { changed: true as const, before, after, auditId: audit.id }
  })
}

/** Restore the state before a placement change, only while the attribute still matches the change's `after`. */
export async function undoPlacementChange(auditId: string, actor: Actor = {}) {
  return inDatabaseTransaction(prisma, async () => {
    const audit = await prisma.auditLog.findUnique({ where: { id: auditId } })
    if (!audit || audit.entityType !== 'CustomAttribute' || audit.action !== 'attribute.placement') throw new PlacementError(404, 'placement change not found')
    const { state: current } = await stateOf(audit.entityId)
    if (!sameState(current, audit.after as unknown as PlacementState)) {
      throw new PlacementError(409, 'The attribute changed after this placement change; undo the later change first.')
    }
    const restored = audit.before as unknown as PlacementState
    const undo = await writeState(audit.entityId, current, restored, 'attribute.placement', actor, { undoOf: auditId })
    return { attributeId: audit.entityId, restored, auditId: undo.id }
  })
}

/** How many stored values and family links an attribute has (the "archive instead" test). */
export async function attributeUsage(code: string, id: string) {
  const [[products], [translations], families] = await Promise.all([
    prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "Product"
      WHERE "deletedAt" IS NULL AND jsonb_typeof("categoryAttributes") = 'object' AND "categoryAttributes" ? ${code}
        AND "categoryAttributes"->${code} NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb)`,
    prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "ProductTranslation"
      WHERE jsonb_typeof(attributes) = 'object' AND attributes ? ${code} AND attributes->${code} NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb)`,
    prisma.familyAttribute.count({ where: { attributeId: id } }),
  ])
  return { products: Number(products?.n ?? 0), translations: Number(translations?.n ?? 0), families }
}

export async function archiveAttribute(id: string, actor: Actor = {}, extra: AuditExtra = {}) {
  return inDatabaseTransaction(prisma, async () => {
    const { state, archivedAt, code } = await stateOf(id)
    if (archivedAt) return { changed: false as const, archivedAt }
    await refuseIfAxis(id, 'archived')
    if (state.requirements.length) {
      throw new PlacementError(409, `${code} is required in ${state.requirements.map(r => r.familyLabel).join(', ')}; make it optional there first — a required attribute is never hidden.`)
    }
    const now = new Date()
    await prisma.customAttribute.update({ where: { id }, data: { archivedAt: now } })
    await prisma.auditLog.create({ data: { entityType: 'CustomAttribute', entityId: id, action: 'attribute.archive', before: { archivedAt: null }, after: { archivedAt: now.toISOString() }, userId: actor.userId ?? null, ip: actor.ip ?? null, ...(extra.metadata ? { metadata: extra.metadata as Prisma.InputJsonValue } : {}) } })
    return { changed: true as const, archivedAt: now }
  })
}

export async function restoreAttribute(id: string, actor: Actor = {}, extra: AuditExtra = {}) {
  return inDatabaseTransaction(prisma, async () => {
    const { archivedAt } = await stateOf(id)
    if (!archivedAt) return { changed: false as const }
    await prisma.customAttribute.update({ where: { id }, data: { archivedAt: null } })
    await prisma.auditLog.create({ data: { entityType: 'CustomAttribute', entityId: id, action: 'attribute.restore', before: { archivedAt: archivedAt.toISOString() }, after: { archivedAt: null }, userId: actor.userId ?? null, ip: actor.ip ?? null, ...(extra.metadata ? { metadata: extra.metadata as Prisma.InputJsonValue } : {}) } })
    return { changed: true as const }
  })
}

/** Delete only an attribute nothing uses; otherwise refuse and point to archive (nothing is lost, it can be restored). */
export async function deleteAttribute(id: string, actor: Actor = {}) {
  return inDatabaseTransaction(prisma, async () => {
    const attribute = await prisma.customAttribute.findUnique({ where: { id }, select: { id: true, code: true, label: true } })
    if (!attribute) throw new PlacementError(404, 'attribute not found')
    const usage = await attributeUsage(attribute.code, id)
    if (usage.products || usage.translations || usage.families) {
      throw new PlacementError(409, `${attribute.code} has ${usage.products} product values, ${usage.translations} translated values and ${usage.families} family links. `
        + 'Archive it instead: nothing is lost and it can be restored.', { usage })
    }
    await prisma.customAttribute.delete({ where: { id } })
    await prisma.auditLog.create({ data: { entityType: 'CustomAttribute', entityId: id, action: 'attribute.delete', before: attribute, after: Prisma.JsonNull, userId: actor.userId ?? null, ip: actor.ip ?? null } })
    return { ok: true as const, id }
  })
}
