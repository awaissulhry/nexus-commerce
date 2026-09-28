/**
 * Sheet pop-up P3, slice A3 (docs/sheet-popup-editor/QUALITY-PLAN-2026-09-28.md §4.10) — "New attribute" from the
 * variation pop-up. An axis under the operator's own name takes its values from a Shared per-variant attribute; when none
 * fits, the operator makes one here, without leaving the sheet.
 *
 * "Values from" is the Shared sheet's per-variant, plain, `categoryAttributes` columns that are not family axes
 * (`family-projection.service.ts` `sharedOwnAxisSources`), and the Shared sheet shows only the attributes PLACED in the
 * product's family (`family-sheet-schema.ts` `familySheetFields`). So a new attribute is created AND placed in the
 * family, in ONE transaction: a failed placement leaves no loose attribute behind. A family is shared by every product
 * in it — each one gets the new, empty column (the pop-up says so before it writes).
 *
 * The same name twice (two operators, or a retried click) never makes two attributes: the code is unique per business,
 * and the loser of that race reads the winner's row and is answered by the rules for an existing attribute.
 */
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { familyHierarchyService } from '../family-hierarchy.service.js'
import { normaliseKey } from './channel-specs/types.js'
import { resolveFamilyRoot, sharedOwnAxisSources } from './family-projection.service.js'
import { getInformationSheet } from './information-sheet.js'
import { ALLOWED_MASTER_FIELDS } from './master-field-gate.js'
import { clearSheetColumnCache } from './sheet-columns.service.js'
import { clearStudioColumnCache } from './studio-columns.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'

/** Every sentence the pop-up shows for this action, in one place — the route, the tests and the web read these. */
export const OWN_AXIS_ATTRIBUTE_COPY = {
  noFamily: 'This product has no family, so a new attribute has nowhere to go. Choose a family on the Shared product first.',
  noPermission: 'Only a user who may manage attributes can create one. Ask the business owner.',
  empty: 'Name the new attribute.',
  noCode: 'Use letters or digits in the name.',
  familyAxis: (label: string) => `${label} is already a Shared axis of this family. Add it from “From Shared”.`,
  notPerVariant: (label: string) => `“${label}” already exists as an attribute for the whole product. Choose another name.`,
  archived: (label: string) => `“${label}” exists but is archived. Restore it in Settings → Attributes, or choose another name.`,
  notPlain: (label: string) => `“${label}” already exists, but it cannot hold one value per variant. Choose another name.`,
  noGroup: 'No attribute group exists yet. Add one in Settings → Attributes first.',
  exists: (label: string) => `“${label}” already exists. Use it in this family?`,
} as const

/** The attribute code rule of `routes/attributes.routes.ts` (`CODE_PATTERN`), which the dictionary enforces. */
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

export interface OwnAxisSourceRow { field: string; label: string; filled: number; of: number; values: string[] }
export interface OwnAxisAttributeResult {
  outcome: 'created' | 'placed' | 'present'
  source: OwnAxisSourceRow
  /** `id` is null only for a Shared product field that is already a source but no dictionary attribute. */
  attribute: { id: string | null; code: string; label: string }
}
export interface NewAttributeState { allowed: boolean; reason: string | null; familyLabel: string | null; familyProducts: number | null }

/** A refusal with its status and code on the error itself — the studio routes' mapper sends it as is. */
export class OwnAxisAttributeError extends Error {
  constructor(readonly statusCode: 400 | 403 | 409, readonly code: string, message: string, readonly detail?: Record<string, unknown>) {
    super(message)
    this.name = 'OwnAxisAttributeError'
  }
}
const refuse = (message: string) => new OwnAxisAttributeError(400, 'own_axis_attribute_refused', message)

/**
 * The dictionary code for a typed name: accents folded ("Vestibilità" → `vestibilita`), every other run of characters
 * one `_`, a leading digit prefixed (`3D` → `v_3d`), at most 64 characters. `''` = the name has no letter or digit.
 */
export function attributeCodeFor(name: string): string {
  let code = name.trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (/^[0-9]/.test(code)) code = `v_${code}`
  code = code.slice(0, 64).replace(/_+$/, '')
  return CODE_PATTERN.test(code) ? code : ''
}

/**
 * The group a new attribute joins: the one most of the family's per-variant attributes use (ties: the lower id, so the
 * answer never depends on read order), else the group coded `attributes`, else the first group. Null = none exists.
 */
