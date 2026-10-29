import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ACK_CHANNELS } from '@nexus/factory-domain/privacy/events'
import { NOTICE_KINDS, NOTICE_STATUSES } from '@nexus/factory-domain/privacy/notices'
import { DPIA_STATUSES, PROCESSING_ACTIVITY_STATUSES } from '@nexus/factory-domain/privacy/records'
import { fileView, presignedView } from '../files/contract'

/**
 * The privacy pack's contracts (B-W1-36; A2 SCR-025, SCR-086, SCR-028). Lengths here only stop oversized bodies; the
 * domain answers the rules in words (factory-domain privacy/*). Counts are counts: no list ranks people.
 */

const count = () => z.number().int().min(0)
const kind = z.enum(NOTICE_KINDS)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const locale = z.string().regex(/^[a-z]{2}$/)
const version = z.number().int().min(1)

const companyRef = output({ id: id(), code: z.string(), name: z.string() })

const languageView = output({
  locale: z.string(),
  /** The text shown on screens (detail only; null: a PDF only, or the list). */
  body: z.string().nullable(),
  hasText: z.boolean(),
  /** The PDF of this language (a file of the notice), when there is one. */
  fileId: id().nullable(),
  /** SHA-256 of the text as shown, else of the PDF: what an acknowledgement stores. */
  sha256: z.string(),
})

const ackCounts = output({
  /** Who should acknowledge it: ACTIVE workers of the company's sites (worker notice) or ACTIVE office people (staff). */
  active: count(),
  acknowledged: count(),
  notAcknowledged: count(),
})

export const noticeView = output({
  id: id(),
  companyId: id(),
  kind,
  versionNo: z.number().int(),
  label: z.string(),
  status: z.enum(NOTICE_STATUSES),
  publishedAt: instant().nullable(),
  publishedById: id().nullable(),
  supersededAt: instant().nullable(),
  version: z.number().int(),
  languages: z.array(languageView),
  /** Who acknowledged this version (worker and staff notices; null for the public notice). */
  acknowledgements: ackCounts.nullable(),
})
export type NoticeView = z.infer<typeof noticeView>

const noticeParams = input({ noticeId: id() })
const textParams = input({ noticeId: id(), locale: z.string().max(8) })

export const listNoticesContract = defineContract({
  querystring: input({ companyId: id(), kind: kind.optional() }),
  response: { 200: output({ company: companyRef, notices: z.array(noticeView) }) },
})

export const getNoticeContract = defineContract({ params: noticeParams, response: { 200: output({ notice: noticeView }) } })

export const createNoticeContract = defineContract({
  body: input({
    companyId: id(),
    kind,
    /** As shown and acknowledged ("2026-10"); default v<number>. */
    label: z.string().max(200).optional(),
    /** Start from the languages (texts, not PDFs) of the version in force. Default true. */
    copyTexts: z.boolean().optional(),
  }),
  response: { 201: output({ notice: noticeView }) },
})

export const putTextContract = defineContract({
  params: textParams,
  body: input({ body: z.string().max(100_000), version }),
  response: { 200: output({ notice: noticeView }) },
})

export const deleteTextContract = defineContract({
  params: textParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ notice: noticeView }) },
})

export const deleteNoticeContract = defineContract({
  params: noticeParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ deleted: z.literal(true) }) },
})

export const publishNoticeContract = defineContract({
  params: noticeParams,
  body: input({ version }),
  response: {
    200: output({
      notice: noticeView,
      /** The version it replaced, now SUPERSEDED. */
      superseded: output({ id: id(), label: z.string() }).nullable(),
      /** What it means, in words. */
      words: z.array(z.string()),
    }),
  },
})

const personView = output({ id: id(), displayName: z.string(), siteId: id().nullable(), acknowledgedAt: instant().nullable(), channel: z.enum(ACK_CHANNELS).nullable(), locale: z.string().nullable() })

