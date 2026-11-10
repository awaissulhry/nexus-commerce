import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { SAMPLE_DECISION_VIAS, SAMPLE_DECISIONS, SAMPLE_KINDS, SAMPLE_LIMITS, SAMPLE_STAGES, SAMPLE_TEST_RESULTS } from '../samples/rules'
import { DECISION_LIMITS, DECISION_REFUSALS, SWATCH_KINDS } from './rules'

/**
 * Sample decisions' contracts (B-W2b-252): what apps/factory-api's modules/sales/sample-decisions accepts and answers. A
 * refusal is a 409 whose issue is `refusal/<CODE>` (DECISION_REFUSALS) with the words. No money anywhere (the round's charge
 * stays B-W2b-246's). People as user ids, a name only inside one record (who decided in the office, who answered in the
 * portal: the typed name). Measures travel as plain decimal strings ("65.8") in the point's unit.
 */

const version = () => z.number().int().min(1)
const words = (max: number) => z.string().trim().min(1).max(max)
const measure = () => z.string().trim().min(1).max(12)
export const decisionRefusal = output({ code: z.enum(DECISION_REFUSALS), message: z.string() })
const action = output({ allowed: z.boolean(), refusal: decisionRefusal.nullable(), needs: z.string().nullable() })

export const roundParams = input({ roundId: id() })
export const commentParams = input({ commentId: id() })
export const swatchParams = input({ swatchId: id() })
export const versionQuery = input({ version: z.coerce.number().int().min(1) })

// ---- the decision (SAL-312) ---------------------------------------------------------------------------------------------

/** "Decide on the sample" (Record decision): on the round's pinned revision; comments say why for the last two. */
export const decisionBody = input({
  version: version(),
  decision: z.enum(SAMPLE_DECISIONS),
  comments: words(DECISION_LIMITS.comments).optional(),
})
export type DecisionBody = z.output<typeof decisionBody>

/** "Make round N" after a rejection: the same style, kind, brand and cells; what differs. */
export const nextRoundBody = input({
  /** The rejected round's version as read. */
  version: version().optional(),
  /** Default: the style's newest revision that is not obsolete. */
  revisionId: id().optional(),
  dueDate: businessDate().optional(),
  /** Default: "Round N rejected: <the comments>". */
  instructions: words(SAMPLE_LIMITS.instructions).optional(),
})
export type NextRoundBody = z.output<typeof nextRoundBody>

/** The notified body's result of a CE test sample and the certificate it led to (each once; at least one). */
export const testResultBody = input({
  version: version(),
  testResult: z.enum(SAMPLE_TEST_RESULTS).optional(),
  certificateId: id().optional(),
})
export type TestResultBody = z.output<typeof testResultBody>

const person = output({ id: id(), name: z.string() })
const revisionRef = output({ id: id(), revision: z.number().int(), status: z.string() })

export const swatchView = output({
  id: id(),
  styleId: id(),
  style: output({ code: z.string(), name: z.string() }),
  roundId: id().nullable(),
  roundNumber: z.string().nullable(),
  party: output({ id: id(), code: z.string(), name: z.string() }),
  kind: z.enum(SWATCH_KINDS),
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string() }),
  itemColour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  lot: output({ id: id(), siteId: id(), code: z.string() }).nullable(),
  note: z.string().nullable(),
  sentAt: instant().nullable(),
  approvalRequestId: id().nullable(),
  decision: z.enum(SAMPLE_DECISIONS).nullable(),
  decisionComments: z.string().nullable(),
  decidedAt: instant().nullable(),
  decidedVia: z.enum(SAMPLE_DECISION_VIAS).nullable(),
  /** Who recorded it in the office, or the brand's portal person (inside the record only); null by link. */
  decidedBy: person.nullable(),
  /** The brand's typed name when it answered by link or portal. */
  signedAs: z.string().nullable(),
  /** OPEN: the brand is asked and has not answered yet. */
  waiting: output({ requestId: id(), dueAt: instant() }).nullable(),
  /** The swatch's company (its round's or its style's); null: a tenant-wide style's swatch of no round. */
  companyId: id().nullable(),
  actions: output({ edit: action, send: action, remove: action, decide: action, ask: action }),
  createdAt: instant(),
  version: z.number().int(),
})
export type SwatchView = z.output<typeof swatchView>

