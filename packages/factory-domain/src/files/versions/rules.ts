/**
 * File versions (COL-046, PLT-216; B-W2b-160 on the B-W2b-153 schema), pure. A new version of a file is a NEW StoredFile
 * row under a new storage key, so nothing in the store is ever overwritten:
 *
 *   series     the first version names no series (seriesId null, versionNo 1); every later one names the first one
 *              (seriesId = the first version's id) and takes the series' highest number plus one, never reused
 *   current    the version that is AVAILABLE and not superseded; at most one per series (the database checks it at commit)
 *   supersede  when a later version becomes AVAILABLE, every earlier version that is not DELETED and not superseded yet is
 *              superseded in the same command, whatever its status (one still held for its virus scan too, so a late
 *              CLEAN never makes two current); from then on it is read-only and still listed
 *   one at a time  no new version while a version of the series is still an announced upload (PENDING_UPLOAD)
 *   restore    an earlier AVAILABLE version comes back as a copy: the series' next version, the same bytes, naming the old
 *              version as its source
 *
 * A fiscal archive file has no later version (a correction is a new document). apps/factory-api's
 * platform/files/versions applies these rules before any write; the database's …_files_depth_w2b_guards hold them for
 * every login.
 */

export interface VersionedFile {
  readonly id: string
  readonly seriesId: string | null
  readonly versionNo: number
  readonly status: string
  readonly supersededAt: Date | string | null
  readonly kind: string
}

/** The series' first version: the id every version of the series names (or is). */
export const seriesRootOf = (file: Pick<VersionedFile, 'id' | 'seriesId'>): string => file.seriesId ?? file.id

/** AVAILABLE and not superseded: the version in force. */
export const isCurrentVersion = (file: Pick<VersionedFile, 'status' | 'supersededAt'>): boolean => file.status === 'AVAILABLE' && file.supersededAt === null

/** The number the next version of the series takes: the highest plus one (numbers are never reused, a deleted one too). */
export function nextVersionNo(series: readonly Pick<VersionedFile, 'versionNo'>[]): number {
  return series.reduce((highest, file) => Math.max(highest, file.versionNo), 0) + 1
}

/** The series' version still uploading (PENDING_UPLOAD), if any: no other version starts until it is confirmed or given up. */
export const uploadingVersionOf = (series: readonly VersionedFile[]): VersionedFile | null => series.find((file) => file.status === 'PENDING_UPLOAD') ?? null

/** Why the series takes no other version while one is still uploading, in words; null when none is. */
export function uploadingRefusal(series: readonly VersionedFile[]): string | null {
  const uploading = uploadingVersionOf(series)
  return uploading ? `Version ${uploading.versionNo} of this file is still uploading: confirm it or give it up first.` : null
}

/** Why no new version may be added to the series of `named` now, in words; null when it may. */
export function newVersionRefusal(named: VersionedFile, series: readonly VersionedFile[]): string | null {
  if (named.kind === 'FISCAL_ARCHIVE') return 'A fiscal archive file has no later version: a correction is a new document.'
  if (named.status === 'DELETED') return 'This file is deleted; add the new version to a version that is kept.'
  return uploadingRefusal(series)
}

/** Why `old` cannot be restored as the series' next version, in words; null when it can. */
export function restoreRefusal(old: VersionedFile, series: readonly VersionedFile[]): string | null {
  if (old.kind === 'FISCAL_ARCHIVE') return 'A fiscal archive file has no later version: a correction is a new document.'
  if (old.status !== 'AVAILABLE') return `This version is ${old.status}; only an available version is restored.`
  if (isCurrentVersion(old)) return 'This is already the current version.'
  return uploadingRefusal(series)
}

/**
 * The versions `file` supersedes when it becomes AVAILABLE: every earlier one (a lower number) that is not DELETED and not
 * superseded yet, whatever its status. A first version supersedes nothing.
 */
export function supersededBy<T extends VersionedFile>(file: Pick<VersionedFile, 'versionNo'>, series: readonly T[]): T[] {
  return series.filter((other) => other.versionNo < file.versionNo && other.status !== 'DELETED' && other.supersededAt === null)
}
