import prisma from '../../db.js'
import { requireWorkspace } from '@nexus/database/workspace-context'
import { whereCoordinate, type ListingCoordinate } from '../../lib/listing-coordinate.js'

export const PRESENCE_VERIFY_CALL_CAP = 10
export const PRESENCE_VERIFY_HOURLY_CAP = 60
const HOUR_MS = 60 * 60 * 1000
const channel = 'PRESENCE_READ'
const endpoint = 'presence/verify'
const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400, code: 'invalid_verify_request' })

export function parseVerifyRequest(body: unknown): { coordinates: ListingCoordinate[]; reason: string } {
  if (!body || typeof body !== 'object') throw invalid('Name the coordinates to verify and a reason.')
  const input = body as Record<string, unknown>
  if (!Array.isArray(input.coordinates) || !input.coordinates.length || input.coordinates.length > PRESENCE_VERIFY_CALL_CAP) {
    throw invalid(`Name between 1 and ${PRESENCE_VERIFY_CALL_CAP} distinct coordinates per call.`)
  }
  const coordinates = input.coordinates.map(value => whereCoordinate(value as ListingCoordinate))
  if (new Set(coordinates.map(value => JSON.stringify(value))).size !== coordinates.length) throw invalid('Duplicate coordinates are not allowed.')
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw invalid('reason is required.')
  return { coordinates, reason: input.reason.trim() }
}

/** Durable workspace-wide reservation, used by manual and queued channel reads alike. */
export async function reservePresenceReadBudget(attempts: number, now = new Date()): Promise<{ remaining: number; resetAt: string }> {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > PRESENCE_VERIFY_CALL_CAP) throw invalid(`Reserve between 1 and ${PRESENCE_VERIFY_CALL_CAP} channel attempts.`)
  const { workspaceId } = requireWorkspace()
  return prisma.$transaction(async tx => {
    // One lock per verified workspace, across every API/worker replica.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`presence-verify-budget:${workspaceId}`}, 0))`
    const active = await tx.rateLimitLog.findMany({ where: { workspaceId, channel, endpoint, resetAt: { gt: now } }, select: { requestCount: true, resetAt: true }, orderBy: { resetAt: 'asc' } })
    const used = active.reduce((total, row) => total + row.requestCount, 0)
    if (used + attempts > PRESENCE_VERIFY_HOURLY_CAP) {
      let needsRelease = used + attempts - PRESENCE_VERIFY_HOURLY_CAP
      let retryAt = new Date(now.getTime() + HOUR_MS)
      for (const row of active) {
        needsRelease -= row.requestCount
        if (needsRelease <= 0) { retryAt = row.resetAt; break }
      }
      const refusal = `At most ${PRESENCE_VERIFY_HOURLY_CAP} coordinates can be checked per hour for this business. Try again at ${retryAt.toISOString()}.`
      throw Object.assign(new Error(refusal), { statusCode: 429, code: 'presence_verify_rate_limit', refusal, retryAt: retryAt.toISOString(), retryAfter: Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000)) })
    }
    const resetAt = new Date(now.getTime() + HOUR_MS)
    await tx.rateLimitLog.upsert({
      where: { channel_endpoint_resetAt: { workspaceId, channel, endpoint, resetAt } },
      create: { workspaceId, channel, endpoint, resetAt, requestCount: attempts },
      update: { requestCount: { increment: attempts } },
    })
    return { remaining: PRESENCE_VERIFY_HOURLY_CAP - used - attempts, resetAt: resetAt.toISOString() }
  }, { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 15_000 })
}

/** Transaction lock spans the READ, so multiple replicas cannot overlap an Amazon account. */
export async function withAmazonPresenceReadLock<T>(accountId: string, read: () => Promise<T>): Promise<T> {
  if (!accountId.trim()) throw invalid('An attributed Amazon account is required for verification.')
  const { workspaceId } = requireWorkspace()
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('lock_timeout', '15000', true)`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`presence-amazon-read:${workspaceId}:${accountId}`}, 0))`
    return read()
  }, { maxWait: 10_000, timeout: 90_000 })
}
