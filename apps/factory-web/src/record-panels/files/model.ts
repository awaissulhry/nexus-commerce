import type { PhotoMark } from '@nexus/ui/components/PhotoCapture/index'
import { DOCUMENT_CATEGORIES } from '@nexus/factory-domain/files/required/rules'
import { expiryDateProblem } from '@nexus/factory-domain/files/expiry/rules'
import type { PanelFile } from '../model'

/**
 * The files panel in depth (B-W2b-177; design shell.panels › Files, pop:file-versions, admin.documents › Required
 * documents "feeds the record frame's GuardList"; COL-048, COL-049, COL-055, COL-046), pure: what each document is and
 * until when, what each status move still needs, the Versions pop-up's rows and its side-by-side, the document dialog's
 * draft, the markup dialog. The container (use-file-depth.ts) reads and writes the API; the views draw this model.
 * Words are message keys of the `record-files` catalogue.
 */

export const CATEGORY_CHOICES = DOCUMENT_CATEGORIES

export type Read<T> = { readonly status: 'loading' } | { readonly status: 'failed'; readonly problem: string } | { readonly status: 'ready'; readonly value: T }

export type ExpiryState = 'NONE' | 'VALID' | 'EXPIRING' | 'EXPIRED'

/** What one file is and until when (GET /files/documents). */
export interface DocumentInfo {
  readonly fileId: string
  readonly name: string
  readonly category: string | null
  readonly expiresOn: string | null
  readonly expiryState: ExpiryState
  readonly daysLeft: number | null
  readonly ofParty: boolean
}

export interface RequirementView {
  readonly ruleId: string
  readonly category: string
  readonly level: 'BLOCK' | 'WARN'
  readonly reason: 'MET' | 'MISSING' | 'EXPIRED'
  readonly fileId: string | null
  readonly expiresOn: string | null
}

export interface MoveView {
  readonly toStatus: string
  readonly requirements: readonly RequirementView[]
}

export interface DocumentsState {
  readonly today: string
  readonly recordStatus: string | null
  readonly byFile: Readonly<Record<string, DocumentInfo>>
  /** The party's documents that count for this record (a supplier's certificate on its purchase order). */
  readonly partyDocuments: readonly DocumentInfo[]
  readonly moves: readonly MoveView[]
  readonly mayTag: boolean
}

/** One row of the Versions pop-up. */
export interface VersionRow {
  readonly id: string
  readonly versionNo: number
  readonly current: boolean
  readonly status: string
  readonly name: string
  readonly sizeBytes: number
  readonly addedAt: string
  /** Null: the system (a copy, a document Nexus made). */
  readonly addedBy: string | null
  readonly fromPartner: boolean
  readonly madeByMarkup: { readonly note: string | null; readonly marks: number } | null
  readonly usedBy: readonly { readonly label: string | null; readonly typeKey: string; readonly href: string }[]
  readonly markups: number
  readonly picture: boolean
  /** Why this version cannot be restored now (a message key), or null. */
  readonly restoreHeld: string | null
}

export interface ComparePicture {
  readonly versionNo: number
  readonly src: string
}

export interface VersionsDialog {
  readonly fileId: string
  readonly name: string
  readonly read: Read<readonly VersionRow[]>
  /** The two versions picked for side by side (ids), at most two. */
  readonly picked: readonly string[]
  readonly compare: Read<readonly [ComparePicture, ComparePicture]> | null
  readonly busy: boolean
  readonly problem: string | null
}

export interface TagDialog {
  readonly fileId: string
  readonly name: string
  readonly category: string | null
  /** As typed (YYYY-MM-DD), '' for none. */
  readonly expiresOn: string
  readonly busy: boolean
  readonly problem: string | null
}

export interface MarkupItem {
  readonly id: string
  readonly page: number | null
  readonly versionNo: number | null
  readonly note: string | null
  readonly by: string | null
  readonly fromPartner: boolean
  readonly at: string
  readonly marks: readonly PhotoMark[]
  readonly madeVersion: boolean
}

