/** Idempotent catalog setup. Default is a plan; --apply adds definitions only, never product values. */
import prisma from '../src/db.js'

const groups = [
  ['attributes', 'Specifications'], ['compliance', 'Compliance and traceability'],
] as const
const attributes = [
  ['material', 'Material', 'text', 'global', 'attributes'],
  ['model_number', 'Model number', 'text', 'global', 'attributes'],
  ['color', 'Color', 'text', 'per_variant', 'attributes'],
  ['size', 'Size', 'text', 'per_variant', 'attributes'],
  ['target_gender', 'Target gender', 'text', 'global', 'attributes'],
  ['age_range_description', 'Age range', 'text', 'global', 'attributes'],
  ['fabric_type', 'Fabric composition', 'textarea', 'global', 'attributes'],
  ['fit_type', 'Fit', 'text', 'global', 'attributes'],
  ['care_instructions', 'Care instructions', 'textarea', 'global', 'attributes'],
  ['water_resistance_level', 'Water resistance', 'text', 'global', 'attributes'],
  ['countryOfOrigin', 'Country of origin', 'text', 'global', 'compliance'],
  ['hsCode', 'HS code', 'text', 'global', 'compliance'],
  ['ppeCategory', 'PPE category', 'text', 'global', 'compliance'],
  ['garmentClass', 'Protective garment class', 'text', 'global', 'compliance'],
  ['impactProtectors', 'Impact protectors', 'text', 'global', 'compliance'],
  ['notifiedBodyNumber', 'Notified body number', 'text', 'global', 'compliance'],
  ['notifiedBodyName', 'Notified body name', 'text', 'global', 'compliance'],
  ['declarationOfConformityUrl', 'Declaration of conformity URL', 'text', 'global', 'compliance'],
  ['hazmatClass', 'Hazardous material class', 'text', 'global', 'compliance'],
  ['hazmatUnNumber', 'UN number', 'text', 'global', 'compliance'],
  ['glove_standard', 'Glove certification standard', 'text', 'global', 'compliance'],
  ['glove_protection_level', 'Glove protection level', 'select', 'global', 'compliance'],
  ['knuckle_impact_protection', 'Knuckle impact protection', 'boolean', 'global', 'compliance'],
] as const
const families = [
  { code: 'general_product', label: 'General product', parent: null, attributes: ['material', 'model_number', 'countryOfOrigin', 'hsCode', 'hazmatClass', 'hazmatUnNumber'] },
  { code: 'apparel', label: 'Apparel', parent: 'general_product', attributes: ['color', 'size', 'target_gender', 'age_range_description', 'fabric_type', 'fit_type', 'care_instructions', 'water_resistance_level'] },
  { code: 'protective_apparel', label: 'Protective apparel', parent: 'apparel', attributes: ['ppeCategory', 'notifiedBodyNumber', 'notifiedBodyName', 'declarationOfConformityUrl'] },
  { code: 'jackets', label: 'Jackets', parent: 'protective_apparel', attributes: ['garmentClass', 'impactProtectors'] },
  { code: 'rainwear', label: 'Rainwear', parent: 'apparel', attributes: [] },
  { code: 'coats', label: 'Coats', parent: 'apparel', attributes: [] },
  { code: 'gloves', label: 'Gloves', parent: 'protective_apparel', attributes: ['glove_standard', 'glove_protection_level', 'knuckle_impact_protection'] },
  { code: 'suits', label: 'Suits', parent: 'protective_apparel', attributes: ['garmentClass', 'impactProtectors'] },
  { code: 'trousers', label: 'Trousers', parent: 'protective_apparel', attributes: ['garmentClass', 'impactProtectors'] },
  { code: 'accessories', label: 'Accessories', parent: 'general_product', attributes: [] },
]

try {
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ action: 'plan', groups, attributes, families, productValuesChanged: 0, productAssignmentsChanged: 0 }, null, 2))
  } else {
    const { categoryTreeService } = await import('../src/services/category-tree.service.js')
    const groupIds = new Map<string, string>()
    for (const [index, [code, label]] of groups.entries()) {
      const row = await prisma.attributeGroup.upsert({ where: { code }, create: { code, label, sortOrder: index }, update: {} })
      groupIds.set(code, row.id)
    }
    const attributeIds = new Map<string, string>()
    for (const [index, [code, label, type, scope, group]] of attributes.entries()) {
      const row = await prisma.customAttribute.upsert({ where: { code }, create: { code, label, type, scope, groupId: groupIds.get(group)!, sortOrder: index }, update: {} })
      attributeIds.set(code, row.id)
    }
    // Store evidence as supplied; these are allowed levels, never inferred product claims.
    for (const code of ['1', '2']) await prisma.attributeOption.upsert({
      where: { attributeId_code: { attributeId: attributeIds.get('glove_protection_level')!, code } },
      create: { attributeId: attributeIds.get('glove_protection_level')!, code, label: `Level ${code}`, sortOrder: Number(code) }, update: {},
    })
    const familyIds = new Map<string, string>()
    const categoryIds = new Map<string, string>()
    for (const family of families) {
      const row = await prisma.productFamily.upsert({ where: { code: family.code }, create: { code: family.code, label: family.label, parentFamilyId: family.parent ? familyIds.get(family.parent) : null }, update: {} })
      familyIds.set(family.code, row.id)
      for (const [sortOrder, code] of family.attributes.entries()) {
        const attributeId = attributeIds.get(code)!
        await prisma.familyAttribute.upsert({ where: { familyId_attributeId: { familyId: row.id, attributeId } }, create: { familyId: row.id, attributeId, sortOrder, required: false, channels: [] }, update: {} })
      }
      const parentId = family.parent ? categoryIds.get(family.parent)! : null
      const existing = await prisma.category.findFirst({ where: { code: `foundation_${family.code}` } })
      const category = existing ?? await categoryTreeService.create({ parentId, code: `foundation_${family.code}`, slug: family.code.replaceAll('_', '-'), name: { en: { name: family.label } }, attributes: { suggestedFamilyId: row.id } })
      categoryIds.set(family.code, category.id)
    }
    // Move the two garment-only links created by this seed to their garment families.
    // Product values and the canonical attribute definitions remain intact.
    await prisma.familyAttribute.deleteMany({ where: {
      familyId: familyIds.get('protective_apparel')!,
      attributeId: { in: [attributeIds.get('garmentClass')!, attributeIds.get('impactProtectors')!] },
    } })
    console.log(JSON.stringify({ action: 'applied', families: Object.fromEntries(familyIds), categories: Object.fromEntries(categoryIds), productValuesChanged: 0, productAssignmentsChanged: 0 }, null, 2))
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
  // The category service imports the process-wide queue. This one-shot seed owns no jobs.
  if (process.argv.includes('--apply')) process.exit(process.exitCode ?? 0)
}
