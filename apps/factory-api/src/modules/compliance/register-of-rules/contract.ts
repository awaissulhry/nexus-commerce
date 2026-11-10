import { z } from 'zod'
import {
  CHANGE_KINDS,
  CHANGE_STATUSES,
  CODE_MAX,
  EDITION_MAX,
  IMPACTS,
  NOTE_MAX,
  OJ_MAX,
  REGULATION_KINDS,
  REGULATION_STATUSES,
  SOURCE_MAX,
  TITLE_MAX,
  WORDS_MAX,
} from '@nexus/factory-domain/compliance/register-of-rules/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The register of laws and standards and the harmonised-standard watch (B-W2b-249; PRD-273, PRD-274; design
 * compliance.settings › rm-regs). Codes, editions, citations, days, states and counts; the certificates and styles a
 * change touches by number and code. No price, no cost; people by their name only where they wrote a row.
 */

const version = () => z.number().int().min(1)
const person = output({ id: id(), name: z.string() }).nullable()
const words = z.record(z.string().min(2).max(12), z.string().trim().min(1).max(TITLE_MAX))
const ref = output({ id: id(), label: z.string() })

export const entryView = output({
  id: id(),
  code: z.string(),
  edition: z.string().nullable(),
  /** As a certificate types it: "EN 17092-4:2020". */
  label: z.string(),
  title: z.string(),
  titleI18n: z.record(z.string(), z.string()),
  kind: z.enum(REGULATION_KINDS),
  status: z.enum(REGULATION_STATUSES),
  ojReference: z.string().nullable(),
  ojDate: businessDate().nullable(),
  supersededBy: ref.nullable(),
  link: z.string().nullable(),
  note: z.string().nullable(),
  /** Registered certificates (not drafts) that cite it: the design's "used by (certificates count)". */
  usedBy: z.number().int(),
  /** Changes of it not closed yet. */
  openChanges: z.number().int(),
  version: z.number().int(),
  updatedAt: instant(),
})
export type EntryView = z.infer<typeof entryView>

const certificateRef = output({
  id: id(),
  number: z.string(),
  standard: z.string(),
  status: z.string(),
  validTo: businessDate(),
  companyId: id().nullable(),
  holderPartyId: id().nullable(),
  /** Styles it covers (ACTIVE coverage). */
  styles: z.number().int(),
})

export const changeView = output({
  id: id(),
  standard: output({ id: id(), label: z.string(), status: z.enum(REGULATION_STATUSES) }),
  newStandard: ref.nullable(),
  kind: z.enum(CHANGE_KINDS),
  whatChanged: z.string(),
  sourceReference: z.string().nullable(),
  noticedAt: instant(),
  noticedBy: person,
  transitionEndsOn: businessDate().nullable(),
  /** Where the transition period stands today. */
  transition: z.enum(['NONE', 'RUNNING', 'ENDS_SOON', 'ENDED']),
  status: z.enum(CHANGE_STATUSES),
  impact: z.enum(IMPACTS).nullable(),
  assessment: z.string().nullable(),
  assessedAt: instant().nullable(),
  assessedBy: person,
  closedAt: instant().nullable(),
  closedBy: person,
  certificates: z.array(output({ id: id(), number: z.string(), status: z.string(), validTo: businessDate() })),
  /** The affected styles: those the named certificates cover (ACTIVE coverage), with the certificates that cover each. */
  styles: z.array(output({ id: id(), code: z.string(), name: z.string(), certificateIds: z.array(id()) })),
  reviews: z.array(output({ id: id(), status: z.string(), certificateId: id(), styleId: id(), styleCode: z.string(), revision: z.number().int() })),
  task: output({ id: id(), title: z.string(), status: z.string() }).nullable(),
  version: z.number().int(),
  createdAt: instant(),
})
export type ChangeView = z.infer<typeof changeView>

