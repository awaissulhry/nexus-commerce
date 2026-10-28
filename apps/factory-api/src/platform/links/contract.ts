import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { EMAIL_CHECKS } from '@nexus/factory-domain/links/evidence'
import { EVIDENCE_ACTIONS, LINK_ACTIONS, LINK_PURPOSES, LINK_STATES } from '@nexus/factory-domain/links/purposes'

/**
 * The link routes' contracts. Office: make a link for a record (its URL shown once, in this answer only), list a
 * record's links with their evidence, revoke one. Link session: open the link. No money field anywhere: a link's
 * record, with its own prices for the purposes that show them, comes from its module's link route (W1).
 */

const EVIDENCE_ACTION_VALUES = Object.values(EVIDENCE_ACTIONS) as [string, ...string[]]
const RECORD_TYPE = /^[A-Z][A-Za-z0-9]{0,63}$/

export const evidenceView = output({
  id: id(),
  action: z.enum(EVIDENCE_ACTION_VALUES),
  /** The link's counted uses after this one; null when it did not count. */
  useNumber: z.number().int().nullable(),
  typedName: z.string().nullable(),
  emailCheck: z.enum(EMAIL_CHECKS),
  at: instant(),
})

export const linkView = output({
  id: id(),
  companyId: id(),
  partyId: id(),
  purpose: z.enum(LINK_PURPOSES),
  recordType: z.string(),
  recordId: id(),
  email: z.string().nullable(),
  note: z.string().nullable(),
  state: z.enum(LINK_STATES),
  expiresAt: instant(),
  maxUses: z.number().int(),
  uses: z.number().int(),
  lastUsedAt: instant().nullable(),
  revokedAt: instant().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  createdById: id(),
  /** Every open and answer, oldest first. */
  evidence: z.array(evidenceView),
})
export type LinkView = z.infer<typeof linkView>

export const createLinkContract = defineContract({
  body: input({
    purpose: z.enum(LINK_PURPOSES),
    /** One of the purpose's record types (Quote, PurchaseOrder, …), offered by its module. */
    recordType: z.string().regex(RECORD_TYPE),
    recordId: id(),
    /** The address it goes to. Left out: the record's contact. null: no known address (an accept records NOT_KNOWN). */
    email: z.string().max(254).nullable().optional(),
    /** For the office only (the partner can never read it). */
    note: z.string().trim().min(1).max(500).optional(),
    /** Default: the purpose's (QUOTE_ACCEPT 30 days); at most the purpose's maximum. */
    expiresInDays: z.number().int().optional(),
    /** Default: the purpose's (QUOTE_ACCEPT 1); at most the purpose's maximum. */
    maxUses: z.number().int().optional(),
  }),
  response: {
    201: output({
      link: linkView,
      /** The link to send (`<web>/l#token=…`), shown this once: only its hash is kept. Null on a repeated request. */
      url: z.string().nullable(),
    }),
  },
})

export const listLinksContract = defineContract({
  querystring: input({ recordType: z.string().regex(RECORD_TYPE), recordId: id() }),
  response: { 200: output({ links: z.array(linkView) }) },
})

export const revokeLinkContract = defineContract({
  params: input({ linkId: id() }),
  body: input({ version: z.number().int().min(1).optional(), reason: z.string().trim().min(1).max(500).optional() }),
  response: { 200: output({ link: linkView }) },
})

export const openLinkContract = defineContract({
  body: input({}),
  response: {
    200: output({
      link: output({
        purpose: z.enum(LINK_PURPOSES),
        record: output({ type: z.string(), id: id() }),
        expiresAt: instant(),
        usesLeft: z.number().int(),
        /** What the holder may answer, and what the page must ask first. */
        answers: z.array(
          output({
            action: z.enum(LINK_ACTIONS),
            typedName: z.enum(['required', 'optional', 'none']),
            /** Ask for the address the link was sent to (never shown). */
            email: z.boolean(),
          }),
        ),
      }),
    }),
  },
})
