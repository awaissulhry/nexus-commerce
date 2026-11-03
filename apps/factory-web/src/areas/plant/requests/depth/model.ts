import { FAILURE_CODES, HAND_BACK_ACTIONS, type HandBackAction } from '@nexus/factory-domain/plant/jobs/close'
import { DEPTH_REFUSALS, type DepthRefusalCode } from '@nexus/factory-domain/plant/requests/refusals'
import { WAITING_MINUTES } from '@nexus/factory-domain/plant/rules'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import type { MachineAfter } from '../../_shared/api'
import { personWords, problemOf, type PlantCan, type Tone, type Words } from '../../_shared/model'
import type { DeepJob, DeepJobRecord, DeepRequest, DeepRequestRecord, DuplicateGroup, HandBackBody, JobClose, Media, MergeBody, TrailEntry } from './api'

/**
 * The rules of Machine requests and Maintenance jobs in depth (B-W2b-140), without React and without the API client:
 * the Age tone by escalation level, where a request was sent in words, the locked machines first, the possible
 * duplicates and what a merge sends (a request that still locks its machine is never merged into another request: H1),
 * Lock as unsafe, the requester's progress, the routing and progress trail in order, the photos and voice notes of a
 * job, the one-screen close (the domain's action and failure-code tiles) and the line lead's confirmation. Each "held"
 * answer is a message key of the `plant` catalogue: the button that waits says why. No figure here is per person.
 */

// ---- refusals (B-W2b-96's DEPTH_REFUSALS, beside W2a's PLANT_REFUSALS) ------------------------------------------------------

export const DEPTH_REFUSAL_CODES: readonly DepthRefusalCode[] = DEPTH_REFUSALS

/** The depth refusal an API error carries (409, `refusal/<CODE>`), or null. */
export function depthRefusalOf(error: unknown): DepthRefusalCode | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (!path.startsWith('refusal/')) continue
    const code = path.slice('refusal/'.length)
    if ((DEPTH_REFUSALS as readonly string[]).includes(code)) return code as DepthRefusalCode
  }
  return null
}

/** The words of a failed depth call: a depth refusal by its code, else W2a's words (a plant refusal or the kind). */
export function depthProblemOf(error: unknown): Words {
  const code = depthRefusalOf(error)
  return code ? { key: `depthRefusal.${code}` } : problemOf(error)
}

// ---- the queue: Age tone by escalation, Routed to ------------------------------------------------------------------------------

const isOpen = (status: DeepRequest['status']) => status === 'NEW' || status === 'ACKNOWLEDGED'

/**
 * The Age tone (design "Countdown since reported; tone by escalation level"): a request that locks its machine is
 * danger; an open one escalated twice is danger, once warning; else W2a's (waiting over 30 minutes: warning).
 */
export function escalationTone(request: Pick<DeepRequest, 'locking' | 'status' | 'ageMinutes' | 'routing'>): Tone {
  if (request.locking) return 'danger'
  if (!isOpen(request.status)) return 'neutral'
  if (request.routing.escalationLevel >= 2) return 'danger'
  if (request.routing.escalationLevel === 1) return 'warning'
  return request.ageMinutes >= WAITING_MINUTES ? 'warning' : 'neutral'
}

/** Where the request was sent, in words: a team by name; a technician by name where the API names one; nobody. */
export function routedWords(routing: DeepRequest['routing']): Words {
  const to = routing.routedTo
  if (!to) return { key: 'routing.none' }
  if (to.kind === 'TEAM') return to.name ? { key: 'routing.team', params: { name: to.name } } : { key: 'routing.aTeam' }
  return to.name ? { key: 'routing.technician', params: { name: to.name } } : { key: 'routing.aTechnician' }
}

/** "Escalated (level 2)" — null when nobody was asked again. */
export const escalatedWords = (routing: DeepRequest['routing']): Words | null => (routing.escalationLevel > 0 ? { key: 'routing.escalated', params: { level: routing.escalationLevel } } : null)

