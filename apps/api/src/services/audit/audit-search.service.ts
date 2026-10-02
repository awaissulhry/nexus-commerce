/**
 * MCP full control P3 — the audit log, read in one place: the audit log page (GET /api/audit-log/search and
 * /api/audit-log/:id, audit-log.routes.ts), the settings history page (GET /api/settings/audit and
 * /api/settings/audit/keys, settings-audit.routes.ts) and Claude's `audit-trail` read call these.
 *
 * AuditLog is append-only: every mutation across the app writes one row (who, which entity, what action, the values
 * before and after). Settings changes are rows with entityType 'Settings' and the page key as entityId.
 *
 * Moved from the routes without a change in behaviour (audit-search.service.vitest.test.ts holds the routes' answers
 * byte for byte). The settings revert (POST /api/settings/audit/:id/revert) is a write and stays in its route.
 */

import { Prisma } from '@prisma/client'
import prisma from '../../db.js'

/** GET /api/audit-log/search's filters, as the query string carries them. */
export interface AuditSearchQuery {
  entityType?: string
  entityId?: string
  /** O.74: comma-separated ids, so the drawer can ask for every shipment of a multi-package order at once. */
  entityIds?: string
  userId?: string
  action?: string
  search?: string
  since?: string
  until?: string
  limit?: string
  cursor?: string
}

/**
 * One page of audit rows, newest first (cursor = the last id seen), and the facet counts for the filter chips: the
 * ten busiest entity types and actions since `since`, or over the last 30 days when no `since` is set.
 */
export async function searchAuditLog(q: AuditSearchQuery) {
  const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200)

  const where: Prisma.AuditLogWhereInput = {}
  if (q.entityType) where.entityType = q.entityType
  if (q.entityId) where.entityId = q.entityId
  else if (q.entityIds) {
    const ids = q.entityIds.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length > 0) where.entityId = { in: ids }
  }
  if (q.userId) where.userId = q.userId
  if (q.action) where.action = q.action
  if (q.since || q.until) {
    where.createdAt = {}
    if (q.since) where.createdAt.gte = new Date(q.since)
    if (q.until) where.createdAt.lte = new Date(q.until)
  }
  if (q.search && q.search.trim().length > 0) {
    // Free-text search across entityId + entityType + action.
    // metadata is JSON; search via path expression on Postgres
    // is awkward without a typed key, so we keep the search
    // surface deliberately tight here.
    const term = q.search.trim()
    where.OR = [
      { entityId: { contains: term, mode: 'insensitive' } },
      { entityType: { contains: term, mode: 'insensitive' } },
      { action: { contains: term, mode: 'insensitive' } },
      { userId: { contains: term, mode: 'insensitive' } },
    ]
  }

  // Cursor pagination: cursor is the last seen id; fetch the
  // limit+1 to know if there's a next page.
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      userId: true,
      ip: true,
      entityType: true,
      entityId: true,
      action: true,
      before: true,
      after: true,
      metadata: true,
      createdAt: true,
    },
  })
  const hasNext = rows.length > limit
  const items = hasNext ? rows.slice(0, limit) : rows
  const nextCursor = hasNext ? items[items.length - 1].id : null

  // Aggregate counts for filter chips (cheap when scoped to the
  // current `since` window; default 30 days back if nothing set).
  const countSince = q.since
    ? new Date(q.since)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const [byEntityType, byAction] = await Promise.all([
    prisma.auditLog.groupBy({
      by: ['entityType'],
      where: { createdAt: { gte: countSince } },
      _count: { _all: true },
      orderBy: { _count: { entityType: 'desc' } },
      take: 10,
    }),
    prisma.auditLog.groupBy({
      by: ['action'],
      where: { createdAt: { gte: countSince } },
      _count: { _all: true },
      orderBy: { _count: { action: 'desc' } },
      take: 10,
    }),
  ])

  return {
    items,
    nextCursor,
    facets: {
      entityType: byEntityType.map((g) => ({
        value: g.entityType,
        count: g._count._all,
      })),
      action: byAction.map((g) => ({
        value: g.action,
        count: g._count._all,
      })),
    },
  }
}

/** One audit row, every column; null when there is none. */
export async function auditLogEntry(id: string) {
  return prisma.auditLog.findUnique({
    where: { id },
  })
}

/** GET /api/settings/audit's filters, as the query string carries them. */
export interface SettingsAuditQuery {
  /** A page key, a comma-separated list of them, or 'all'. */
  key?: string
  action?: string
  since?: string
  until?: string
  limit?: string
  offset?: string
}

