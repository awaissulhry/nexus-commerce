/** Read only. Run from apps/api using ../../node_modules/.bin/tsx ../../docs/audits/2026-09-11-information/migration-preview.mts */
import prisma from '../../../apps/api/src/db.js'
import { INFORMATION_DICTIONARY_PLAN as plan } from '../../../apps/api/src/services/pim/information-dictionary-plan.js'
const [accounts, formulas, attributes, products, operations] = await Promise.all([
  prisma.channelConnection.findMany({ where: { isActive: true }, select: { id: true, channelType: true, isPrimary: true } }),
  // Raw query works before the new identity columns exist. Workspace context still scopes the read.
  prisma.$queryRaw<Array<{ id: string; productId: string; channel: string; marketplace: string; locale: string; fieldKey: string }>>`SELECT id, "productId", channel, marketplace, locale, "fieldKey" FROM "CellFormula" WHERE scope = 'channel'`,
  prisma.customAttribute.findMany({ where: { code: { in: [...plan.update.map(p => p.code), ...plan.add.map(p => p.code)] } }, include: { options: true, familyAttributes: true } }),
  prisma.product.findMany({ where: { deletedAt: null }, select: { id: true, sku: true, familyId: true, isParent: true, categoryAttributes: true, localizedContent: true } }),
  prisma.bulkOperation.findMany({ where: { changes: { path: ['kind'], equals: 'product-formula-v2' } }, select: { id: true, status: true, changes: true } }),
])
const formulaDestinations = formulas.map(formula => {
  const choices = accounts.filter(a => a.channelType === formula.channel)
  const effective = choices.filter(a => a.isPrimary || choices.length === 1)
  return { ...formula, proposedAccountId: effective.length === 1 ? effective[0].id : null, requiresHistoricalDestinationReview: true, blocked: effective.length !== 1 }
})
const dictionary = [...plan.update, ...plan.add].map(change => {
  const current = attributes.find(a => a.code === change.code)
  const populated = products.filter(p => Object.prototype.hasOwnProperty.call(p.categoryAttributes ?? {}, change.code))
  return { code: change.code, definitionId: current?.id ?? null, before: current ? { type: current.type, localizable: current.localizable, scope: current.scope, validation: current.validation, options: current.options.map(o => o.code) } : null,
    proposed: change, families: current?.familyAttributes.map(a => a.familyId) ?? [], populatedRows: populated.length,
    affectedProducts: populated.map(p => ({ id: p.id, sku: p.sku, parent: p.isParent, familyId: p.familyId, saved: (p.categoryAttributes as any)?.[change.code] })) }
})
console.log(JSON.stringify({ readOnly: true, generatedAt: new Date().toISOString(), revision: plan.revision, formulaDestinations, dictionary,
  unboundRecoveryOperations: operations.filter(o => (o.changes as any)?.input?.scope === 'channel' && (o.changes as any)?.destinationVersion !== 1).map(o => ({ id: o.id, status: o.status })),
  productsChanged: 0, familyAssignmentsChanged: 0, mappingsChanged: 0 }, null, 2))
await prisma.$disconnect()