// ---- the locked machines (always first on the page) --------------------------------------------------------------------------

/** Banners drawn one by one; the rest behind "N more · Show them" (the UNSAFE tile). */
export const LOCKS_SHOWN = 3

// ---- possible duplicates and the merge ---------------------------------------------------------------------------------------

export type MergeTarget = { readonly kind: 'JOB'; readonly id: string; readonly number: string } | { readonly kind: 'REQUEST'; readonly id: string }

/** One machine's open requests (two or more), oldest first, its open job, and the suggested target. */
export interface MergeGroup {
  readonly machine: DeepRequest['machine']
  readonly requests: readonly DeepRequest[]
  readonly openJob: { readonly id: string; readonly number: string } | null
  readonly withinMinutes: number
  readonly suggested: MergeTarget
}

export const targetKey = (target: MergeTarget): string => `${target.kind}:${target.id}`

const byTime = (a: DeepRequest, b: DeepRequest) => a.reportedAt.localeCompare(b.reportedAt) || a.id.localeCompare(b.id)

/** The suggestion of factory-domain plant/requests/merge: the open job, else the request that locks, else the oldest. */
function suggestedOf(requests: readonly DeepRequest[], openJob: MergeGroup['openJob']): MergeTarget {
  if (openJob) return { kind: 'JOB', id: openJob.id, number: openJob.number }
  const lock = requests.find((request) => request.locking) ?? requests[0]!
  return { kind: 'REQUEST', id: lock.id }
}

/** A group of GET /plant/requests/duplicates. */
export function groupOfDuplicates(group: DuplicateGroup): MergeGroup {
  const requests = [...group.requests].sort(byTime)
  const openJob = group.suggested.kind === 'JOB' && group.suggested.job ? { id: group.suggested.job.id, number: group.suggested.job.number } : null
  const suggested: MergeTarget = openJob ? { kind: 'JOB', ...openJob } : { kind: 'REQUEST', id: group.suggested.requestId ?? suggestedOf(requests, null).id }
  return { machine: group.machine, requests, openJob, withinMinutes: group.withinMinutes, suggested }
}

/** The group a request's detail knows: the request (while open) and the machine's other open requests; null under two. */
export function groupOfRecord(record: Pick<DeepRequestRecord, 'request' | 'duplicates' | 'card'>): MergeGroup | null {
  const requests = [...(isOpen(record.request.status) ? [record.request] : []), ...record.duplicates.filter((other) => isOpen(other.status))].sort(byTime)
  if (requests.length < 2) return null
  const openJob = record.card.openJob ? { id: record.card.openJob.id, number: record.card.openJob.number } : null
  const first = requests[0]!
  const last = requests.at(-1)!
  return { machine: record.request.machine, requests, openJob, withinMinutes: Math.max(0, Math.round((Date.parse(last.reportedAt) - Date.parse(first.reportedAt)) / 60_000)), suggested: suggestedOf(requests, openJob) }
}

export interface MergeDraft {
  /** `JOB:<id>` or `REQUEST:<id>`. */
  readonly target: string
  /** The requests to merge (the target request itself is never one). */
  readonly picked: readonly string[]
}

/** The draft a merge opens with: the target asked for (else the suggestion) and every other request that may go into it. */
export function mergeDraftOf(group: MergeGroup, target: string | null = null): MergeDraft {
  const chosen = target && targetsOf(group).some((entry) => targetKey(entry) === target) ? target : targetKey(group.suggested)
  return retarget(group, { target: chosen, picked: [] })
}

/** The draft with another target: every request that may go into it is picked again (a locking one never into a request). */
export function retarget(group: MergeGroup, draft: MergeDraft): MergeDraft {
  return { target: draft.target, picked: group.requests.filter((request) => sourceHeld(request, draft) === null).map((request) => request.id) }
}

/** The targets a group offers: its open job first, then each of its requests. */
export const targetsOf = (group: MergeGroup): MergeTarget[] => [...(group.openJob ? [{ kind: 'JOB' as const, id: group.openJob.id, number: group.openJob.number }] : []), ...group.requests.map((request) => ({ kind: 'REQUEST' as const, id: request.id }))]