/** One page of settings changes, newest first, and how many match. Dates that do not parse are ignored. */
export async function listSettingsAudit(q: SettingsAuditQuery) {
  const limit = Math.min(
    Math.max(parseInt(q.limit ?? '50', 10) || 50, 1),
    200,
  )
  const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0)

  const where: any = { entityType: 'Settings' }
  if (q.key && q.key !== 'all') {
    // Allow comma-separated list ("key=account,profile").
    const keys = q.key.split(',').map((k) => k.trim()).filter(Boolean)
    if (keys.length === 1) where.entityId = keys[0]
    else if (keys.length > 1) where.entityId = { in: keys }
  }
  if (q.action) {
    where.action = q.action
  }
  if (q.since) {
    const d = new Date(q.since)
    if (!Number.isNaN(d.getTime())) {
      where.createdAt = { ...(where.createdAt ?? {}), gte: d }
    }
  }
  if (q.until) {
    const d = new Date(q.until)
    if (!Number.isNaN(d.getTime())) {
      where.createdAt = { ...(where.createdAt ?? {}), lte: d }
    }
  }

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        entityId: true,
        action: true,
        before: true,
        after: true,
        metadata: true,
        createdAt: true,
        userId: true,
      },
    }),
  ])

  return {
    total,
    limit,
    offset,
    items: rows.map((r) => ({
      id: r.id,
      key: r.entityId,
      action: r.action,
      before: r.before,
      after: r.after,
      metadata: r.metadata,
      createdAt: r.createdAt.toISOString(),
      userId: r.userId,
    })),
  }
}

/** How many settings changes each page key had in the last 30 days (the filter-chip badges). One groupBy, no joins. */
export async function settingsAuditKeyCounts() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const rows = await prisma.auditLog.groupBy({
    by: ['entityId'],
    where: { entityType: 'Settings', createdAt: { gte: cutoff } },
    _count: { _all: true },
  })
  const byKey: Record<string, number> = {}
  for (const r of rows) byKey[r.entityId] = r._count._all
  return { byKey, since: cutoff.toISOString() }
}

// ── MCP full control P6 — Claude's audit trail ──────────────────────────────────────────────────────────

/**
 * Audit rows that are never Claude's to read, whatever filter it asks for: sign-ins, people, sessions, password resets
 * and invitations (the auth writer, lib/auth/audit.ts), API keys, personal-data erasure, the channel apps' secrets, and
 * the personal settings pages (a person's own profile and password) and the API-key page. They are a person's own
 * security and the safety system itself (plan section 09 §2).
 */
export const AUDIT_TRAIL_HIDDEN_ENTITY_TYPES = [
  'Auth', 'User', 'UserProfile', 'Session', 'PasswordReset', 'Invitation', 'WorkspaceInvitation', 'ApiKey',
  'ErasureRequest', 'ChannelApp', 'OAuthGrant', 'OAuthClient', 'TwoFactor',
] as const
export const AUDIT_TRAIL_HIDDEN_SETTINGS_KEYS = ['profile', 'profile.password', 'api-keys'] as const

export interface AuditTrailQuery {
  entityType?: string
  entityId?: string
  action?: string
  /** The oldest change to include. */
  since: Date
  /** Rows per page (the caller bounds it). */
  limit: number
  /** The id of the last row of the previous page. */
  afterId?: string | null
}

/**
 * One page of the audit trail as Claude may read it: newest first (id breaks ties), never a hidden row, never the IP
 * address. The values before and after are returned as stored; the caller makes them safe to hand out.
 */
export async function searchAuditTrail(q: AuditTrailQuery) {
  const where: Prisma.AuditLogWhereInput = {
    createdAt: { gte: q.since },
    NOT: [
      { entityType: { in: [...AUDIT_TRAIL_HIDDEN_ENTITY_TYPES], mode: 'insensitive' } },
      { entityType: { equals: 'Settings', mode: 'insensitive' }, entityId: { in: [...AUDIT_TRAIL_HIDDEN_SETTINGS_KEYS] } },
    ],
    ...(q.entityType ? { entityType: q.entityType } : {}),
    ...(q.entityId ? { entityId: q.entityId } : {}),
    ...(q.action ? { action: q.action } : {}),
  }
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    ...(q.afterId ? { cursor: { id: q.afterId }, skip: 1 } : {}),
    select: { id: true, userId: true, entityType: true, entityId: true, action: true, before: true, after: true, metadata: true, createdAt: true },
  })
  const items = rows.slice(0, q.limit)
  return { items, nextId: rows.length > q.limit ? items[items.length - 1].id : null }
}