/** The round's Approval tab: the decision, the brand's request, the swatches, the CE test sample, what may happen now. */
export const approvalView = output({
  round: output({
    id: id(),
    number: z.string(),
    kind: z.enum(SAMPLE_KINDS),
    roundNo: z.number().int(),
    stage: z.enum(SAMPLE_STAGES),
    partyId: id().nullable(),
    styleId: id(),
    /** The pinned revision the decision is on ("On revision N"). */
    revision: revisionRef,
    version: z.number().int(),
  }),
  decision: output({
    decision: z.enum(SAMPLE_DECISIONS),
    comments: z.string().nullable(),
    at: instant(),
    via: z.enum(SAMPLE_DECISION_VIAS),
    /** OFFICE: who recorded it; PORTAL: the brand's person; LINK: null. */
    by: person.nullable(),
    /** The brand's typed name (PORTAL, LINK). */
    signedAs: z.string().nullable(),
    revision: z.number().int(),
  }).nullable(),
  /** The round's latest approval request to its brand (its full detail: GET /approvals-out/:id). */
  request: output({ id: id(), status: z.string(), dueAt: instant(), answeredAt: instant().nullable(), createdAt: instant(), version: z.number().int() }).nullable(),
  swatches: z.array(swatchView),
  /** CERTIFICATION only (PRD-158): who it was sent to (its outbound shipments' parties), the zones, the result, the certificate. */
  certification: output({
    sentTo: z.array(output({ id: id(), code: z.string(), name: z.string(), sentAt: instant().nullable(), receivedAt: instant().nullable() })),
    testZones: z.string().nullable(),
    testResult: z.enum(SAMPLE_TEST_RESULTS).nullable(),
    certificate: output({ id: id(), number: z.string(), standard: z.string(), notifiedBodyNumber: z.string(), validTo: businessDate(), status: z.string() }).nullable(),
  }).nullable(),
  /** The change requests the round raised (product.changes.view; null without it). */
  changeRequests: z.array(output({ id: id(), number: z.string().nullable(), status: z.string(), title: z.string() })).nullable(),
  actions: output({ decide: action, askBrand: action, nextRound: action, testResult: action, raiseChangeRequest: action }),
})
export type ApprovalView = z.output<typeof approvalView>

// ---- the fit (PRD-070) --------------------------------------------------------------------------------------------------

/** One cell of the grid saved (autosave per cell, or a pasted column): measured null clears the value (and the row with no note). */
export const fitCellBody = input({
  pointOfMeasureId: id(),
  size: z.string().trim().min(1).max(SAMPLE_LIMITS.size),
  measured: measure().nullable(),
  note: words(DECISION_LIMITS.fitNote).nullable().optional(),
  /** The cell's version as read (left out for a new cell). */
  version: version().optional(),
})
export const fitSaveBody = input({ cells: z.array(fitCellBody).min(1).max(DECISION_LIMITS.fitCells) })
export type FitSaveBody = z.output<typeof fitSaveBody>

export const commentBody = input({
  /** A point of measure of the round's revision spec; left out: a body area or the whole sample. */
  pointOfMeasureId: id().optional(),
  bodyArea: words(DECISION_LIMITS.bodyArea).optional(),
  text: words(DECISION_LIMITS.commentText),
})
export type CommentBody = z.output<typeof commentBody>

/** A comment changed while the round is open; `resolved` moves at any time. */
export const updateCommentBody = input({
  version: version(),
  text: words(DECISION_LIMITS.commentText).optional(),
  bodyArea: words(DECISION_LIMITS.bodyArea).nullable().optional(),
  resolved: z.boolean().optional(),
})
export type UpdateCommentBody = z.output<typeof updateCommentBody>

const measured = output({
  id: id(),
  /** Frozen from the spec when it was first written. */
  nominal: z.string(),
  toleranceMinus: z.string(),
  tolerancePlus: z.string(),
  measured: z.string().nullable(),
  /** measured − nominal, signed ("+1.3"). */
  difference: z.string().nullable(),
  pass: z.boolean().nullable(),
  measuredAt: instant().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
})

