/**
 * Settings rebuild — Phase B
 *
 * Helper that every settings server action calls right after the
 * mutation commits. Writes ONE AuditLog row per save with a slim
 * before/after diff — only fields that actually changed.
 *
 * Audit shape (consistent across the whole settings hub):
 *
 *   entityType:  'Settings'
 *   entityId:    page key — see SETTINGS_AUDIT_KEYS for the list
 *   action:      'update' | 'create' | 'delete'
 *   before:      { changedField: oldValue, ... }      // null on create
 *   after:       { changedField: newValue, ... }      // null on delete
 *   metadata:    { source: 'settings-ui', label?, actor? }
 *
 * Convention: pageKey is the URL slug after /settings (e.g. 'account',
 * 'profile', 'company'). Composite keys use a dot ('profile.password').
 *
 * Fail-soft: if the audit write throws, log + swallow. The user-facing
 * save already succeeded; we don't want a Prisma blip on the audit
 * write to surface as a save error. The trail is best-effort.
 */

import { prisma } from '@nexus/database'

/**
 * Canonical list of settings page keys. New pages MUST add their
 * key here so the audit viewer can filter by it and surface a
 * human-readable label.
 */
export const SETTINGS_AUDIT_KEYS = {
  account: { label: 'Business' },
  profile: { label: 'Profile' },
  'profile.password': { label: 'Profile · password' },
  notifications: { label: 'Notifications' },
  'api-keys': { label: 'API keys' },
  company: { label: 'Company & fiscal' },
  terminology: { label: 'Terminology' },
} as const

export type SettingsAuditKey = keyof typeof SETTINGS_AUDIT_KEYS

export type SettingsAuditAction = 'update' | 'create' | 'delete'

interface WriteSettingsAuditInput {
  /** Which settings page produced the change. */
  key: SettingsAuditKey
  /** Required: what kind of mutation. */
  action: SettingsAuditAction
  /**
   * Previous record snapshot (or relevant fields). Pass null on
   * 'create'. Helper diffs vs `after` and only stores changed fields.
   */
  before: Record<string, unknown> | null
  /**
   * New record snapshot. Pass null on 'delete'. Helper diffs vs
   * `before`.
   */
  after: Record<string, unknown> | null
  /**
   * Optional: extra context for the audit viewer (e.g. the label
   * of a tag the user just renamed, the id of an API key revoked).
   */
  metadata?: Record<string, unknown>
}

/**
 * Cheap value equality used for the diff. Handles primitives, Dates,
 * and shallow arrays/objects via JSON canonicalisation. Sufficient
 * for the kind of values settings forms produce; deep object diffs
 * are out of scope here.
 */
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

/**
 * Slim a (before, after) pair down to just the changed fields. Both
 * shapes need not have the same keys — keys present in only one side
 * survive (treated as a change from undefined ↔ value).
 */
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

/**
 * Returns the number of changed fields between two snapshots. Useful
 * for the caller to skip a no-op audit write entirely.
 */
export function countChangedFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): number {
  const d = diff(before, after)
  if (d.before == null && d.after == null) return 0
  if (d.before == null) return Object.keys(d.after ?? {}).length
  if (d.after == null) return Object.keys(d.before ?? {}).length
  return Object.keys(d.after).length
}

/**
 * Write one AuditLog row. Skips when before === after (no diff).
 * Returns the row id on success, or undefined when nothing was
 * written (no-op or write failed).
 */
export async function writeSettingsAudit(
  input: WriteSettingsAuditInput,
): Promise<string | undefined> {
  try {
    const { before, after } = diff(input.before, input.after)
    // Pure no-op: don't pollute the log.
    if (input.action === 'update') {
      const beforeKeys = before ? Object.keys(before).length : 0
      const afterKeys = after ? Object.keys(after).length : 0
      if (beforeKeys === 0 && afterKeys === 0) return undefined
    }

    const row = await (prisma as any).auditLog.create({
      data: {
        userId: null, // Single-tenant for now; will populate from session in Phase I.
        entityType: 'Settings',
        entityId: input.key,
        action: input.action,
        before,
        after,
        metadata: {
          source: 'settings-ui',
          label: SETTINGS_AUDIT_KEYS[input.key]?.label ?? input.key,
          ...(input.metadata ?? {}),
        },
      },
    })
    return row.id as string
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings-audit] write failed', {
      key: input.key,
      action: input.action,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}
