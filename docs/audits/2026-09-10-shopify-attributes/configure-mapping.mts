/** Installs reviewed local Nexus mappings; never publishes Shopify product data. */
import '../../../apps/api/src/env.js'
import '../../../apps/api/src/services/cx/connectors/shopify/spec.js'
import { writeFile } from 'node:fs/promises'
import prisma from '../../../apps/api/src/db.js'
import { withWorkspace, LEGACY_WORKSPACE_ID } from '../../../apps/api/src/lib/workspace-context.js'
import { shopifyProductSpec } from '../../../apps/api/src/services/pim/channel-specs/store.js'
import { masterDefaultRule } from '../../../apps/api/src/services/pim/mapping/master-default-rule.js'
import { ALLOWED_MASTER_FIELDS } from '../../../apps/api/src/services/pim/master-field-gate.js'
import { getMappingForMarketplace } from '../../../apps/api/src/services/pim/schema-mapping.service.js'
import { mappingToken } from '../../../apps/api/src/services/pim/mapping/revision-token.js'
import { createMappingImpact, runMappingImpact, readMappingImpact, activateMappingImpact } from '../../../apps/api/src/services/pim/mapping/impact.service.js'

try {
  await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const mapping = await getMappingForMarketplace('SHOPIFY', 'GLOBAL')
    const attributes = await prisma.customAttribute.findMany({ select: { code: true, type: true, scope: true } })
    const definition = { code: 'shopify_product_type', label: 'Shopify product type', type: 'text', scope: 'global', localizable: false,
      description: 'Custom Shopify product type. Independent of Amazon product type and channel taxonomy category assignments.' }
    const existing = attributes.find(a => a.code === definition.code)
    if (existing && (existing.type !== definition.type || existing.scope !== definition.scope)) throw new Error('The existing Shopify product type source has an incompatible definition.')
    const sources = new Set([...ALLOWED_MASTER_FIELDS, ...attributes.map(a => a.code), definition.code])
    const changes = shopifyProductSpec().fields.flatMap(field => {
      const rule = masterDefaultRule(field, sources)
      return rule && !mapping.fields[field.key] ? [{ fieldKey: field.key, rule }] : []
    })
    const plan = { observedAt: new Date().toISOString(), beforeToken: mappingToken(mapping), changes,
      definitionToAdd: existing ? null : definition, retainedRules: Object.keys(mapping.fields), publishesProducts: false }
    await writeFile(new URL('./mapping-plan.json', import.meta.url), JSON.stringify(plan, null, 2) + '\n')
    console.log(JSON.stringify(plan))
    if (!process.argv.includes('--apply')) return
    if (mappingToken(await getMappingForMarketplace('SHOPIFY', 'GLOBAL')) !== plan.beforeToken) throw new Error('Mapping changed. Build a fresh plan.')
    if (!existing) await prisma.$transaction(async tx => {
      const group = await tx.attributeGroup.findFirstOrThrow({ where: { code: 'specifications' }, select: { id: true } })
      const attribute = await tx.customAttribute.create({ data: { ...definition, groupId: group.id, validation: { shape: 'scalar' } } })
      const products = await tx.product.findMany({ where: { deletedAt: null }, select: { familyId: true, parent: { select: { familyId: true } } } })
      const familyIds = [...new Set(products.map(p => p.familyId ?? p.parent?.familyId).filter((id): id is string => !!id))]
      await tx.familyAttribute.createMany({ data: familyIds.map(familyId => ({ familyId, attributeId: attribute.id, required: false, channels: [], sortOrder: 1000 })), skipDuplicates: true })
    }, { isolationLevel: 'Serializable' })
    if (!changes.length) return
    const review = await createMappingImpact({ channel: 'SHOPIFY', market: 'GLOBAL', changes, expectedToken: plan.beforeToken, userId: null })
    const receipt: any = { jobId: review.jobId, changes: changes.length, definitionAdded: !existing }
    const save = () => writeFile(new URL('./mapping-activation.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n')
    await save()
    for (let attempt = 0; attempt < 180; attempt++) {
      await runMappingImpact(review.jobId)
      const result = await readMappingImpact(review.jobId, null)
      if (!result) throw new Error('The mapping review is unavailable.')
      if (result.state !== 'MAPPING_SCANNING') {
        Object.assign(receipt, { state: result.state, counts: result.counts, errors: result.errors }); await save()
        if (result.state !== 'MAPPING_REVIEW' || result.counts.introducedInvalid) throw new Error('The mapping review needs correction: ' + JSON.stringify(receipt))
        await activateMappingImpact(review.jobId, null)
        receipt.state = 'MAPPING_APPLIED'; await save(); console.log(JSON.stringify(receipt)); return
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error('Mapping review is still running. Resume the saved review before activating.')
  })
} finally { await prisma.$disconnect() }
