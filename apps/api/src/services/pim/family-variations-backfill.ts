/**
 * VTR step 1a — the backfill REPORT (read only). Loads every family root, its variants and the business dictionary, and runs
 * `planFamilyVariations` on each. It writes nothing: the Owner reads the report before step 1b writes anything.
 */
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { attributeForAxis, matchValue, planFamilyVariations, type DictionaryAttribute, type FamilyVariationIssue, type FamilyVariationsPlan } from './family-variations-core.js'
import { setFamilyAxes, setFamilyVariationValues, type VariationValueChange } from './family-variations.service.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import { splitSetString } from './variation-rules.service.js'

type ReportDb = Pick<typeof prisma, 'customAttribute' | 'product'>

export interface FamilyVariationsReport {
  families: FamilyVariationsPlan[]
  totals: { families: number; variants: number; issues: Record<FamilyVariationIssue['kind'], number>; optionsToCreate: number }
}

export async function readFamilyVariationsReport(db: ReportDb = prisma): Promise<FamilyVariationsReport> {
  const attributes: DictionaryAttribute[] = await db.customAttribute.findMany({ orderBy: { code: 'asc' }, select: {
    id: true, code: true, label: true, semanticKey: true, archivedAt: true,
    options: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { id: true, code: true, label: true, metadata: true, synonyms: true, sortOrder: true, archivedAt: true } },
  } })
  const roots = await db.product.findMany({ where: { deletedAt: null, parentId: null, OR: [{ variationAxes: { isEmpty: false } }, { children: { some: { deletedAt: null } } }] },
    orderBy: { sku: 'asc' }, select: { id: true, sku: true, variationAxes: true, variationTheme: true,
      children: { where: { deletedAt: null }, orderBy: { sku: 'asc' }, select: { id: true, sku: true, categoryAttributes: true, variantAttributes: true } } } })
  const families = roots.map(root => planFamilyVariations({ familyId: root.id, sku: root.sku, variationAxes: root.variationAxes,
    variationTheme: root.variationTheme, attributes, variants: root.children.map(child => ({ ...child, included: true })) }))
  const issues = { 'theme-without-axes': 0, 'axis-without-attribute': 0, empty: 0, 'new-option': 0, 'store-conflict': 0, 'store-legacy-only': 0, duplicate: 0 }
  // One option per attribute and code, however many families ask for it.
  const toCreate = new Set<string>()
  for (const family of families) for (const issue of family.issues) {
    issues[issue.kind] += 'skus' in issue ? issue.skus.length : 1
    if (issue.kind === 'new-option') toCreate.add(`${issue.axis}:${issue.code}`)
  }
  return { families, totals: { families: families.length, variants: families.reduce((n, f) => n + f.variants.length, 0), issues, optionsToCreate: toCreate.size } }
}

// ------------------------------------------------------------------
// Step 1b — the WRITE (the Owner reads the report first; production runs on his word)
// ------------------------------------------------------------------

export interface FamilyBackfillResult {
  sku: string
  status: 'planned' | 'written' | 'unchanged' | 'skipped' | 'failed'
  axes?: string[]
  valueChanges?: number
  optionsToCreate?: string[]
  conflicts?: string[]
  reason?: string
}

const bagOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * Per family, in ONE transaction: the axes become attribute codes (the label mirror keeps today's spelling — a family with only a
 * theme text takes the theme's parts, the Owner's rule), then each value moves under its code as the dictionary spells it (a value
 * no option names becomes a business option). Only what differs is sent, so a second run changes nothing. A family that cannot be
 * mapped is skipped; a value whose stores disagree is left as it is and reported.
 */