export const noticeAcksContract = defineContract({
  params: noticeParams,
  response: {
    200: output({
      notice: output({ id: id(), kind, label: z.string(), status: z.enum(NOTICE_STATUSES) }),
      counts: ackCounts.nullable(),
      /** By name only with privacy.manage (else null); sorted by name, never a ranking. */
      people: z.array(personView).nullable(),
    }),
  },
})

export const paperAckContract = defineContract({
  params: noticeParams,
  body: input({ workerId: id(), locale }),
  response: { 200: output({ acknowledgementId: id(), changed: z.boolean() }) },
})

const pdfBody = input({ originalName: z.string().min(1).max(500), contentType: z.string().min(1).max(200), sizeBytes: z.number().int().min(1), sha256: z.string() })

export const announceTextPdfContract = defineContract({ params: textParams, body: pdfBody, response: { 201: output({ file: fileView, upload: presignedView }) } })
export const completeTextPdfContract = defineContract({ params: input({ noticeId: id(), locale: z.string().max(8), fileId: id() }), response: { 200: output({ notice: noticeView, file: fileView }) } })

// --- DPIA -------------------------------------------------------------------------------------------------------------

export const dpiaView = output({
  id: id(),
  companyId: id(),
  versionNo: z.number().int(),
  scope: z.string(),
  status: z.enum(DPIA_STATUSES),
  fileId: id().nullable(),
  fileSha256: z.string().nullable(),
  signedByName: z.string().nullable(),
  signedOn: businessDate().nullable(),
  reviewDueOn: businessDate().nullable(),
  storedAt: instant().nullable(),
  supersededAt: instant().nullable(),
  version: z.number().int(),
})

export const listDpiaContract = defineContract({
  querystring: input({ companyId: id() }),
  response: { 200: output({ company: companyRef, stored: dpiaView.nullable(), versions: z.array(dpiaView) }) },
})
export const createDpiaContract = defineContract({ body: input({ companyId: id(), scope: z.string().max(5_000).optional() }), response: { 201: output({ dpia: dpiaView }) } })
const dpiaParams = input({ dpiaId: id() })
export const announceDpiaPdfContract = defineContract({ params: dpiaParams, body: pdfBody, response: { 201: output({ file: fileView, upload: presignedView }) } })
export const completeDpiaPdfContract = defineContract({ params: input({ dpiaId: id(), fileId: id() }), response: { 200: output({ dpia: dpiaView, file: fileView }) } })
export const storeDpiaContract = defineContract({
  params: dpiaParams,
  body: input({ signedByName: z.string().max(500), signedOn: businessDate(), reviewDueOn: businessDate(), version }),
  response: { 200: output({ dpia: dpiaView, superseded: id().nullable() }) },
})

// --- the record of processing activities ---------------------------------------------------------------------------------

const list = z.array(z.string().max(500)).max(100)
const text = z.string().max(5_000)
const activityFields = {
  name: text,
  purpose: text,
  legalBasis: text,
  dataSubjects: list,
  dataCategories: list,
  recipients: list,
  processors: list,
  transfers: text,
  retention: text,
  security: text,
}
export const activityView = output({
  id: id(),
  companyId: id(),
  code: z.string(),
  name: z.string(),
  purpose: z.string(),
  legalBasis: z.string(),
  dataSubjects: z.array(z.string()),
  dataCategories: z.array(z.string()),
  recipients: z.array(z.string()),
  processors: z.array(z.string()),
  transfers: z.string(),
  retention: z.string(),
  security: z.string(),
  status: z.enum(PROCESSING_ACTIVITY_STATUSES),
  version: z.number().int(),
  updatedAt: instant(),
})
export const listActivitiesContract = defineContract({
  querystring: input({ companyId: id(), status: z.enum(PROCESSING_ACTIVITY_STATUSES).optional() }),
  response: { 200: output({ company: companyRef, activities: z.array(activityView) }) },
})
export const createActivityContract = defineContract({ body: input({ companyId: id(), code: z.string().max(100), ...activityFields }), response: { 201: output({ activity: activityView }) } })
const activityParams = input({ activityId: id() })
export const patchActivityContract = defineContract({
  params: activityParams,
  body: input({ version, ...Object.fromEntries(Object.entries(activityFields).map(([key, schema]) => [key, schema.optional()])) } as { version: typeof version } & {
    [Key in keyof typeof activityFields]: z.ZodOptional<(typeof activityFields)[Key]>
  }),
  response: { 200: output({ activity: activityView }) },
})
export const archiveActivityContract = defineContract({ params: activityParams, body: input({ version }), response: { 200: output({ activity: activityView }) } })

