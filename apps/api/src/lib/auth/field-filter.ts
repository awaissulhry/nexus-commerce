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

/**
 * The same strip as {@link filterFinancialPayload}, on a copy. The approval gate needs it: it stores the
 * raw preview (each reader is filtered when the row is read) and hands the caller a filtered one.
 *
 * Only plain objects and arrays are copied. Decimal, Date and other class instances are returned as they
 * are, so a copy serializes exactly like the original. `extra` names tool-specific money keys that the
 * shared registry does not (an agent tool's `revenue`). Below MAX_DEPTH nothing is returned: a value this
 * filter could not inspect is not handed out.
 */
export function financialPayloadCopy<T>(
  payload: T,
  resolved: ResolvedPermissions,
  extra?: Readonly<Record<string, string>>,
): T {
  if (resolved.isOwner || resolved.permissions.has(FIELDS.financialsView)) return payload
  return copyWalk(payload, resolved.permissions, extra, 0) as T
}

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)

function copyWalk(
  value: unknown,
  perms: Set<string>,
  extra: Readonly<Record<string, string>> | undefined,
  depth: number,
): unknown {
  if (value == null || typeof value !== 'object') return value
  if (depth > MAX_DEPTH) return undefined
  if (Array.isArray(value)) return value.map((item) => copyWalk(item, perms, extra, depth + 1))
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    // Own keys only: a payload key named `constructor` must not match Object.prototype.
    const gate = own(RESTRICTED_FIELDS, key)
      ? RESTRICTED_FIELDS[key]
      : extra && own(extra, key)
        ? extra[key]
        : undefined
    if (gate && !perms.has(gate)) continue
    out[key] = copyWalk(item, perms, extra, depth + 1)
  }
  return out
}

const NO_PERMS: ResolvedPermissions = { isOwner: false, permissions: new Set() }

/** preSerialization hook — enforce-mode field stripping. */
export async function financialFilterHook(
  req: FastifyRequest,
  _reply: unknown,
  payload: unknown,
): Promise<unknown> {
  if (process.env.NEXUS_RBAC_MODE !== 'enforce' && process.env.NEXUS_WORKSPACES_ENABLED !== '1') return payload
  // Reuse the perms the RBAC gate already resolved this request; absent
  // (no session / PUBLIC route) → no financial perms → strip everything.
  const resolved = req.__rbacResolved ?? NO_PERMS
  return filterFinancialPayload(payload, resolved)
}
