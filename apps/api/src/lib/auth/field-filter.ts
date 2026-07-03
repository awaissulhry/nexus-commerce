/**
 * Phase S2 (RBAC engine) — the one field-level financial filter.
 *
 * Runs as a `preSerialization` hook so it sees the raw response OBJECT
 * before Fastify serializes it: restricted money fields are deleted for
 * callers who lack the matching `financials.*` permission, so they never
 * reach the wire (master prompt §3.3). Because it recurses, it also strips
 * money smuggled inside JSON blobs (AuditLog.before/after, amazonMetadata,
 * PO snapshots) — the bypass channels S0 flagged.
 *
 * Gated to enforce mode: in shadow it is a no-op, so deploying it can't
 * strip fields from the still-unauthenticated app. SSE payloads bypass
 * serialization; export writers bypass the hook — both must call
 * filterFinancialPayload() directly (integration points, S2 follow-up).
 */

import type { FastifyRequest } from 'fastify'
import { RESTRICTED_FIELDS } from './financial-fields.js'
import type { ResolvedPermissions } from './rbac.js'
import { FIELDS } from '@nexus/shared/permissions'

const MAX_DEPTH = 12

function walk(value: unknown, perms: Set<string>, depth: number): unknown {
  if (value == null || depth > MAX_DEPTH) return value
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = walk(value[i], perms, depth + 1)
    return value
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      const gate = RESTRICTED_FIELDS[key]
      if (gate && !perms.has(gate)) {
        delete obj[key]
        continue
      }
      obj[key] = walk(obj[key], perms, depth + 1)
    }
    return obj
  }
  return value
}

/**
 * Strip restricted financial fields the caller can't see. Mutates + returns
 * the payload. Owners and `financials.view` holders see everything.
 */
export function filterFinancialPayload(
  payload: unknown,
  resolved: ResolvedPermissions,
): unknown {
  if (resolved.isOwner) return payload
  if (resolved.permissions.has(FIELDS.financialsView)) return payload // implies all grains
  if (payload == null || typeof payload !== 'object') return payload
  return walk(payload, resolved.permissions, 0)
}

const NO_PERMS: ResolvedPermissions = { isOwner: false, permissions: new Set() }

/** preSerialization hook — enforce-mode field stripping. */
export async function financialFilterHook(
  req: FastifyRequest,
  _reply: unknown,
  payload: unknown,
): Promise<unknown> {
  if (process.env.NEXUS_RBAC_MODE !== 'enforce') return payload
  // Reuse the perms the RBAC gate already resolved this request; absent
  // (no session / PUBLIC route) → no financial perms → strip everything.
  const resolved = req.__rbacResolved ?? NO_PERMS
  return filterFinancialPayload(payload, resolved)
}
