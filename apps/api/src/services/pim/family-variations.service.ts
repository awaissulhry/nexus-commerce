/**
 * VTR step 1 — THE writer of a family's variation values (docs/variation-theme/STEP1-PLAN.md §2, Owner D3 a).
 *
 * One transaction does the four things every writer in STEP1-WRITERS.md did differently, or not at all:
 *  1. normalise — a value is matched to its dictionary option and saved as the dictionary spells the matched name
 *     (`matchValue`), under the attribute CODE; an unknown value is refused unless the caller asks to add the option;
 *  2. refuse two COMPLETE variants with the same values (an incomplete one is a missing value, not a duplicate);
 *  3. compare-and-set on the family root's version, and bump every changed variant's version;
 *  4. event + readiness + read cache.
 * Old spellings of the axis leave the store, the legacy bag drops it, and a flat copy of the axis is kept in step.
 * Nothing else writes variation values once step 1's writers are re-routed here.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { afterDatabaseCommit, inDatabaseTransaction } from '../../lib/database-context.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { productEventService } from '../product-event.service.js'
import { writeVariationValues } from './category-attributes-write.js'
import { produceReadinessForProducts } from './readiness-index.service.js'
import { variationBag } from './shared-variation-values.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import { variationAxisValue } from './variation-collisions.js'
import { attributeForAxis, codeForNewOption, matchValue, valueIdentity, type DictionaryAttribute } from './family-variations-core.js'

export class FamilyVariationError extends Error {
  constructor(message: string, readonly status = 409, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'FamilyVariationError'
  }
}

export interface VariationValueChange {
  productId: string
  /** The dictionary attribute code of the axis (`color`). */
  axis: string
  /** null or '' clears the value. */
  value: string | null
  /** Save an unknown value as a new option of the axis's attribute. */
  addOption?: boolean
}

type Bag = Record<string, unknown>
const bag = (value: unknown): Bag => value && typeof value === 'object' && !Array.isArray(value) ? value as Bag : {}

/** The business's attribute dictionary, as the writers read it (the eBay import plans a new family's axes against it too). */
export async function variationDictionary(): Promise<DictionaryAttribute[]> {
  return prisma.customAttribute.findMany({ where: { archivedAt: null }, orderBy: { code: 'asc' }, select: {
    id: true, code: true, label: true, semanticKey: true, archivedAt: true,
    options: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { id: true, code: true, label: true, metadata: true, synonyms: true, sortOrder: true, archivedAt: true } },
  } })
}

