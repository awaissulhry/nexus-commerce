import type { Issue } from '../core/errors'
import { payByLinkProblem } from './pay'

/**
 * A link's set of files (COL-051 "a share of several files", MES-274 the secure file; links-depth.prisma LinkFile). A
 * DOCUMENT_VIEW or SECURE_FILE link of a StoredFile lists its files in order; the link's record is the first one. The set
 * is chosen when the link is made and never changes (the link's evidence names what was shared). A newer version of a
 * shared file is NAMED on the page from its series ("Version 4 replaced this one on 12 Nov"), never swapped in silently:
 * the person still gets what was sent, and learns that it is not the latest.
 *
 *   each file   AVAILABLE, of the link's company (or tenant-wide), not deleted, and never one of a record with pay figures
 *               (links/pay); a file once in the set.
 *   at most     LINK_FILES_MAX files.
 */

export const LINK_FILES_MAX = 20

export interface CandidateFile {
  readonly id: string
  readonly companyId: string | null
  readonly status: string
  readonly recordType: string
  readonly originalName: string
  /** For a file of a PayrollExport: one of the export's values has an amount. */
  readonly payrollCarriesPay?: boolean
}

/**
 * What stops these files from going on one link of `companyId`, as issues at `fileIds/<i>` (the order the office gave);
 * a missing file (one the caller cannot see either) is named too. Empty: they may go.
 */
export function fileSetProblems(fileIds: readonly string[], found: ReadonlyMap<string, CandidateFile>, companyId: string): Issue[] {
  const issues: Issue[] = []
  if (fileIds.length === 0) issues.push({ path: 'fileIds', message: 'Choose at least one file.' })
  if (fileIds.length > LINK_FILES_MAX) issues.push({ path: 'fileIds', message: `A link shares at most ${LINK_FILES_MAX} files.` })
  const seen = new Set<string>()
  fileIds.forEach((fileId, index) => {
    const path = `fileIds/${index}`
    if (seen.has(fileId)) return issues.push({ path, message: 'This file is in the list twice.' })
    seen.add(fileId)
    const file = found.get(fileId)
    if (!file) return issues.push({ path, message: 'File not found.' })
    if (file.status !== 'AVAILABLE') return issues.push({ path, message: `"${file.originalName}" is ${file.status.toLowerCase()}: only an available file can be shared.` })
    if (file.companyId !== null && file.companyId !== companyId) return issues.push({ path, message: `"${file.originalName}" belongs to another company.` })
    const pay = payByLinkProblem({ recordType: file.recordType, payrollCarriesPay: file.payrollCarriesPay, fileName: file.originalName })
    if (pay) return issues.push({ path, message: pay })
    return undefined
  })
  return issues
}

export interface VersionFacts {
  readonly id: string
  readonly versionNo: number
  readonly status: string
  readonly supersededAt: Date | null
}

export interface NewerVersion {
  /** The current version's number, when the series has one now. */
  readonly versionNo: number | null
  /** When a later version replaced the shared one. */
  readonly replacedAt: Date
  /** The current version is on this link too (its file id), so the page can point at it. */
  readonly sharedFileId: string | null
}

/**
 * The newer version of a shared file, or null when it is still the current one. `series` is every version of its series
 * (files/versions seriesOf); `shared` the file ids of this link.
 */
export function newerVersionOf(file: VersionFacts, series: readonly VersionFacts[], shared: ReadonlySet<string>): NewerVersion | null {
  if (file.supersededAt === null) return null
  const current = series.find((version) => version.status === 'AVAILABLE' && version.supersededAt === null && version.id !== file.id) ?? null
  return { versionNo: current?.versionNo ?? null, replacedAt: file.supersededAt, sharedFileId: current && shared.has(current.id) ? current.id : null }
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Rome' })

/** The banner's words (English; the page has its own catalogue): "Version 4 replaced this one on 12 Nov 2026." */
export function newerVersionWords(newer: NewerVersion): string {
  const when = DAY.format(newer.replacedAt)
  const which = newer.versionNo === null ? 'A newer version' : `Version ${newer.versionNo}`
  return `${which} replaced this one on ${when}.${newer.sharedFileId ? ' It is in this list too.' : ' Ask the sender for it.'}`
}
