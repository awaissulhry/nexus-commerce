import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { photosDeleteAfterFor, UNSENT_PHOTO_DAYS } from '@nexus/factory-domain/sales/measure-link/rules'
import { callerFor, command, type CommandCaller } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { processFiles, type FilesRuntime } from '../../../platform/files/service'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { photosOf, PROFILE_RECORD, type Reader } from './store'

/**
 * The body photos' retention (B-W2b-171; SAL-286; Owner question 3 of W2b-3, the recommended answer: the photos are deleted
 * 90 days after the garment ships, the numbers stay in the profile). The scheduler's clustered cron
 * `sales.measurementPhotos` (hourly at minute 17), per ACTIVE tenant in its system scope, in three passes:
 *
 *   1. the day: a revision with photos and no deletion day whose garment shipped — an order line made to it, or to a later
 *      revision of the same rider and garment type, left in a SHIPPED or DELIVERED shipment — gets the first shipping day
 *      + 90 days (photosDeleteAfter; the office may set or move it: office.ts)
 *   2. the deletion: a revision whose day passed has its photo files DELETED (the objects removed from the store, best
 *      effort), its file ids kept; measurement_photos.deleted
 *   3. the leftovers: photos uploaded through a link and never sent (no revision, older than the longest link life + 7 days)
 *      and retakes the sent revision does not name, DELETED
 *
 * One command per pass and tenant, one audit row per profile or file. A tick that fails for a tenant is logged and tried
 * again at the next hour.
 */

export interface PhotoRetentionOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  /** The file store (tests); by default the process's. */
  readonly files?: FilesRuntime
}

const BATCH = 500
const SHIPPED = ['SHIPPED', 'DELIVERED'] as const
const FILE_COLUMNS = { id: true, companyId: true, status: true, storeAccountId: true, storageKey: true, thumbnailKey: true, retainUntil: true } as const
type FileRow = { id: string; companyId: string | null; status: string; storeAccountId: string; storageKey: string; thumbnailKey: string | null; retainUntil: Date | null }

/** The revisions with photos and no deletion day, with the day their garment first shipped (none: not yet). */
async function dueToSchedule(db: Reader): Promise<Array<{ id: string; deleteAfter: Date; shippedAt: Date }>> {
  const candidates = await db.measurementProfile.findMany({
    where: { photosDeleteAfter: null, OR: [{ photoFrontFileId: { not: null } }, { photoSideFileId: { not: null } }, { photoBackFileId: { not: null } }] },
    select: { id: true, partyId: true, riderName: true, garmentType: true, revision: true },
    orderBy: { id: 'asc' },
    take: BATCH,
  })
  const out: Array<{ id: string; deleteAfter: Date; shippedAt: Date }> = []
  for (const candidate of candidates) {
    const later = await db.measurementProfile.findMany({ where: { partyId: candidate.partyId, riderName: candidate.riderName, garmentType: candidate.garmentType, revision: { gte: candidate.revision } }, select: { id: true } })
    const lines = await db.salesOrderLine.findMany({ where: { measurementProfileId: { in: later.map((row) => row.id) } }, select: { id: true } })
    if (lines.length === 0) continue
    const shipped = await db.shipmentLine.findMany({
      where: { salesOrderLineId: { in: lines.map((line) => line.id) }, shipment: { status: { in: [...SHIPPED] }, shippedAt: { not: null } } },
      select: { shipment: { select: { shippedAt: true } } },
    })
    const first = shipped.map((row) => row.shipment.shippedAt!).sort((a, b) => a.getTime() - b.getTime())[0]
    if (first) out.push({ id: candidate.id, deleteAfter: photosDeleteAfterFor(first), shippedAt: first })
  }
  return out
}

async function removeObjects(files: FilesRuntime | null, caller: CommandCaller, rows: readonly FileRow[], now: Date): Promise<void> {
  if (!files) return
  for (const row of rows) {
    for (const key of [row.storageKey, row.thumbnailKey].filter((value): value is string => value !== null)) {
      // The row is DELETED: an object left behind is invisible, removed again by a later sweep.
      await files.storage.remove(caller, row.storeAccountId, { key, legalHold: false, retainUntil: row.retainUntil }, now).catch(() => undefined)
    }
  }
}

const deletable = (now: Date) => ({ status: { not: 'DELETED' as const }, legalHold: false, OR: [{ retainUntil: null }, { retainUntil: { lte: now } }] })