// --- the overview (SCR-086 "Your privacy duties") ------------------------------------------------------------------------

const inForceView = output({ id: id(), label: z.string(), publishedAt: instant().nullable() }).nullable()
export const overviewContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: {
    200: output({
      companies: z.array(
        output({
          company: companyRef,
          duties: z.array(output({ key: z.enum(['register', 'publicNotice', 'staffNotice', 'workerNotice', 'dpia']), done: z.boolean(), words: z.string() })),
          notices: output({ WORKER_FLOOR: inForceView, OFFICE_STAFF: inForceView, PRIVACY_PUBLIC: inForceView }),
          dpia: output({ id: id(), versionNo: z.number().int(), signedOn: businessDate().nullable(), reviewDueOn: businessDate().nullable() }).nullable(),
          activities: count(),
          /** Each site of the company: may real floor work start (the privacy gate and the floor rules), in words. */
          sites: z.array(output({ id: id(), code: z.string(), name: z.string(), readyForFloor: z.boolean(), notes: z.array(z.string()) })),
        }),
      ),
    }),
  },
})

// --- the people's notices: the floor's worker notice, the office's staff notice, the public notice ------------------------

/** What the tablet does with the signed-in worker (sign-in, /floor/me). */
export const workerNoticeGateView = output({
  noticeId: id().nullable(),
  label: z.string().nullable(),
  acknowledged: z.boolean(),
  /** A version is in force and not yet acknowledged: the tablet opens it after sign-in. */
  due: z.boolean(),
  /** The site names workers and this worker may not be named yet: scan tiles are held ("Read the notice first"). */
  blocksScans: z.boolean(),
})

const shownNotice = output({
  id: id(),
  kind,
  label: z.string(),
  versionNo: z.number().int(),
  publishedAt: instant().nullable(),
  /** The language shown: the reader's, else Italian, else English. */
  locale: z.string(),
  body: z.string(),
  /** SHA-256 of the text shown: send it back with the acknowledgement. */
  sha256: z.string(),
  /** The languages it has on screen. */
  languages: z.array(z.string()),
  /** false: the reader's language is not ready on screen (a paper copy in their language comes from HR). */
  languageReady: z.boolean(),
})

export const floorNoticeContract = defineContract({
  querystring: input({ locale: locale.optional() }),
  response: { 200: output({ notice: shownNotice.nullable(), gate: workerNoticeGateView, means: z.string() }) },
})

const ackBody = input({ noticeId: id(), locale, sha256, deviceTime: instant().optional() })
export const floorAckContract = defineContract({ body: ackBody, response: { 200: output({ acknowledged: z.literal(true), changed: z.boolean(), gate: workerNoticeGateView }) } })

export const staffNoticeContract = defineContract({
  querystring: input({ locale: locale.optional() }),
  response: { 200: output({ companyId: id().nullable(), notice: shownNotice.nullable(), acknowledged: z.boolean(), means: z.string() }) },
})
export const staffAckContract = defineContract({
  body: input({ noticeId: id(), locale, sha256 }),
  response: { 200: output({ acknowledged: z.literal(true), changed: z.boolean() }) },
})

export const publicNoticeContract = defineContract({
  params: input({ companyId: z.string().max(64) }),
  querystring: input({ locale: locale.optional() }),
  response: { 200: output({ company: output({ id: id(), name: z.string() }), notice: shownNotice }) },
})
