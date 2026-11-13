import { toUtcIso } from '@nexus/factory-domain/core/time'
import { photosDeleteAfterFor } from '@nexus/factory-domain/sales/measure-link/rules'
import { MTM_PHOTO_CATEGORIES, type MtmPhotoCategory } from '@nexus/factory-domain/sales/mtm-photos/rules'
import { command, type CommandCaller } from '../../../../core/command'
import type { FilesRuntime } from '../../../../platform/files/service'
import type { Reader } from '../store'

/**
 * The made-to-measure office photos' delete dates (B-W2b-371, XF2:01; B-W2b-363's StoredFile.deleteAfter), looked after by
 * B-W2b-171's hourly cron `sales.measurementPhotos` (measure-link/retention.ts, its fourth pass), per tenant in its system scope:
 *
 *   1. the day: a photo without a delete date (MTM_PHOTO of a revision, FITTING_PHOTO of a fitting result) whose rider's garment
 *      shipped — an order line made to its revision, or to a later revision of the same rider and garment type, left in a SHIPPED
 *      or DELIVERED shipment — gets the first shipping day + 90 days (Owner answer 3 of W2b-3, as the body photos sent by link);
 *      measurement_photo.dated
 *   2. the deletion: a photo whose day came is DELETED (its object removed from the store, best effort; never while it is on legal
 *      hold or retained); measurement_photo.deleted per profile
 *
 * One command per pass and tenant, one audit row per file.
 */

const BATCH = 500
const SHIPPED = ['SHIPPED', 'DELIVERED'] as const
const FILE_COLUMNS = { id: true, companyId: true, status: true, recordType: true, recordId: true, category: true, storeAccountId: true, storageKey: true, thumbnailKey: true, retainUntil: true } as const
type FileRow = { id: string; companyId: string | null; status: string; recordType: string; recordId: string; category: string | null; storeAccountId: string; storageKey: string; thumbnailKey: string | null; retainUntil: Date | null }

/** The profile each photo is of (a revision's, or its fitting result's), with its customer. */
async function profilesOf(db: Reader, rows: readonly FileRow[]): Promise<Map<string, { id: string; partyId: string }>> {
  const resultIds = rows.filter((row) => row.category === 'FITTING_PHOTO').map((row) => row.recordId)
  const results = resultIds.length === 0 ? [] : await db.fittingResult.findMany({ where: { id: { in: resultIds } }, select: { id: true, measurementProfileId: true } })
  const profileIds = [...new Set([...rows.filter((row) => row.category === 'MTM_PHOTO').map((row) => row.recordId), ...results.map((row) => row.measurementProfileId)])]
  const profiles = profileIds.length === 0 ? [] : await db.measurementProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, partyId: true } })
  const byId = new Map(profiles.map((row) => [row.id, row]))
  const out = new Map<string, { id: string; partyId: string }>()
  for (const row of rows) {
    const profileId = row.category === 'MTM_PHOTO' ? row.recordId : results.find((result) => result.id === row.recordId)?.measurementProfileId
    const profile = profileId ? byId.get(profileId) : undefined
    if (profile) out.set(row.id, profile)
  }
  return out
}

/** The first day the rider's garment of this revision (or of a later one) shipped; null: not yet. */
async function shippedAt(db: Reader, profileId: string): Promise<Date | null> {
  const profile = await db.measurementProfile.findUnique({ where: { id: profileId }, select: { partyId: true, riderName: true, garmentType: true, revision: true } })
  if (!profile) return null
  const later = await db.measurementProfile.findMany({ where: { partyId: profile.partyId, riderName: profile.riderName, garmentType: profile.garmentType, revision: { gte: profile.revision } }, select: { id: true } })
  const lines = await db.salesOrderLine.findMany({ where: { measurementProfileId: { in: later.map((row) => row.id) } }, select: { id: true } })
  if (lines.length === 0) return null
  const shipped = await db.shipmentLine.findMany({ where: { salesOrderLineId: { in: lines.map((line) => line.id) }, shipment: { status: { in: [...SHIPPED] }, shippedAt: { not: null } } }, select: { shipment: { select: { shippedAt: true } } } })
  return shipped.map((row) => row.shipment.shippedAt!).sort((a, b) => a.getTime() - b.getTime())[0] ?? null
}

const photoWhere = { category: { in: [...MTM_PHOTO_CATEGORIES] } }

