import { FAILURE_CODES, HAND_BACK_ACTIONS, type HandBackAction } from '@nexus/factory-domain/plant/jobs/close'
import type { ProgressStep } from '@nexus/factory-domain/plant/requests/progress'
import type { Locale } from '../../../lib/i18n/locales'
import type { FloorRequest, HandBackBody, JobRecord, MachineAfter, QueueEntry, StoredMedia, Symptom } from './api'
import { afterHeld, WORDS_MAX } from './model'

/**
 * The W2b parts of the machine problem (B-W2b-102 on the API of B-W2b-96; design floor.machine "Optional photo or voice
 * note" QHS-189, "Progress" QHS-180, "Close on one screen" QHS-190) — the screen's rules, pure:
 *
 *   photo or voice note   taken on the tablet with the report (kept in this page only, never in the queue: the queue has
 *                         no bytes), sent once the office has recorded the report and named its request; a request under
 *                         way takes more later; held offline with the reason (a picture needs the network)
 *   progress              what the reporter sees: reported → acknowledged → on the way → fixed → works again, steps that
 *                         never happened left out; "It works" held with the reason until it may be said (never while the
 *                         machine is locked: Owner answer H1); the line lead's confirmation once the job is handed back
 *   the technician        the site's open requests (to me first), acknowledge and on the way
 *   one-screen close      the action tile, the failure code tile, the minutes (the API's, from Start), the machine after
 *                         (running preselected unless the machine is locked), before and after photos
 *
 * Nothing here names a person or holds money.
 */

// ---- photos and voice notes (QHS-189) -----------------------------------------------------------------------------------

/** The most photos and voice notes the tablet takes with one report (the floor notes' limit, B-W2b-47). */
export const MEDIA_MAX = 4
/** The longest voice note, in seconds (the API takes 10 MiB of audio; a minute of speech is far less). */
export const VOICE_SECONDS = 60

export type MediaKind = 'PHOTO' | 'AUDIO'

/** A photo or voice note taken on this tablet, not sent yet: in this page's memory only. */
export interface TakenMedia {
  readonly id: string
  readonly kind: MediaKind
  readonly blob: Blob
  readonly name: string
}

/** What this browser records a voice note as, in order of preference (the API's AUDIO types); null: it cannot. */
export function voiceTypeOf(supported: (type: string) => boolean): string | null {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'].find(supported) ?? null
}

const AUDIO_EXTENSION: Readonly<Record<string, string>> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac', 'audio/wav': 'wav' }

/** The file's name as the office sees it: the machine's tag (or job number), what it is and its place in the list. */
export function mediaName(kind: MediaKind, base: string, index: number, contentType: string): string {
  const type = contentType.split(';')[0]!.trim()
  return kind === 'PHOTO' ? `${base}-photo-${index}.jpg` : `${base}-voice-${index}.${AUDIO_EXTENSION[type] ?? 'webm'}`
}

/** Why the tablet takes no photo or voice note now (a `floor-machine` key), or null. */
export function mediaHeld(input: { readonly online: boolean; readonly count: number; readonly busy?: boolean }): string | null {
  if (!input.online) return 'held.mediaOffline'
  if (input.count >= MEDIA_MAX) return 'held.mediaFull'
  if (input.busy) return 'held.busy'
  return null
}

/** Where a photo or voice note taken with the report stands, once the office has the report. */
export type UploadState = 'waiting' | 'sending' | 'added' | 'failed'

export interface MediaUpload {
  readonly id: string
  readonly kind: MediaKind
  readonly name: string
  readonly state: UploadState
}

/** The next one to send: the first still waiting (one at a time, in the order they were taken). */
export const nextUpload = (uploads: readonly MediaUpload[]): MediaUpload | null => (uploads.some((entry) => entry.state === 'sending') ? null : (uploads.find((entry) => entry.state === 'waiting') ?? null))