export async function applyFamilyVariationsBackfill(options: { write: boolean; familyIds?: string[] }): Promise<{ families: FamilyBackfillResult[] }> {
  const attributes: DictionaryAttribute[] = await prisma.customAttribute.findMany({ where: { archivedAt: null }, orderBy: { code: 'asc' }, select: {
    id: true, code: true, label: true, semanticKey: true, archivedAt: true,
    options: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { id: true, code: true, label: true, metadata: true, synonyms: true, sortOrder: true, archivedAt: true } },
  } })
  const roots = await prisma.product.findMany({ where: { deletedAt: null, parentId: null, ...(options.familyIds ? { id: { in: options.familyIds } } : {}),
    OR: [{ variationAxes: { isEmpty: false } }, { children: { some: { deletedAt: null } } }] }, orderBy: { sku: 'asc' },
    select: { id: true, sku: true, version: true, variationAxes: true, variationAxisCodes: true, variationTheme: true,
      children: { where: { deletedAt: null }, orderBy: { sku: 'asc' }, select: { id: true, sku: true, categoryAttributes: true, variantAttributes: true } } } })

  const families: FamilyBackfillResult[] = []
  for (const root of roots) {
    const labels = root.variationAxes.length ? root.variationAxes : splitSetString(root.variationTheme)
    if (!labels.length) continue
    const axes: Array<{ label: string; attribute: DictionaryAttribute }> = []
    let reason: string | undefined
    for (const label of labels) {
      const found = attributeForAxis(label, attributes)
      if ('reason' in found) { reason = `The ${label} axis ${found.reason === 'ambiguous' ? 'matches more than one dictionary attribute' : 'maps to no dictionary attribute'}.`; break }
      axes.push({ label, attribute: found.attribute })
    }
    if (reason) { families.push({ sku: root.sku, status: 'skipped', reason }); continue }
    const codes = axes.map(a => a.attribute.code)
    const plan = planFamilyVariations({ familyId: root.id, sku: root.sku, variationAxes: labels, variationTheme: root.variationTheme, attributes,
      variants: root.children.map(child => ({ ...child, included: true })) })

    const changes: VariationValueChange[] = []
    const toCreate = new Set<string>(), conflicts: string[] = []
    for (const [i, child] of root.children.entries()) {
      const variations = bagOf(bagOf(child.categoryAttributes).variations), legacy = bagOf(child.variantAttributes)
      for (const axis of axes) {
        const planned = plan.variants[i].values[axis.attribute.code]
        if (!planned || planned.empty) continue
        if (planned.conflict) { conflicts.push(`${child.sku} ${axis.attribute.code}: ${planned.conflict.join(' / ')}`); continue }
        const spelled = matchValue(planned.text, axis.attribute)?.spelled ?? planned.text
        if (!matchValue(planned.text, axis.attribute)) toCreate.add(`${axis.attribute.code}:${planned.text}`)
        const same = (key: string) => canonicalVariantAxis(key) === canonicalVariantAxis(axis.attribute.code) || canonicalVariantAxis(key) === canonicalVariantAxis(axis.label)
        const settled = Object.keys(variations).filter(same).join('|') === axis.attribute.code && variations[axis.attribute.code] === spelled
          && !Object.keys(legacy).some(same)
        if (!settled) changes.push({ productId: child.id, axis: axis.attribute.code, value: planned.text, addOption: true })
      }
    }
    const axesChanged = JSON.stringify(root.variationAxisCodes) !== JSON.stringify(codes) || JSON.stringify(root.variationAxes) !== JSON.stringify(labels)
    const summary = { axes: codes, valueChanges: changes.length, optionsToCreate: [...toCreate].sort(), ...(conflicts.length ? { conflicts } : {}) }
    if (!axesChanged && !changes.length) { families.push({ sku: root.sku, status: 'unchanged', ...summary }); continue }
    if (!options.write) { families.push({ sku: root.sku, status: 'planned', ...summary }); continue }
    try {
      await inDatabaseTransaction(prisma, async () => {
        let version = root.version
        if (axesChanged) version = (await setFamilyAxes(root.id, { expectedVersion: version, codes, labels })).version
        if (changes.length) await setFamilyVariationValues(root.id, { expectedVersion: version, changes })
      }, { isolationLevel: 'Serializable' })
      families.push({ sku: root.sku, status: 'written', ...summary })
    } catch (error) {
      families.push({ sku: root.sku, status: 'failed', ...summary, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { families }
}

