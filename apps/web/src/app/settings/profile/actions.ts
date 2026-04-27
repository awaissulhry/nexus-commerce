'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'
import { createHash } from 'crypto'

// Simple hash for demo — in production use bcrypt
function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex')
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
  } else {
    await (prisma as any).userProfile.create({
      data: { displayName, avatarUrl, email: '' },
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

  revalidatePath('/settings/profile')
  return { success: true }
}
