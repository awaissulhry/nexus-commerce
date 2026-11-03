import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { AMEND_LIMITS, AMENDED_RECORDS, AMENDED_ROWS, AMENDMENT_STATES } from '@nexus/factory-domain/quality/amendments/rules'

/**
 * Locked results with amendments (B-W2b-123; QHS-145). Office only; every write takes an Idempotency-Key. Refusals in
 * words: `body/<field>` (400), `refusal/<CODE>` in issues[0].path (409): NOT_SIGNED (the record is not signed yet),
 * VERDICT (the correction would change whether a line passes), WAITING (a correction of the field waits already),
 * SAME_PERSON (who asked never answers), STALE (the value moved since it was asked), ANSWERED; a missing step-up code: 403
 * with issue path `stepUp`. Values are text (a decimal as "58.400"); no money anywhere; office people by id with their
 * names; no worker.
 */

const person = output({ id: id(), name: z.string().nullable() })
const rowRef = output({ type: z.enum(AMENDED_ROWS), id: id(), label: z.string() })
const record = output({ type: z.enum(AMENDED_RECORDS), id: id(), label: z.string() })
const fieldKind = z.enum(['note', 'text', 'value', 'decimal', 'zone', 'cause'])

export const correctionView = output({
  id: id(),
  /** Its number once signed (A1, A2 … in the order they were signed); null while waiting or refused. */
  ref: z.number().int().nullable(),
  field: z.string(),
  fieldWords: z.string(),
  row: rowRef.nullable(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  beforeWords: z.string(),
  afterWords: z.string(),
  reason: z.string(),
  state: z.enum(AMENDMENT_STATES),
  stateWords: z.string(),
  askedBy: person,
  askedAt: instant(),
  signatureSha256: z.string(),
  /** The caller asked for it (so may not answer it). */
  mine: z.boolean(),
  answer: output({ id: id(), kind: z.enum(['SIGNED', 'REFUSED']), by: person, at: instant(), reason: z.string().nullable(), signatureSha256: z.string() }).nullable(),
})

export const fieldView = output({
  field: z.string(),
  row: rowRef.nullable(),
  kind: fieldKind,
  words: z.string(),
  /** What stands now (the record with its signed corrections). */
  value: z.string().nullable(),
  valueWords: z.string(),
  nullable: z.boolean(),
  /** The signed correction that set it, or null (the record's own value). */
  amendedBy: id().nullable(),
  /** A correction of it waiting for the second signature, or null. */
  waiting: id().nullable(),
  choices: z.array(z.string()).optional(),
})

export const amendmentsView = output({
  record: output({ type: z.enum(AMENDED_RECORDS), id: id(), label: z.string(), status: z.string(), signed: z.boolean(), companyId: id(), siteId: id(), amended: z.boolean() }),
  corrections: z.array(correctionView),
  fields: z.array(fieldView),
  waiting: z.number().int(),
  words: output({ locked: z.string(), waiting: z.string() }),
  may: output({ request: z.boolean(), sign: z.boolean() }),
})

const inspectionParams = input({ inspectionId: id() })
const checkParams = input({ checkId: id() })
const requestBody = input({
  field: z.string().min(1).max(80),
  row: input({ type: z.enum(AMENDED_ROWS), id: id() }).nullable().optional(),
  /** The new value as text; null clears a field that may be empty. */
  after: z.string().max(AMEND_LIMITS.note).nullable(),
  reason: z.string().min(1).max(AMEND_LIMITS.reason),
})
const written = output({ amendmentId: id(), amendments: amendmentsView })
const answered = output({ answerId: id(), amendments: amendmentsView })

export const inspectionAmendmentsContract = defineContract({ params: inspectionParams, response: { 200: amendmentsView } })
export const requestInspectionContract = defineContract({ params: inspectionParams, body: requestBody, response: { 201: written } })
export const incomingAmendmentsContract = defineContract({ params: inspectionParams, response: { 200: amendmentsView } })
export const requestIncomingContract = defineContract({ params: inspectionParams, body: requestBody, response: { 201: written } })
export const checkAmendmentsContract = defineContract({ params: checkParams, response: { 200: amendmentsView } })
export const requestCheckContract = defineContract({ params: checkParams, body: requestBody, response: { 201: written } })

export const queueContract = defineContract({
  querystring: input({ state: z.enum([...AMENDMENT_STATES, 'all']).optional(), recordType: z.enum(AMENDED_RECORDS).optional(), limit: z.coerce.number().int().min(1).max(AMEND_LIMITS.list).optional() }),
  response: {
    200: output({
      state: z.string(),
      amendments: z.array(
        output({
          id: id(),
          record,
          field: z.string(),
          fieldWords: z.string(),
          rowType: z.enum(AMENDED_ROWS).nullable(),
          state: z.enum(AMENDMENT_STATES),
          stateWords: z.string(),
          askedBy: person,
          askedAt: instant(),
          answeredBy: person.nullable(),
          answeredAt: instant().nullable(),
          mine: z.boolean(),
          maySign: z.boolean(),
        }),
      ),
    }),
  },
})

const amendmentParams = input({ amendmentId: id() })
export const signContract = defineContract({ params: amendmentParams, body: input({}).optional(), response: { 201: answered } })
export const refuseContract = defineContract({ params: amendmentParams, body: input({ reason: z.string().min(1).max(AMEND_LIMITS.reason) }), response: { 201: answered } })