/** A stored photo or voice note in words: `media.photo` / `media.photoBefore` / `media.photoAfter` / `media.voice`. */
export function mediaKey(file: Pick<StoredMedia, 'kind' | 'category'>): string {
  if (file.kind === 'AUDIO') return 'media.voice'
  return file.category === 'BEFORE_WORK' ? 'media.photoBefore' : file.category === 'AFTER_WORK' ? 'media.photoAfter' : 'media.photo'
}

// ---- "Guard missing also offers Report an incident" (joins with B-W2b-137) -------------------------------------------------

/**
 * THE hook for B-W2b-137 (floor Report an incident): set this to its page (`/floor/incident`). Until then the screen shows
 * "Report an incident" held with the reason (tell the team leader), never a dead control.
 */
export const INCIDENT_PAGE: string | null = null

/** The symptoms that also offer an incident report (design floor.machine: "'Guard missing' also offers Report an incident"). */
export const INCIDENT_SYMPTOMS: readonly string[] = ['GUARD_MISSING']

export const offersIncident = (symptom: Pick<Symptom, 'code'> | null): boolean => symptom !== null && INCIDENT_SYMPTOMS.includes(symptom.code)

// ---- progress (QHS-180) ---------------------------------------------------------------------------------------------------

export type ProgressRowKey = ProgressStep | 'CLOSED'

/** One line of the request's timeline: when it happened, or null when it has not happened yet. */
export interface ProgressRow {
  readonly key: ProgressRowKey
  readonly at: string | null
}

/**
 * The reporter's timeline: reported → acknowledged → on the way → fixed → works again. A step that never happened before a
 * later one (the office made the job at once, nobody said "on the way") is left out; the steps after the last one show
 * "not yet". A request closed without a job ends there.
 */
export function progressRows(request: Pick<FloorRequest, 'reportedAt' | 'progress'>): ProgressRow[] {
  const p = request.progress
  if (p.closedWithoutJob) {
    return [{ key: 'REPORTED', at: request.reportedAt }, ...(p.acknowledgedAt ? [{ key: 'ACKNOWLEDGED' as const, at: p.acknowledgedAt }] : []), { key: 'CLOSED', at: p.fixedAt }]
  }
  const all: ProgressRow[] = [
    { key: 'REPORTED', at: request.reportedAt },
    { key: 'ACKNOWLEDGED', at: p.acknowledgedAt },
    { key: 'ON_THE_WAY', at: p.onTheWayAt },
    { key: 'FIXED', at: p.fixedAt },
    { key: 'WORKS', at: p.worksAt },
  ]
  let last = 0
  all.forEach((row, index) => {
    if (row.at) last = index
  })
  return all.filter((row, index) => index > last || row.at !== null)
}

export type ProgressTone = 'neutral' | 'info' | 'warning' | 'success'

/** A request's row tone in the station's list: fixed (waiting for "It works") and works again in success. */
export const progressTone = (request: Pick<FloorRequest, 'progress' | 'locking'>): ProgressTone => {
  if (request.locking) return 'warning'
  switch (request.progress.step) {
    case 'REPORTED':
      return 'neutral'
    case 'ACKNOWLEDGED':
    case 'ON_THE_WAY':
      return 'info'
    case 'FIXED':
    case 'WORKS':
      return 'success'
  }
}

/** The station's requests: the ones waiting for "It works" first, then the API's order (newest first). */
export const stationOrder = (requests: readonly FloorRequest[]): FloorRequest[] => [...requests.filter((entry) => entry.progress.canConfirm), ...requests.filter((entry) => !entry.progress.canConfirm)]

