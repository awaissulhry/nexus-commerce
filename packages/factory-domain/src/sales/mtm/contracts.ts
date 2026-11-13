import { z } from 'zod'
import { businessDate, id, input, instant, output, unitPrice } from '../../core/contracts'
import { money } from '../../money/marked'
import { PRODUCT_TYPES } from '../../product/styles/rules'
import { MTM_LINE_CODES } from './codes'
import { MTM_OFFICE_LIMITS, REVIEW_DECISIONS, REVIEW_STATUSES } from './rules'

/**
 * The made-to-measure office's contracts (B-W2b-358): what apps/factory-api's modules/sales/mtm, quotes/mtm-line.ts and
 * product/measures/templates-write.ts accept and answer. No money but a quote line's typed price (the price grain, as W1's
 * lines). Values travel as plain decimal strings in their unit ("102.5"); body data are office reads only.
 */

const text = (max: number) => z.string().trim().min(1).max(max)
const oneLine = (max: number) => text(max).refine((value) => !/[\r\n]/.test(value), { message: 'One line.' })
const code = () => z.string().trim().min(1).max(60)
const nameWords = z.record(z.string().max(16), z.string().max(200))

// ---- rider profiles -------------------------------------------------------------------------------------------------------

const measured = {
  /** Per point of the template ("chest": "102.5"), in the point's unit; plus "height" (cm) and "weight" (kg). */
  measurements: z.record(z.string().max(60), z.string().trim().max(12)),
  /** The points outside their plausible range the person checked again (else they are asked again, in words). */
  confirmedOutside: z.array(code()).max(MTM_OFFICE_LIMITS.values).optional(),
  /** The standard size it is closest to, when known (a size of the style's range on a quote line). */
  baseSize: z.string().trim().min(1).max(20).nullish(),
  /** Fit, posture, asymmetry: the rider may read them. */
  fitNotes: text(MTM_OFFICE_LIMITS.notes).nullish(),
  /** The office's only. */
  internalNote: text(MTM_OFFICE_LIMITS.notes).nullish(),
  /** When the rider was measured (not in the future). */
  takenAt: instant(),
  /** Who measured, as written (a dealer's fitter, the rider); default: the office person who measured. */
  takenBy: oneLine(MTM_OFFICE_LIMITS.takenBy).optional(),
  /** SAL-291: the office person of ours who measured (an active office user); null: none of ours. */
  measuredByUserId: id().nullish(),
  /** SAL-291: where ("Showroom", "Mugello paddock"). */
  measuredPlace: oneLine(MTM_OFFICE_LIMITS.place).nullish(),
}

/** POST /sales/mtm/profiles: revision 1 of a rider's garment type. */
export const newProfileBody = input({
  partyId: id(),
  /** The rider as a contact of the customer (role RIDER), when known. */
  contactId: id().nullish(),
  riderName: oneLine(MTM_OFFICE_LIMITS.rider),
  /** The measurement template's code. */
  garmentType: code(),
  ...measured,
  /** GDPR art. 13: the notice the rider was given before any value, and when. */
  privacyNoticeRef: oneLine(MTM_OFFICE_LIMITS.noticeRef),
  privacyNoticeAt: instant(),
})
export type NewProfileBody = z.output<typeof newProfileBody>

/** POST /sales/mtm/profiles/:profileId/revisions: the next revision (the notice: the newest revision's unless sent). */
export const newRevisionBody = input({
  ...measured,
  privacyNoticeRef: oneLine(MTM_OFFICE_LIMITS.noticeRef).optional(),
  privacyNoticeAt: instant().optional(),
})
export type NewRevisionBody = z.output<typeof newRevisionBody>

export const profilesQuery = input({
  q: z.string().trim().max(100).optional(),
  partyId: id().optional(),
  garmentType: code().optional(),
  review: z.enum(REVIEW_STATUSES).optional(),
  /** Only the riders measured more than 12 months ago. */
  old: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
})
export type ProfilesQuery = z.output<typeof profilesQuery>

const reviewView = output({
  status: z.enum(REVIEW_STATUSES),
  by: output({ id: id(), name: z.string() }).nullable(),
  at: z.string().nullable(),
  note: z.string().nullable(),
})

