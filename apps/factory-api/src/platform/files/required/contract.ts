import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_CATEGORIES, PARTY_ROLES, REQUIRED_CATEGORIES, REQUIRED_LEVELS } from '@nexus/factory-domain/files/required/rules'
import { RECORD_TYPE } from '../rules'

/**
 * Required documents and a document's type and expiry (COL-048, COL-049; B-W2b-177): the company's rules (admin.documents ›
 * Required documents), what a record has and still lacks before each status move (the record's Files panel), and what a
 * file is and until when it is valid.
 */

export const ruleView = output({
  id: id(),
  companyId: id(),
  recordType: z.string(),
  category: z.enum(REQUIRED_CATEGORIES),
  beforeStatus: z.string(),
  partyRole: z.enum(PARTY_ROLES).nullable(),
  level: z.enum(REQUIRED_LEVELS),
  active: z.boolean(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type RuleView = z.infer<typeof ruleView>

export const listRulesContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: {
    200: output({
      rules: z.array(ruleView),
      /** What a rule may name: each record type with its statuses, and the documents. */
      recordTypes: z.array(output({ recordType: z.string(), statuses: z.array(z.string()) })),
      categories: z.array(z.enum(REQUIRED_CATEGORIES)),
      /** The companies whose rules this person may change (documents.required.manage). */
      mayChange: z.array(id()),
    }),
  },
})

export const createRuleContract = defineContract({
  body: input({
    companyId: id(),
    recordType: z.string().min(1).max(60),
    category: z.string().min(1).max(60),
    beforeStatus: z.string().min(1).max(60),
    partyRole: z.string().min(1).max(30).nullable(),
    level: z.string().min(1).max(10),
  }),
  response: { 201: output({ rule: ruleView }) },
})

export const changeRuleContract = defineContract({
  params: input({ ruleId: id() }),
  body: input({ level: z.enum(REQUIRED_LEVELS).optional(), active: z.boolean().optional(), version: z.number().int().min(1) }),
  response: { 200: output({ rule: ruleView }) },
})

export const requirementView = output({
  ruleId: id(),
  category: z.enum(REQUIRED_CATEGORIES),
  partyRole: z.enum(PARTY_ROLES).nullable(),
  level: z.enum(REQUIRED_LEVELS),
  reason: z.enum(['MET', 'MISSING', 'EXPIRED']),
  fileId: id().nullable(),
  expiresOn: businessDate().nullable(),
})

export const documentView = output({
  fileId: id(),
  category: z.enum(DOCUMENT_CATEGORIES).nullable(),
  expiresOn: businessDate().nullable(),
  expiryState: z.enum(['NONE', 'VALID', 'EXPIRING', 'EXPIRED']),
  daysLeft: z.number().int().nullable(),
  /** On the record's party, not the record itself (a supplier's certificate on a purchase order). */
  ofParty: z.boolean(),
  originalName: z.string(),
})

export const recordDocumentsContract = defineContract({
  querystring: input({ recordType: z.string().regex(RECORD_TYPE), recordId: id() }),
  response: {
    200: output({
      /** The record's status now, when it is a record type rules may name (else null and no moves). */
      status: z.string().nullable(),
      today: businessDate(),
      /** What each current document of the record (and of its party) is, and until when. */
      documents: z.array(documentView),
      /** Each status move that has rules: what it needs, met or not. */
      moves: z.array(output({ toStatus: z.string(), requirements: z.array(requirementView) })),
      /** May change this record's documents' type and date (files.upload on its company). */
      mayTag: z.boolean(),
    }),
  },
})

export const setDocumentContract = defineContract({
  params: input({ fileId: id() }),
  body: input({
    /** What the file is evidence of; null clears it. Left out: unchanged. */
    category: z.enum(DOCUMENT_CATEGORIES).nullable().optional(),
    /** The last day it is valid; null: it does not expire. Left out: unchanged. A new date starts the reminders again. */
    expiresOn: z.string().max(10).nullable().optional(),
    version: z.number().int().min(1),
  }),
  response: { 200: output({ document: documentView, version: z.number().int() }) },
})
