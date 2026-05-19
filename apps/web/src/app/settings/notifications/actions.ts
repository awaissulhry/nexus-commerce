'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'
import { writeSettingsAudit } from '@/lib/settings-audit'
// 'use server' modules can only export async functions, so the
// registry lives in its own module (./event-types.ts).
import { EVENT_TYPES } from './event-types'

const ALLOWED_KEYS = new Set<string>(EVENT_TYPES.map((e) => e.key))
const ALLOWED_CADENCE = new Set(['instant', 'hourly', 'daily', 'off'])

export interface NotificationPrefInput {
  eventType: string
  email: boolean
  sms: boolean
  inApp: boolean
  channelFilter: string[]
  digestCadence: string
}

/**
 * Quiet hours sit on UserProfile (already has timezone). We update
 * them in the same save so the user thinks of "notification settings"
 * as one form. Pass null to clear.
 */
export interface QuietHoursInput {
  quietHoursStart: string | null
  quietHoursEnd: string | null
}

function flattenPrefs(
  rows: Array<{
    eventType: string
    email: boolean
    sms: boolean
    inApp: boolean
    channelFilter: string[]
    digestCadence: string
  }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const r of rows) {
    out[`${r.eventType}.email`] = r.email
    out[`${r.eventType}.sms`] = r.sms
    out[`${r.eventType}.inApp`] = r.inApp
    out[`${r.eventType}.cadence`] = r.digestCadence
    out[`${r.eventType}.channelFilter`] = [...r.channelFilter].sort().join(',')
  }
  return out
}

export async function saveNotificationPreferences(input: {
  prefs: NotificationPrefInput[]
  quietHours: QuietHoursInput
}) {
  // Phase E — find the single workspace user. When auth lands this
  // becomes session.userId; until then we attach prefs to the
  // singleton UserProfile if one exists, otherwise fall back to
  // userId=null (workspace-global, existing behaviour).
  const user = await (prisma as any).userProfile.findFirst()
  const userId: string | null = user?.id ?? null

  // Snapshot before-state for the audit diff.
  const beforeRows = await (prisma as any).notificationPreference.findMany({
    where: { userId: userId ?? undefined },
  })

  // Validate + persist each pref. Per-row failures don't abort the
  // batch; bad rows surface in the response but the rest still saves.
  const afterRows: typeof input.prefs = []
  const errors: Array<{ eventType: string; reason: string }> = []
  for (const p of input.prefs) {
    if (!ALLOWED_KEYS.has(p.eventType)) {
      errors.push({ eventType: p.eventType, reason: 'Unknown event type' })
      continue
    }
    if (!ALLOWED_CADENCE.has(p.digestCadence)) {
      errors.push({
        eventType: p.eventType,
        reason: 'Cadence must be instant | hourly | daily | off',
      })
      continue
    }
    const data = {
      email: !!p.email,
      sms: !!p.sms,
      inApp: !!p.inApp,
      channelFilter: Array.isArray(p.channelFilter)
        ? Array.from(new Set(p.channelFilter.filter((s) => typeof s === 'string')))
        : [],
      digestCadence: p.digestCadence,
    }
    if (userId) {
      // Composite unique on (userId, eventType) — upsert works
      // cleanly because we now have a non-null user.
      await (prisma as any).notificationPreference.upsert({
        where: { userId_eventType: { userId, eventType: p.eventType } },
        update: data,
        create: { userId, eventType: p.eventType, ...data },
      })
    } else {
      // Pre-auth fallback: workspace-global row keyed on eventType
      // alone. Find-or-create by hand since Prisma can't upsert on
      // a partial-unique-with-NULL.
      const existing = await (prisma as any).notificationPreference.findFirst({
        where: { userId: null, eventType: p.eventType },
      })
      if (existing) {
        await (prisma as any).notificationPreference.update({
          where: { id: existing.id },
          data,
        })
      } else {
        await (prisma as any).notificationPreference.create({
          data: { userId: null, eventType: p.eventType, ...data },
        })
      }
    }
    afterRows.push({ eventType: p.eventType, ...data })
  }

  // Quiet hours on UserProfile.
  if (user) {
    await (prisma as any).userProfile.update({
      where: { id: user.id },
      data: {
        quietHoursStart: input.quietHours.quietHoursStart || null,
        quietHoursEnd: input.quietHours.quietHoursEnd || null,
      },
    })
  }

  // Audit row — flatten so the diff highlights per-toggle changes.
  await writeSettingsAudit({
    key: 'notifications',
    action: 'update',
    before: {
      ...flattenPrefs(beforeRows),
      quietHoursStart: user?.quietHoursStart ?? null,
      quietHoursEnd: user?.quietHoursEnd ?? null,
    },
    after: {
      ...flattenPrefs(afterRows),
      quietHoursStart: input.quietHours.quietHoursStart ?? null,
      quietHoursEnd: input.quietHours.quietHoursEnd ?? null,
    },
  })

  revalidatePath('/settings/notifications')
  return {
    success: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  } as const
}