/** Why "It works" cannot be said now (a `floor-machine` key), or null. Offline is no reason: the step queues. */
export function worksHeld(request: Pick<FloorRequest, 'progress' | 'locking'>, canReport: boolean, busy = false): string | null {
  if (!canReport) return 'held.noReport'
  if (request.progress.worksAt) return 'held.worksDone'
  if (request.progress.closedWithoutJob) return 'held.worksClosed'
  if (request.locking) return 'held.worksLocked'
  if (!request.progress.canConfirm) return 'held.worksNotFixed'
  if (busy) return 'held.busy'
  return null
}

/** The line lead confirms on the floor once the request's job is handed back (floor.lead; the API refuses a second time). */
export const leadOffered = (request: Pick<FloorRequest, 'job'>, canLead: boolean): boolean => canLead && request.job?.status === 'HANDED_BACK'

/** Why the line lead's confirmation is held now, or null: a signing act, online only. */
export const leadHeld = (online: boolean, busy = false): string | null => (!online ? 'held.offline' : busy ? 'held.busy' : null)

/** Why a technician's step (acknowledge, on the way) is held, or null: the API says whether it may be made now. Offline it queues. */
export function techHeld(may: boolean, canWork: boolean, busy = false): string | null {
  if (!canWork) return 'held.noWork'
  if (!may) return 'held.stepDone'
  if (busy) return 'held.busy'
  return null
}

/** The technician's queue: the rows that still need a technician's step, then the others, in the API's order (to me first). */
export const queueOrder = (entries: readonly QueueEntry[]): QueueEntry[] => [...entries.filter((entry) => entry.canAcknowledge || entry.canGo), ...entries.filter((entry) => !entry.canAcknowledge && !entry.canGo)]

// ---- the one-screen close (QHS-190) ---------------------------------------------------------------------------------------

export interface CloseTile {
  readonly code: string
  readonly label: string
}

/** The action tiles (adjusted, replaced a part, cleaned, other) in the screen's language: factory-domain's own list. */
export const actionTiles = (locale: Locale): CloseTile[] => HAND_BACK_ACTIONS.map((entry) => ({ code: entry.code, label: locale === 'it' ? entry.labelIt : entry.labelEn }))

/** The failure code tiles (until QHS-188's list) in the screen's language: factory-domain's own list. */
export const failureTiles = (locale: Locale): CloseTile[] => FAILURE_CODES.map((entry) => ({ code: entry.code, label: locale === 'it' ? entry.labelIt : entry.labelEn }))

export interface CloseDraft {
  readonly action: HandBackAction | null
  readonly failure: string | null
  readonly words: string
  readonly after: MachineAfter | null
}

/** A fresh close: running preselected (the usual end, so the close is three taps), none while the machine is locked (H1). */
export const closeDraftOf = (record: Pick<JobRecord, 'close'>): CloseDraft => ({ action: null, failure: null, words: '', after: record.close.runningHeld ? null : 'RUNNING' })

/** Why the close cannot be sent now (a `floor-machine` key), or null. */
export function closeHeld(draft: CloseDraft, machine: { readonly locked: boolean }, online: boolean, busy = false): string | null {
  if (!online) return 'held.offline'
  if (busy) return 'held.busy'
  if (!draft.action) return 'held.whatDone'
  if (draft.action === 'OTHER' && draft.words.trim() === '') return 'held.words'
  if (!draft.failure) return 'held.failure'
  if (!draft.after) return 'held.after'
  return afterHeld(draft.after, machine)
}

/** POST /plant/jobs/:id/hand-back's body of a complete draft (closeHeld null): the words only when there are some. */
export function closeBody(draft: CloseDraft): HandBackBody {
  const words = draft.words.trim().slice(0, WORDS_MAX)
  return { action: draft.action!, failureCode: draft.failure!, machineAfter: draft.after!, ...(words ? { workDone: words } : {}) }
}

/** What a photo taken on the close is: before the work while the job has not been handed back, or after it. */
export type CloseCapture = { readonly kind: 'PHOTO'; readonly category: 'BEFORE_WORK' | 'AFTER_WORK' } | { readonly kind: 'AUDIO' }
