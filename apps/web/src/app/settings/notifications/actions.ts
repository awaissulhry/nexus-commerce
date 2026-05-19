'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'
import { writeSettingsAudit } from '@/lib/settings-audit'

const EVENT_TYPES = [
  'NEW_ORDER',
  'LOW_STOCK',
  'RETURN_REQUEST',
  'SYNC_FAILURE',
  'AI_COMPLETE',
]

/**
 * Flatten the array of NotificationPreference rows into a single
 * before/after object that diffs cleanly. Key format:
 * "<EVENT_TYPE>.<channel>" — e.g. "NEW_ORDER.email". This lets the
 * audit viewer show "NEW_ORDER.sms: false → true" in one line per
 * actual change instead of dumping whole rows.
 */
function flattenPrefs(
  rows: Array<{ eventType: string; email: boolean; sms: boolean; inApp: boolean }>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const r of rows) {
    out[`${r.eventType}.email`] = r.email
    out[`${r.eventType}.sms`] = r.sms
    out[`${r.eventType}.inApp`] = r.inApp
  }
  return out
}

export async function saveNotificationPreferences(formData: FormData) {
  // Snapshot before — so the audit diff can highlight specific
  // toggle changes ("NEW_ORDER.sms: off → on") rather than dumping
  // every row.
  const before = await (prisma as any).notificationPreference.findMany({
    where: { eventType: { in: EVENT_TYPES } },
  })

  const after: Array<{
    eventType: string
    email: boolean
    sms: boolean
    inApp: boolean
  }> = []
  for (const eventType of EVENT_TYPES) {
    const email = formData.get(`${eventType}_email`) === 'on'
    const sms = formData.get(`${eventType}_sms`) === 'on'
    const inApp = formData.get(`${eventType}_inApp`) === 'on'

    await (prisma as any).notificationPreference.upsert({
      where: { eventType },
      update: { email, sms, inApp },
      create: { eventType, email, sms, inApp },
    })
    after.push({ eventType, email, sms, inApp })
  }

  await writeSettingsAudit({
    key: 'notifications',
    action: 'update',
    before: flattenPrefs(before),
    after: flattenPrefs(after),
  })

  revalidatePath('/settings/notifications')
  return { success: true }
}
