import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { REVIEW_STATUSES } from '../mtm/rules'
import { MTM_PHOTO_CATEGORIES, MTM_PHOTO_LIMITS, MTM_PHOTO_VIEWS } from './rules'

/**
 * Made-to-measure office photos' contracts (B-W2b-371): what apps/factory-api's modules/sales/mtm/photos accepts and answers. No
 * money; never a measure. A photo is announced (the presigned PUT), then confirmed; its delete date is a business day.
 */

const presigned = output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })

/** A photo to announce: its view, the file's facts, and its delete date when the person knows it (else 90 days after shipping). */
export const photoBody = input({
  view: z.enum(MTM_PHOTO_VIEWS),
  contentType: z.string().trim().min(1).max(100),
  sizeBytes: z.number().int().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  deleteOn: businessDate().nullish(),
})
export type PhotoBody = z.output<typeof photoBody>

/** The delete date moved (earlier or later; today: deleted within the hour), at the file's version, with why. */
export const deleteOnBody = input({ version: z.number().int().min(1), deleteOn: businessDate(), reason: z.string().trim().min(1).max(MTM_PHOTO_LIMITS.reason) })
export type DeleteOnBody = z.output<typeof deleteOnBody>

export const photoView = output({
  id: id(),
  category: z.enum(MTM_PHOTO_CATEGORIES),
  view: z.enum(MTM_PHOTO_VIEWS),
  /** PENDING_UPLOAD, AVAILABLE, QUARANTINED (its check, or the virus scan), DELETED. */
  status: z.string(),
  sizeBytes: z.number().int(),
  /** From when the purge deletes it; null: 90 days after the garment ships (not shipped yet). */
  deleteAfter: instant().nullable(),
  createdAt: instant(),
  by: output({ id: id(), name: z.string() }).nullable(),
  version: z.number().int(),
})
export type PhotoView = z.output<typeof photoView>

export const photosView = output({
  /** The rider's chain (any revision's id answers it). */
  profileId: id(),
  partyId: id(),
  riderName: z.string(),
  garmentType: z.string(),
  /** Made-to-measure started for the garment type's template (GATE-MTM): no photo is added while it is off. */
  started: z.boolean(),
  /** The office's photos per revision, newest revision first (only revisions with a photo). */
  revisions: z.array(
    output({
      id: id(),
      revision: z.number().int(),
      review: z.enum(REVIEW_STATUSES),
      /** The privacy notice the rider was given with these measurements (the consent reference) and when. */
      notice: output({ ref: z.string(), at: instant() }),
      photos: z.array(photoView),
    }),
  ),
  /** The photos of each fitting of the chain with a photo, newest first. */
  fittings: z.array(output({ resultId: id(), fittedAt: instant(), verdict: z.enum(['OK', 'ALTER', 'REMAKE']), revision: z.number().int(), photos: z.array(photoView) })),
  /** What the caller may do now (the web says why not from these facts). */
  may: output({ upload: z.boolean(), uploadFitting: z.boolean(), date: z.boolean(), dateFitting: z.boolean() }),
})
export type PhotosView = z.output<typeof photosView>

export const announcedView = output({ file: output({ id: id(), status: z.string(), sizeBytes: z.number().int() }), upload: presigned })
export const completedView = output({ photo: photoView })
export const openedView = output({ file: output({ id: id(), view: z.enum(MTM_PHOTO_VIEWS) }), download: presigned })
export const datedView = output({ photo: photoView })