export interface MarkupDialog {
  readonly fileId: string
  readonly name: string
  readonly target: 'picture' | 'pdf'
  readonly page: number
  /** A PDF's page count once it is open. */
  readonly pages: number | null
  /** The picture or the PDF page to draw on (made in the browser, never sent anywhere), or a problem. */
  readonly image: Read<{ readonly src: string; readonly width: number; readonly height: number }>
  readonly note: string
  readonly markups: Read<readonly MarkupItem[]>
  readonly busy: boolean
  readonly problem: string | null
}

export interface FileDepthModel {
  readonly documents: Read<DocumentsState>
  /** files.upload on the record (marking up, restoring, saying what a file is). */
  readonly canUpload: boolean
  readonly versions: VersionsDialog | null
  readonly tag: TagDialog | null
  readonly markup: MarkupDialog | null
  /** What a depth action did (a message key of `record-files`), or null. */
  readonly notice: { readonly key: string; readonly tone: 'success' | 'warning' | 'danger' } | null
}

// ---- grouping by series (B-W2b-160: a version names its series' first version) ---------------------------------------

export interface SeriesGroup {
  readonly key: string
  readonly latest: PanelFile
  readonly earlier: readonly PanelFile[]
}

const nameKey = (file: PanelFile) => `${file.kind}:${file.name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()}`

/**
 * The record's files as the panel lists them: a series (its versions, the newest number on top) once the API names it,
 * else W0's rule (same kind and name). Deleted files are left out.
 */
export function seriesGroups(files: readonly PanelFile[]): SeriesGroup[] {
  const groups = new Map<string, PanelFile[]>()
  for (const file of files) {
    if (file.status === 'DELETED') continue
    const key = file.versionNo !== undefined ? `series:${file.seriesId ?? file.id}` : nameKey(file)
    groups.set(key, [...(groups.get(key) ?? []), file])
  }
  const newest = (a: PanelFile, b: PanelFile) => (b.versionNo ?? 0) - (a.versionNo ?? 0) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
  return [...groups.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort(newest)
      return { key, latest: sorted[0]!, earlier: sorted.slice(1) }
    })
    .sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt) || b.latest.id.localeCompare(a.latest.id))
}

// ---- documents ---------------------------------------------------------------------------------------------------------

/** The expiry tag of a file: its words, tone and params; null when it has no date. */
export function expiryTag(info: DocumentInfo | undefined): { readonly key: string; readonly tone: 'neutral' | 'warning' | 'danger'; readonly params: Record<string, string | number> } | null {
  if (!info || info.expiresOn === null) return null
  if (info.expiryState === 'EXPIRED') return { key: 'expiry.expired', tone: 'danger', params: { date: info.expiresOn } }
  if (info.expiryState === 'EXPIRING') return { key: info.daysLeft === 0 ? 'expiry.today' : 'expiry.soon', tone: 'warning', params: { date: info.expiresOn, count: info.daysLeft ?? 0 } }
  return { key: 'expiry.valid', tone: 'neutral', params: { date: info.expiresOn } }
}

/** A move's state: what blocks it, what only warns, all met. */
export function moveState(move: MoveView): { readonly blocks: number; readonly warnings: number } {
  const open = move.requirements.filter((requirement) => requirement.reason !== 'MET')
  return { blocks: open.filter((requirement) => requirement.level === 'BLOCK').length, warnings: open.filter((requirement) => requirement.level === 'WARN').length }
}

/** The tone of one requirement's row. */
export const requirementTone = (requirement: RequirementView): 'success' | 'warning' | 'danger' => (requirement.reason === 'MET' ? 'success' : requirement.level === 'BLOCK' ? 'danger' : 'warning')