/** One tick for one tenant (the measurement photos cron calls it): the days set, the photos whose day came deleted. */
export async function lookAfterMtmPhotos(caller: CommandCaller, files: FilesRuntime | null, now: Date): Promise<{ scheduled: number; deleted: number }> {
  // 1. the day, once the garment shipped
  const due = await caller.withClient(async (db) => {
    const rows = await db.storedFile.findMany({ where: { ...photoWhere, deleteAfter: null, status: { not: 'DELETED' } }, select: FILE_COLUMNS, orderBy: { id: 'asc' }, take: BATCH })
    if (rows.length === 0) return []
    const profiles = await profilesOf(db, rows)
    const out: Array<{ row: FileRow; profile: { id: string; partyId: string }; day: Date }> = []
    const shippedOf = new Map<string, Date | null>()
    for (const row of rows) {
      const profile = profiles.get(row.id)
      if (!profile) continue
      if (!shippedOf.has(profile.id)) shippedOf.set(profile.id, await shippedAt(db, profile.id))
      const first = shippedOf.get(profile.id)
      if (!first) continue
      const day = photosDeleteAfterFor(first)
      // Never before the day it is kept until (B-W2b-363's rule): the later of the two.
      out.push({ row, profile, day: row.retainUntil && row.retainUntil.getTime() > day.getTime() ? row.retainUntil : day })
    }
    return out
  })
  if (due.length > 0) {
    await command(caller, { name: 'mtmPhotos.schedule', input: { at: toUtcIso(now), files: due.length } }, async ({ tx, audit, emit }) => {
      for (const { row, profile, day } of due) {
        const { count } = await tx.storedFile.updateMany({ where: { id: row.id, deleteAfter: null, status: { not: 'DELETED' } }, data: { deleteAfter: day } })
        if (count !== 1) continue
        audit({ recordType: 'StoredFile', recordId: row.id, companyId: row.companyId, before: { deleteAfter: null }, after: { deleteAfter: toUtcIso(day) }, reason: 'The garment shipped: the photo is deleted 90 days after.' })
        emit({ type: 'measurement_photo.dated', subject: row.id, companyId: row.companyId, payload: { profileId: profile.id, partyId: profile.partyId, fileId: row.id, category: row.category as MtmPhotoCategory, deleteAfter: toUtcIso(day) } })
      }
      return null
    })
  }

  // 2. the photos whose day came
  const expired = await caller.withClient(async (db) => {
    const rows = await db.storedFile.findMany({
      where: { ...photoWhere, deleteAfter: { lte: now }, status: { not: 'DELETED' }, legalHold: false, OR: [{ retainUntil: null }, { retainUntil: { lte: now } }] },
      select: FILE_COLUMNS,
      orderBy: { id: 'asc' },
      take: BATCH,
    })
    const profiles = rows.length === 0 ? new Map<string, { id: string; partyId: string }>() : await profilesOf(db, rows)
    return rows.flatMap((row) => {
      const profile = profiles.get(row.id)
      return profile ? [{ row, profile }] : []
    })
  })
  if (expired.length > 0) {
    await command(caller, { name: 'mtmPhotos.delete', input: { at: toUtcIso(now), files: expired.length } }, async ({ tx, audit, emit, now: at }) => {
      const perProfile = new Map<string, { partyId: string; companyId: string | null; files: number }>()
      for (const { row, profile } of expired) {
        await tx.storedFile.update({ where: { id: row.id }, data: { status: 'DELETED', deletedAt: at } })
        audit({ action: 'files.delete', recordType: 'StoredFile', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'DELETED' }, reason: 'Made-to-measure photo: its delete date came.' })
        const seen = perProfile.get(profile.id) ?? { partyId: profile.partyId, companyId: row.companyId, files: 0 }
        perProfile.set(profile.id, { ...seen, files: seen.files + 1 })
      }
      for (const [profileId, entry] of perProfile) emit({ type: 'measurement_photo.deleted', subject: profileId, companyId: entry.companyId, payload: { profileId, partyId: entry.partyId, files: entry.files } })
      return null
    })
    if (files) {
      for (const { row } of expired) {
        for (const key of [row.storageKey, row.thumbnailKey].filter((value): value is string => value !== null)) {
          // The row is DELETED: an object left behind is invisible, removed again by a later sweep.
          await files.storage.remove(caller, row.storeAccountId, { key, legalHold: false, retainUntil: row.retainUntil }, now).catch(() => undefined)
        }
      }
    }
  }
  return { scheduled: due.length, deleted: expired.length }
}