export const profileRowView = output({
  /** The newest revision of the rider's garment type. */
  id: id(),
  partyId: id(),
  customer: output({ code: z.string(), name: z.string() }),
  contactId: id().nullable(),
  riderName: z.string(),
  garmentType: z.string(),
  revision: z.number().int(),
  takenAt: z.string(),
  takenBy: z.string(),
  measuredPlace: z.string().nullable(),
  baseSize: z.string().nullable(),
  review: output({ status: z.enum(REVIEW_STATUSES), at: z.string().nullable() }),
  byLink: z.boolean(),
  privacyNoticeAt: z.string(),
  /** Measured more than 12 months ago (re-measure before a repeat order). */
  old: z.boolean(),
  /** Made-to-measure order lines of open orders made to any revision of the rider's garment type. */
  openUnits: z.number().int(),
  /** The earliest BOOKED fitting of any revision (B-W2b-360's appointments); null: none. */
  nextFittingAt: z.string().nullable(),
})

export const profilesView = output({
  rows: z.array(profileRowView),
  /** The riders matching the filters (the rows are a page of them). */
  matching: z.number().int(),
  tiles: output({ waitingReview: z.number().int(), needMore: z.number().int(), older: z.number().int(), fittingsThisWeek: z.number().int(), outsideRange: z.null() }),
  asOf: z.string(),
})

export const revisionView = output({
  id: id(),
  revision: z.number().int(),
  supersedesId: id().nullable(),
  measurements: z.record(z.string(), output({ value: z.string(), unit: z.string() })),
  baseSize: z.string().nullable(),
  fitNotes: z.string().nullable(),
  internalNote: z.string().nullable(),
  takenAt: z.string(),
  takenBy: z.string(),
  measuredBy: output({ id: id(), name: z.string() }).nullable(),
  measuredPlace: z.string().nullable(),
  privacyNoticeRef: z.string(),
  privacyNoticeAt: z.string(),
  byLink: z.boolean(),
  submittedAt: z.string().nullable(),
  photos: z.number().int(),
  review: reviewView,
  old: z.boolean(),
  createdAt: z.string(),
})

const checksView = output({
  /** The template's made-to-measure rules are on (else nothing was checked, GATE-MTM). */
  on: z.boolean(),
  warnings: z.array(output({ code: z.string(), pointCode: z.string(), message: z.string() })),
  blocks: z.array(output({ path: z.string(), message: z.string() })),
})

export const unitView = output({
  kind: z.enum(['QUOTE', 'ORDER']),
  lineId: id(),
  documentId: id(),
  number: z.string(),
  status: z.string(),
  profileId: id(),
  revision: z.number().int(),
  style: output({ id: id(), code: z.string() }),
  colourway: output({ id: id(), code: z.string() }),
  baseSize: z.string().nullable(),
  at: z.string(),
})