/** The moves that still need something, the ones that block first; all met: none. */
export function openMoves(moves: readonly MoveView[]): MoveView[] {
  return moves.filter((move) => moveState(move).blocks + moveState(move).warnings > 0).sort((a, b) => moveState(b).blocks - moveState(a).blocks)
}

// ---- what a file may do here (held with the reason) ------------------------------------------------------------------

const PICTURES = ['image/jpeg', 'image/png', 'image/webp']
export const isPicture = (contentType: string): boolean => PICTURES.includes(contentType.toLowerCase())
export const markTargetOf = (contentType: string): 'picture' | 'pdf' | null => (contentType.toLowerCase() === 'application/pdf' ? 'pdf' : isPicture(contentType) ? 'picture' : null)
const isCurrent = (file: PanelFile) => file.status === 'AVAILABLE' && (file.supersededAt ?? null) === null

/** Why Mark up is held for this file (a message key), or null. */
export function markupHeld(file: PanelFile, canUpload: boolean): string | null {
  if (!canUpload) return 'depth.held.noUpload'
  if (markTargetOf(file.contentType) === null) return 'depth.held.notMarkable'
  if (!isCurrent(file)) return 'depth.held.notCurrent'
  return null
}

/** Why "What it is" is held for this file, or null. */
export function tagHeld(file: PanelFile, documents: Read<DocumentsState>): string | null {
  if (documents.status !== 'ready') return documents.status === 'loading' ? 'depth.held.reading' : 'depth.held.unreadable'
  if (!documents.value.mayTag) return 'depth.held.noUpload'
  if (!isCurrent(file)) return 'depth.held.notCurrent'
  if (file.version === undefined) return 'depth.held.reading'
  return null
}

/** Why Restore is held for a version row, or null. */
export function restoreHeld(row: Pick<VersionRow, 'current' | 'status'>, canUpload: boolean, uploading: boolean): string | null {
  if (!canUpload) return 'depth.held.noUpload'
  if (row.current) return 'versions.held.current'
  if (row.status !== 'AVAILABLE') return 'versions.held.notAvailable'
  if (uploading) return 'versions.held.uploading'
  return null
}

/** Why Side by side is held, or null: two pictures picked. */
export function compareHeld(rows: readonly VersionRow[], picked: readonly string[]): string | null {
  const chosen = rows.filter((row) => picked.includes(row.id))
  if (chosen.length !== 2) return 'versions.held.pickTwo'
  if (!chosen.every((row) => row.picture)) return 'versions.held.pictures'
  return null
}

/** The picked list after a tick: at most two, the newest tick replacing the older one. */
export function pick(picked: readonly string[], id: string, on: boolean): string[] {
  if (!on) return picked.filter((value) => value !== id)
  return [...picked.filter((value) => value !== id), id].slice(-2)
}

/** What is wrong with the document dialog's draft (a message key), or null. */
export function tagProblem(draft: Pick<TagDialog, 'category' | 'expiresOn'>, today: string): string | null {
  if (draft.expiresOn !== '' && expiryDateProblem(draft.expiresOn, today) !== null) return 'tag.problem.date'
  if (draft.category !== null && !(CATEGORY_CHOICES as readonly string[]).includes(draft.category)) return 'tag.problem.category'
  return null
}

/** The PUT body: only what changed against what the file says now. */
export function tagBody(draft: Pick<TagDialog, 'category' | 'expiresOn'>, before: DocumentInfo | undefined): { category?: string | null; expiresOn?: string | null } {
  const expiresOn = draft.expiresOn === '' ? null : draft.expiresOn
  return {
    ...(draft.category !== (before?.category ?? null) ? { category: draft.category } : {}),
    ...(expiresOn !== (before?.expiresOn ?? null) ? { expiresOn } : {}),
  }
}

/** Why Save is held in the markup dialog (a message key), or null: something drawn. */
export const markupSaveHeld = (marks: readonly PhotoMark[]): string | null => (marks.length === 0 ? 'markup.held.noMarks' : null)
