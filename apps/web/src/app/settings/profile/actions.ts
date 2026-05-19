'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'
import { createHash } from 'crypto'
import { writeSettingsAudit } from '@/lib/settings-audit'

// Simple hash for demo — in production use bcrypt
function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex')
}

const PROFILE_SNAPSHOT_FIELDS = ['displayName', 'email', 'avatarUrl'] as const

function profileSnapshot(
  row: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!row) return null
  const out: Record<string, unknown> = {}
  for (const k of PROFILE_SNAPSHOT_FIELDS) out[k] = row[k] ?? null
  return out
}

export async function saveProfile(formData: FormData) {
  const displayName = formData.get('displayName') as string || ''
  const avatarUrl = formData.get('avatarUrl') as string || ''

  const existing = await (prisma as any).userProfile.findFirst()

  if (existing) {
    await (prisma as any).userProfile.update({
      where: { id: existing.id },
      data: { displayName, avatarUrl },
    })
    await writeSettingsAudit({
      key: 'profile',
      action: 'update',
      before: profileSnapshot(existing),
      after: profileSnapshot({ ...existing, displayName, avatarUrl }),
    })
  } else {
    await (prisma as any).userProfile.create({
      data: { displayName, avatarUrl, email: '' },
    })
    await writeSettingsAudit({
      key: 'profile',
      action: 'create',
      before: null,
      after: { displayName, avatarUrl, email: '' },
    })
  }

  revalidatePath('/settings/profile')
  return { success: true }
}

export async function changePassword(formData: FormData) {
  const currentPassword = formData.get('currentPassword') as string || ''
  const newPassword = formData.get('newPassword') as string || ''
  const confirmPassword = formData.get('confirmPassword') as string || ''

  if (!newPassword || newPassword.length < 8) {
    return { success: false, error: 'Password must be at least 8 characters' }
  }

  if (newPassword !== confirmPassword) {
    return { success: false, error: 'Passwords do not match' }
  }

  const existing = await (prisma as any).userProfile.findFirst()

  if (existing && existing.passwordHash) {
    const currentHash = hashPassword(currentPassword)
    if (currentHash !== existing.passwordHash) {
      return { success: false, error: 'Current password is incorrect' }
    }
  }

  const newHash = hashPassword(newPassword)

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

  // Never log the hash itself. The audit row records the event,
  // not the credential — operators can see "you changed your
  // password at 14:03" without exposing the value.
  await writeSettingsAudit({
    key: 'profile.password',
    action: 'update',
    before: { passwordSet: !!existing?.passwordHash },
    after: { passwordSet: true },
    metadata: { event: 'password_changed' },
  })

  revalidatePath('/settings/profile')
  return { success: true }
}
