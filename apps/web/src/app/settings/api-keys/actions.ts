'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'
import { createHash, randomBytes } from 'crypto'

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export async function generateApiKey(formData: FormData) {
  const label = (formData.get('label') as string) || 'Untitled Key'

  // Generate a secure random key: nxk_ + 32 random hex chars
  const rawKey = `nxk_${randomBytes(24).toString('hex')}`
  const keyHash = hashKey(rawKey)
  const keyPrefix = rawKey.substring(0, 12) + '…'

  await (prisma as any).apiKey.create({
    data: {
      label,
      keyHash,
      keyPrefix,
    },
  })

  revalidatePath('/settings/api-keys')

  // Return the raw key ONCE — it cannot be retrieved again
  return { success: true, rawKey }
}

export async function revokeApiKey(keyId: string) {
  await (prisma as any).apiKey.update({
    where: { id: keyId },
    data: { revokedAt: new Date() },
  })

  revalidatePath('/settings/api-keys')
  return { success: true }
}

export async function deleteApiKey(keyId: string) {
  await (prisma as any).apiKey.delete({
    where: { id: keyId },
  })

  revalidatePath('/settings/api-keys')
  return { success: true }
}
