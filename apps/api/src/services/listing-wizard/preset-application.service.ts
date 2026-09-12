import type { ListingWizard, WizardTemplate } from '@prisma/client'
import prisma from '../../db.js'
import { channelsHash, type ChannelTuple } from './channels.js'

/** A wizard edit and preset usage stamp either both persist or both roll back. */
export async function commitWizardPreset(wizard: Pick<ListingWizard, 'id' | 'version' | 'updatedAt'>, preset: Pick<WizardTemplate, 'id' | 'updatedAt'>, channels: ChannelTuple[], mergedState: Record<string, unknown>) {
  const wizardId = wizard.id
  return await prisma.$transaction(async tx => {
    const saved = await tx.listingWizard.updateMany({
      where: { id: wizardId, version: wizard.version, updatedAt: wizard.updatedAt, status: 'DRAFT' },
      data: { channels: channels as unknown as object, channelsHash: channelsHash(channels), state: mergedState as object, version: { increment: 1 } },
    })
    if (!saved.count) throw new Error('PRESET_CONFLICT')
    const used = await tx.wizardTemplate.updateMany({
      where: { id: preset.id, updatedAt: preset.updatedAt },
      // Usage is not a change to the reusable definition. Keep its revision stable.
      data: { usageCount: { increment: 1 }, lastUsedAt: new Date(), updatedAt: preset.updatedAt },
    })
    if (!used.count) throw new Error('PRESET_CONFLICT')
    return tx.listingWizard.findUniqueOrThrow({ where: { id: wizardId } })
  })
}
