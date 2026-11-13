import { businessDate, type BusinessDate } from '../../core/time'

/**
 * Made-to-measure office photos (B-W2b-371, XF2:01; SAL-286, SAL-297; design rider.photos "Upload (ImageUpload) · Open in Lightbox ·
 * Delete (reason, logged)"): the office's own photos of a rider in a base layer on a profile revision (StoredFile category
 * MTM_PHOTO, of the MeasurementProfile revision) and the photos of a fitting (FITTING_PHOTO, of the FittingResult), each with its
 * delete date (StoredFile.deleteAfter, B-W2b-363: only these two categories; moved earlier or later, never cleared; fixed once the
 * file is DELETED). The office's only (visibility exactly OFFICE): never a floor, a portal or a link. Pure rules: the API and the
 * web say the same.
 *
 * A photo's name says its view and revision, never the person's own file name (a name may carry personal data): `mtm-front-r3.jpg`,
 * `fitting-detail.png`. Without a date given, the photo is deleted 90 days after the garment ships (as the body photos sent by link,
 * B-W2b-171: the job sets the day once the garment shipped). A date is a business day: the purge deletes the photo from that day on
 * (today: within the hour). Never before today, never after the longest keep (two years: a remake months later still has them).
 */

export const MTM_PHOTO_VIEWS = ['FRONT', 'SIDE', 'BACK', 'DETAIL'] as const
export type MtmPhotoView = (typeof MTM_PHOTO_VIEWS)[number]

export const MTM_PHOTO_CATEGORIES = ['MTM_PHOTO', 'FITTING_PHOTO'] as const
export type MtmPhotoCategory = (typeof MTM_PHOTO_CATEGORIES)[number]

/** JPEG or PNG (the stripped copy the office is shown is made of these; a HEIC keeps its location). */
export const MTM_PHOTO_TYPES = ['image/jpeg', 'image/png'] as const

export const MTM_PHOTO_LIMITS = Object.freeze({
  /** Photos on one revision, or of one fitting result (retakes included; a deleted one counts no more). */
  perRecord: 12,
  maxBytes: 15 * 1_048_576,
  reason: 500,
  /** The latest delete date from today, in days. */
  keepDays: 730,
})

/** The record a photo of each category belongs to. */
export const PHOTO_RECORD: Readonly<Record<MtmPhotoCategory, 'MeasurementProfile' | 'FittingResult'>> = Object.freeze({ MTM_PHOTO: 'MeasurementProfile', FITTING_PHOTO: 'FittingResult' })

const extensionOf = (contentType: string): 'png' | 'jpg' => (contentType === 'image/png' ? 'png' : 'jpg')

/** The stored name of a photo: its category, view and (for a revision) the revision's number. */
export function photoNameOf(category: MtmPhotoCategory, view: MtmPhotoView, contentType: string, revision: number | null): string {
  const head = category === 'MTM_PHOTO' ? 'mtm' : 'fitting'
  return `${head}-${view.toLowerCase()}${revision !== null ? `-r${revision}` : ''}.${extensionOf(contentType)}`
}

/** The view a stored name says (DETAIL when it says none). */
export function viewOfPhotoName(name: string): MtmPhotoView {
  const match = /^(?:mtm|fitting)-(front|side|back|detail)(?:-r\d+)?\.(?:jpg|png)$/.exec(name)
  return match ? (match[1]!.toUpperCase() as MtmPhotoView) : 'DETAIL'
}

/** A photo to announce: JPEG or PNG of at most 15 MB. Codes; the API and the web word them. */
export type PhotoProblem = 'TYPE' | 'SIZE' | 'FULL' | 'DAY' | 'PAST' | 'TOO_LATE' | 'REASON' | 'DELETED' | 'SAME'

export function photoUploadProblems(input: { readonly contentType: string; readonly sizeBytes: number; readonly held: number }): PhotoProblem[] {
  const problems: PhotoProblem[] = []
  if (!(MTM_PHOTO_TYPES as readonly string[]).includes(input.contentType.trim().toLowerCase())) problems.push('TYPE')
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MTM_PHOTO_LIMITS.maxBytes) problems.push('SIZE')
  if (input.held >= MTM_PHOTO_LIMITS.perRecord) problems.push('FULL')
  return problems
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The last day a delete date may name, from today. */
export function latestDeleteDay(today: BusinessDate): BusinessDate {
  return businessDate(new Date(new Date(`${today}T12:00:00Z`).getTime() + MTM_PHOTO_LIMITS.keepDays * 86_400_000))
}

/**
 * What is wrong with a delete date (none: it may be written): a day, from today on (today: deleted within the hour), within the
 * longest keep; a move needs its reason (logged), a deleted photo keeps its date, the same day is no change.
 */
export function deleteDayProblems(input: {
  readonly day: string
  readonly today: BusinessDate
  readonly reason: string | null
  /** The photo's date now (a business day), null: not set. */
  readonly current: BusinessDate | null
  readonly deleted: boolean
}): PhotoProblem[] {
  if (input.deleted) return ['DELETED']
  const problems: PhotoProblem[] = []
  if (!DAY.test(input.day)) problems.push('DAY')
  else if (input.day < input.today) problems.push('PAST')
  else if (input.day > latestDeleteDay(input.today)) problems.push('TOO_LATE')
  else if (input.current === input.day) problems.push('SAME')
  if (input.reason !== null && input.reason.trim().length === 0) problems.push('REASON')
  if (input.reason !== null && input.reason.trim().length > MTM_PHOTO_LIMITS.reason) problems.push('REASON')
  return problems
}

/** The English words of a problem (the API's answer; the web says its own). */
export const PHOTO_PROBLEM_WORDS: Readonly<Record<PhotoProblem, string>> = Object.freeze({
  TYPE: 'A photo as JPEG or PNG (a HEIC keeps its location: choose "Most compatible" on the phone).',
  SIZE: 'At most 15 MB.',
  FULL: `At most ${MTM_PHOTO_LIMITS.perRecord} photos here: delete one first, or take them on the next revision.`,
  DAY: 'A day written YYYY-MM-DD.',
  PAST: 'A day from today on (today: the photo is deleted within the hour).',
  TOO_LATE: `At most ${MTM_PHOTO_LIMITS.keepDays} days from today.`,
  REASON: `Why, in at most ${MTM_PHOTO_LIMITS.reason} characters (it is logged).`,
  DELETED: 'This photo is deleted already: its delete date stays as it is.',
  SAME: 'The photo is deleted on that day already.',
})
