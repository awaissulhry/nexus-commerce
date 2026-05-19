import { prisma } from '@nexus/database'
import NotificationsClient from './NotificationsClient'

export const dynamic = 'force-dynamic'

export interface NotificationPref {
  eventType: string
  email: boolean
  sms: boolean
  inApp: boolean
}

const DEFAULT_PREFS: NotificationPref[] = [
  { eventType: 'NEW_ORDER', email: true, sms: false, inApp: true },
  { eventType: 'LOW_STOCK', email: true, sms: false, inApp: true },
  { eventType: 'RETURN_REQUEST', email: true, sms: false, inApp: true },
  { eventType: 'SYNC_FAILURE', email: true, sms: false, inApp: true },
  { eventType: 'AI_COMPLETE', email: false, sms: false, inApp: true },
]

export default async function NotificationsPage() {
  // U.61 — defensive try/catch. See /catalog/drafts for context.
  let saved: any[] = []
  try {
    saved = await (prisma as any).notificationPreference.findMany()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings/notifications] prisma error:', err)
  }

  const prefs: NotificationPref[] = DEFAULT_PREFS.map((def) => {
    const found = saved.find((s: any) => s.eventType === def.eventType)
    return found
      ? { eventType: found.eventType, email: found.email, sms: found.sms, inApp: found.inApp }
      : def
  })

  return <NotificationsClient preferences={prefs} />
}
