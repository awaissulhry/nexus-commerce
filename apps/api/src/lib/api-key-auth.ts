/**
 * Phase G — API key authorisation.
 *
 * Single source of truth for:
 *   1. The canonical scope registry — every scope a key can hold,
 *      with a human label + description for the UI.
 *   2. verifyApiKey() — the check downstream Fastify routes call
 *      when they want to gate an endpoint on a key. Honours scope,
 *      IP allowlist, expiry, revocation, and the rotation grace
 *      window.
 *   3. cidrMatch() — minimal CIDR check supporting plain-IP and
 *      /<n> notation for both IPv4 and IPv6. Sufficient for the
 *      key allowlist; we don't need full BGP-grade range math here.
 *
 * Phase G itself does NOT wire verifyApiKey into every route. That's
 * a follow-up sweep — schema + UI + helper land here so the next
 * sweep is "import + call" rather than "design + ship".
 */

import bcrypt from 'bcryptjs'
import { createHash, timingSafeEqual } from 'crypto'
import prisma from '../db.js'

/**
 * Phase G — legacy-aware hash comparator.
 * Pre-Phase-G keys were hashed with raw SHA-256 hex by
 * apps/web/src/app/settings/api-keys/actions.ts. Phase G's create
 * flow switches to bcrypt; the verifier detects format and routes
 * accordingly. Bcrypt hashes start with "$2"; SHA-256 hex is 64
 * lowercase hex characters.
 */
async function compareRawToStoredHash(
  rawKey: string,
  storedHash: string,
): Promise<boolean> {
  if (!storedHash) return false
  if (storedHash.startsWith('$2')) {
    return bcrypt.compare(rawKey, storedHash).catch(() => false)
  }
  // Legacy SHA-256 path. Constant-time compare to avoid timing
  // attacks against the prefix-matched candidate set.
  const hex = createHash('sha256').update(rawKey).digest('hex')
  if (hex.length !== storedHash.length) return false
  try {
    return timingSafeEqual(Buffer.from(hex), Buffer.from(storedHash))
  } catch {
    return false
  }
}

// ─── Canonical scope registry ────────────────────────────────────
//
// Add a new scope here + nowhere else. The /settings/api-keys UI
// imports the same registry (via a duplicate apps/web/src/lib
// file — kept byte-identical the same way the Phase D fiscal
// validators are) so the user can't pick a scope the server
// doesn't know about.

export interface ScopeDef {
  /** Canonical key, lower-case, colon-separated. */
  value: string
  /** Short label for chips + dropdowns. */
  label: string
  /** One-line description for the create form. */
  description: string
  /** Group label so the UI can render related scopes together. */
  group: 'Catalog' | 'Sales' | 'Operations' | 'Analytics' | 'Admin'
}

export const CANONICAL_SCOPES: readonly ScopeDef[] = [
  {
    value: 'products:read',
    label: 'Read products',
    description: 'List + read product master data.',
    group: 'Catalog',
  },
  {
    value: 'products:write',
    label: 'Write products',
    description: 'Create, update, soft-delete products.',
    group: 'Catalog',
  },
  {
    value: 'listings:read',
    label: 'Read listings',
    description: 'View channel listings + coverage + sync status.',
    group: 'Catalog',
  },
  {
    value: 'listings:write',
    label: 'Write listings',
    description: 'Publish + edit channel listings, trigger syncs.',
    group: 'Catalog',
  },
  {
    value: 'orders:read',
    label: 'Read orders',
    description: 'List orders + line items + customer fields.',
    group: 'Sales',
  },
  {
    value: 'orders:write',
    label: 'Write orders',
    description: 'Fulfill, refund, edit orders.',
    group: 'Sales',
  },
  {
    value: 'stock:read',
    label: 'Read stock',
    description: 'Stock levels, lots, bins, replenishment forecasts.',
    group: 'Operations',
  },
  {
    value: 'stock:write',
    label: 'Write stock',
    description:
      'Adjust stock, create POs + receipts, lot tracking writes.',
    group: 'Operations',
  },
  {
    value: 'analytics:read',
    label: 'Read analytics',
    description: 'Reports, dashboards, profit + ad-spend rollups.',
    group: 'Analytics',
  },
  {
    value: 'admin',
    label: 'Admin',
    description:
      'Super-scope — implies every other scope. Use sparingly; rotate often.',
    group: 'Admin',
  },
] as const

const VALID_SCOPES = new Set(CANONICAL_SCOPES.map((s) => s.value))

export function isValidScope(s: string): boolean {
  return VALID_SCOPES.has(s)
}

// ─── CIDR matching (minimal) ─────────────────────────────────────
// Accepts:
//   '203.0.113.5'         — exact IPv4 match
//   '203.0.113.0/24'      — IPv4 range
//   '2001:db8::1'         — exact IPv6 match
//   '2001:db8::/32'       — IPv6 range
// Anything else returns false. Public-facing error UI distinguishes
// "malformed entry" so the operator can fix the typo on save.

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    out = (out << 8) + n
  }
  // Force unsigned 32-bit
  return out >>> 0
}

function ipv6ToBytes(addr: string): Uint8Array | null {
  // Expand ::, then split into 8 groups of 16 bits.
  const [head, tail] = addr.split('::')
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  if (tail === undefined) {
    if (headParts.length !== 8) return null
  } else if (headParts.length + tailParts.length > 7) {
    return null
  }
  const missing = 8 - headParts.length - tailParts.length
  const allParts = [
    ...headParts,
    ...Array(missing).fill('0'),
    ...tailParts,
  ]
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const n = parseInt(allParts[i], 16)
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null
    out[i * 2] = (n >> 8) & 0xff
    out[i * 2 + 1] = n & 0xff
  }
  return out
}