export function chooseAttributeGroup(perVariantGroupIds: readonly string[], namedAttributesGroupId: string | null, firstGroupId: string | null): string | null {
  const counts = new Map<string, number>()
  for (const id of perVariantGroupIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  const [best] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return best?.[0] ?? namedAttributesGroupId ?? firstGroupId
}

type ExistingAttribute = { id: string; code: string; label: string; type: string; scope: string; placement: string; archivedAt: Date | null; validation: unknown }

/**
 * Can an existing attribute give an axis one value per variant? The same tests the Shared sheet and "Values from" apply
 * (`family-sheet-schema.ts` `toFieldDefinition`, `sharedOwnAxisSources`): per variant, not archived, on the Shared
 * scope, a plain value in the variant's own attributes — not a file, a reference, a list or a measure, and not one of
 * the product's own fields.
 */
function usability(attribute: ExistingAttribute): 'usable' | 'notPerVariant' | 'archived' | 'notPlain' {
  if (attribute.scope !== 'per_variant') return 'notPerVariant'
  if (attribute.archivedAt) return 'archived'
  const shape = attribute.validation && typeof attribute.validation === 'object' ? (attribute.validation as Record<string, unknown>).shape : undefined
  if (attribute.placement !== 'shared' || ['asset', 'reference', 'multiselect'].includes(attribute.type) || shape === 'list' || shape === 'measure'
    || ALLOWED_MASTER_FIELDS.has(attribute.code)) return 'notPlain'
  return 'usable'
}

/** The "New attribute" button's state in the pop-up: held with its reason, never dead. */
export async function ownAxisAttributeState(productId: string, mayManage: boolean): Promise<NewAttributeState> {
  const root = await resolveFamilyRoot(productId)
  const family = root.familyId ? await prisma.productFamily.findUnique({ where: { id: root.familyId }, select: { label: true } }) : null
  if (!root.familyId || !family) return { allowed: false, reason: OWN_AXIS_ATTRIBUTE_COPY.noFamily, familyLabel: null, familyProducts: null }
  const familyProducts = await prisma.product.count({ where: { familyId: root.familyId, parentId: null, deletedAt: null } })
  return { allowed: mayManage, reason: mayManage ? null : OWN_AXIS_ATTRIBUTE_COPY.noPermission, familyLabel: family.label, familyProducts }
}

/** Unique-key violation, as Prisma reports it with and without the driver adapter. */
function uniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string; code?: string } } }; message?: string } | null
  if (!e) return false
  if (e.code === 'P2002') return true
  const cause = e.meta?.driverAdapterError?.cause
  return [e.meta?.code, cause?.originalCode, cause?.code].includes('23505') || /\b23505\b/.test(e.message ?? '')
}

/** The attribute last in the family's own order, as `POST /families/:id/attributes` would place it. */
async function place(familyId: string, attributeId: string): Promise<void> {
  const last = await prisma.familyAttribute.aggregate({ where: { familyId }, _max: { sortOrder: true } })
  await prisma.familyAttribute.create({ data: { familyId, attributeId, required: false, channels: [], sortOrder: (last._max.sortOrder ?? 0) + 1 } })
}

async function groupFor(familyId: string): Promise<string | null> {
  const chain = await familyHierarchyService.walkFamilyChain(familyId)
  const ids = [...new Set(chain.flatMap(node => node.familyAttributes.map(fa => fa.attributeId)))]
  const perVariant = ids.length ? await prisma.customAttribute.findMany({ where: { id: { in: ids }, scope: 'per_variant' }, select: { groupId: true } }) : []
  const [named, first] = await Promise.all([
    prisma.attributeGroup.findFirst({ where: { code: 'attributes' }, select: { id: true } }),
    prisma.attributeGroup.findFirst({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { id: true } }),
  ])
  return chooseAttributeGroup(perVariant.map(a => a.groupId), named?.id ?? null, first?.id ?? null)
}

/**
 * Make (or reuse) the Shared per-variant attribute an own-name axis takes its values from, and place it in the product's
 * family. Answers the new "Values from" entry, read after the commit and the column caches are cleared — so what the
 * pop-up offers next is what the save's own check (`assertOwnAxisSources`) will accept.
 */
