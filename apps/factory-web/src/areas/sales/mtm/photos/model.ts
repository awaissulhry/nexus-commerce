import { businessDate } from '@nexus/factory-domain/core/time'
import { deleteDayProblems, MTM_PHOTO_LIMITS, MTM_PHOTO_TYPES, MTM_PHOTO_VIEWS, type MtmPhotoView, type PhotoProblem } from '@nexus/factory-domain/sales/mtm-photos/rules'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { StoreError } from '../../../../record-panels/store'
import type { MtmCan, Phrase } from '../model'
import type { PhotosView, PhotoTarget, PhotoView } from './api'

/**
 * Made-to-measure office photos (B-W2b-371, XF2:01; design rider.photos "Upload · Open in Lightbox · Delete (reason, logged)"), pure:
 * why an upload or a date is held now, what a picked file lacks, the delete date in words, a refusal said from its path — in this
 * part's catalogue (`sales-mtm-office-extras`, keys under `photo.`), never the API's English. Made-to-measure is OFF per template
 * (Owner 11-10): no photo is added while it is off, said with the way to start it.
 */

export const EXTRAS_NS = 'sales-mtm-office-extras'
export { MTM_PHOTO_VIEWS }
export type { MtmPhotoView }

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** Why a photo cannot be added here now (null: it can). */
export function uploadHeld(photos: PhotosView | null, kind: PhotoTarget['kind'], can: MtmCan, offline: boolean): Phrase | null {
  if (!photos) return phrase('photo.held.reading')
  if (!photos.started) return phrase('photo.held.off', { garment: photos.garmentType })
  if (kind === 'profile' ? !can.record : !can.fittings) return phrase(kind === 'profile' ? 'photo.held.rightRecord' : 'photo.held.rightFittings')
  if (offline) return phrase('photo.held.offline')
  return null
}

/** What the picked file lacks (null: it may be sent): JPEG or PNG of at most 15 MB. */
export function fileProblem(file: Pick<File, 'type' | 'size'> | null): Phrase | null {
  if (!file) return phrase('photo.upload.noFile')
  if (!(MTM_PHOTO_TYPES as readonly string[]).includes(file.type.toLowerCase())) return phrase('photo.upload.type')
  if (file.size <= 0 || file.size > MTM_PHOTO_LIMITS.maxBytes) return phrase('photo.upload.size')
  return null
}

/** The delete date as the row says it: a day, within the hour (today or past), or 90 days after the garment ships. */
export function deleteLine(photo: Pick<PhotoView, 'deleteAfter' | 'status'>, today: string): Phrase {
  if (!photo.deleteAfter) return phrase('photo.delete.afterShipping')
  const day = businessDate(new Date(photo.deleteAfter))
  return day <= today ? phrase('photo.delete.withinHour') : phrase('photo.delete.on', { date: day })
}

const PROBLEM_KEY: Readonly<Record<PhotoProblem, string>> = Object.freeze({
  TYPE: 'photo.upload.type',
  SIZE: 'photo.upload.size',
  FULL: 'photo.upload.full',
  DAY: 'photo.date.problem.day',
  PAST: 'photo.date.problem.past',
  TOO_LATE: 'photo.date.problem.tooLate',
  REASON: 'photo.date.problem.reason',
  DELETED: 'photo.date.problem.deleted',
  SAME: 'photo.date.problem.same',
})

/** Why the new delete date cannot be saved as typed (null: it can), from the domain's rule. */
export function dateHeld(draft: { readonly day: string; readonly reason: string }, photo: Pick<PhotoView, 'deleteAfter' | 'status'>, today: string, may: boolean, offline: boolean): Phrase | null {
  if (!may) return phrase('photo.held.rightDate')
  if (offline) return phrase('photo.held.offline')
  const problems = deleteDayProblems({ day: draft.day, today, reason: draft.reason, current: photo.deleteAfter ? businessDate(new Date(photo.deleteAfter)) : null, deleted: photo.status === 'DELETED' })
  return problems.length > 0 ? phrase(PROBLEM_KEY[problems[0]!]) : null
}

/** Why the upload's own delete date (optional) is not right (null: none or fine). */
export function uploadDateHeld(day: string, today: string): Phrase | null {
  if (!day) return null
  const problems = deleteDayProblems({ day, today, reason: null, current: null, deleted: false })
  return problems.length > 0 ? phrase(PROBLEM_KEY[problems[0]!]) : null
}

/** A refused upload in our words, from its path (`held/MTM_NOT_STARTED`, `body/contentType` …) or its kind. */
export function uploadProblem(error: unknown): Phrase {
  if (error instanceof StoreError) return phrase('photo.upload.store')
  if (!isApiError(error)) return phrase('photo.problem.failed')
  const paths = error.issues.map((issue) => issuePath(issue).replace(/\./g, '/'))
  if (paths.includes('held/MTM_NOT_STARTED')) return phrase('photo.upload.off')
  if (paths.includes('held/FULL')) return phrase('photo.upload.full')
  if (paths.includes('body/contentType')) return phrase('photo.upload.type')
  if (paths.includes('body/sizeBytes')) return phrase('photo.upload.size')
  if (paths.includes('body/deleteOn')) return phrase('photo.date.problem.past')
  return commonProblem(error.kind)
}

/** A refused date move in our words. */
export function dateProblem(error: unknown): Phrase {
  if (!isApiError(error)) return phrase('photo.problem.failed')
  const paths = error.issues.map((issue) => issuePath(issue).replace(/\./g, '/'))
  if (paths.includes('held/STALE') || paths.includes('held/PHOTO_RULE')) return phrase('photo.date.problem.stale')
  if (paths.includes('held/DELETED')) return phrase('photo.date.problem.deleted')
  if (paths.includes('held/RETAINED')) return phrase('photo.date.problem.retained')
  if (paths.includes('body/deleteOn')) return phrase('photo.date.problem.past')
  if (paths.includes('body/reason')) return phrase('photo.date.problem.reason')
  return commonProblem(error.kind)
}

function commonProblem(kind: string): Phrase {
  if (kind === 'forbidden') return phrase('photo.problem.forbidden')
  if (kind === 'not_found') return phrase('photo.problem.notFound')
  if (kind === 'unavailable' || kind === 'network') return phrase('photo.problem.unavailable')
  return phrase('photo.problem.failed')
}

/** The office's and the fittings' photos together (the Photos tab's count). */
export const photoCount = (photos: PhotosView | null): number | null => (photos ? photos.revisions.reduce((sum, revision) => sum + revision.photos.length, 0) + photos.fittings.reduce((sum, fitting) => sum + fitting.photos.length, 0) : null)

/** A fitting result's photos (none: an empty list). */
export const fittingPhotos = (photos: PhotosView | null, resultId: string): readonly PhotoView[] => photos?.fittings.find((fitting) => fitting.resultId === resultId)?.photos ?? []
