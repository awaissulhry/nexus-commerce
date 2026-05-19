'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'
import { createHash, randomBytes } from 'crypto'
import { writeSettingsAudit } from '@/lib/settings-audit'

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export async function generateApiKey(formData: FormData) {
  const label = (formData.get('label') as string) || 'Untitled Key'

  // Generate a secure random key: nxk_ + 32 random hex chars
  const rawKey = `nxk_${randomBytes(24).toString('hex')}`
  const keyHash = hashKey(rawKey)
  const keyPrefix = rawKey.substring(0, 12) + '…'

  const created = await (prisma as any).apiKey.create({
    data: {
      label,
      keyHash,
      keyPrefix,
    },
  })

  // Never log keyHash or rawKey. The audit row records WHICH key
  // was created (id + label + prefix) for traceability without
  // exposing the credential.
  await writeSettingsAudit({
    key: 'api-keys',
    action: 'create',
    before: null,
    after: { id: created.id, label, keyPrefix },
    metadata: { event: 'key_generated' },
  })

  revalidatePath('/settings/api-keys')

  // Return the raw key ONCE — it cannot be retrieved again
  return { success: true, rawKey }
}

export async function revokeApiKey(keyId: string) {
  const before = await (prisma as any).apiKey.findUnique({ where: { id: keyId } })
  await (prisma as any).apiKey.update({
    where: { id: keyId },
    data: { revokedAt: new Date() },
  })

  if (before) {
    await writeSettingsAudit({
      key: 'api-keys',
      action: 'update',
      before: {
        id: before.id,
        label: before.label,
        keyPrefix: before.keyPrefix,
        revokedAt: before.revokedAt,
      },
      after: {
        id: before.id,
        label: before.label,
        keyPrefix: before.keyPrefix,
        revokedAt: new Date(),
      },
      metadata: { event: 'key_revoked' },
    })
  }

  revalidatePath('/settings/api-keys')
  return { success: true }
}

export async function deleteApiKey(keyId: string) {
  const before = await (prisma as any).apiKey.findUnique({ where: { id: keyId } })
  await (prisma as any).apiKey.delete({
    where: { id: keyId },
  })

  if (before) {
    await writeSettingsAudit({
      key: 'api-keys',
      action: 'delete',
      before: {
        id: before.id,
        label: before.label,
        keyPrefix: before.keyPrefix,
      },
      after: null,
      metadata: { event: 'key_deleted' },
    })
  }

  revalidatePath('/settings/api-keys')
  return { success: true }
}