const intoRequest = (draft: MergeDraft): string | null => (draft.target.startsWith('REQUEST:') ? draft.target.slice('REQUEST:'.length) : null)

/** Why this request may not be merged into the chosen target (a message key), or null. */
export function sourceHeld(request: Pick<DeepRequest, 'id' | 'locking'>, draft: MergeDraft): string | null {
  const into = intoRequest(draft)
  if (into === request.id) return 'mergeMany.isTarget'
  return into && request.locking ? 'mergeMany.lockedSource' : null
}

/** The requests that go (picked, not the target, not held). */
export const mergeSources = (group: MergeGroup, draft: MergeDraft): DeepRequest[] => group.requests.filter((request) => draft.picked.includes(request.id) && sourceHeld(request, draft) === null)

/** Why the merge may not go now (a message key), or null. */
export function mergeHeld(group: MergeGroup, draft: MergeDraft, can: Pick<PlantCan, 'triage'>, busy = false): string | null {
  if (!can.triage) return 'held.noTriage'
  const picked = group.requests.filter((request) => draft.picked.includes(request.id))
  if (picked.some((request) => sourceHeld(request, draft) === 'mergeMany.lockedSource')) return 'mergeMany.held.lockedSource'
  if (mergeSources(group, draft).length === 0) return 'mergeMany.held.none'
  return busy ? 'held.busy' : null
}

/** What POST /plant/requests/merge takes for the draft. */
export function mergeBody(group: MergeGroup, draft: MergeDraft): MergeBody {
  const requests = mergeSources(group, draft).map((request) => ({ id: request.id, version: request.version }))
  const into = intoRequest(draft)
  return into ? { requests, intoId: into } : { requests, intoJobId: draft.target.slice('JOB:'.length) }
}

// ---- Lock as unsafe ----------------------------------------------------------------------------------------------------------

/** Why this person may not lock the machine from this request now (a message key), or null. */
export function lockHeld(record: Pick<DeepRequestRecord, 'request' | 'card' | 'canLock'>, can: Pick<PlantCan, 'report'>, busy = false): string | null {
  if (!can.report) return 'held.noReport'
  if (record.card.machine.status === 'RETIRED') return 'held.machineRetired'
  if (record.request.locking || record.card.machine.locked) return 'lockAsUnsafe.held.locked'
  if (!record.canLock) return 'lockAsUnsafe.held.notAllowed'
  return busy ? 'held.busy' : null
}

// ---- the requester's progress (QHS-180) ---------------------------------------------------------------------------------------

export const PROGRESS_ORDER = ['REPORTED', 'ACKNOWLEDGED', 'ON_THE_WAY', 'FIXED', 'WORKS'] as const
export type ProgressKey = (typeof PROGRESS_ORDER)[number]

export interface ProgressRow {
  readonly key: ProgressKey
  readonly at: string | null
  readonly done: boolean
}

/** The five steps the reporter follows; a step skipped before a later one (on the way never said) is left out. */
export function progressRows(request: Pick<DeepRequest, 'reportedAt' | 'progress'>): ProgressRow[] {
  const p = request.progress
  const at: Record<ProgressKey, string | null> = { REPORTED: request.reportedAt, ACKNOWLEDGED: p.acknowledgedAt, ON_THE_WAY: p.onTheWayAt, FIXED: p.fixedAt, WORKS: p.worksAt }
  const reached = PROGRESS_ORDER.indexOf(p.step)
  return PROGRESS_ORDER.filter((key, index) => !(index < reached && at[key] === null && index > 0)).map((key) => ({ key, at: at[key], done: PROGRESS_ORDER.indexOf(key) <= reached }))
}

