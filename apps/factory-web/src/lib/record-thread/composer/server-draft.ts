import type { DraftAudience, DraftFile } from '../attachments/model'
import type { Recipient } from '../send-check/model'
import type { ComposerDraft, ComposerMode, DraftLink, NumberSwap } from './model'

/**
 * B-TH-287 — the composer's draft on the server (threads plan TH-9, N6 on B-TH-092; T5-F10, T8-F07 "Drafts kept"): ONE draft per
 * person and record, kept until it is sent (the send's own command clears it) or discarded, so the person finds what they typed on
 * another computer — "Draft saved 10:42" in words. The pure part: what a save sends (the box's mode, words, the reply's subject and
 * To / Cc, the files with their audience), what a draft read back puts in the box (every visit still starts safe: a portal message
 * comes back as an office note, a reply only to whoever may still send it), which of the device copy and the server's is newer, and
 * the line's words. No React, no API.
 *
 * Brand wall (W08, W37): a draft is its writer's own — the API takes the person from the session, never from what is sent; nothing
 * here names a person or a party.
 */

/** What the box holds that a draft keeps (the office container's work without its outbox). */
export interface DraftParts {
  readonly draft: ComposerDraft
  readonly to: readonly Recipient[]
  readonly cc: readonly Recipient[]
  readonly subject: string
  readonly files: readonly DraftFile[]
}

/** What one save sends (PUT …/draft, without the version). */
export interface DraftSave {
  readonly audience: 'OFFICE' | 'PARTNER'
  readonly body: string
  readonly fields: Record<string, unknown>
  readonly attachments: readonly string[]
}

/** The files a draft keeps: those that went up (a file still uploading or refused is not kept; the tray says so). */
const keptFiles = (files: readonly DraftFile[]): DraftFile[] => files.filter((file) => file.phase === 'done' && typeof file.fileId === 'string')

/** Something worth keeping: words, or a file that went up. */
export const worthKeeping = (parts: Pick<DraftParts, 'draft' | 'files'>): boolean => parts.draft.body.trim() !== '' || keptFiles(parts.files).length > 0

/** The save for what the box holds, or null when there is nothing to keep (an empty box: the server's draft is discarded). */
export function draftToSave(parts: DraftParts): DraftSave | null {
  if (!worthKeeping(parts)) return null
  const files = keptFiles(parts.files)
  const fields: Record<string, unknown> = { mode: parts.draft.mode }
  if (parts.draft.forFloor) fields.forFloor = true
  if (parts.draft.mode === 'reply') {
    if (parts.subject.trim() !== '') fields.subject = parts.subject
    if (parts.to.length > 0) fields.to = parts.to.map((item) => item.address)
    if (parts.cc.length > 0) fields.cc = parts.cc.map((item) => item.address)
  }
  if (parts.draft.link) fields.link = { kind: parts.draft.link.kind, messageId: parts.draft.link.messageId, who: parts.draft.link.who, at: parts.draft.link.at, ...(parts.draft.link.way ? { way: parts.draft.link.way } : {}) }
  if (files.length > 0) fields.fileAudiences = Object.fromEntries(files.map((file) => [file.fileId as string, file.audience]))
  // th-backend-g step 1 (§0.5): the office numbers a saved reply put in a note go with the draft, so a later switch to the customer
  // still swaps them for the customer's own (a restored draft never sends an office number to a customer).
  if (parts.draft.numbers && parts.draft.numbers.length > 0) fields.numbers = parts.draft.numbers.map((pair) => ({ office: pair.office, customer: pair.customer }))
  return { audience: parts.draft.mode === 'note' ? 'OFFICE' : 'PARTNER', body: parts.draft.body, fields, attachments: files.map((file) => file.fileId as string) }
}

/** A draft as the API answers it (GET …/draft). */
export interface ServerDraftIn {
  readonly audience: 'OFFICE' | 'PARTNER' | null
  readonly body: string
  readonly fields: Readonly<Record<string, unknown>>
  readonly attachments: readonly { readonly id: string; readonly originalName: string; readonly contentType: string; readonly sizeBytes: number; readonly status: string; readonly locked?: 'MEASUREMENTS' | undefined }[]
  readonly savedAt: string
  readonly version: number
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const addresses = (value: unknown): Recipient[] =>
  Array.isArray(value) ? value.flatMap((item) => (typeof item === 'string' && item.trim() !== '' ? [{ address: item.trim().toLowerCase(), name: null, kind: null, organisation: null } satisfies Recipient] : [])) : []

/** The number pairs kept with a draft (th-backend-g step 1), each an office number and the customer's own (or null). */
function numbersOf(value: unknown): NumberSwap[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const pair = item as Record<string, unknown>
    return typeof pair.office === 'string' && pair.office !== '' && (typeof pair.customer === 'string' || pair.customer === null) ? [{ office: pair.office, customer: pair.customer as string | null }] : []
  })
}