export const commentView = output({
  id: id(),
  pointOfMeasureId: id().nullable(),
  pomCode: z.string().nullable(),
  bodyArea: z.string().nullable(),
  text: z.string(),
  resolved: z.boolean(),
  resolvedAt: instant().nullable(),
  resolvedBy: person.nullable(),
  createdBy: person.nullable(),
  createdAt: instant(),
  /** Its photos (StoredFile PHOTO of record type SampleComment, available). */
  photos: z.array(output({ id: id(), originalName: z.string(), contentType: z.string() })),
  version: z.number().int(),
})
export type CommentView = z.output<typeof commentView>

/** The round's Fit & comments tab: points of the revision's spec × the round's sizes, what was measured, the comments. */
export const fitView = output({
  round: output({ id: id(), number: z.string(), stage: z.enum(SAMPLE_STAGES), revision: revisionRef, companyId: id(), version: z.number().int() }),
  /** The revision's live measurement spec (an approved one, or the draft a proto or fit round is made against); null: none. */
  spec: output({ id: id(), status: z.string(), baseSize: z.string() }).nullable(),
  sizes: z.array(z.string()),
  points: z.array(
    output({
      pointOfMeasureId: id().nullable(),
      code: z.string(),
      name: z.string(),
      uom: z.string(),
      /** In the spec now (false: a value measured earlier against a point the spec no longer has). */
      inSpec: z.boolean(),
      cells: z.array(
        output({
          size: z.string(),
          /** The spec's value now (null: none for this size). */
          spec: output({ nominal: z.string(), toleranceMinus: z.string(), tolerancePlus: z.string() }).nullable(),
          measurement: measured.nullable(),
        }),
      ),
    }),
  ),
  /** Values outside their tolerance, listed above the grid. */
  outside: z.array(output({ pomCode: z.string(), size: z.string(), measured: z.string(), nominal: z.string(), difference: z.string(), words: z.string() })),
  measuredCount: z.number().int(),
  comments: z.array(commentView),
  openComments: z.number().int(),
  /** The cells and comments may be written now (else why, in words). */
  editable: z.boolean(),
  refusal: decisionRefusal.nullable(),
})
export type FitView = z.output<typeof fitView>

// ---- swatches (SAL-314) -------------------------------------------------------------------------------------------------

export const swatchListQuery = input({
  styleId: id().optional(),
  roundId: id().optional(),
  partyId: id().optional(),
  kind: z.enum(SWATCH_KINDS).optional(),
  /** OPEN: not decided yet; DECIDED: decided. */
  state: z.enum(['OPEN', 'DECIDED']).optional(),
  limit: z.coerce.number().int().min(1).max(DECISION_LIMITS.list).optional(),
})
export type SwatchListQuery = z.output<typeof swatchListQuery>

export const createSwatchBody = input({
  styleId: id(),
  /** A round of the style (its brand's); left out: the style's. */
  roundId: id().optional(),
  /** The brand it goes to; default: the round's brand (a style's swatch names it). */
  partyId: id().optional(),
  kind: z.enum(SWATCH_KINDS),
  /** The material (a leather for a LEATHER swatch), its colour and/or one of its lots (at least one). */
  itemId: id(),
  itemColourId: id().optional(),
  lotId: id().optional(),
  note: words(DECISION_LIMITS.swatchNote).optional(),
  /** Sent already (not in the future). */
  sentAt: instant().optional(),
})
export type CreateSwatchBody = z.output<typeof createSwatchBody>

/** What was sent changes until it is sent; the note at any time; sentAt once. */
export const updateSwatchBody = input({
  version: version(),
  itemColourId: id().nullable().optional(),
  lotId: id().nullable().optional(),
  note: words(DECISION_LIMITS.swatchNote).nullable().optional(),
  sentAt: instant().optional(),
})
export type UpdateSwatchBody = z.output<typeof updateSwatchBody>

export const swatchList = output({ rows: z.array(swatchView), complete: z.boolean() })