export async function setFamilyVariationValues(familyId: string, input: { expectedVersion: number; changes: VariationValueChange[] }) {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new FamilyVariationError('An observed family version is required.', 400)
  if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 2000) throw new FamilyVariationError('Send between 1 and 2000 changes.', 400)
  const seen = new Set<string>()
  for (const change of input.changes) {
    if (!change || typeof change.productId !== 'string' || typeof change.axis !== 'string' || (change.value !== null && typeof change.value !== 'string'))
      throw new FamilyVariationError('Every change needs a product, an axis and a text value (or null).', 400)
    const key = `${change.productId}|${change.axis}`
    if (seen.has(key)) throw new FamilyVariationError(`${change.productId} changes ${change.axis} twice. Send one change per variant and axis.`, 400)
    seen.add(key)
  }

  return inDatabaseTransaction(prisma, async () => {
    const root = await prisma.product.findFirst({ where: { id: familyId, deletedAt: null }, select: { id: true, sku: true, parentId: true, version: true,
      variationAxes: true, variationAxisCodes: true,
      children: { where: { deletedAt: null }, orderBy: { sku: 'asc' }, select: { id: true, sku: true, categoryAttributes: true, variantAttributes: true } } } })
    if (!root) throw new FamilyVariationError('This family no longer exists.', 404)
    if (root.parentId) throw new FamilyVariationError('Change variation values on the family parent.', 400)
    if (root.version !== input.expectedVersion) throw new FamilyVariationError('This family changed. Reload and review the change again.', 409, { current: root.version })

    // The family's axes → dictionary attributes: the stored codes, else today's labels through the concept.
    const attributes = await variationDictionary()
    const axes = (root.variationAxisCodes.length ? root.variationAxisCodes : root.variationAxes).map(name => {
      const found = root.variationAxisCodes.length ? { attribute: attributes.find(a => a.code === name) ?? null } : attributeForAxis(name, attributes)
      if (!found.attribute) throw new FamilyVariationError(`The ${name} axis of ${root.sku} is not linked to a dictionary attribute. Link it before editing values.`, 409)
      return { name, attribute: found.attribute }
    })
    const members = new Map(root.children.map(child => [child.id, child]))

    // 1. Normalise every change against the dictionary (and add options only when asked).
    const createdOptions: Array<{ axis: string; code: string; label: string }> = []
    const planned = new Map<string, Map<string, string>>()   // productId → attribute code → saved text ('' = cleared)
    for (const change of input.changes) {
      if (!members.has(change.productId)) throw new FamilyVariationError(`"${change.productId}" is not a variant of ${root.sku}.`, 400)
      const axis = axes.find(a => a.attribute.code === change.axis)
      if (!axis) throw new FamilyVariationError(`${root.sku} has no ${change.axis} axis.`, 400)
      const text = (change.value ?? '').trim()
      let saved = ''
      if (text) {
        const match = matchValue(text, axis.attribute)
        if (match) saved = match.spelled
        else if (!change.addOption) throw new FamilyVariationError(`"${text}" is not a ${axis.attribute.label} value yet. Choose "Save as a new option" to add it.`, 422, { axis: axis.attribute.code, value: text })
        else {
          const code = codeForNewOption(text, axis.attribute)
          const sortOrder = Math.max(0, ...axis.attribute.options.map(o => o.sortOrder)) + 1
          const option = await prisma.attributeOption.create({ data: { attributeId: axis.attribute.id, code, label: text, sortOrder },
            select: { id: true, code: true, label: true, metadata: true, synonyms: true, sortOrder: true, archivedAt: true } })
          axis.attribute.options.push(option)
          createdOptions.push({ axis: axis.attribute.code, code, label: text })
          saved = text
        }
      }
      const perVariant = planned.get(change.productId) ?? new Map<string, string>()
      perVariant.set(axis.attribute.code, saved)
      planned.set(change.productId, perVariant)
    }

    // 2. Two COMPLETE variants with the same values are refused.
    const valueOf = (child: (typeof root.children)[number], axis: (typeof axes)[number]) =>
      planned.get(child.id)?.get(axis.attribute.code) ?? String(variationAxisValue(variationBag(child) as Record<string, string>, axis.name) || variationAxisValue(variationBag(child) as Record<string, string>, axis.attribute.code) || '').trim()
    const combos = new Map<string, string[]>()
    for (const child of root.children) {
      const values = axes.map(axis => valueOf(child, axis))
      if (values.some(v => !v)) continue
      const key = JSON.stringify(axes.map((axis, i) => valueIdentity(values[i], axis.attribute)))
      combos.set(key, [...(combos.get(key) ?? []), child.sku])
    }
    for (const skus of combos.values()) {
      const changedHere = skus.some(sku => planned.has(root.children.find(c => c.sku === sku)!.id))
      if (skus.length > 1 && changedHere) throw new FamilyVariationError(`${skus.join(' and ')} would have the same values. Give each variant its own combination.`, 409, { skus })
    }

    // 3. Compare-and-set on the family root first, so a concurrent writer loses before anything is written.
    const won = await prisma.product.updateMany({ where: { id: root.id, version: input.expectedVersion }, data: { version: { increment: 1 } } })
    if (won.count !== 1) throw new FamilyVariationError('This family changed. Reload and review the change again.', 409)

    for (const [productId, values] of planned) {
      const child = members.get(productId)!
      const stored = bag(bag(child.categoryAttributes).variations), flat = bag(child.categoryAttributes), legacy = bag(child.variantAttributes)
      const set: Bag = {}, unset: string[] = [], legacyDrop: string[] = []
      const flatSet: Bag = {}, flatDrop: string[] = []
      for (const [code, saved] of values) {
        const axisName = axes.find(a => a.attribute.code === code)!.name
        const same = (key: string) => canonicalVariantAxis(key) === canonicalVariantAxis(code) || canonicalVariantAxis(key) === canonicalVariantAxis(axisName)
        for (const key of Object.keys(stored)) if (same(key) && !(saved && key === code)) unset.push(key)
        if (saved) set[code] = saved
        else if (!unset.includes(code)) unset.push(code)
        for (const key of Object.keys(legacy)) if (same(key)) legacyDrop.push(key)
        for (const key of Object.keys(flat)) if (key !== 'variations' && same(key)) { if (saved) flatSet[key] = saved; else flatDrop.push(key) }
      }
      await writeVariationValues(prisma, productId, { set, unset, legacyDrop })
      if (Object.keys(flatSet).length || flatDrop.length) {
        await prisma.$executeRaw`UPDATE "Product" SET "categoryAttributes" = (COALESCE("categoryAttributes", '{}'::jsonb) - ${flatDrop}::text[]) || ${JSON.stringify(flatSet)}::jsonb WHERE id = ${productId}`
      }
      await prisma.product.update({ where: { id: productId }, data: { version: { increment: 1 } } })
      await productEventService.emitTx(prisma as unknown as Prisma.TransactionClient, { aggregateId: productId, aggregateType: 'Product', eventType: 'PRODUCT_UPDATED',
        data: { variations: Object.fromEntries([...values].map(([code, saved]) => [code, saved || null])) }, metadata: { source: 'OPERATOR', writer: 'family-variations' } })
    }

    // 4. Readiness and the read cache follow the values.
    const changed = [...planned.keys()]
    await produceReadinessForProducts([root.id, ...changed])
    await afterDatabaseCommit(`product-cache:${[root.id, ...changed].sort().join(',')}`, () => productReadCacheService.refreshMany([root.id, ...changed]))
    return { version: input.expectedVersion + 1, changed, createdOptions }
  }, { isolationLevel: 'Serializable' })
}

