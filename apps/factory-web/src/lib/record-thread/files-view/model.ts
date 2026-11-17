import type { FileAudience, FileKind } from '../../../record-panels/model'
import { fileSeries, recordFiles, type FileOrigin, type FileSeries, type FilesParty, type ThreadFile } from '../files/model'

/**
 * B-TH-299 — the Files view (threads plan T9; features T9-F01…F06, F09, F10, F13): every file of ONE record (its POST /files
 * files) in a centred window up to 1160 px (a full-screen sheet on a phone): groups, versions, real multi-select with a
 * counted bulk bar, the upload with the system's kinds and an audience, retention, legal hold and quarantine read-only,
 * "Missing before Shipped" from the required-document rule. Tabs that do work or use their own file API keep their files
 * (R-1 to R-4): only the record's own files come here. The pure part; no React, no API.
 *
 * Not drawn until the back end has it: groups by origin (From the customer · Ours · Made by us · Floor) wait for the
 * file's origin (WALL-G13, B-TH-029) — until then the files group by the system's kinds; "Use on the quote / order /
 * style" (N8, B-TH-024); mark-up and expiry stay on the record's Files tab. B-TH-283 (N11, B-TH-083): the upload asks "This is a
 * measurement sheet" (a PDF or a photo; never for the floor); a sheet is locked for who may not open it, and marked for who may.
 *
 * Brand wall (W13, W25, W26): "Share with <customer>" shares with THIS record's party only (B-TH-003 refuses any other);
 * the Customer mark shows only on files shared with this party; another record's file is never listed.
 */

/** A group of the window: by origin when every file says where it came from, else by the system's kind. */
export type GroupKey = { readonly by: 'origin'; readonly origin: FileOrigin } | { readonly by: 'kind'; readonly kind: FileKind }

export interface FilesGroup {
  readonly key: string
  readonly group: GroupKey
  readonly series: readonly FileSeries[]
}

const ORIGINS: readonly FileOrigin[] = ['party', 'ours', 'made', 'floor']
const KINDS: readonly FileKind[] = ['PHOTO', 'DOCUMENT', 'CERTIFICATE', 'ATTACHMENT', 'AUDIO', 'FISCAL_ARCHIVE']

/** The record's documents in groups: by origin once the API says it for every file (WALL-G13), else by kind; empty groups hidden. */
export function filesGroups(files: readonly ThreadFile[], record: { readonly type: string; readonly id: string }): FilesGroup[] {
  const series = fileSeries(recordFiles(files, record))
  const byOrigin = series.length > 0 && series.every((one) => one.latest.origin)
  if (byOrigin) {
    return ORIGINS.map((origin) => ({ key: `origin:${origin}`, group: { by: 'origin' as const, origin }, series: series.filter((one) => one.latest.origin === origin) })).filter((group) => group.series.length > 0)
  }
  return KINDS.map((kind) => ({ key: `kind:${kind}`, group: { by: 'kind' as const, kind }, series: series.filter((one) => one.latest.kind === kind) })).filter((group) => group.series.length > 0)
}

/** What the person may do in the window (their rights over the record; the API checks every call again). */
export interface FilesAbilities {
  /** files.upload */
  readonly upload: boolean
  /** files.manage: change who sees a file (share with the record's party, office only). */
  readonly share: boolean
  /** files.delete */
  readonly delete: boolean
}

/** The bulk bar's actions, each with the files it reaches (only those it is allowed for: the button says the count). */
export interface BulkReach {
  readonly download: readonly string[]
  /** Shared with THIS record's party (B-TH-003); empty without a party or the right. */
  readonly share: readonly string[]
  readonly officeOnly: readonly string[]
  readonly remove: readonly string[]
  /** Chosen files a legal hold keeps (Delete refuses them, said in words). */
  readonly onHold: number
}

