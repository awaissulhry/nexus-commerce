/** Sheet publish parity, step 4 — display names for the user ids of history runs, in one read. */
import prisma from '../../../db.js'

/** Display names for user ids, in one read. */
export async function userNames(ids: Array<string | null | undefined>): Promise<Map<string, string | null>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))]
  if (!wanted.length) return new Map()
  const users = await prisma.userProfile.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(users.map(user => [user.id, user.displayName.trim() || null]))
}