export async function createOwnAxisAttribute(input: { productId: string; market: string; name: string; useExisting?: boolean }): Promise<OwnAxisAttributeResult> {
  const label = input.name.trim()
  if (!label) throw refuse(OWN_AXIS_ATTRIBUTE_COPY.empty)
  const code = attributeCodeFor(label)
  if (!code) throw refuse(OWN_AXIS_ATTRIBUTE_COPY.noCode)
  const market = input.market.trim().toUpperCase()
  const root = await resolveFamilyRoot(input.productId)
  if (!root.familyId) throw refuse(OWN_AXIS_ATTRIBUTE_COPY.noFamily)
  const familyId = root.familyId
  const axes = new Set((root.variationAxes ?? []).map(canonicalVariantAxis))
  if (axes.has(canonicalVariantAxis(code)) || axes.has(canonicalVariantAxis(label))) throw refuse(OWN_AXIS_ATTRIBUTE_COPY.familyAxis(label))

  /* A Shared column that is not a dictionary attribute may already carry the name (a product field such as Brand). Read
     before the transaction: those columns come from the field registry and the schemas, not from this race. */
  const sheet = await getInformationSheet({ productId: root.id, scope: 'master', market, includeMapping: false })
  const clash = (sheet?.columns ?? []).find(c => normaliseKey(c.key) === normaliseKey(code)) ?? null

  const decide = () => inDatabaseTransaction(prisma, async (): Promise<{ outcome: OwnAxisAttributeResult['outcome']; attribute: OwnAxisAttributeResult['attribute'] }> => {
    const existing = await prisma.customAttribute.findFirst({
      where: { code },
      select: { id: true, code: true, label: true, type: true, scope: true, placement: true, archivedAt: true, validation: true },
    }) as ExistingAttribute | null
    if (existing) {
      const kind = usability(existing)
      if (kind === 'notPerVariant') throw refuse(OWN_AXIS_ATTRIBUTE_COPY.notPerVariant(existing.label))
      if (kind === 'archived') throw refuse(OWN_AXIS_ATTRIBUTE_COPY.archived(existing.label))
      if (kind === 'notPlain') throw refuse(OWN_AXIS_ATTRIBUTE_COPY.notPlain(existing.label))
      const attribute = { id: existing.id, code: existing.code, label: existing.label }
      const chain = await familyHierarchyService.walkFamilyChain(familyId)
      if (chain.some(node => node.familyAttributes.some(fa => fa.attributeId === existing.id))) return { outcome: 'present', attribute }
      if (!input.useExisting) {
        throw new OwnAxisAttributeError(409, 'own_axis_attribute_exists', OWN_AXIS_ATTRIBUTE_COPY.exists(existing.label), { offer: { code: existing.code, label: existing.label } })
      }
      await place(familyId, existing.id)
      return { outcome: 'placed', attribute }
    }
    if (clash) {
      const source = clash.scope === 'per_variant' && clash.editable !== false && clash.storage === 'categoryAttributes' && (!clash.shape || clash.shape === 'scalar')
      if (source) return { outcome: 'present', attribute: { id: null, code: clash.key, label: clash.label } }
      throw refuse(clash.scope === 'per_variant' ? OWN_AXIS_ATTRIBUTE_COPY.notPlain(clash.label) : OWN_AXIS_ATTRIBUTE_COPY.notPerVariant(clash.label))
    }
    const groupId = await groupFor(familyId)
    if (!groupId) throw refuse(OWN_AXIS_ATTRIBUTE_COPY.noGroup)
    const created = await prisma.customAttribute.create({
      data: { code, label, groupId, type: 'text', scope: 'per_variant', placement: 'shared' },
      select: { id: true, code: true, label: true },
    })
    await place(familyId, created.id)
    return { outcome: 'created', attribute: created }
  })

  /* The same code created twice at once: under Serializable (the default here) PostgreSQL reports the loser as a
     serialization failure, which `inDatabaseTransaction` retries — the retry reads the winner's row and answers by the
     existing-attribute rules (measured in own-axis-attribute-postgres.vitest.test.ts). A unique violation reaches this
     catch only at a lower isolation; it is answered the same way, from the committed row. */
  let decision: Awaited<ReturnType<typeof decide>>
  try {
    decision = await decide()
  } catch (error) {
    if (!uniqueViolation(error)) throw error
    decision = await decide()
  }
  // The column caches already key on the dictionary's version (`dictionary-version.ts`); clearing them is the same belt
  // and braces the `/api/attributes` and `/api/families` writers wear (`attribute-schema-invalidation.ts`).
  if (decision.outcome !== 'present') { clearSheetColumnCache(); clearStudioColumnCache() }

  const source = (await sharedOwnAxisSources(input.productId, market)).find(s => s.field === decision.attribute.code)
  if (!source) {
    throw new Error(`The attribute ${decision.attribute.code} is ${decision.outcome} in the family but is not a "Values from" source — the Shared sheet dropped its column.`)
  }
  return { outcome: decision.outcome, source, attribute: decision.attribute }
}
