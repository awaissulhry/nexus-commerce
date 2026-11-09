import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { EMAIL_CHECKS } from '@nexus/factory-domain/links/evidence'
import { LINK_FILES_MAX } from '@nexus/factory-domain/links/files'
import { LINK_PASSWORD } from '@nexus/factory-domain/links/password'
import { EVIDENCE_ACTIONS, FILE_SET_PURPOSES, LINK_ACTIONS, LINK_PURPOSES, LINK_STATES } from '@nexus/factory-domain/links/purposes'
import { LINK_RENEW_NOTE_MAX } from '@nexus/factory-domain/links/renew'
import { presignedView } from '../files/contract'
import { proofBody } from '../abuse/contract'

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
  // W2b-3 (B-W2b-163).
  /** The set of files it shares, in order (DOCUMENT_VIEW, SECURE_FILE); empty for any other link. */
  files: z.array(output({ fileId: id(), position: z.number().int(), name: z.string() })),
  /** It has a password (never shown), and until when five wrong ones hold it. */
  password: output({ set: z.boolean(), heldUntil: instant().nullable() }),
  /** "I received these files" (SECURE_FILE): when, and the name typed. */
  receipt: output({ at: instant(), name: z.string().nullable() }).nullable(),
  /** The party contact it went to; the dead link it renews. */
  contactId: id().nullable(),
  renewalOfId: id().nullable(),
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

// ---- W2b-3 (B-W2b-163): sets of files, passwords, the receipt, drafts, ask for a new link -------------------------------

export const UNLOCK_HEADER = 'x-factory-link-unlock'

export const createFileLinkContract = defineContract({
  body: input({
    purpose: z.enum(FILE_SET_PURPOSES as unknown as [string, ...string[]]),
    /** The company whose files they are (the link's). */
    companyId: id(),
    /** The customer, supplier or other party the files go to. */
    partyId: id(),
    /** The party's contact it goes to (the address on file); or `email` alone, an address with no contact. */
    contactId: id().optional(),
    email: z.string().max(254).optional(),
    /** In order: the first is the link's record. */
    fileIds: z.array(id()).min(1).max(LINK_FILES_MAX),
    /** A password the office tells the person another way; never in the mail, never shown again. */
    password: z.string().min(1).max(LINK_PASSWORD.maxLength * 4).optional(),
    /** For the office only. */
    note: z.string().trim().min(1).max(500).optional(),
    expiresInDays: z.number().int().optional(),
    maxUses: z.number().int().optional(),
    /** Mail the link to the address now (FAKE locally); else the answer shows the link this once. */
    send: z.boolean().optional(),
    language: z.enum(['it', 'en']).optional(),
    message: z.string().trim().min(1).max(2000).optional(),
  }),
  response: {
    201: output({
      link: linkView,
      /** The link to send (`<web>/l#token=…`), shown this once when it was not mailed; null on a repeated request. */
      url: z.string().nullable(),
      /** The mail, when sent: SENT, FAILED (send again: a new link), QUEUED. */
      delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable(),
    }),
  },
})

const newerView = output({
  versionNo: z.number().int().nullable(),
  replacedAt: instant(),
  /** The current version is on this link too. */
  sharedFileId: id().nullable(),
  words: z.string(),
})

export const linkFilesContract = defineContract({
  response: {
    200: output({
      link: output({
        purpose: z.enum(LINK_PURPOSES),
        expiresAt: instant(),
        usesLeft: z.number().int(),
        /** A password guards the files: `unlocked` once the page sent a right one (its unlock key). */
        password: output({ asked: z.boolean(), unlocked: z.boolean(), heldUntil: instant().nullable() }),
        /** SECURE_FILE: may confirm "I received these files", and whether it did. */
        receipt: output({ asked: z.boolean(), at: instant().nullable(), name: z.string().nullable() }),
      }),
      sender: output({ companyName: z.string() }),
      count: z.number().int(),
      /** Listed once the password was given (or when there is none). */
      files: z.array(
        output({
          id: id(),
          position: z.number().int(),
          name: z.string(),
          sizeBytes: z.number().int(),
          /** SHA-256, hex: the checksum the page shows short. */
          sha256: z.string(),
          contentType: z.string(),
          /** Shown in the page (DOCUMENT_VIEW, a PDF or a picture); null: download only. */
          preview: z.enum(['inline']).nullable(),
          /** Still there to download (a deleted file stays listed, not downloadable). */
          available: z.boolean(),
          /** A later version replaced it (named, never swapped in). */
          newer: newerView.nullable(),
        }),
      ),
    }),
  },
})

export const linkPasswordContract = defineContract({
  body: input({ password: z.string().min(1).max(LINK_PASSWORD.maxLength * 4) }),
  response: { 200: output({ unlock: z.string(), unlockedUntil: instant() }) },
})

export const linkFileParams = input({ fileId: id() })

export const linkFileDownloadContract = defineContract({
  params: linkFileParams,
  body: input({}).optional(),
  response: { 200: output({ fileId: id(), name: z.string(), usesLeft: z.number().int(), download: presignedView }) },
})

export const linkFilePreviewContract = defineContract({
  params: linkFileParams,
  response: { 200: output({ fileId: id(), mode: z.literal('inline'), preview: presignedView }) },
})

export const linkReceiptContract = defineContract({
  body: input({ typedName: z.string().max(400).optional() }),
  response: { 200: output({ receipt: output({ at: instant(), name: z.string().nullable() }) }) },
})

export const linkDraftContract = defineContract({
  response: {
    200: output({
      draft: output({ data: z.record(z.string(), z.unknown()), version: z.number().int(), savedAt: instant(), purgeAfter: instant() }).nullable(),
      link: output({ expiresAt: instant() }),
    }),
  },
})

export const saveLinkDraftContract = defineContract({
  body: input({
    /** The form as the page keeps it (any JSON object); sealed before it is stored. */
    data: z.record(z.string(), z.unknown()),
    /** The version the page saved last; left out on the first save. */
    version: z.number().int().min(1).optional(),
  }),
  response: { 200: output({ draft: output({ version: z.number().int(), savedAt: instant(), purgeAfter: instant() }) }) },
})

export const renewLinkContract = defineContract({
  body: input({
    proof: proofBody.optional(),
    /** B-W2b-F17: the reader's own words to the person who made the link (passed on only where no renewer makes a new one). */
    note: z.string().trim().min(1).max(LINK_RENEW_NOTE_MAX).optional(),
  }).optional(),
  response: { 202: output({ status: z.literal('requested'), message: z.string() }) },
})
