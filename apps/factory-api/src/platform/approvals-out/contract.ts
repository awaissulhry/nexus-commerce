import { z } from 'zod'
import { ANSWER_CHANNELS, APPROVAL_DECISIONS, APPROVAL_KINDS, APPROVAL_STATUSES } from '@nexus/factory-domain/approvals-out/kinds'
import { APPROVAL_LIMITS, OVERRIDE_LIMITS } from '@nexus/factory-domain/approvals-out/rules'
import { REVERSE_EFFECTS } from '@nexus/factory-domain/production-brand/override'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { LINE_CHANGES } from '@nexus/factory-domain/sales/amendments/amendments'

/**
 * Approval requests to partners (B-W2b-184). Money only in a revised order's panel, behind the price grain (the APPROVAL
 * link's, a portal person's, an office person's); every other field is words, ids, times and states. Words come in the
 * reader's language where a partner reads them (it/en). B-W2b-F16: the kind, the state and the due date go as codes
 * (`kind`, `status`, `dueAt`) and the record's label in both languages (`words`): the screens say them in their own words.
 */

const kind = z.enum(APPROVAL_KINDS)
/** The record's label in both languages ("SO-2026-0042 · revisione 2" / "… · revision 2"). */
const words = output({ it: z.string(), en: z.string() })
const status = z.enum(APPROVAL_STATUSES)
const locale = z.enum(['it', 'en'])
const version = () => z.number().int().min(1)
const fileView = output({ id: id(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int() })
const point = input({ x: z.number(), y: z.number() })
const shape = z.union([input({ kind: z.literal('arrow'), from: point, to: point }), input({ kind: z.literal('circle'), center: point, radius: z.number() })])

const markup = input({
  fileId: id(),
  page: z.number().int().min(1).nullable(),
  shapes: z.array(shape).min(1).max(200),
  note: z.string().max(2000).nullable(),
})

// ---- the office --------------------------------------------------------------------------------------------------------

const officeRequestView = output({
  id: id(),
  companyId: id(),
  kind,
  record: output({ type: z.string(), id: id(), words }),
  party: output({ id: id(), name: z.string() }),
  contactId: id().nullable(),
  question: z.string(),
  dueAt: instant(),
  status,
  answer: output({
    at: instant(),
    typedName: z.string(),
    words: z.string().nullable(),
    /** B-PR-30a: OFFICE — decided for the party by an office person (personName), with the reason the party reads. */
    via: z.enum([...ANSWER_CHANNELS, 'OFFICE']),
    personName: z.string().nullable(),
    markup: output({ fileId: id(), page: z.number().int().nullable(), shapes: z.array(z.unknown()), note: z.string().nullable() }).nullable(),
  }).nullable(),
  withdrawn: output({ at: instant(), byName: z.string().nullable(), reason: z.string().nullable() }).nullable(),
  // B-PR-30a/30b: decided by us for the party (who, why the party reads), its answer put back (when, who, why), an override
  // waiting for a second person (its task in Home › Approvals).
  decidedForParty: output({ byName: z.string().nullable(), reason: z.string() }).nullable(),
  reversed: output({ at: instant(), byName: z.string().nullable(), reason: z.string() }).nullable(),
  override: output({ taskId: id(), act: z.enum(['DECIDE_FOR', 'REVERSE']) }).nullable(),
  askedBy: z.string().nullable(),
  createdAt: instant(),
  files: z.array(fileView),
  links: z.array(output({ id: id(), email: z.string().nullable(), expiresAt: instant(), used: z.boolean(), revoked: z.boolean(), lastUsedAt: instant().nullable() })),
  /** B-PR-30a/30b: Decide for the customer, Reverse — for the reader (production.brand.override; never the person who asked). */
  may: output({ withdraw: z.boolean(), decideForParty: z.boolean(), reverse: z.boolean() }),
  version: z.number().int(),
})

export const askContract = defineContract({
  body: input({
    kind,
    recordType: z.string().min(1).max(64),
    recordId: id(),
    partyId: id().optional(),
    contactId: id().optional(),
    email: z.string().trim().max(254).optional(),
    question: z.string().max(APPROVAL_LIMITS.question),
    dueAt: instant().optional(),
    fileIds: z.array(id()).max(APPROVAL_LIMITS.files).optional(),
    send: z.boolean(),
    language: locale.optional(),
    /** B-TH-004: "Send outside this customer" ticked: the address may be another party's contact (recorded). */
    sendOutside: z.boolean().optional(),
  }),
  response: { 201: output({ request: officeRequestView, url: z.string().nullable(), delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable() }) },
})

export const recordRequestsContract = defineContract({
  querystring: input({ recordType: z.string().min(1).max(64), recordId: id() }),
  response: { 200: output({ record: output({ type: z.string(), id: id(), words }), kinds: z.array(kind), held: z.string().nullable(), requests: z.array(officeRequestView) }) },
})

const requestParams = input({ requestId: id() })

export const officeRequestContract = defineContract({
  params: requestParams,
  response: { 200: output({ request: officeRequestView }) },
})

export const withdrawContract = defineContract({
  params: requestParams,
  body: input({ version: version(), reason: z.string().max(APPROVAL_LIMITS.reason).nullish() }),
  response: { 200: output({ request: officeRequestView }) },
})

// ---- B-PR-30a / B-PR-30b: decide for the party, put its answer back (production.brand.override, step-up) ----------------------

/** Done at once, or waiting for a second person (the customer's switch): its task, and the words that say so. */
const overrideOutcome = output({ outcome: z.enum(['DONE', 'SECOND_PERSON']), taskId: id().nullable(), words: words.nullable() })

export const decideForPartyContract = defineContract({
  params: requestParams,
  body: input({
    version: version(),
    decision: z.enum(APPROVAL_DECISIONS),
    answer: z.string().max(APPROVAL_LIMITS.answer).nullish(),
    typedName: z.string().max(APPROVAL_LIMITS.typedName + 50),
    /** Why we decide for the party: it reads it ("Decided by us for you: …"). */
    reason: z.string().max(OVERRIDE_LIMITS.reason + 50),
  }),
  response: { 200: output({ request: officeRequestView, override: overrideOutcome }) },
})

export const reverseContract = defineContract({
  params: requestParams,
  body: input({
    version: version(),
    /** Why the answer is put back: the party reads it ("Put back by us: …"). */
    reason: z.string().max(OVERRIDE_LIMITS.reason + 50),
  }),
  response: {
    200: output({
      request: officeRequestView,
      override: overrideOutcome,
      /** What it did to the record (none yet while a second person grants it). */
      effects: z.array(z.enum(REVERSE_EFFECTS)),
      /** A new date asked again: the new request, and its link ONCE for a customer without a portal (null after a repeat). */
      asked: output({ requestId: id(), url: z.string().nullable() }).nullable(),
    }),
  },
})

// ---- the partner (link and portal) ---------------------------------------------------------------------------------------

const lineChange = output({
  change: z.enum(LINE_CHANGES),
  lineId: id(),
  seq: z.number().int(),
  style: output({ code: z.string(), name: z.string() }),
  colour: output({ code: z.string(), name: z.string() }),
  piecesBefore: z.number().int(),
  piecesAfter: z.number().int(),
  sizes: z.array(output({ size: z.string(), before: z.number().int(), after: z.number().int() })),
  /** Its unit price changed (the prices themselves are in `prices`, with the price grain). */
  priceChanged: notMoney(z.boolean()),
})

const pageView = {
  request: output({
    id: id(),
    kind,
    words,
    /** The English of `words` (B-W2b-187's customer Home reads it; drop it once nothing does). */
    label: z.string(),
    question: z.string(),
    from: output({ companyName: z.string() }),
    dueAt: instant(),
    status,
    /** The design's "Decided": "Approved — signed by Anna Rossi at 10:42 on 3 Nov. We can go ahead with cutting." */
    decided: z.string().nullable(),
    answer: output({ at: instant(), typedName: z.string(), words: z.string().nullable(), markupFileId: id().nullable() }).nullable(),
    /** B-PR-30a: we decided it for you — "Decided by us for you: <why>" (never who of us); null: you answered it, or it waits. */
    decidedForYou: z.string().nullable(),
    /** B-PR-30b: we put your answer back — when, and "Put back by us: <why>" (your answer itself is kept). */
    reversed: output({ at: instant(), words: z.string() }).nullable(),
    version: z.number().int(),
  }),
  content: output({
    facts: z.array(output({ label: z.string(), value: z.string() })),
    revisedOrder: output({
      orderNumber: z.string(),
      revision: z.number().int(),
      reason: z.string(),
      currency: z.string(),
      lines: z.array(lineChange),
      header: z.array(output({ field: z.enum(['customerRef', 'requestedDate']), before: z.string().nullable(), after: z.string().nullable() })),
      /** Per line: its unit price old → new (when it changed) and its net old → new: the party's own order, the price grain. */
      prices: money.price(z.array(output({ lineId: id(), unitPrice: money.price(output({ before: z.string().nullable(), after: z.string().nullable() }).nullable()), netBefore: z.number().int(), netAfter: z.number().int() }))),
      netAmountBefore: money.price(z.number().int()),
      netAmountAfter: money.price(z.number().int()),
      grossAmountBefore: money.price(z.number().int()),
      grossAmountAfter: money.price(z.number().int()),
    }).nullable(),
  }),
  files: z.array(fileView),
  may: output({ answer: z.boolean(), withChanges: z.boolean(), held: z.string().nullable() }),
  locale,
}

const linkTerms = output({ expiresAt: instant(), usesLeft: z.number().int() })
const receipt = z.enum(['SENT', 'FAILED', 'QUEUED']).nullable()

export const linkPageContract = defineContract({
  querystring: input({ language: locale.optional() }),
  response: { 200: output({ ...pageView, link: linkTerms }) },
})

const answerFields = {
  answer: z.string().max(APPROVAL_LIMITS.answer).nullish(),
  typedName: z.string().max(APPROVAL_LIMITS.typedName + 50),
  markup: markup.nullish(),
}

export const linkApproveContract = defineContract({
  querystring: input({ language: locale.optional() }),
  body: input({ decision: z.enum(['APPROVED', 'APPROVED_WITH_CHANGES']), ...answerFields }),
  response: { 200: output({ ...pageView, link: linkTerms, receipt }) },
})

export const linkRefuseContract = defineContract({
  querystring: input({ language: locale.optional() }),
  body: input({ ...answerFields }),
  response: { 200: output({ ...pageView, link: linkTerms, receipt }) },
})

export const portalListContract = defineContract({
  querystring: input({ state: z.enum(['OPEN', 'DONE']).optional() }),
  response: {
    200: output({
      state: z.enum(['OPEN', 'DONE']),
      items: z.array(
        output({
          id: id(),
          kind,
          words,
          question: z.string(),
          dueAt: instant(),
          status,
          decided: z.string().nullable(),
          /** B-PR-29: an open production approval its customer's named approver answers, and the reader is not that person: their name ("Waiting for Anna"); else null. */
          waitingFor: z.string().nullable(),
          /** F-PR-14: an open priced counter-offer the reader may not answer (no prices): "Waiting for your buyer" (B-PR-26's rule). */
          waitingForBuyer: notMoney(z.boolean()),
        }),
      ),
    }),
  },
})

export const portalPageContract = defineContract({
  params: requestParams,
  response: { 200: output(pageView) },
})

export const portalAnswerContract = defineContract({
  params: requestParams,
  body: input({ decision: z.enum(APPROVAL_DECISIONS), ...answerFields, version: version() }),
  response: { 200: output({ ...pageView, receipt }) },
})

// ---- PLT-089: approve from e-mail ------------------------------------------------------------------------------------------

const mailSettings = output({ on: z.boolean(), since: instant().nullable(), lastSentAt: instant().nullable(), version: z.number().int() })

export const mailSettingsContract = defineContract({ response: { 200: mailSettings } })

export const setMailContract = defineContract({
  body: input({ on: z.boolean() }),
  response: { 200: mailSettings },
})

export const mailOpenContract = defineContract({
  body: input({ key: z.string().min(1).max(300) }),
  response: {
    200: output({ record: output({ type: z.string(), id: id(), label: z.string() }), companyId: id().nullable(), anchor: z.string().nullable(), messageKey: z.string(), waiting: z.boolean() }),
  },
})