/**
 * VTR step 1 — THE writer of a family's axes: an ordered list of dictionary attribute CODES (`variationAxisCodes`). The label mirror
 * `variationAxes` keeps each axis's existing spelling ("Colore") so today's readers see no change; a new axis takes the attribute label.
 * Compare-and-set on the family root; open coordinate editors are invalidated (their listing versions bump), as the studio axes save does.
 */
export async function setFamilyAxes(familyId: string, input: { expectedVersion: number; codes: string[]; labels?: string[] }) {
  if (input.labels !== undefined && (!Array.isArray(input.labels) || input.labels.length !== input.codes?.length || input.labels.some(l => typeof l !== 'string' || !l.trim())))
    throw new FamilyVariationError('Send one label per axis code, or none.', 400)
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new FamilyVariationError('An observed family version is required.', 400)
  if (!Array.isArray(input.codes) || input.codes.length > 10 || input.codes.some(code => typeof code !== 'string' || !code.trim()))
    throw new FamilyVariationError('Send up to 10 attribute codes.', 400)
  const repeated = input.codes.find((code, i) => input.codes.indexOf(code) !== i)
  if (repeated) throw new FamilyVariationError(`${repeated} twice. A family varies by each attribute once.`, 400)

  return inDatabaseTransaction(prisma, async () => {
    const root = await prisma.product.findFirst({ where: { id: familyId, deletedAt: null }, select: { id: true, sku: true, parentId: true, version: true,
      variationAxes: true, variationAxisCodes: true, children: { where: { deletedAt: null }, select: { id: true } } } })
    if (!root) throw new FamilyVariationError('This family no longer exists.', 404)
    if (root.parentId) throw new FamilyVariationError('Set axes on the family parent.', 400)
    if (root.version !== input.expectedVersion) throw new FamilyVariationError('This family changed. Reload and review the change again.', 409, { current: root.version })
    const attributes = await variationDictionary()
    const names = (label: string, code: string) => { const found = attributeForAxis(label, attributes); return !('reason' in found) && found.attribute.code === code }
    const mirror = input.codes.map((code, i) => {
      const attribute = attributes.find(a => a.code === code)
      if (!attribute) throw new FamilyVariationError(`${code} is not an attribute of the dictionary.`, 400)
      // A given spelling (the backfill keeps a theme text's "Colore") must name the same attribute.
      const given = input.labels?.[i]
      if (given !== undefined && !names(given, code)) throw new FamilyVariationError(`"${given}" does not name the ${code} attribute.`, 400)
      return given ?? root.variationAxes.find(label => names(label, code)) ?? attribute.label
    })
    if (JSON.stringify(input.codes) === JSON.stringify(root.variationAxisCodes) && JSON.stringify(mirror) === JSON.stringify(root.variationAxes)) return { version: root.version }
    const won = await prisma.product.updateMany({ where: { id: root.id, version: input.expectedVersion },
      data: { variationAxisCodes: input.codes, variationAxes: mirror, version: { increment: 1 } } })
    if (won.count !== 1) throw new FamilyVariationError('This family changed. Reload and review the change again.', 409)
    await prisma.channelListing.updateMany({ where: { productId: root.id }, data: { version: { increment: 1 } } })
    await productEventService.emitTx(prisma as unknown as Prisma.TransactionClient, { aggregateId: root.id, aggregateType: 'Product', eventType: 'PRODUCT_UPDATED',
      data: { variationAxisCodes: input.codes, variationAxes: mirror, previousVariationAxisCodes: root.variationAxisCodes, previousVariationAxes: root.variationAxes },
      metadata: { source: 'OPERATOR', writer: 'family-variations' } })
    const ids = [root.id, ...root.children.map(c => c.id)]
    await produceReadinessForProducts(ids)
    await afterDatabaseCommit(`product-cache:${[...ids].sort().join(',')}`, () => productReadCacheService.refreshMany(ids))
    return { version: input.expectedVersion + 1 }
  }, { isolationLevel: 'Serializable' })
}

