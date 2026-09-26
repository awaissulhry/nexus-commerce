/**
 * VTR step 1a — the backfill REPORT (read only). Loads every family root, its variants and the business dictionary, and runs
 * `planFamilyVariations` on each. It writes nothing: the Owner reads the report before step 1b writes anything.
 */
import prisma from '../../db.js'
import { planFamilyVariations, type DictionaryAttribute, type FamilyVariationIssue, type FamilyVariationsPlan } from './family-variations-core.js'

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
