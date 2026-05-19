/**
 * Settings rebuild — Phase B (API-side mirror of the web helper)
 *
 * Brand-settings + terminology save through the Fastify API rather
 * than Next.js server actions, so they need their own audit writer.
 * Output AuditLog shape MUST match apps/web/src/lib/settings-audit.ts
 * exactly — the /settings/audit viewer consumes both writers' rows
 * without distinguishing source.
 *
 * Keep this helper minimal — it shouldn't accumulate per-page
 * logic. Diffing + the canonical row shape live here; everything
 * else stays at the call site.
 */

import prisma from '../db.js'

export type SettingsAuditKey =
  | 'account'
  | 'profile'
  | 'profile.password'
  | 'notifications'
  | 'api-keys'
  | 'company'
  | 'terminology'

const KEY_LABEL: Record<SettingsAuditKey, string> = {
  account: 'Business',
  profile: 'Profile',
  'profile.password': 'Profile · password',
  notifications: 'Notifications',
  'api-keys': 'API keys',
  company: 'Company & fiscal',
  terminology: 'Terminology',
}

export type SettingsAuditAction = 'update' | 'create' | 'delete'

interface WriteSettingsAuditInput {
  key: SettingsAuditKey
  action: SettingsAuditAction
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  metadata?: Record<string, unknown>
}

function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): {
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
} {
  if (before == null && after == null) return { before: null, after: null }
  if (before == null) return { before: null, after: after ?? {} }
  if (after == null) return { before: before ?? {}, after: null }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const b: Record<string, unknown> = {}
  const a: Record<string, unknown> = {}
  for (const k of keys) {
    if (!valueEqual(before[k], after[k])) {
      b[k] = before[k] ?? null
      a[k] = after[k] ?? null
    }
  }
  return { before: b, after: a }
}

export async function writeSettingsAudit(
  input: WriteSettingsAuditInput,
): Promise<string | undefined> {
  try {
    const { before, after } = diff(input.before, input.after)
    if (input.action === 'update') {
      const beforeKeys = before ? Object.keys(before).length : 0
      const afterKeys = after ? Object.keys(after).length : 0
      if (beforeKeys === 0 && afterKeys === 0) return undefined
    }

    const row = await (prisma as any).auditLog.create({
      data: {
        userId: null,
        entityType: 'Settings',
        entityId: input.key,
        action: input.action,
        before,
        after,
        metadata: {
          source: 'settings-ui',
          label: KEY_LABEL[input.key],
          ...(input.metadata ?? {}),
        },
      },
    })
    return row.id as string
  } catch (err) {
    console.error('[settings-audit] write failed', {
      key: input.key,
      action: input.action,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}