/** Why "On my way" waits (a message key), or null. */
export function goHeld(record: Pick<DeepRequestRecord, 'request' | 'canGo'>, can: Pick<PlantCan, 'work'>, busy = false): string | null {
  if (!can.work) return 'held.noWork'
  if (record.request.progress.onTheWayAt) return 'progress.held.onTheWay'
  if (!isOpen(record.request.status) && record.request.status !== 'JOB_MADE') return 'held.notOpen'
  if (!record.canGo) return 'progress.held.cannotGo'
  return busy ? 'held.busy' : null
}

/** Why "It works again" waits (a message key), or null. */
export function worksHeld(record: Pick<DeepRequestRecord, 'request' | 'canConfirm'>, can: Pick<PlantCan, 'report'>, busy = false): string | null {
  const request = record.request
  if (!can.report) return 'held.noReport'
  if (request.progress.worksAt) return 'progress.held.confirmed'
  if (request.locking) return 'progress.held.locked'
  if (request.progress.closedWithoutJob) return 'progress.held.closedWithoutJob'
  if (!request.progress.fixedAt) return 'progress.held.notFixed'
  if (!record.canConfirm) return 'progress.held.cannotConfirm'
  return busy ? 'held.busy' : null
}

// ---- the trail (routing, escalation and progress, in time order) ---------------------------------------------------------------

export interface TrailStep {
  readonly key: string
  /** A message key and its params. */
  readonly words: Words
  readonly at: string | null
  readonly tone: 'info' | 'success' | 'neutral' | 'warning'
  /** A second line (a note, a reason). */
  readonly note?: string | null
}

/**
 * What happened to the request, in order: the API's trail (reported, routed, escalated, acknowledged, on the way, merged,
 * closed, signed safe, fixed, works again) with who did it where the request names them, its job, and a lock still
 * waiting for the sign-safe. A worker is named only inside this one record, where the API names one (Owner answer W1).
 */
export function trailSteps(t: Translate, request: DeepRequest, trail: readonly TrailEntry[]): TrailStep[] {
  const steps: TrailStep[] = []
  const routed = routedWords(request.routing)
  for (const [index, entry] of trail.entries()) {
    const key = `${entry.kind}-${index}`
    switch (entry.kind) {
      case 'REPORTED':
        steps.push({ key, words: { key: 'trail.reported', params: { who: personWords(t, request.reportedBy) } }, at: entry.at, tone: 'info' })
        break
      case 'ROUTED':
        steps.push({ key, words: { key: 'trail2.routed', params: { to: t(routed.key, routed.params) } }, at: entry.at, tone: 'info' })
        break
      case 'ESCALATED':
        steps.push({ key, words: { key: 'trail2.escalated', params: { level: entry.level ?? request.routing.escalationLevel } }, at: entry.at, tone: 'warning' })
        break
      case 'ACKNOWLEDGED':
        steps.push({ key, words: { key: 'trail.acknowledged', params: { who: personWords(t, request.acknowledgedBy) } }, at: entry.at, tone: 'info' })
        break
      case 'ON_THE_WAY':
        steps.push({ key, words: { key: 'trail2.onTheWay', params: { who: personWords(t, request.progress.onTheWayBy) } }, at: entry.at, tone: 'info' })
        break
      case 'MERGED':
        steps.push({ key, words: { key: 'trail.merged' }, at: entry.at, tone: 'neutral' })
        break
      case 'CLOSED':
        steps.push({ key, words: { key: 'trail.closed', params: { reason: request.closeReason ? t(`closeReason.${request.closeReason}`) : '—', who: personWords(t, request.closedBy) } }, at: entry.at, tone: 'neutral', note: request.closeNote })
        break
      case 'SIGNED_SAFE':
        steps.push({ key, words: { key: 'trail.signedSafe', params: { who: personWords(t, request.signedSafe?.by) } }, at: entry.at, tone: 'success', note: request.signedSafe?.note ?? null })
        break
      case 'FIXED':
        steps.push({ key, words: request.job ? { key: 'trail2.fixedJob', params: { number: request.job.number } } : { key: 'trail2.fixed' }, at: entry.at, tone: 'success' })
        break
      case 'WORKS_AGAIN':
        steps.push({ key, words: { key: 'trail2.works', params: { who: personWords(t, request.progress.worksBy) } }, at: entry.at, tone: 'success' })
        break
    }
  }
  if (request.job) {
    const job: TrailStep = { key: 'job', words: { key: 'trail.job', params: { number: request.job.number } }, at: null, tone: 'success', note: t(`jobStatus.${request.job.status}`) }
    const fixedAt = steps.findIndex((step) => step.key.startsWith('FIXED-'))
    if (fixedAt >= 0) steps.splice(fixedAt, 0, job)
    else steps.push(job)
  }
  if (request.locking && !trail.some((entry) => entry.kind === 'SIGNED_SAFE')) steps.push({ key: 'locked', words: { key: 'trail.waitsSignSafe' }, at: null, tone: 'warning', note: t('trail.waitsSignSafeDetail') })
  return steps
}

