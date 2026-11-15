import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { DUPLICATE_REASONS, DUPLICATE_RECORD_TYPES, LIKELIHOODS, MERGE_REASON, MERGE_REFUSALS, USE_GROUPS } from '@nexus/factory-domain/imports/duplicates/rules'

/**
 * Likely duplicates (B-W2b-427; feature PLT-178; design admin.import "possible duplicates", customers.new and
 * materials.new "Duplicate warning"). Office only. Payloads carry codes, names, statuses and the reasons as codes; an
 * e-mail domain or a website host is the only value echoed (never a tax number, never a contact's address).
 */

const reasonView = output({
  code: z.enum(DUPLICATE_REASONS),
  /** SAME_EMAIL_DOMAIN, SAME_WEBSITE: the domain or host. */
  detail: z.string().nullable(),
  /** SIMILAR_NAME: 0..100. */
  score: z.number().int().nullable(),
})

/** A record that looks like the one checked. */
export const candidateView = output({
  recordType: z.enum(DUPLICATE_RECORD_TYPES),
  id: id(),
  code: z.string(),
  name: z.string(),
  /** PARTY: PROSPECT | ACTIVE | BLOCKED | ARCHIVED; MATERIAL: ACTIVE | ARCHIVED. */
  status: z.string(),
  companyId: id().nullable(),
  /** PARTY: its roles (CUSTOMER, SUPPLIER …); MATERIAL: none. */
  roles: z.array(z.string()),
  /** MATERIAL: its kind; PARTY: null. */
  kind: z.string().nullable(),
  likelihood: z.enum(LIKELIHOODS),
  reasons: z.array(reasonView),
})

const candidates = output({ candidates: z.array(candidateView) })

const text = (max: number) => z.string().trim().max(max).nullable().optional()

export const checkPartyContract = defineContract({
  body: input({
    /** The company the new party belongs to (null: every company); only candidates the caller may see are named. */
    companyId: id().nullable().optional(),
    /** A record that exists already and is left out (an edit). */
    exceptId: id().optional(),
    legalName: text(200),
    tradeName: text(200),
    country: z.string().trim().max(2).nullable().optional(),
    vatNumber: text(40),
    fiscalCode: text(40),
    emails: z.array(z.string().trim().max(254)).max(20).optional(),
    website: text(200),
  }),
  response: { 200: candidates },
})

export const checkMaterialContract = defineContract({
  body: input({
    companyId: id().nullable().optional(),
    exceptId: id().optional(),
    code: text(40),
    name: text(200),
    supplierId: id().nullable().optional(),
    supplierArticleCode: text(64),
  }),
  response: { 200: candidates },
})

/** Two records that look alike (the record seen first is `a`: the older one, the one usually kept). */
export const pairView = output({
  key: z.string(),
  a: candidateView.omit({ likelihood: true, reasons: true }).extend({ createdAt: z.string() }),
  b: candidateView.omit({ likelihood: true, reasons: true }).extend({ createdAt: z.string() }),
  likelihood: z.enum(LIKELIHOODS),
  reasons: z.array(reasonView),
})

export const scanContract = defineContract({
  /** Only the records of this company and those for every company. */
  querystring: input({ companyId: id().optional() }),
  response: {
    200: output({
      recordType: z.enum(DUPLICATE_RECORD_TYPES),
      pairs: z.array(pairView),
      /** More pairs exist than the answer holds (the strongest come first). */
      more: z.boolean(),
      /** How many records were compared. */
      compared: z.number().int(),
    }),
  },
})

const useView = output({ group: z.enum(USE_GROUPS), count: z.number().int(), tables: z.array(z.string()) })

const sideView = output({ id: id(), code: z.string(), name: z.string(), status: z.string(), companyId: id().nullable(), version: z.number().int(), kind: z.string().nullable(), roles: z.array(z.string()) })

/** What a merge would do, or why it cannot. */
export const mergePreviewView = output({
  recordType: z.enum(DUPLICATE_RECORD_TYPES),
  kept: sideView,
  dropped: sideView,
  refusals: z.array(z.enum(MERGE_REFUSALS)),
  /** What uses the duplicate (IN_USE). */
  uses: z.array(useView),
  /** What moves to the record that stays. */
  moves: output({ contacts: z.number().int(), addresses: z.number().int(), taxIdentities: z.number().int(), colours: z.number().int() }),
  /** What stays on the archived duplicate: a part another record points to, an archived one, a contact whose e-mail the record that stays has, a colour whose code it has, tax identities when it has its own. */
  stays: output({ contacts: z.number().int(), addresses: z.number().int(), taxIdentities: z.number().int(), colours: z.number().int() }),
  /** The other way round (keep the duplicate, archive the other) would go ahead. */
  reverseWorks: z.boolean(),
})

const mergeParams = input({ recordType: z.enum(DUPLICATE_RECORD_TYPES) })

export const mergePreviewContract = defineContract({
  params: mergeParams,
  querystring: input({ keptId: id(), droppedId: id() }),
  response: { 200: mergePreviewView },
})

export const mergeContract = defineContract({
  params: mergeParams,
  body: input({
    keptId: id(),
    droppedId: id(),
    keptVersion: z.number().int().min(1),
    droppedVersion: z.number().int().min(1),
    reason: z.string().trim().min(MERGE_REASON.min).max(MERGE_REASON.max),
  }),
  response: { 200: output({ recordType: z.enum(DUPLICATE_RECORD_TYPES), kept: sideView, dropped: sideView, moved: mergePreviewView.shape.moves }) },
})

/** A sheet row the import would create that looks like a record already there, or like another row of the sheet. */
export const importRowView = output({
  rowNumber: z.number().int(),
  key: z.string().nullable(),
  name: z.string().nullable(),
  /** After the apply: the record the row made (a merge may archive it into a candidate). */
  recordId: id().nullable(),
  candidates: z.array(candidateView),
  /** Earlier rows of the same sheet it looks like. */
  sameSheet: z.array(output({ rowNumber: z.number().int(), key: z.string().nullable(), recordId: id().nullable(), likelihood: z.enum(LIKELIHOODS), reasons: z.array(reasonView) })),
})

export const importDuplicatesContract = defineContract({
  params: input({ importId: id() }),
  response: {
    200: output({
      jobId: id(),
      importerKey: z.string(),
      /** The importer makes parties or materials (the only records checked); false: nothing to check. */
      supported: z.boolean(),
      recordType: z.enum(DUPLICATE_RECORD_TYPES).nullable(),
      /** How many new rows were checked (at most 500, in sheet order). */
      checked: z.number().int(),
      /** More new rows than were checked. */
      more: z.boolean(),
      rows: z.array(importRowView),
    }),
  },
})