function linkOf(value: unknown): DraftLink | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const link = value as Record<string, unknown>
  if ((link.kind !== 'reply' && link.kind !== 'correct') || typeof link.messageId !== 'string' || typeof link.at !== 'string') return undefined
  const way = link.way === 'note' || link.way === 'reply' || link.way === 'portal' ? (link.way as ComposerMode) : undefined
  return { kind: link.kind, messageId: link.messageId, who: typeof link.who === 'string' ? link.who : null, at: link.at, ...(way ? { way } : {}) }
}

/**
 * What a draft read back puts in the box. The mode is safe by default (P3): an office note stays one; a reply comes back as a reply
 * only to whoever may still send mail to the record's customer (else an office note, the words kept); a message for the portal comes
 * back as an office note (as the device copy does: the box starts there) — nothing reaches a customer without the person choosing it.
 * Files: those the person may still open, with the audience they had (a sheet locked for them, or a file gone, is left out).
 */
export function draftFromServer(server: ServerDraftIn, can: { readonly reply: boolean }): DraftParts & { readonly mode: ComposerMode } {
  const saved = text(server.fields.mode)
  const mode: ComposerMode = server.audience === 'PARTNER' && saved === 'reply' && can.reply ? 'reply' : 'note'
  const link = linkOf(server.fields.link)
  // A link that goes another way than the box now does is let go (a correction keeps the way of the message it corrects).
  const keptLink = link && !(link.kind === 'correct' && link.way && link.way !== mode) ? link : undefined
  const audiences = (typeof server.fields.fileAudiences === 'object' && server.fields.fileAudiences !== null ? server.fields.fileAudiences : {}) as Record<string, unknown>
  const files: DraftFile[] = server.attachments
    .filter((file) => file.status === 'AVAILABLE' && !file.locked)
    .map((file) => ({
      key: `draft-${file.id}`,
      name: file.originalName,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
      source: 'record',
      phase: 'done',
      fileId: file.id,
      audience: (audiences[file.id] === 'PARTY' ? 'PARTY' : 'OFFICE') as DraftAudience,
    }))
  const numbers = numbersOf(server.fields.numbers)
  return {
    mode,
    draft: { mode, body: server.body, forFloor: mode === 'note' && server.fields.forFloor === true, ...(keptLink ? { link: keptLink } : {}), ...(numbers.length > 0 ? { numbers } : {}) },
    to: mode === 'reply' ? addresses(server.fields.to) : [],
    cc: mode === 'reply' ? addresses(server.fields.cc) : [],
    subject: mode === 'reply' ? text(server.fields.subject) : '',
    files,
  }
}

/** Which copy the box takes on arrival: the newer of the device's (ms) and the server's (ISO); null when there is neither. */
export function newerCopy(local: { readonly savedAt: number } | null, server: { readonly savedAt: string } | null): 'local' | 'server' | null {
  if (!server) return local ? 'local' : null
  if (!local) return 'server'
  return local.savedAt > Date.parse(server.savedAt) ? 'local' : 'server'
}

/** How long typing must stop before the draft is saved (and on leaving the page at once). */
export const DRAFT_SAVE_MS = 2000

/**
 * The line under the box: "Draft saved 10:42" (the server has it), "Saving the draft…", "Not saved · Retry" (the text stays on this
 * device), "You are offline; your text stays on this device", and — two tabs, the newest wins — "A newer draft from another tab or
 * computer was replaced". Keys of record-thread-helpers `draft.*`.
 */
export type DraftSaved =
  | { readonly state: 'saving' }
  | { readonly state: 'saved'; readonly at: string }
  | { readonly state: 'replaced'; readonly at: string }
  | { readonly state: 'failed' }
  | { readonly state: 'offline' }

export const savedKey = (saved: DraftSaved): string =>
  saved.state === 'saved' ? 'draft.saved' : saved.state === 'replaced' ? 'draft.replaced' : saved.state === 'saving' ? 'draft.saving' : saved.state === 'failed' ? 'draft.failed' : 'draft.offline'