export function cidrMatch(allowEntry: string, candidate: string): boolean {
  const entry = allowEntry.trim()
  if (entry.length === 0) return false
  if (!entry.includes('/')) {
    return entry === candidate
  }
  const [prefix, bitsStr] = entry.split('/')
  const bits = Number(bitsStr)
  if (!Number.isInteger(bits) || bits < 0) return false
  // IPv4 path
  if (prefix.includes('.')) {
    if (bits > 32) return false
    const p = ipv4ToInt(prefix)
    const c = ipv4ToInt(candidate)
    if (p === null || c === null) return false
    if (bits === 0) return true
    const mask = (0xffffffff << (32 - bits)) >>> 0
    return (p & mask) === (c & mask)
  }
  // IPv6 path
  if (bits > 128) return false
  const p = ipv6ToBytes(prefix)
  const c = ipv6ToBytes(candidate)
  if (!p || !c) return false
  const fullBytes = Math.floor(bits / 8)
  for (let i = 0; i < fullBytes; i++) {
    if (p[i] !== c[i]) return false
  }
  const remainingBits = bits - fullBytes * 8
  if (remainingBits === 0) return true
  const mask = (0xff << (8 - remainingBits)) & 0xff
  return (p[fullBytes] & mask) === (c[fullBytes] & mask)
}

function ipAllowed(allowlist: string[], requestIp: string): boolean {
  if (allowlist.length === 0) return true // empty = any
  return allowlist.some((entry) => cidrMatch(entry, requestIp))
}

// ─── Verifier ────────────────────────────────────────────────────

export type VerifyResult =
  | {
      ok: true
      keyId: string
      label: string
      scopes: string[]
    }
  | { ok: false; code: 'missing' | 'malformed' | 'unknown' | 'revoked' | 'expired' | 'rotated' | 'scope_denied' | 'ip_denied'; message: string }

interface VerifyInput {
  /** The raw key from `Authorization: Bearer nxk_…`. */
  rawKey: string
  /** Required scope OR `null` to skip scope check. */
  requiredScope: string | null
  /** Request origin IP. From request.ip on Fastify. */
  requestIp: string
}

/**
 * Validate an API key end-to-end.
 *
 * Side-effect: bumps lastUsed on success. We do NOT bump on failure
 * so brute-force attempts don't reveal "this key id exists" via the
 * lastUsed timestamp.
 *
 * The verifier locates the row by keyPrefix (the first 12 chars of
 * `nxk_<24-hex>` → "nxk_<8 hex>"), then bcrypt-compares the rest.
 * Prefix is non-secret + indexed; doing the lookup by hash would
 * require scanning the whole table.
 */
export async function verifyApiKey(
  input: VerifyInput,
): Promise<VerifyResult> {
  const raw = (input.rawKey ?? '').trim()
  if (!raw) {
    return { ok: false, code: 'missing', message: 'No API key provided.' }
  }
  if (!/^nxk_[a-f0-9]{16,}$/i.test(raw)) {
    return {
      ok: false,
      code: 'malformed',
      message: 'API key must start with "nxk_" followed by hex characters.',
    }
  }
  const prefix = raw.slice(0, 12) + '…'
  const rows = await (prisma as any).apiKey.findMany({
    where: { keyPrefix: prefix },
    select: {
      id: true,
      label: true,
      keyHash: true,
      scopes: true,
      ipAllowlist: true,
      expiresAt: true,
      revokedAt: true,
      rotatedAt: true,
      rotatedToId: true,
      rotationGraceUntil: true,
    },
  })
  // Multiple rows can share the same prefix (collision is rare but
  // possible with 8 hex chars). Iterate and bcrypt-check each.
  for (const row of rows) {
    const match = await compareRawToStoredHash(raw, row.keyHash)
    if (!match) continue
    // We found the row. Now run the gate checks.
    if (row.revokedAt) {
      return {
        ok: false,
        code: 'revoked',
        message: 'This API key was revoked.',
      }
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      return {
        ok: false,
        code: 'expired',
        message: `This API key expired on ${row.expiresAt.toISOString().slice(0, 10)}.`,
      }
    }
    if (row.rotatedAt) {
      const graceEnd = row.rotationGraceUntil?.getTime() ?? 0
      if (graceEnd <= Date.now()) {
        return {
          ok: false,
          code: 'rotated',
          message:
            'This API key was rotated and is past its grace window. Use the new key.',
        }
      }
      // Within grace — still allowed, but downstream might want to
      // warn. We could attach a Warning header in middleware that
      // calls verifyApiKey; left to the caller.
    }
    if (!ipAllowed(row.ipAllowlist ?? [], input.requestIp)) {
      return {
        ok: false,
        code: 'ip_denied',
        message: `Request IP ${input.requestIp} is not in this key's allowlist.`,
      }
    }
    if (input.requiredScope) {
      const scopes: string[] = row.scopes ?? []
      // Empty scopes[] = legacy "full access" — grandfathered for
      // back-compat. Anything else requires the exact scope or
      // the 'admin' super-scope.
      const ok =
        scopes.length === 0 ||
        scopes.includes('admin') ||
        scopes.includes(input.requiredScope)
      if (!ok) {
        return {
          ok: false,
          code: 'scope_denied',
          message: `This key does not have the "${input.requiredScope}" scope.`,
        }
      }
    }
    // Successful match — update lastUsed without awaiting; the
    // request shouldn't wait on this side-effect.
    void (prisma as any).apiKey
      .update({ where: { id: row.id }, data: { lastUsed: new Date() } })
      .catch(() => undefined)
    return {
      ok: true,
      keyId: row.id,
      label: row.label,
      scopes: row.scopes ?? [],
    }
  }
  return {
    ok: false,
    code: 'unknown',
    message: 'API key not recognised.',
  }
}