const listQuery = input({
  kind: z.enum(REGULATION_KINDS).optional(),
  status: z.enum(REGULATION_STATUSES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
})

export const listEntriesContract = defineContract({
  querystring: listQuery,
  response: { 200: output({ entries: z.array(entryView), asOf: instant(), mayManage: z.boolean() }) },
})

const entryParams = input({ standardId: id() })
export const getEntryContract = defineContract({
  params: entryParams,
  response: { 200: output({ entry: entryView, certificates: z.array(certificateRef), supersedes: z.array(ref), changes: z.array(changeView), asOf: instant() }) },
})

const entryFields = {
  title: z.string().trim().min(1).max(TITLE_MAX),
  titleI18n: words.nullable(),
  kind: z.enum(REGULATION_KINDS),
  ojReference: z.string().trim().min(1).max(OJ_MAX).nullable(),
  ojDate: businessDate().nullable(),
  link: z.string().trim().min(1).max(2000).nullable(),
  note: z.string().trim().min(1).max(NOTE_MAX).nullable(),
}

export const createEntryContract = defineContract({
  body: input({
    code: z.string().trim().min(1).max(CODE_MAX),
    edition: z.string().trim().min(1).max(EDITION_MAX).nullable().optional(),
    ...entryFields,
    titleI18n: entryFields.titleI18n.optional(),
    ojReference: entryFields.ojReference.optional(),
    ojDate: entryFields.ojDate.optional(),
    link: entryFields.link.optional(),
    note: entryFields.note.optional(),
    /** IN_FORCE by default; an entry recorded as SUPERSEDED or WITHDRAWN raises no change (nothing cites it yet). */
    status: z.enum(REGULATION_STATUSES).optional(),
  }),
  response: { 200: output({ entry: entryView }) },
})

export const editEntryContract = defineContract({
  params: entryParams,
  body: input({
    version: version(),
    code: z.string().trim().min(1).max(CODE_MAX).optional(),
    edition: z.string().trim().min(1).max(EDITION_MAX).nullable().optional(),
    title: entryFields.title.optional(),
    titleI18n: entryFields.titleI18n.optional(),
    kind: entryFields.kind.optional(),
    ojReference: entryFields.ojReference.optional(),
    ojDate: entryFields.ojDate.optional(),
    link: entryFields.link.optional(),
    note: entryFields.note.optional(),
    /** Moving to SUPERSEDED or WITHDRAWN raises a change (unless one is still open) naming the certificates that cite it. */
    status: z.enum(REGULATION_STATUSES).optional(),
    supersededById: id().nullable().optional(),
    /** What changed, in words: required with a move to SUPERSEDED or WITHDRAWN (the raised change's words). */
    reason: z.string().trim().min(3).max(WORDS_MAX).optional(),
    /** The day the transition period ends (the raised change's), when the Official Journal gives one. */
    transitionEndsOn: businessDate().nullable().optional(),
  }),
  response: { 200: output({ entry: entryView, raised: changeView.nullable() }) },
})

export const deleteEntryContract = defineContract({
  params: entryParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ deleted: id() }) },
})

// ---- the watch ----------------------------------------------------------------------------------------------------------

export const listChangesContract = defineContract({
  querystring: input({ status: z.enum(CHANGE_STATUSES).optional(), standardId: id().optional(), open: z.enum(['true', 'false']).optional() }),
  response: { 200: output({ changes: z.array(changeView), asOf: instant() }) },
})

const changeParams = input({ changeId: id() })
export const getChangeContract = defineContract({ params: changeParams, response: { 200: output({ change: changeView, asOf: instant() }) } })

export const recordChangeContract = defineContract({
  params: entryParams,
  body: input({
    kind: z.enum(CHANGE_KINDS),
    whatChanged: z.string().trim().min(3).max(WORDS_MAX),
    sourceReference: z.string().trim().min(1).max(SOURCE_MAX).nullable().optional(),
    transitionEndsOn: businessDate().nullable().optional(),
    /** The register entry of the new edition, when it is in the register. */
    newStandardId: id().nullable().optional(),
  }),
  response: { 200: output({ change: changeView }) },
})

export const assessChangeContract = defineContract({
  params: changeParams,
  body: input({
    version: version(),
    impact: z.enum(IMPACTS),
    assessment: z.string().trim().min(3).max(WORDS_MAX),
    /**
     * REVIEW or RETEST: the certificates (named by the change) that need the notified body again. For each, W2a's
     * type-change review opens on the current revision of every style it covers — which holds that revision's class label
     * until the review is decided.
     */
    reviewCertificateIds: z.array(id()).max(50).optional(),
  }),
  response: { 200: output({ change: changeView }) },
})

export const addCertificatesContract = defineContract({
  params: changeParams,
  body: input({ version: version(), certificateIds: z.array(id()).min(1).max(100) }),
  response: { 200: output({ change: changeView }) },
})

export const changeTaskContract = defineContract({
  params: changeParams,
  body: input({ version: version(), assigneeId: id().nullable().optional(), language: z.enum(['it', 'en']).optional() }),
  response: { 200: output({ change: changeView }) },
})

export const closeChangeContract = defineContract({
  params: changeParams,
  body: input({ version: version() }),
  response: { 200: output({ change: changeView }) },
})
