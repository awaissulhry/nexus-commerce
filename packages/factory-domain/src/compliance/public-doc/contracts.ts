import { z } from 'zod'
import { publicBranding } from '../../branding/contracts'
import { businessDate, id, input, output } from '../../core/contracts'
import { PUBLIC_DOC_KINDS } from './code'
// B-W2b-260 (RG1:01): a recall's or withdrawal's public notice, first on the page.
import { publicSafetyNotice } from '../recall/public-notice'

/**
 * The public DoC page's contracts (B-W2b-166; design links.doc; PRD-294, PRD-356). The page speaks its own words: the API
 * sends codes, numbers, days and the documents' own facts (names, numbers, the maker's name and address as the
 * declaration prints them), never a sentence. No price, no cost, no person: the page is for anyone holding the garment.
 */

const PPE_CATEGORY = z.enum(['NOT_PPE', 'CATEGORY_I', 'CATEGORY_II', 'CATEGORY_III'])

/** One signed PDF of the page (a declaration or a leaflet in one language), served by GET /public/doc/:code/files/:fileId. */
export const publicDocFile = output({
  /** ISO 639-1. */
  language: z.string(),
  fileId: id(),
  /** The file's name as stored (the office's upload). */
  name: z.string(),
  sizeBytes: z.number().int(),
  /** SHA-256 of the bytes: the fingerprint an authority checks against its copy. */
  sha256: z.string(),
  /** The number printed on it (the declaration's reference); null when none. */
  number: z.string().nullable(),
  /** The day it was issued (Europe/Rome); null when not known. */
  issuedOn: businessDate().nullable(),
})
export type PublicDocFile = z.infer<typeof publicDocFile>

/** The release days of the batches made to one style revision: "batches made March 2025 to September 2026". */
export const batchSpan = output({ first: businessDate(), last: businessDate() })
export type BatchSpan = z.infer<typeof batchSpan>

/** A care symbol (ISO 3758) of the garment label with its text per language, as the label prints it. */
export const careLine = output({ symbol: z.string(), text: z.record(z.string(), z.string()) })
export type CareLine = z.infer<typeof careLine>

