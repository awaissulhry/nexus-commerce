'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'
import { createHash, timingSafeEqual } from 'crypto'
import bcrypt from 'bcryptjs'
import { writeSettingsAudit } from '@/lib/settings-audit'

// Phase C — bcrypt hashes (current). Legacy rows had raw sha256
// hex; the verifier detects format and re-hashes opportunistically
// on the next successful changePassword.
function isBcryptHash(s: string): boolean {
  return typeof s === 'string' && s.startsWith('$2')
}

async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!stored) return false
  if (isBcryptHash(stored)) {
    return bcrypt.compare(plain, stored)
  }
  // Legacy sha256 path.
  const hex = createHash('sha256').update(plain).digest('hex')
  if (hex.length !== stored.length) return false
  try {
    return timingSafeEqual(Buffer.from(hex), Buffer.from(stored))
  } catch {
    return false
  }
}

const SNAPSHOT_FIELDS = [
  'displayName',
  'email',
  'avatarUrl',
  'phone',
  'timezone',
  'language',
  'dateFormat',
  'weekStart',
  'workingHoursStart',
  'workingHoursEnd',
] as const

function snapshot(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null
  const out: Record<string, unknown> = {}
  for (const k of SNAPSHOT_FIELDS) out[k] = row[k] ?? null
  return out
}

interface ProfileInput {
  displayName: string
  avatarUrl: string
  phone: string
  timezone: string
  language: string
  dateFormat: string
  weekStart: number | null
  workingHoursStart: string
  workingHoursEnd: string
}

/**
 * Phase C — single save action for the whole profile form (Identity +
 * Locale + Working hours). Email is not editable from here (see the
 * inline note in the UI); password is its own action.
 */
export async function saveProfile(input: ProfileInput) {
  // Light validation. Anything malformed becomes null rather than
  // throwing — the form is a friendly UX, not an API surface.
  const data: Record<string, unknown> = {
    displayName: input.displayName.trim(),
    avatarUrl: input.avatarUrl.trim() || '',
    phone: input.phone.trim() || null,
    timezone: input.timezone.trim() || null,
    language: input.language.trim() || null,
    dateFormat: input.dateFormat.trim() || null,
    weekStart:
      input.weekStart === null || input.weekStart === undefined
        ? null
        : Math.max(0, Math.min(6, Math.floor(input.weekStart))),
    workingHoursStart: input.workingHoursStart.trim() || null,
    workingHoursEnd: input.workingHoursEnd.trim() || null,
  }

  const existing = await (prisma as any).userProfile.findFirst()
  let next: any
  if (existing) {
    next = await (prisma as any).userProfile.update({
      where: { id: existing.id },
      data,
    })
  } else {
    next = await (prisma as any).userProfile.create({
      data: { ...data, email: '' },
    })
  }
  await writeSettingsAudit({
    key: 'profile',
    action: existing ? 'update' : 'create',
    before: snapshot(existing),
    after: snapshot(next),
  })

  revalidatePath('/settings/profile')
  return { success: true as const }
}

export async function changePassword(input: {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}) {
  const { currentPassword, newPassword, confirmPassword } = input
  if (!newPassword || newPassword.length < 8) {
    return { success: false as const, error: 'Password must be at least 8 characters' }
  }
  if (newPassword !== confirmPassword) {
    return { success: false as const, error: 'Passwords do not match' }
  }
  // Reject if identical to the current one — common foot-gun where
  // the user "rotates" the same password.
  const existing = await (prisma as any).userProfile.findFirst()
  if (existing?.passwordHash) {
    const sameAsCurrent = await verifyPassword(newPassword, existing.passwordHash)
    if (sameAsCurrent) {
      return {
        success: false as const,
        error: 'New password must differ from your current password.',
      }
    }
    if (!(await verifyPassword(currentPassword, existing.passwordHash))) {
      return { success: false as const, error: 'Current password is incorrect' }
    }
  }

  // Phase C — bcrypt cost 12 = ~250ms on modern hardware. High
  // enough to make brute-force unattractive without slowing legit
  // login to a crawl.
  const newHash = await bcrypt.hash(newPassword, 12)

  if (existing) {
    await (prisma as any).userProfile.update({
      where: { id: existing.id },
      data: { passwordHash: newHash },
    })
  } else {
    await (prisma as any).userProfile.create({
      data: { displayName: '', email: '', passwordHash: newHash },
    })
  }

  await writeSettingsAudit({
    key: 'profile.password',
    action: 'update',
    before: { passwordSet: !!existing?.passwordHash, algorithm: existing?.passwordHash ? (isBcryptHash(existing.passwordHash) ? 'bcrypt' : 'sha256') : null },
    after: { passwordSet: true, algorithm: 'bcrypt' },
    metadata: {
      event: 'password_changed',
      // Surface the upgrade explicitly so an operator inspecting the
      // audit trail sees the hash migration happened.
      ...(existing?.passwordHash && !isBcryptHash(existing.passwordHash)
        ? { upgradedFrom: 'sha256' }
        : {}),
    },
  })

  revalidatePath('/settings/profile')
  return { success: true as const }
}
