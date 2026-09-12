import prisma from '../db.js'
import { checkPasswordStrength, hashPassword, verifyPassword } from '../lib/auth/password.js'

export async function changeUserPassword(userId: string, currentPassword: unknown, newPassword: unknown, confirmPassword: unknown): Promise<{ userId: string } | { status: 400 | 409; error: string }> {
  const user = await prisma.userProfile.findUnique({ where: { id: userId } })
  if (!user?.passwordHash || typeof currentPassword !== 'string' || currentPassword.length > 512 || !(await verifyPassword(currentPassword, user.passwordHash)).ok) return { status: 400, error: 'Current password is incorrect.' }
  if (typeof newPassword !== 'string' || newPassword !== confirmPassword) return { status: 400, error: 'Passwords do not match.' }
  const strength = checkPasswordStrength(newPassword, [user.email, user.displayName])
  if (!strength.ok) return { status: 400, error: strength.message }
  if ((await verifyPassword(newPassword, user.passwordHash)).ok) return { status: 400, error: 'Choose a different password.' }
  const changed = await prisma.userProfile.updateMany({ where: { id: user.id, passwordHash: user.passwordHash, status: 'active' }, data: { passwordHash: await hashPassword(newPassword) } })
  if (changed.count !== 1) return { status: 409, error: 'Your login changed. Sign in again before changing the password.' }
  return { userId: user.id }
}
