/**
 * A3.1 — optimistic concurrency (CAS) for ChannelListing writes.
 *
 * ChannelListing.version exists and the schema even documents the intent
 * ("clients send the version they read; server rejects with 409"), but the
 * cockpit + flat-file writes were last-write-wins. This is the shared primitive:
 * with an expectedVersion the update is keyed on (id, version) and bumps version,
 * so a concurrent write by another surface/operator is rejected (Prisma P2025)
 * instead of silently clobbered. Mirrors the proven Product W1.2 CAS.
 */

/** Thrown when the row moved on since the caller read it. Carries the current
 *  version so the route can 409 and the client can refresh + retry. */
export class ChannelListingVersionConflict extends Error {
  constructor(
    public readonly id: string,
    public readonly expectedVersion: number,
    public readonly currentVersion: number | null,
  ) {
    super(`ChannelListing ${id} version conflict (expected ${expectedVersion}, current ${currentVersion ?? 'unknown'})`)
    this.name = 'ChannelListingVersionConflict'
  }
}

export function isVersionConflict(e: unknown): e is ChannelListingVersionConflict {
  return e instanceof ChannelListingVersionConflict
}

/** Minimal prisma-ish surface so this works with both `prisma` and a `$transaction` tx. */
interface ChannelListingClient {
  channelListing: {
    update: (args: any) => Promise<any>
    findUnique: (args: any) => Promise<any>
  }
}

/**
 * Update a ChannelListing with optimistic concurrency.
 * - `expectedVersion` provided → CAS on (id, version); throws
 *   ChannelListingVersionConflict (with the current version) if the row moved.
 * - omitted → just bump version (back-compat for callers not yet threading it).
 * Always increments version so the next reader sees a fresh number.
 */
export async function casUpdateChannelListing(
  db: ChannelListingClient,
  id: string,
  expectedVersion: number | null | undefined,
  data: Record<string, any>,
): Promise<any> {
  if (expectedVersion === undefined || expectedVersion === null) {
    return db.channelListing.update({ where: { id }, data: { ...data, version: { increment: 1 } } })
  }
  try {
    return await db.channelListing.update({
      where: { id, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    })
  } catch (e: any) {
    if (e?.code === 'P2025') {
      const fresh = await db.channelListing
        .findUnique({ where: { id }, select: { version: true } })
        .catch(() => null)
      throw new ChannelListingVersionConflict(id, expectedVersion, fresh?.version ?? null)
    }
    throw e
  }
}