// ---- photos and voice notes -----------------------------------------------------------------------------------------------------

/** A photo or voice note on screen: its address once read (null while reading, or when it could not be read). */
export interface MediaView {
  readonly id: string
  readonly kind: Media['kind']
  readonly category: Media['category']
  readonly name: string
  readonly availableAt: string | null
  /** The request it came from (a job's view of its requests' files). */
  readonly requestId: string | null
  readonly src: string | null
}

/** The words of one file's kind: a photo before / after the work, a photo, a voice note. */
export const mediaKey = (media: Pick<Media, 'kind' | 'category'>): string => (media.kind === 'AUDIO' ? 'media.voice' : media.category === 'BEFORE_WORK' ? 'media.before' : media.category === 'AFTER_WORK' ? 'media.after' : 'media.photo')

export function mediaViews(files: readonly (Media & { requestId?: string })[], known: readonly MediaView[] = []): MediaView[] {
  return files.map((file) => ({ id: file.id, kind: file.kind, category: file.category, name: file.originalName, availableAt: file.availableAt, requestId: file.requestId ?? null, src: known.find((seen) => seen.id === file.id)?.src ?? null }))
}

/** The photos shown in the Lightbox (in the order on screen: before, after, the others). */
export const lightboxPhotos = (media: readonly MediaView[]): MediaView[] => media.filter((entry) => entry.kind === 'PHOTO' && entry.src)

/** Why a photo or voice note may not be added to the job now (a message key), or null. */
export function uploadHeld(job: Pick<DeepJob, 'open'>, can: Pick<PlantCan, 'work'>, busy = false): string | null {
  if (!can.work) return 'held.noWork'
  if (!job.open) return 'media.held.closed'
  return busy ? 'held.busy' : null
}

/** A file name for a photo or voice note taken in the office: `<job>-before-1.jpg`, `<job>-voice-2.webm`. */
export function mediaName(base: string, kind: Media['kind'], category: Media['category'], index: number, contentType: string): string {
  const extension = kind === 'PHOTO' ? (contentType.includes('png') ? 'png' : 'jpg') : contentType.includes('ogg') ? 'ogg' : contentType.includes('mp4') || contentType.includes('m4a') ? 'm4a' : contentType.includes('mpeg') ? 'mp3' : contentType.includes('wav') ? 'wav' : contentType.includes('aac') ? 'aac' : 'webm'
  const what = kind === 'AUDIO' ? 'voice' : category === 'BEFORE_WORK' ? 'before' : category === 'AFTER_WORK' ? 'after' : 'photo'
  return `${base}-${what}-${index}.${extension}`
}

/** Voice notes the API takes (audio/webm|ogg|mp4|mpeg|aac|wav, 10 MiB). */
export const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav'] as const
export const AUDIO_MAX_BYTES = 10 * 1024 * 1024

/** Why a picked audio file is not taken (a message key), or null. */
export function audioRefusal(file: { readonly type: string; readonly size: number }): string | null {
  const type = file.type.split(';')[0]!.trim().toLowerCase()
  if (!(AUDIO_TYPES as readonly string[]).includes(type === 'audio/x-m4a' ? 'audio/mp4' : type === 'audio/x-wav' || type === 'audio/wave' ? 'audio/wav' : type)) return 'media.audioType'
  return file.size > AUDIO_MAX_BYTES ? 'media.audioSize' : null
}