export const worksheetVersionView = output({
  id: id(),
  /** The revision it prints. */
  profileId: id(),
  revision: z.number().int(),
  version: z.number().int(),
  companyId: id(),
  language: z.string(),
  number: z.string().nullable(),
  fileId: id(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
})

export const profileRecordView = output({
  id: id(),
  partyId: id(),
  customer: output({ code: z.string(), name: z.string() }),
  contactId: id().nullable(),
  riderName: z.string(),
  garmentType: z.string(),
  latestId: id(),
  /** Newest first. */
  revisions: z.array(revisionView),
  template: output({
    id: id(),
    code: z.string(),
    name: z.string(),
    rulesOn: z.boolean(),
    points: z.array(output({ code: z.string(), name: z.string(), uom: z.string(), required: z.boolean(), minValue: z.string().nullable(), maxValue: z.string().nullable(), howTo: z.string().nullable(), status: z.string() })),
  }).nullable(),
  /** The newest revision's factory review: may the caller decide, why not, what the checks flag. */
  review: output({
    may: output({ confirm: z.boolean(), askMore: z.boolean() }),
    why: z.string().nullable(),
    checks: checksView,
    /** Points of the newest revision outside their plausible range (kept because the person checked them). */
    outside: z.array(z.string()),
    /** An address is known to mail "need more" to. */
    mailTo: z.boolean(),
  }),
  units: z.array(unitView),
  worksheets: z.array(worksheetVersionView),
  nextFittingAt: z.string().nullable(),
  may: output({ record: z.boolean(), worksheet: z.boolean() }),
})

export const recordedView = output({ profile: revisionView, checks: checksView })

/** POST /sales/mtm/profiles/:profileId/review. */
export const reviewBody = input({
  decision: z.enum(REVIEW_DECISIONS),
  /** NEED_MORE: what more is needed (required; mailed to the rider or dealer). CONFIRM: design notes (optional). */
  note: z.string().max(MTM_OFFICE_LIMITS.review).nullish(),
  /** NEED_MORE: mail the words (FAKE locally) when an address is known; default true. */
  notify: z.boolean().default(true),
  language: z.enum(['it', 'en']).optional(),
  /** NEED_MORE: the company the mail goes from; default: the revision's link's, else the newest unit's. */
  companyId: id().optional(),
})
export type ReviewBody = z.output<typeof reviewBody>

export const reviewedView = output({
  profile: revisionView,
  mailed: z.boolean(),
  delivery: z.string().nullable(),
  /** CONFIRM: the orders that waited only for this review and went on (PENDING_APPROVAL → CONFIRMED). */
  ordersGoneOn: z.array(output({ id: id(), number: z.string() })),
})

/** GET /sales/mtm/profiles/:profileId/repeat: what a repeat order would use (SAL-300). */
export const repeatView = output({
  latest: output({ id: id(), revision: z.number().int(), takenAt: z.string(), takenOn: businessDate(), months: z.number().int(), old: z.boolean(), review: z.enum(REVIEW_STATUSES) }),
  /** Why a new measure is asked first (measured more than 12 months ago); null: none. */
  reMeasure: z.string().nullable(),
  /** The made-to-measure units made to the rider's garment type, newest first: what a repeat copies. */
  earlier: z.array(unitView),
})

/** POST /sales/mtm/profiles/:profileId/repeat: a made-to-measure unit like an earlier one, on the newest revision, on a DRAFT quote. */
export const repeatBody = input({
  quoteId: id(),
  /** The quote's version (as every quote write). */
  version: z.number().int().min(1),
  /** The earlier made-to-measure quote or order line to copy (style, colourway, base size); default: the newest. */
  fromLineId: id().optional(),
  /** The measures are old and the person orders on them anyway (said in the audit). */
  measuredOk: z.boolean().default(false),
})
export type RepeatBody = z.output<typeof repeatBody>

/** POST /sales/mtm/profiles/:profileId/worksheets. */
export const worksheetBody = input({
  /** The company whose papers it is (its letterhead). */
  companyId: id(),
  language: z.enum(['it', 'en']).optional(),
})

// ---- made-to-measure quote lines ------------------------------------------------------------------------------------------

/** POST /sales/quotes/:quoteId/lines/made-to-measure (W1's POST …/lines with kind MADE_TO_MEASURE comes here too). */
export const mtmLineBody = input({
  version: z.number().int().min(1),
  styleId: id(),
  colourwayId: id(),
  styleRevisionId: id().nullish(),
  /** The rider's newest revision (of the quote's customer). */
  measurementProfileId: id(),
  /** A size of the style's range; default: the size the measures point to (the template's base size rule). */
  baseSize: z.string().trim().min(1).max(20).nullish(),
  unitPrice: money.price(unitPrice().nullish()),
  listUnitPrice: money.price(unitPrice().nullish()),
  discountPct: z.string().trim().max(12).nullish(),
  description: text(500).nullish(),
  note: text(2000).nullish(),
})
export type MtmLineBody = z.output<typeof mtmLineBody>

/** PATCH /sales/quotes/:quoteId/lines/:lineId/made-to-measure: a DRAFT unit's revision, base size, colourway, price, words. */
export const mtmLineEditBody = input({
  version: z.number().int().min(1),
  colourwayId: id().optional(),
  styleRevisionId: id().nullish(),
  /** Another revision of the same rider and garment type: the newest. */
  measurementProfileId: id().optional(),
  baseSize: z.string().trim().min(1).max(20).nullish(),
  unitPrice: money.price(unitPrice().nullish()),
  listUnitPrice: money.price(unitPrice().nullish()),
  discountPct: z.string().trim().max(12).nullish(),
  description: text(500).nullish(),
  note: text(2000).nullish(),
})
export type MtmLineEditBody = z.output<typeof mtmLineEditBody>

/** POST /sales/quotes/:quoteId/lines/:lineId/out-of-chart (SAL-276): a size outside the chart becomes a made-to-measure unit. */
export const outOfChartBody = input({
  version: z.number().int().min(1),
  /** The size the customer asked that the style's range does not have ("62"). */
  size: z.string().trim().min(1).max(20),
  /** The rider's newest revision. */
  measurementProfileId: id(),
  baseSize: z.string().trim().min(1).max(20).nullish(),
})
export type OutOfChartBody = z.output<typeof outOfChartBody>

export const lineFindingView = output({ code: z.enum(MTM_LINE_CODES), severity: z.enum(['BLOCKS', 'WARNING']), message: z.string() })

/** GET /sales/quotes/:quoteId/made-to-measure, GET /sales/orders/:orderId/made-to-measure. */
export const documentUnitsView = output({
  kind: z.enum(['QUOTE', 'ORDER']),
  id: id(),
  number: z.string(),
  status: z.string(),
  /** An order that waits (PENDING_APPROVAL) while a unit's measures are not confirmed. */
  waitsForReview: z.boolean(),
  units: z.array(
    output({
      lineId: id(),
      seq: z.number().int(),
      style: output({ id: id(), code: z.string() }),
      colourway: output({ id: id(), code: z.string() }),
      baseSize: z.string().nullable(),
      profile: output({ id: id(), riderName: z.string(), garmentType: z.string(), revision: z.number().int(), latestRevision: z.number().int(), review: z.enum(REVIEW_STATUSES), takenAt: z.string() }),
      verdict: z.enum(['OK', 'WARN', 'BLOCK']),
      suggestedBaseSize: z.string().nullable(),
      insideCertifiedRange: z.boolean().nullable(),
      findings: z.array(lineFindingView),
    }),
  ),
})

// ---- measurement templates (B-W1-17) ------------------------------------------------------------------------------------

export const templatePointBody = input({
  /** Its key in a profile and in a size's body measures ("chest"), unique in the template; a point keeps its id while its code stays. */
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/, { message: 'A code of letters, digits, _ . and -, no spaces ("chest", "back_length").' }),
  name: oneLine(200),
  nameI18n: nameWords.nullish(),
  uom: z.enum(['CM', 'MM']).default('CM'),
  minValue: z.string().trim().max(12).nullish(),
  maxValue: z.string().trim().max(12).nullish(),
  required: z.boolean().default(true),
  howTo: text(2000).nullish(),
  /** The library's BODY point of measure it is (its zone, picture and words). */
  pointOfMeasureId: id().nullish(),
})
export type TemplatePointBody = z.output<typeof templatePointBody>

