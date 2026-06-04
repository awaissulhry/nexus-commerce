/**
 * FM.13 — mapping version history + rollback.
 *
 * recordMappingRevision snapshots the CURRENT Marketplace.schemaMapping
 * (pre-change) into a MappingRevision row. The pim-mapping PUT/DELETE
 * routes call it before each edit, so the history captures the state
 * before every change. rollbackMapping restores a snapshot — recording the
 * current state first, so the rollback is itself undoable. Capped to the
 * last MAX_REVISIONS per (channel, code).
 */

import prisma from '../../db.js'
import {
  getMappingForMarketplace,
  validateMapping,
  MarketplaceNotFoundError,
  type MarketplaceSchemaMapping,
} from './schema-mapping.service.js'

const MAX_REVISIONS = 30

/** Snapshot the current mapping into a new revision (pre-change). No-op if
 *  the marketplace doesn't exist. */
export async function recordMappingRevision(
  channel: string,
  code: string,
  opts: { changedBy?: string | null; reason?: string } = {},
): Promise<void> {
  let snapshot: MarketplaceSchemaMapping
  try {
    snapshot = await getMappingForMarketplace(channel, code)
  } catch (err) {
    if (err instanceof MarketplaceNotFoundError) return
    throw err
  }

  const last = await prisma.mappingRevision.findFirst({
    where: { channel, code },
    orderBy: { version: 'desc' },
    select: { version: true },
  })
  const version = (last?.version ?? 0) + 1

  await prisma.mappingRevision.create({
    data: {
      channel,
      code,
      version,
      snapshot: snapshot as unknown as object,
      changedBy: opts.changedBy ?? null,
      reason: opts.reason ?? null,
    },
  })

  // Cap: drop the oldest beyond MAX_REVISIONS.
  const count = await prisma.mappingRevision.count({ where: { channel, code } })
  if (count > MAX_REVISIONS) {
    const old = await prisma.mappingRevision.findMany({
      where: { channel, code },
      orderBy: { version: 'asc' },
      take: count - MAX_REVISIONS,
      select: { id: true },
    })
    await prisma.mappingRevision.deleteMany({ where: { id: { in: old.map((o) => o.id) } } })
  }
}

/** Recent revisions (metadata only — snapshots are fetched on rollback). */
export async function listMappingRevisions(channel: string, code: string) {
  return prisma.mappingRevision.findMany({
    where: { channel, code },
    orderBy: { version: 'desc' },
    take: 50,
    select: { id: true, version: true, changedBy: true, reason: true, createdAt: true },
  })
}

/** Restore a revision's snapshot to the live mapping. Records the current
 *  state first so the rollback can itself be undone. Returns the restored
 *  mapping. */
export async function rollbackMapping(
  channel: string,
  code: string,
  revisionId: string,
): Promise<MarketplaceSchemaMapping> {
  const rev = await prisma.mappingRevision.findUnique({ where: { id: revisionId } })
  if (!rev || rev.channel !== channel || rev.code !== code) {
    throw new Error('Revision not found for this marketplace')
  }
  const snapshot = rev.snapshot as unknown as MarketplaceSchemaMapping
  const errors = validateMapping(snapshot)
  if (errors.length > 0) {
    throw new Error(`Revision snapshot is invalid: ${errors.join('; ')}`)
  }

  // Snapshot the current state so the rollback is reversible.
  await recordMappingRevision(channel, code, { reason: `pre-rollback-to-v${rev.version}` })

  await prisma.marketplace.update({
    where: { channel_code: { channel, code } },
    data: { schemaMapping: snapshot as unknown as object },
  })
  return snapshot
}
