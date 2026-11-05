import type { Prisma } from '@nexus/factory-db'
import { isCurrentVersion, supersededBy } from '@nexus/factory-domain/files/versions/rules'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTools } from '../../../core/command'

/**
 * Superseding (COL-046, PLT-216; B-W2b-160), INSIDE the command that makes a version AVAILABLE — the confirm of an
 * upload (files.ts completeUpload), a clean scan (scan/scan.ts), a large upload's completion (multipart/) or a restore
 * (versions/restore.ts): every earlier version of the series that is not DELETED and not superseded yet gets
 * `supersededAt`, whatever its status (one still held for its scan too, so a late CLEAN never makes two current). The
 * database refuses superseding before a later version is AVAILABLE, and refuses at commit a series with two current
 * versions, so this runs after the version's own update, in the same transaction. One audit row per superseded version.
 */

export const VERSION_SELECT = {
  id: true,
  seriesId: true,
  versionNo: true,
  status: true,
  supersededAt: true,
  kind: true,
  companyId: true,
} as const satisfies Prisma.StoredFileSelect

export type VersionRow = Prisma.StoredFileGetPayload<{ select: typeof VERSION_SELECT }>

/** Every version of a series, the first one first (deleted ones too: their numbers are never reused). */
export async function seriesOf(client: Pick<Prisma.TransactionClient, 'storedFile'>, root: string): Promise<VersionRow[]> {
  return client.storedFile.findMany({ where: { OR: [{ id: root }, { seriesId: root }] }, select: VERSION_SELECT, orderBy: { versionNo: 'asc' } })
}

/** Supersedes what the AVAILABLE version `fileId` replaces; returns the ids it superseded. A first version replaces nothing. */
export async function supersedeEarlierVersions(tools: Pick<CommandTools, 'tx' | 'audit' | 'now'>, fileId: string): Promise<string[]> {
  const file = await tools.tx.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: VERSION_SELECT })
  if (file.seriesId === null || file.status !== 'AVAILABLE') return []
  const earlier = supersededBy(file, await seriesOf(tools.tx, file.seriesId))
  for (const old of earlier) {
    await tools.tx.storedFile.update({ where: { id: old.id }, data: { supersededAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      action: 'files.supersedeVersion',
      recordType: 'StoredFile',
      recordId: old.id,
      companyId: old.companyId,
      before: { versionNo: old.versionNo, status: old.status, current: isCurrentVersion(old) },
      after: { supersededAt: toUtcIso(tools.now), byFileId: file.id, byVersionNo: file.versionNo },
    })
  }
  return earlier.map((old) => old.id)
}

/** A superseded version's new sharing only narrows its old one: no new audience, no other floor site or party. */
export function sharingNarrows(
  before: { readonly visibility: readonly string[]; readonly floorSiteId: string | null; readonly partyId: string | null },
  after: { readonly visibility: readonly string[]; readonly floorSiteId: string | null; readonly partyId: string | null },
): boolean {
  return (
    after.visibility.every((audience) => before.visibility.includes(audience)) &&
    (after.floorSiteId === null || after.floorSiteId === before.floorSiteId) &&
    (after.partyId === null || after.partyId === before.partyId)
  )
}