export const newTemplateBody = input({
  /** null: every company's (tenant-wide master data). */
  companyId: id().nullable().default(null),
  /** The garment type, unique in the tenant ("JACKET"): fixed once a profile names it. */
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_-]{0,39}$/, { message: 'A code of capital letters, digits, _ and - ("JACKET", "RACE_SUIT").' }),
  name: oneLine(200),
  nameI18n: nameWords.nullish(),
  productType: z.enum(PRODUCT_TYPES),
  instructions: text(4000).nullish(),
  points: z.array(templatePointBody).min(1).max(60),
})
export type NewTemplateBody = z.output<typeof newTemplateBody>

export const editTemplateBody = input({
  version: z.number().int().min(1),
  name: oneLine(200).optional(),
  nameI18n: nameWords.nullish(),
  productType: z.enum(PRODUCT_TYPES).optional(),
  instructions: text(4000).nullish(),
})
export type EditTemplateBody = z.output<typeof editTemplateBody>

/** PUT …/points: the whole list in its order (kept by code, changed, added; a point left out is archived, never deleted). */
export const templatePointsBody = input({ version: z.number().int().min(1), points: z.array(templatePointBody).min(1).max(60) })
export type TemplatePointsBody = z.output<typeof templatePointsBody>

export const templateMoveBody = input({ version: z.number().int().min(1) })

export const templateView = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()),
  productType: z.enum(PRODUCT_TYPES),
  instructions: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  rulesOn: z.boolean(),
  /** B-W2b-248's words for the rules ("Off (nothing is checked) · 2 rules (1 blocking) · …"). */
  rulesSummary: z.string(),
  version: z.number().int(),
  updatedAt: z.string(),
  points: z.array(
    output({
      id: id(),
      code: z.string(),
      name: z.string(),
      nameI18n: z.record(z.string(), z.string()),
      seq: z.number().int(),
      uom: z.string(),
      minValue: z.string().nullable(),
      maxValue: z.string().nullable(),
      required: z.boolean(),
      howTo: z.string().nullable(),
      pointOfMeasureId: id().nullable(),
      status: z.enum(['ACTIVE', 'ARCHIVED']),
      /** Active rules check or compare it (it is not archived while they do). */
      rules: z.number().int(),
    }),
  ),
  /** Styles measured with it, and those made to measure. */
  styles: output({ measured: z.number().int(), madeToMeasure: z.number().int() }),
  /** Rider profile revisions measured for its garment type. */
  profiles: z.number().int(),
  editable: z.boolean(),
  refusal: z.string().nullable(),
})
