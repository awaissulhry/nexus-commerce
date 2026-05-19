import { prisma } from '@nexus/database'
import NotificationsClient, { type LoadedPref } from './NotificationsClient'
import { EVENT_TYPES } from './actions'

export const dynamic = 'force-dynamic'

export default async function NotificationsPage() {
  let user: any = null
  let saved: any[] = []
  try {
    user = await (prisma as any).userProfile.findFirst()
    saved = await (prisma as any).notificationPreference.findMany({
      where: user ? { OR: [{ userId: user.id }, { userId: null }] } : { userId: null },
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings/notifications] prisma error:', err)
  }

  // Merge: prefer the per-user row when both exist; fall back to the
  // workspace-global row; finally fall back to the event-type default.
  const byEvent: Record<string, any> = {}
  for (const row of saved) {
    if (!byEvent[row.eventType] || row.userId) byEvent[row.eventType] = row
  }

  const prefs: LoadedPref[] = EVENT_TYPES.map((ev) => {
    const row = byEvent[ev.key]
    return {
      eventType: ev.key,
      email: row?.email ?? ev.defaults.email,
      sms: row?.sms ?? ev.defaults.sms,
      inApp: row?.inApp ?? ev.defaults.inApp,
      channelFilter: row?.channelFilter ?? [],
      digestCadence: row?.digestCadence ?? ev.defaults.digestCadence,
    }
  })

  return (
    <NotificationsClient
      initialPrefs={prefs}
      quietHoursStart={user?.quietHoursStart ?? ''}
      quietHoursEnd={user?.quietHoursEnd ?? ''}
      timezone={user?.timezone ?? null}
    />
  )
}