/**
 * Sheet pop-up rebuild P2 (docs/sheet-popup-editor/PLAN-2026-09-27.md §4.2) — THE writer of a family's VALUE ORDER: per axis
 * attribute code, the dictionary option codes in the order the operator dragged them (`Product.variationValueOrder`, the per-family
 * home VTR step 1 named; `media-plan.service.ts loadFamily` already reads it in this shape). Only the axes sent change; the others
 * keep their order. A code the family does not vary by, or an option its attribute does not have, is refused — an order may not
 * invent values. Compare-and-set on the family root, and the family's listings bump (a channel's own order is still its own), with
 * the event, readiness and read cache of `setFamilyAxes`.
 */
export async function setFamilyValueOrder(familyId: string, input: { expectedVersion: number; order: Record<string, string[]> }) {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new FamilyVariationError('An observed family version is required.', 400)
  const entries = input.order && typeof input.order === 'object' && !Array.isArray(input.order) ? Object.entries(input.order) : null
  if (!entries || !entries.length || entries.length > 10) throw new FamilyVariationError('Send the order of 1 to 10 axes.', 400)
  for (const [code, options] of entries) {
    if (!Array.isArray(options) || options.length > 500 || options.some(o => typeof o !== 'string' || !o.trim()))
      throw new FamilyVariationError(`Send ${code}'s values as up to 500 option codes.`, 400)
    const repeated = options.find((o, i) => options.indexOf(o) !== i)
    if (repeated) throw new FamilyVariationError(`${repeated} twice in ${code}. Each value has one place.`, 400)
  }

  return inDatabaseTransaction(prisma, async () => {
    const root = await prisma.product.findFirst({ where: { id: familyId, deletedAt: null }, select: { id: true, parentId: true, version: true,
      variationAxisCodes: true, variationValueOrder: true, children: { where: { deletedAt: null }, select: { id: true } } } })
    if (!root) throw new FamilyVariationError('This family no longer exists.', 404)
    if (root.parentId) throw new FamilyVariationError('Set the value order on the family parent.', 400)
    if (root.version !== input.expectedVersion) throw new FamilyVariationError('This family changed. Reload and review the change again.', 409, { current: root.version })
    const attributes = await variationDictionary()
    for (const [code, options] of entries) {
      if (!root.variationAxisCodes.includes(code)) throw new FamilyVariationError(`This family does not vary by ${code}.`, 400)
      const attribute = attributes.find(a => a.code === code)
      if (!attribute) throw new FamilyVariationError(`${code} is not an attribute of the dictionary.`, 400)
      const unknown = options.find(o => !attribute.options.some(opt => opt.code === o && !opt.archivedAt))
      if (unknown) throw new FamilyVariationError(`${unknown} is not a value of ${attribute.label}. Add it to the dictionary first.`, 400)
    }
    const previous = bag(root.variationValueOrder)
    const next: Record<string, unknown> = { ...previous, ...Object.fromEntries(entries) }
    if (JSON.stringify(next) === JSON.stringify(previous)) return { version: root.version }
    const won = await prisma.product.updateMany({ where: { id: root.id, version: input.expectedVersion },
      data: { variationValueOrder: next as Prisma.InputJsonValue, version: { increment: 1 } } })
    if (won.count !== 1) throw new FamilyVariationError('This family changed. Reload and review the change again.', 409)
    await prisma.channelListing.updateMany({ where: { productId: root.id }, data: { version: { increment: 1 } } })
    await productEventService.emitTx(prisma as unknown as Prisma.TransactionClient, { aggregateId: root.id, aggregateType: 'Product', eventType: 'PRODUCT_UPDATED',
      data: { variationValueOrder: next, previousVariationValueOrder: previous }, metadata: { source: 'OPERATOR', writer: 'family-variations' } })
    const ids = [root.id, ...root.children.map(c => c.id)]
    await produceReadinessForProducts(ids)
    await afterDatabaseCommit(`product-cache:${[...ids].sort().join(',')}`, () => productReadCacheService.refreshMany(ids))
    return { version: input.expectedVersion + 1 }
  }, { isolationLevel: 'Serializable' })
}
