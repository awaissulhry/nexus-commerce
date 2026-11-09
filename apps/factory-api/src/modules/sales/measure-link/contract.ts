import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BODY_ZONES, FITS, MEASURE_LIMITS, MEASURE_UNITS, PHOTO_RULES, PHOTO_VIEWS } from '@nexus/factory-domain/sales/measure-link/rules'

/**
 * Measurements by link (B-W2b-171; SAL-096, SAL-286): the rider's MEASUREMENTS link page, its notice, photos and send; the
 * office's link, what came back, a photo opened, the day the photos go. Never a price; the API's English words only in
 * refusals: the page speaks its own catalogue from codes and numbers.
 */

const at = instant()
const words = output({ it: z.string(), en: z.string() })
const view = z.enum(PHOTO_VIEWS)
const photoRule = z.enum(PHOTO_RULES)
const presigned = output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: at })
const fileParams = input({ fileId: id() })
const profileParams = input({ profileId: id() })
const short = (max: number) => z.string().max(max)

// ---- the link ---------------------------------------------------------------------------------------------------------

const point = output({
  code: z.string(),
  name: words,
  seq: z.number().int(),
  zone: z.enum(BODY_ZONES),
  required: z.boolean(),
  minCm: z.string().nullable(),
  maxCm: z.string().nullable(),
  howTo: z.string().nullable(),
})

export const measurePage = output({
  sender: output({ companyId: id(), companyName: z.string() }),
  rider: output({ name: z.string() }),
  garment: output({ code: z.string(), name: words }),
  order: output({ number: z.string() }).nullable(),
  /** The company's public notice in force (GDPR art. 13), null when none is published: the form is held. */
  notice: output({ id: id(), label: z.string(), publishedAt: at.nullable() }).nullable(),
  /** When the rider ticked "I have read…" on this link for the notice in force; null: not yet (every field stays held). */
  noticeRead: output({ noticeId: id(), at }).nullable(),
  photos: photoRule,
  points: z.array(point),
  link: output({ expiresAt: at, usesLeft: z.number().int(), live: z.boolean() }),
  locale: z.enum(['it', 'en']),
})

export const linkLanguage = input({ language: z.enum(['it', 'en']).optional() })
export const measurePageContract = defineContract({ querystring: linkLanguage, response: { 200: measurePage } })

export const noticeContract = defineContract({
  body: input({ noticeId: id() }),
  response: { 200: output({ noticeRead: output({ noticeId: id(), at }) }) },
})

const photoBody = { view, originalName: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(100), sizeBytes: z.number().int().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }
const fileAnswer = output({ id: id(), view, sizeBytes: z.number().int(), status: z.string() })
export const photoContract = defineContract({ body: input(photoBody), response: { 201: output({ file: fileAnswer, upload: presigned }) } })
export const photoDoneContract = defineContract({ params: fileParams, response: { 200: output({ file: fileAnswer }) } })
export const photoPreviewContract = defineContract({ params: fileParams, response: { 200: output({ file: fileAnswer, preview: presigned }) } })

const decimalText = short(12)
export const sendBody = input({
  units: z.enum(MEASURE_UNITS),
  basics: input({ height: decimalText, weight: decimalText, age: decimalText }),
  values: z.record(z.string().max(60), decimalText),
  fit: input({ fit: z.enum(FITS).nullable(), posture: short(MEASURE_LIMITS.notes + 200), asymmetry: short(MEASURE_LIMITS.notes + 200) }),
  photos: input({ FRONT: id().optional(), SIDE: id().optional(), BACK: id().optional() }),
  noticeId: id(),
  typedName: z.string().trim().max(MEASURE_LIMITS.typedName).nullish(),
})
export const sendContract = defineContract({
  body: sendBody,
  response: { 201: output({ sent: output({ profileId: id(), revision: z.number().int(), at, photos: z.number().int() }), link: output({ usesLeft: z.number().int() }) }) },
})

// ---- the office ---------------------------------------------------------------------------------------------------------

export const makeLinkContract = defineContract({
  body: input({
    /** The profile to measure again (its latest revision is the link's record) … */
    profileId: id().optional(),
    /** … or a made-to-measure order line (its profile; the order's company). */
    salesOrderLineId: id().optional(),
    /** The company that asks (needed with a profile; an order line names its own). */
    companyId: id().optional(),
    contactId: id().optional(),
    email: z.string().trim().max(254).optional(),
    send: z.boolean(),
    photos: photoRule.optional(),
    language: z.enum(['it', 'en']).optional(),
    expiresInDays: z.number().int().min(1).max(60).optional(),
  }),
  response: {
    201: output({
      link: output({ id: id(), purpose: z.literal('MEASUREMENTS'), profileId: id(), expiresAt: at, email: z.string().nullable(), photos: photoRule }),
      /** The link's address, ONCE, when it was not mailed (to pass it on); never stored or logged. */
      url: z.string().nullable(),
      delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable(),
    }),
  },
})

const measurement = output({ value: z.string(), unit: z.string() })
const sentRevision = output({
  id: id(),
  revision: z.number().int(),
  supersedesId: id().nullable(),
  submittedAt: at,
  takenBy: z.string(),
  link: output({ id: id(), email: z.string().nullable(), contactId: id().nullable(), contactName: z.string().nullable() }),
  notice: output({ id: id(), label: z.string(), at }),
  measurements: z.record(z.string(), measurement),
  fitNotes: z.string().nullable(),
  photos: z.array(output({ view, fileId: id(), status: z.string() })),
  photosDeleteAfter: at.nullable(),
})
const madeLink = output({ id: id(), recordId: id(), email: z.string().nullable(), createdAt: at, expiresAt: at, uses: z.number().int(), maxUses: z.number().int(), revoked: z.boolean(), photos: photoRule })
export const sentContract = defineContract({
  params: profileParams,
  response: { 200: output({ profile: output({ id: id(), riderName: z.string(), garmentType: z.string(), latestRevision: z.number().int() }), revisions: z.array(sentRevision), links: z.array(madeLink) }) },
})
export const openPhotoContract = defineContract({ params: input({ profileId: id(), fileId: id() }), response: { 200: output({ file: output({ id: id(), view }), download: presigned }) } })
export const deleteAfterContract = defineContract({
  params: profileParams,
  body: input({ deleteAfter: at, reason: z.string().trim().min(1).max(500) }),
  response: { 200: output({ profile: output({ id: id(), photosDeleteAfter: at }) }) },
})