/** What each bulk action reaches among the chosen files (the files in force of the chosen documents). */
export function bulkReach(chosen: readonly ThreadFile[], party: FilesParty | null, can: FilesAbilities): BulkReach {
  // B-TH-231: a sheet locked for this reader is neither downloaded nor shared by them (they cannot open it).
  const available = chosen.filter((file) => file.status === 'AVAILABLE' && !file.locked)
  const sharedWithParty = (file: ThreadFile) => file.visibility.includes('PARTNER') && party !== null && file.partyId === party.id
  return {
    download: available.map((file) => file.id),
    share: can.share && party ? available.filter((file) => !sharedWithParty(file)).map((file) => file.id) : [],
    officeOnly: can.share ? chosen.filter((file) => file.visibility.some((audience) => audience !== 'OFFICE')).map((file) => file.id) : [],
    remove: can.delete ? chosen.filter((file) => !file.legalHold).map((file) => file.id) : [],
    onHold: can.delete ? chosen.filter((file) => file.legalHold).length : 0,
  }
}

/** A range for shift-click: the ids from the last clicked row to this one, in the window's order. */
export function rangeOf(order: readonly string[], from: string | null, to: string): string[] {
  const end = order.indexOf(to)
  const start = from === null ? -1 : order.indexOf(from)
  if (start < 0 || end < 0) return [to]
  const [low, high] = start <= end ? [start, end] : [end, start]
  return order.slice(low, high + 1)
}

/** The read-only lines of a file: held, legal hold, retention (kept until, due for removal). Keys of `record-thread-files-view`. */
export function keepLines(file: ThreadFile, now: number): { readonly key: string; readonly tone: 'neutral' | 'warning' | 'danger'; readonly params?: Readonly<Record<string, string | number>> }[] {
  const lines: { key: string; tone: 'neutral' | 'warning' | 'danger'; params?: Record<string, string | number> }[] = []
  if (file.status === 'QUARANTINED') lines.push({ key: file.quarantineReason === 'virus_found' ? 'keep.infected' : file.quarantineReason === 'scan_pending' ? 'keep.scanPending' : 'keep.held', tone: file.quarantineReason === 'virus_found' ? 'danger' : 'warning' })
  if (file.legalHold) lines.push({ key: 'keep.legalHold', tone: 'warning' })
  if (file.retainUntil) lines.push(Date.parse(file.retainUntil) < now ? { key: 'keep.due', tone: 'neutral' } : { key: 'keep.until', tone: 'neutral', params: { date: file.retainUntil } })
  return lines
}

/** A required document still missing before a status move (the required-document rule): WARN lets the move go, BLOCK refuses it. */
export interface MissingDocument {
  readonly id: string
  /** The document's name as the rule calls it ("Declaration of conformity"). */
  readonly document: string
  /** The status it is needed before ("Shipped"), in words. */
  readonly before: string
  readonly level: 'WARN' | 'BLOCK'
}

/** The upload being asked: the dropped files, then one kind and one audience for all of them (the audience starts on Office). */
export interface UploadAsk {
  readonly files: readonly { readonly name: string; readonly sizeBytes: number }[]
  readonly kind: FileKind
  readonly audience: 'OFFICE' | Exclude<FileAudience, 'OFFICE'>
  /** The kinds and audiences this record takes (record-panels' uploadChoices). */
  readonly kinds: readonly FileKind[]
  readonly audiences: readonly FileAudience[]
  /** B-TH-283 (B-TH-083): "This is a measurement sheet" — filed as body data (only holders of the measurements right open it). */
  readonly sheet?: boolean
}

/** B-TH-283: why the upload waits (a key of record-thread-files-view), or null: a measurement sheet never goes to the floor. */
export const uploadAskHeld = (ask: Pick<UploadAsk, 'sheet' | 'audience'>): string | null => (ask.sheet && ask.audience === 'FLOOR' ? 'upload.sheetFloor' : null)

export const START_AUDIENCE: FileAudience = 'OFFICE'
