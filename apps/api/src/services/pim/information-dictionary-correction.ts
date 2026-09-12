import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { INFORMATION_DICTIONARY_PLAN as plan } from './information-dictionary-plan.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'

/** Explicit definition-only correction; callers must review the fingerprint before applying. */
export async function dictionaryCorrectionPreview(db: PrismaClient, familyIds: string[]) {
  const families = await db.productFamily.findMany({ where: { id: { in: [...new Set(familyIds)] } }, select: { id: true, code: true } })
  if (families.length !== new Set(familyIds).size || !families.length) throw new Error('Name existing families for the optional additions. Imported products are never assigned a family here.')
  const codes = [...plan.update.map(p => p.code), ...plan.add.map(p => p.code)]
  const definitions = await db.customAttribute.findMany({ where: { code: { in: codes } }, include: { options: { orderBy: { code: 'asc' } }, familyAttributes: { orderBy: { familyId: 'asc' } } }, orderBy: { code: 'asc' } })
  const products = await db.product.findMany({ where: { deletedAt: null }, select: { id: true, sku: true, isParent: true, familyId: true, categoryAttributes: true }, orderBy: { id: 'asc' } })
  const mappings = await db.marketplace.findMany({ select: { id: true, channel: true, code: true, schemaMapping: true }, orderBy: { id: 'asc' } })
  const inputs = { revision: plan.revision, workspaceId: workspaceIdForQuery(), familyIds: [...familyIds].sort(), definitions,
    populated: products.filter(p => codes.some(code => Object.prototype.hasOwnProperty.call(p.categoryAttributes ?? {}, code))), mappings }
  return { ...inputs, fingerprint: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'), plan, productsChanged: 0, assignmentsChanged: 0 }
}

export async function applyDictionaryCorrection(db: PrismaClient, familyIds: string[], expectedFingerprint: string) {
  return db.$transaction(async tx => {
    const preview = await dictionaryCorrectionPreview(tx as unknown as PrismaClient, familyIds)
    if (preview.fingerprint !== expectedFingerprint) throw new Error('The dictionary, mapped sources or saved values changed after review. Generate a new preview.')
    const workspaceId = workspaceIdForQuery()
    const group = await tx.attributeGroup.upsert({ where: { workspace_code: { workspaceId, code: 'information_shared' } },
      create: { code: 'information_shared', label: 'Shared specifications' }, update: {} })
    for (const change of [...plan.update, ...plan.add]) {
      const old = preview.definitions.find(a => a.code === change.code)
      const isAddition = plan.add.some(a => a.code === change.code)
      if (!old && !isAddition) continue
      const { code, options, validation, ...rest } = change as Record<string, any>
      const data = { ...rest, ...(validation ? { validation: { ...(old?.validation as object ?? {}), ...validation } } : {}) }
      const attribute = old ? await tx.customAttribute.update({ where: { id: old.id, updatedAt: old.updatedAt }, data })
        : await tx.customAttribute.create({ data: { code, groupId: group.id, ...data } as any })
      for (const [index, option] of (options ?? []).entries()) {
        const existing = old?.options.find(o => o.code === option.code)
        if (!existing) await tx.attributeOption.create({ data: { attributeId: attribute.id, code: option.code, label: option.label, sortOrder: index } })
      }
      if (isAddition) for (const familyId of familyIds) {
        if (!old?.familyAttributes.some(f => f.familyId === familyId)) await tx.familyAttribute.create({ data: { familyId, attributeId: attribute.id, required: false, channels: [], sortOrder: 30 } })
      }
    }
    await tx.auditLog.create({ data: { entityType: 'InformationDictionaryCorrection', entityId: plan.revision, action: 'information.dictionary.corrected', metadata: { fingerprint: expectedFingerprint, familyIds, productsChanged: 0, assignmentsChanged: 0 } } })
    return { applied: true, revision: plan.revision, productsChanged: 0, assignmentsChanged: 0 }
  })
}
