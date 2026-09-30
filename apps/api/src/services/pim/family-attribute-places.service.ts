/**
 * P1 (fix/product-sheet-editing; issue #15, report 6 I-8/I-9) — where each of a product's FAMILY attributes lives.
 *
 * The sheet's "All attributes (79)" counted only the columns of the scope on screen, while the family page counts every
 * attribute of the family (197 on Motovento: Shared 51 + Amazon 43 + eBay 3 + archived 100). An attribute placed on a
 * channel the business has no account for, or archived, had no column anywhere and nothing said so (#14). The sheet's
 * Customise dialog reads this to list the family attributes that have no column on the sheet in view, and where each one
 * is. Read on demand (when Customise opens), never with the sheet, so the sheet's own load pays nothing for it.
 */
import prisma from '../../db.js'
import { familyHierarchyService } from '../family-hierarchy.service.js'
import { UnknownProductError } from './studio-sheet.service.js'

export interface FamilyAttributePlace {
  code: string
  label: string
  /** `shared` (the Shared product sheet) or `channel` (only the channels in `channels`). */
  placement: 'shared' | 'channel'
  channels: string[]
  archived: boolean
}

export interface FamilyAttributePlaces {
  family: { id: string; label: string } | null
  attributes: FamilyAttributePlace[]
  /** The channels this business has an account for (any connection, active or not). */
  channelsWithAccount: string[]
}

export async function familyAttributePlaces(productId: string): Promise<FamilyAttributePlaces> {
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { familyId: true, parent: { select: { familyId: true } } },
  })
  if (!product) throw new UnknownProductError(productId)
  const familyId = product.familyId ?? product.parent?.familyId ?? null
  const connections = await prisma.channelConnection.findMany({ select: { channelType: true }, distinct: ['channelType'] })
  const channelsWithAccount = [...new Set(connections.map(c => String(c.channelType).toUpperCase()))].sort()
  if (!familyId) return { family: null, attributes: [], channelsWithAccount }
  const [family, effective] = await Promise.all([
    prisma.productFamily.findUnique({ where: { id: familyId }, select: { id: true, label: true } }),
    familyHierarchyService.resolveEffectiveAttributes(familyId),
  ])
  const rows = effective.length ? await prisma.customAttribute.findMany({
    where: { id: { in: effective.map(e => e.attributeId) } },
    select: { code: true, label: true, placement: true, placementChannels: true, archivedAt: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  }) : []
  return {
    family,
    attributes: rows.map(a => ({
      code: a.code, label: a.label,
      placement: a.placement === 'channel' ? 'channel' as const : 'shared' as const,
      channels: (a.placementChannels ?? []).map(c => String(c).toUpperCase()),
      archived: !!a.archivedAt,
    })),
    channelsWithAccount,
  }
}