export const publicDocPage = output({
  /** The code as printed: `7K3Q-M2XA`. */
  code: z.string(),
  /** The code without its hyphen, as in the address. */
  path: z.string(),
  kind: z.enum(PUBLIC_DOC_KINDS),
  /** Whose page it is (the company that makes the product): the head's logo, name and colour. */
  sender: publicBranding,
  /** Whom to ask: the company's default conversation address; null when none is set. */
  contact: output({ email: z.string().nullable() }),
  product: output({
    style: output({
      code: z.string(),
      name: z.string(),
      /** The style's name per language (ISO 639-1), when the office wrote one. */
      names: z.record(z.string(), z.string()),
    }),
    /** The batch the QR names (BATCH codes): its number and the day it was released for production. */
    batch: output({ number: z.string(), releasedOn: businessDate() }).nullable(),
    /** The legal maker (Annex IX 2, art. 8(6)): the brand for private label, else the company; as the declaration prints it. */
    maker: output({ name: z.string(), address: z.string(), role: z.enum(['BRAND', 'COMPANY']) }).nullable(),
    importer: output({ name: z.string(), address: z.string() }).nullable(),
  }),
  ppe: output({
    category: PPE_CATEGORY,
    /** "EN 17092-4:2020" */
    standard: z.string().nullable(),
    /** "AA" */
    ppeClass: z.string().nullable(),
    /** Category II and III: an EU type-examination certificate of a notified body. */
    certificateRequired: z.boolean(),
  }),
  /** The declaration valid for this batch (its frozen style revision) or the style's current one; null: see `missing`. */
  declaration: output({
    revision: z.number().int(),
    /** CURRENT: the one batches are made to now; EARLIER: a later revision took over on `before`. */
    standing: z.enum(['CURRENT', 'EARLIER']),
    before: businessDate().nullable(),
    /** The batches made to this revision (null: none released yet). */
    batches: batchSpan.nullable(),
    /** One per language, the languages the label prints first. */
    files: z.array(publicDocFile),
  }).nullable(),
  /** Why there is no declaration: NOT_PPE (none is needed) or NOT_PUBLISHED (none for this revision yet). */
  missing: z.enum(['NOT_PPE', 'NOT_PUBLISHED']).nullable(),
  /** The EU type-examination certificate the declaration cites (else one covering the style), on `day`; null: none needed or none on record. */
  certificate: output({
    number: z.string(),
    notifiedBody: output({ name: z.string(), number: z.string() }),
    standard: z.string(),
    ppeClass: z.string().nullable(),
    validFrom: businessDate(),
    validTo: businessDate(),
    /** The batch's release day (BATCH) or today (STYLE). */
    day: businessDate(),
    validOnDay: z.boolean(),
  }).nullable(),
  /** User information of the same revision (Annex II 1.4; GPSR art. 19) and the label's care lines. */
  instructions: output({ files: z.array(publicDocFile), care: z.array(careLine) }),
  /** Older declarations, newest first, each with the batches it covers and the leaflet of its revision. */
  versions: z.array(
    output({
      revision: z.number().int(),
      issuedOn: businessDate().nullable(),
      batches: batchSpan.nullable(),
      declarations: z.array(publicDocFile),
      instructions: z.array(publicDocFile),
    }),
  ),
  /**
   * Two records share this code (two ids with the same last 40 bits: rare): this page is match `n`, the others are listed
   * so the reader picks the product on their label (lookup again with their `n`). Empty almost always.
   */
  n: z.number().int(),
  others: z.array(output({ n: z.number().int(), style: output({ code: z.string(), name: z.string() }), batch: z.string().nullable() })),
  /**
   * B-W2b-260 (RG1:01; design links.doc › sec:recall): the safety notices of a recall or withdrawal of this batch or style,
   * published and not taken down, newest first; the page shows them before anything else. The API always sends the list
   * (empty: no notice, the section is not drawn); optional only so pages written before it still read.
   */
  notices: z.array(publicSafetyNotice).optional(),
  /**
   * B-W2b-236 (SY3:03): the style's main picture, shown through a copy stripped of camera and location data (never the
   * office's file): `GET /public/doc/<code>/picture/<fileId>`. null: the style has no main picture that can be shown (none,
   * not available yet, or a type that cannot be stripped). Optional only so pages written before it still read.
   */
  picture: output({ fileId: id(), contentType: z.string(), caption: z.string().nullable() }).nullable().optional(),
})
export type PublicDocPage = z.infer<typeof publicDocPage>

/** At most this many records are told apart under one code (a collision of three is already one in 10^12). */
export const MAX_CODE_MATCHES = 10

/**
 * POST /public/doc/lookup: the code read from the address or typed under "Type the code"; `n` picks one of several
 * records sharing it (`others`); `proof` only after a 429 `challenge`.
 */
export const lookupBody = input({
  code: z.string().min(1).max(200),
  n: z.number().int().min(0).max(MAX_CODE_MATCHES - 1).optional(),
  proof: input({ challenge: z.string().min(1).max(200), nonce: z.string().min(1).max(32) }).optional(),
})
export type LookupBody = z.infer<typeof lookupBody>

/** GET /compliance/public-doc/address (office): the public address of a style or a batch, as its label's QR prints it. */
export const addressQuery = input({ styleId: id().optional(), workOrderId: id().optional() })

export const addressView = output({
  kind: z.enum(PUBLIC_DOC_KINDS),
  code: z.string(),
  path: z.string(),
  /** The whole address on the factory web (what the QR holds). */
  address: z.string(),
  /** The page shows something today: a released batch, or a style with a published declaration. Otherwise the address answers "not found" until then. */
  live: z.boolean(),
})
export type AddressView = z.infer<typeof addressView>
