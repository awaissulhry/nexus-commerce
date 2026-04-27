'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'

const EVENT_TYPES = [
  'NEW_ORDER',
  'LOW_STOCK',
  'RETURN_REQUEST',
  'SYNC_FAILURE',
  'AI_COMPLETE',
]

export async function saveNotificationPreferences(formData: FormData) {
  for (const eventType of EVENT_TYPES) {
    const email = formData.get(`${eventType}_email`) === 'on'
    const sms = formData.get(`${eventType}_sms`) === 'on'
    const inApp = formData.get(`${eventType}_inApp`) === 'on'

    await (prisma as any).notificationPreference.upsert({
      where: { eventType },
      update: { email, sms, inApp },
      create: { eventType, email, sms, inApp },
    })
  }

  revalidatePath('/settings/notifications')
  return { success: true }
}
