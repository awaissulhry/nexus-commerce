'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'

export async function saveAccountSettings(formData: FormData) {
  const data = {
    businessName: formData.get('businessName') as string || '',
    addressLine1: formData.get('addressLine1') as string || '',
    addressLine2: formData.get('addressLine2') as string || '',
    city: formData.get('city') as string || '',
    state: formData.get('state') as string || '',
    postalCode: formData.get('postalCode') as string || '',
    country: formData.get('country') as string || 'US',
    timezone: formData.get('timezone') as string || 'America/New_York',
    currency: formData.get('currency') as string || 'USD',
  }

  // Upsert: find the first record or create one
  const existing = await (prisma as any).accountSettings.findFirst()

  if (existing) {
    await (prisma as any).accountSettings.update({
      where: { id: existing.id },
      data,
    })
  } else {
    await (prisma as any).accountSettings.create({ data })
  }

  revalidatePath('/settings/account')
  return { success: true }
}