/** One tick over every active tenant (the cron's; tests call it directly). */
export async function runPhotoRetention(options: PhotoRetentionOptions): Promise<{ scheduled: number; deleted: number; leftovers: number }> {
  const now = (options.clock ?? serverClock).now()
  const requestId = `measurement-photos-${newId()}`
  let files: FilesRuntime | null = options.files ?? null
  if (!files) {
    try {
      files = processFiles()
    } catch {
      files = null
    }
  }
  const totals = { scheduled: 0, deleted: 0, leftovers: 0 }
  for (const tenantId of await activeTenants(options.database)) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    try {
      // 1. the day the photos go, once the garment shipped
      const due = await caller.withClient((client) => dueToSchedule(client))
      if (due.length > 0) {
        await command(caller, { name: 'measureLink.schedulePhotos', input: { at: toUtcIso(now), profiles: due.length } }, async ({ tx, audit }) => {
          for (const row of due) {
            const { count } = await tx.measurementProfile.updateMany({ where: { id: row.id, photosDeleteAfter: null }, data: { photosDeleteAfter: row.deleteAfter } })
            if (count === 1) audit({ recordType: PROFILE_RECORD, recordId: row.id, companyId: null, before: { photosDeleteAfter: null }, after: { photosDeleteAfter: toUtcIso(row.deleteAfter), shippedAt: toUtcIso(row.shippedAt) } })
          }
          return null
        })
        totals.scheduled += due.length
      }

      // 2. the photos whose day passed
      const expired = await caller.withClient(async (client) => {
        const profiles = await client.measurementProfile.findMany({ where: { photosDeleteAfter: { lte: now } }, select: { id: true, partyId: true, photoFrontFileId: true, photoSideFileId: true, photoBackFileId: true }, orderBy: { id: 'asc' }, take: BATCH })
        const ids = profiles.flatMap((profile) => photosOf(profile).map((photo) => photo.fileId))
        const rows = ids.length > 0 ? await client.storedFile.findMany({ where: { id: { in: ids }, ...deletable(now) }, select: FILE_COLUMNS }) : []
        return profiles.map((profile) => ({ profile, files: rows.filter((row) => photosOf(profile).some((photo) => photo.fileId === row.id)) })).filter((entry) => entry.files.length > 0)
      })
      if (expired.length > 0) {
        await command(caller, { name: 'measureLink.deletePhotos', input: { at: toUtcIso(now), profiles: expired.length } }, async ({ tx, audit, emit, now: at }) => {
          for (const { profile, files: rows } of expired) {
            for (const row of rows) {
              await tx.storedFile.update({ where: { id: row.id }, data: { status: 'DELETED', deletedAt: at } })
              audit({ action: 'files.delete', recordType: 'StoredFile', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'DELETED' }, reason: 'Body photo retention ended (measurements by link).' })
            }
            emit({ type: 'measurement_photos.deleted', subject: profile.id, companyId: rows[0]!.companyId, payload: { profileId: profile.id, partyId: profile.partyId, files: rows.length } })
          }
          return null
        })
        await removeObjects(files, caller, expired.flatMap((entry) => entry.files), now)
        totals.deleted += expired.reduce((sum, entry) => sum + entry.files.length, 0)
      }

      // 3. photos never sent (no revision after the longest link life) and retakes the sent revision does not name
      const leftovers = await caller.withClient(async (client) => {
        const rows = await client.storedFile.findMany({ where: { recordType: PROFILE_RECORD, category: 'BODY_PHOTO', ...deletable(now) }, select: { ...FILE_COLUMNS, recordId: true, createdAt: true }, orderBy: { id: 'asc' }, take: BATCH * 4 })
        if (rows.length === 0) return []
        const profiles = await client.measurementProfile.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.recordId))] } }, select: { id: true, submittedViaLinkId: true, photoFrontFileId: true, photoSideFileId: true, photoBackFileId: true } })
        const unsentBefore = now.getTime() - UNSENT_PHOTO_DAYS * 86_400_000
        return rows.filter((row) => {
          const profile = profiles.find((entry) => entry.id === row.recordId)
          if (!profile) return row.createdAt.getTime() < unsentBefore
          // Only a revision sent by link drops what it does not name (an office revision's files are the office's).
          return profile.submittedViaLinkId !== null && !photosOf(profile).some((photo) => photo.fileId === row.id)
        })
      })
      if (leftovers.length > 0) {
        await command(caller, { name: 'measureLink.deleteLeftoverPhotos', input: { at: toUtcIso(now), files: leftovers.length } }, async ({ tx, audit, now: at }) => {
          for (const row of leftovers) {
            await tx.storedFile.update({ where: { id: row.id }, data: { status: 'DELETED', deletedAt: at } })
            audit({ action: 'files.delete', recordType: 'StoredFile', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'DELETED' }, reason: 'A body photo never sent with measurements (or taken again).' })
          }
          return null
        })
        await removeObjects(files, caller, leftovers, now)
        totals.leftovers += leftovers.length
      }
    } catch (error) {
      options.log.error({ err: error, tenantId }, 'the body photos of a tenant could not be looked after')
    }
  }
  if (totals.scheduled + totals.deleted + totals.leftovers > 0) options.log.info(totals, 'body photos looked after')
  return totals
}

/** The scheduler's cron: every hour at minute 17. */
export function measurementPhotosCron(options: PhotoRetentionOptions): CronJob {
  return defineCron({
    name: 'sales.measurementPhotos',
    schedule: '17 * * * *',
    lockTtlMs: 600_000,
    async run() {
      await runPhotoRetention(options)
    },
  })
}
