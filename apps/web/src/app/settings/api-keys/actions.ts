'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'
import { randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'
import { writeSettingsAudit } from '@/lib/settings-audit'
import { SCOPE_VALUES } from '@/lib/api-key-scopes'

// Phase G — bcrypt for new keys (cost 10 keeps verify-on-every-
// request cheap enough). Legacy SHA-256 keys keep working — see
// apps/api/src/lib/api-key-auth.ts for the dual-format verifier.
const BCRYPT_COST = 10

interface CreateInput {
  label: string
  scopes: string[]
  ipAllowlist: string[]
  /** Days from now until expiry, or null for "never". */
  expiresInDays: number | null
}

function sanitiseList(arr: unknown): string[] {
  if (!Array.isArray(arr)) return []
  return Array.from(
    new Set(
      arr
        .filter((v): v is string => typeof v === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  )
}

// Minimal IP-or-CIDR shape check — mirrors the format the server
// verifier accepts. Bad entries get rejected at save time so the
// operator notices before issuing the key.
function looksLikeIpOrCidr(entry: string): boolean {
  // IPv4 plain
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(entry)) return true
  // IPv4 CIDR
  if (/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(entry)) return true
  // IPv6 (very loose — accepts anything with colons; the server
  // does the real parse and rejects malformed values).
  if (entry.includes(':')) return true
  return false
}

export async function generateApiKey(input: CreateInput) {
  const label = input.label.trim()
  if (label.length === 0 || label.length > 80) {
    return { success: false as const, error: 'Label must be 1–80 characters.' }
  }
  const scopes = sanitiseList(input.scopes).filter((s) => SCOPE_VALUES.has(s))
  // Bad scopes get silently dropped above — but if the caller asked
  // for something we don't know AND it was the only entry, surface
  // the error so they can correct the typo.
  if (input.scopes.length > 0 && scopes.length === 0) {
    return {
      success: false as const,
      error: 'No recognised scope in the selection.',
    }
  }
  const ipAllowlist = sanitiseList(input.ipAllowlist)
  const badIps = ipAllowlist.filter((e) => !looksLikeIpOrCidr(e))
  if (badIps.length > 0) {
    return {
      success: false as const,
      error: `IP allowlist contains malformed entries: ${badIps.join(', ')}`,
    }
  }
  const expiresAt =
    input.expiresInDays && input.expiresInDays > 0
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null

  // Generate the raw key. Format: nxk_<48 hex chars>. Prefix shown
  // in the UI is the first 12 chars (nxk_ + 8 hex) + ellipsis.
  const rawKey = `nxk_${randomBytes(24).toString('hex')}`
  const keyHash = await bcrypt.hash(rawKey, BCRYPT_COST)
  const keyPrefix = rawKey.substring(0, 12) + '…'

  const created = await (prisma as any).apiKey.create({
    data: {
      label,
      keyHash,
      keyPrefix,
      scopes,
      ipAllowlist,
      expiresAt,
    },
  })

  await writeSettingsAudit({
    key: 'api-keys',
    action: 'create',
    before: null,
    after: {
      id: created.id,
      label,
      keyPrefix,
      scopes,
      ipAllowlist,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
    metadata: { event: 'key_generated' },
  })

  revalidatePath('/settings/api-keys')
  // Raw key returned exactly once.
  return { success: true as const, rawKey }
}

export async function revokeApiKey(keyId: string) {
  const before = await (prisma as any).apiKey.findUnique({ where: { id: keyId } })
  await (prisma as any).apiKey.update({
    where: { id: keyId },
    data: { revokedAt: new Date() },
  })
  if (before) {
    await writeSettingsAudit({
      key: 'api-keys',
      action: 'update',
      before: {
        id: before.id,
        label: before.label,
        keyPrefix: before.keyPrefix,
        revokedAt: before.revokedAt,
      },
      after: {
        id: before.id,
        label: before.label,
        keyPrefix: before.keyPrefix,
        revokedAt: new Date(),
      },
      metadata: { event: 'key_revoked' },
    })
  }
  revalidatePath('/settings/api-keys')
  return { success: true as const }
}

export async function deleteApiKey(keyId: string) {
  const before = await (prisma as any).apiKey.findUnique({ where: { id: keyId } })
  await (prisma as any).apiKey.delete({ where: { id: keyId } })
  if (before) {
    await writeSettingsAudit({
      key: 'api-keys',
      action: 'delete',
      before: {
        id: before.id,
        label: before.label,
        keyPrefix: before.keyPrefix,
      },
      after: null,
      metadata: { event: 'key_deleted' },
    })
  }
  revalidatePath('/settings/api-keys')
  return { success: true as const }
}

/**
 * Phase G — rotation. Issues a NEW key with the same scopes + IP
 * allowlist + expiry as the source. The OLD key gets rotatedAt +
 * rotatedToId + rotationGraceUntil set; it keeps validating until
 * the grace ends (default 24h), at which point the verifier
 * rejects it with code='rotated'.
 *
 * The grace window matters: integrations need a few minutes-to-
 * hours to roll the new key through deploys. Twenty-four hours is
 * a conservative default; the operator can pick a different
 * window when the safety case allows.
 */
export async function rotateApiKey(input: {
  keyId: string
  graceHours: number
}) {
  const source = await (prisma as any).apiKey.findUnique({
    where: { id: input.keyId },
  })
  if (!source) {
    return { success: false as const, error: 'Key not found.' }
  }
  if (source.revokedAt) {
    return {
      success: false as const,
      error: 'Cannot rotate a revoked key. Create a new one instead.',
    }
  }
  if (source.rotatedAt) {
    return {
      success: false as const,
      error: 'This key was already rotated.',
    }
  }
  const grace = Math.max(0, Math.min(168, input.graceHours)) // cap 7 days
  const rawKey = `nxk_${randomBytes(24).toString('hex')}`
  const keyHash = await bcrypt.hash(rawKey, BCRYPT_COST)
  const keyPrefix = rawKey.substring(0, 12) + '…'

  const replacement = await prisma.$transaction(async (tx: any) => {
    const r = await tx.apiKey.create({
      data: {
        label: source.label + ' (rotated)',
        keyHash,
        keyPrefix,
        scopes: source.scopes ?? [],
        ipAllowlist: source.ipAllowlist ?? [],
        expiresAt: source.expiresAt,
      },
    })
    await tx.apiKey.update({
      where: { id: source.id },
      data: {
        rotatedAt: new Date(),
        rotatedToId: r.id,
        rotationGraceUntil:
          grace === 0
            ? new Date() // immediate cutover
            : new Date(Date.now() + grace * 60 * 60 * 1000),
      },
    })
    return r
  })

  await writeSettingsAudit({
    key: 'api-keys',
    action: 'create',
    before: null,
    after: {
      id: replacement.id,
      label: replacement.label,
      keyPrefix,
      rotatedFromId: source.id,
      graceHours: grace,
    },
    metadata: { event: 'key_rotated' },
  })

  revalidatePath('/settings/api-keys')
  return { success: true as const, rawKey, replacementId: replacement.id }
}