// ---- the one-screen close (QHS-190) ----------------------------------------------------------------------------------------------

export interface CloseTile {
  readonly code: string
  readonly label: string
}

/** The action tiles of factory-domain plant/jobs/close in the page's language (the floor's close shows the same). */
export const actionTiles = (locale: Locale): CloseTile[] => HAND_BACK_ACTIONS.map((entry) => ({ code: entry.code, label: locale === 'it' ? entry.labelIt : entry.labelEn }))

/** The failure-code tiles (until QHS-188's list) in the page's language. */
export const failureTiles = (locale: Locale): CloseTile[] => FAILURE_CODES.map((entry) => ({ code: entry.code, label: locale === 'it' ? entry.labelIt : entry.labelEn }))

/** A stored failure code in words (a code outside the tiles: the code itself). */
export const failureLabel = (code: string, locale: Locale): string => failureTiles(locale).find((tile) => tile.code === code)?.label ?? code

export interface CloseDraft {
  readonly action: HandBackAction | null
  readonly failure: string | null
  readonly words: string
  readonly after: MachineAfter | null
}

/** The close starts with Running chosen, unless the lock holds it (H1): three taps on the usual path. */
export const closeDraftOf = (close: Pick<JobClose, 'runningHeld'> | null): CloseDraft => ({ action: null, failure: null, words: '', after: close && !close.runningHeld ? 'RUNNING' : null })

/** Why one "machine after" may not be chosen (a message key), or null. */
export const afterHeld = (after: MachineAfter, job: { readonly machine: { readonly locked: boolean } }, close: Pick<JobClose, 'runningHeld'> | null): string | null => (after === 'RUNNING' && (job.machine.locked || (close?.runningHeld ?? false)) ? 'held.lockedRunning' : null)

/** Why the hand-back may not go now (a message key), or null. */
export function closeHeld(draft: CloseDraft, job: Pick<DeepJob, 'status' | 'machine'>, close: Pick<JobClose, 'runningHeld'> | null, can: Pick<PlantCan, 'work'>, busy = false): string | null {
  if (!can.work) return 'held.noWork'
  if (job.status !== 'IN_PROGRESS') return 'held.move.handBack'
  if (!draft.action) return 'close.held.action'
  if (draft.action === 'OTHER' && draft.words.trim().length === 0) return 'close.held.words'
  if (!draft.failure) return 'close.held.failure'
  if (!draft.after) return 'held.machineAfterNeeded'
  const after = afterHeld(draft.after, job, close)
  if (after) return after
  return busy ? 'held.busy' : null
}

/** What POST /plant/jobs/:id/hand-back takes (words only when typed: the API writes the tile's words otherwise). */
export function closeBody(draft: CloseDraft, version: number): HandBackBody {
  return { version, machineAfter: draft.after!, action: draft.action!, failureCode: draft.failure, ...(draft.words.trim() ? { workDone: draft.words.trim() } : {}) }
}

// ---- the line lead confirms (QHS-180) --------------------------------------------------------------------------------------------

/** Why "Confirm it works" waits on the job (a message key), or null. */
export function leadHeld(record: Pick<DeepJobRecord, 'job' | 'canConfirm'>, can: Pick<PlantCan, 'triage'>, busy = false): string | null {
  if (record.job.leadConfirmed) return 'lead.held.done'
  if (!can.triage) return 'lead.held.noRight'
  if (record.job.status !== 'HANDED_BACK') return 'lead.held.notHandedBack'
  if (!record.canConfirm) return 'lead.held.cannot'
  return busy ? 'held.busy' : null
}

/** A stitch-settings repair asks a first-piece check (W3, QHS-191): said, not drawn yet. */
export const firstPieceAsked = (job: Pick<DeepJob, 'handedBack'>): boolean => job.handedBack?.failureCode === 'SETTINGS'
