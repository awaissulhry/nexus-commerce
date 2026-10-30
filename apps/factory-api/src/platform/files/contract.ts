import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { FILE_AUDIENCES, FILE_KINDS, FILE_SCAN_STATUSES, FILE_STATUSES, QUARANTINE_REASONS, RECORD_TYPE } from './rules'

/**
 * The files routes' contracts (plan A1 §3.6). A file is never sent through the API: an upload is announced (POST
 * /files), sent straight to the store with the presigned request in the answer, then confirmed (POST …/complete); a
 * download is a presigned GET that lives 60 seconds. The storage key and the store account stay inside the API.
 * Columns a floor or partner role cannot read (legal hold; the other audience's site or party) are left out of its view.
 */

export const fileView = output({
  id: id(),
  companyId: id().nullable(),
  recordType: z.string(),
  recordId: id(),
  kind: z.enum(FILE_KINDS),
  originalName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  status: z.enum(FILE_STATUSES),
  visibility: z.array(z.enum(FILE_AUDIENCES)),
  floorSiteId: id().nullable().optional(),
  partyId: id().nullable().optional(),
  retainUntil: instant().nullable(),
  legalHold: z.boolean().optional(),
  quarantineReason: z.enum(QUARANTINE_REASONS).nullable(),
  /** The virus scan (B-W2a-42): NOT_SCANNED without a scanner; the office also sees the scanner and what it found. */
  scanStatus: z.enum(FILE_SCAN_STATUSES),
  scannedAt: instant().nullable(),
  scanEngine: z.string().nullable().optional(),
  scanFinding: z.string().nullable().optional(),
  availableAt: instant().nullable(),
  deletedAt: instant().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type FileView = z.infer<typeof fileView>

/** A request to make straight to the store: send exactly these headers (they are signed) before `expiresAt`. */
export const presignedView = output({
  method: z.enum(['PUT', 'GET']),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  expiresAt: instant(),
})

const fileParams = input({ fileId: id() })
const version = () => z.number().int().min(1)
const one = { 200: output({ file: fileView }) }

export const requestUploadContract = defineContract({
  body: input({
    /** The company whose staff see the file; null or left out for tenant-wide master data. */
    companyId: id().nullable().optional(),
    /** The record it belongs to: its model name and id. */
    recordType: z.string().regex(RECORD_TYPE),
    recordId: id(),
    kind: z.enum(FILE_KINDS),
    originalName: z.string().min(1).max(500),
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(1),
    /** SHA-256 of the content, 64 lower-case hex digits: the store refuses a body that does not match. */
    sha256: z.string(),
    /** Default office only. OFFICE is always added. */
    visibility: z.array(z.enum(FILE_AUDIENCES)).max(FILE_AUDIENCES.length).optional(),
    /** With FLOOR: the site whose floor sees it (one of the company's sites). */
    floorSiteId: id().nullable().optional(),
    /** With PARTNER or LINK: the party it is shared with. */
    partyId: id().nullable().optional(),
    /** Keep it at least until then (a fiscal archive file: ten years from now, or later). */
    retainUntil: instant().nullable().optional(),
  }),
  response: { 201: output({ file: fileView, upload: presignedView }) },
})

export const completeUploadContract = defineContract({ params: fileParams, response: one })

export const listFilesContract = defineContract({
  querystring: input({ recordType: z.string().regex(RECORD_TYPE), recordId: id() }),
  response: { 200: output({ files: z.array(fileView) }) },
})

export const getFileContract = defineContract({ params: fileParams, response: one })

export const downloadContract = defineContract({ params: fileParams, response: { 200: output({ download: presignedView }) } })

export const setVisibilityContract = defineContract({
  params: fileParams,
  body: input({
    visibility: z.array(z.enum(FILE_AUDIENCES)).max(FILE_AUDIENCES.length),
    floorSiteId: id().nullable().optional(),
    partyId: id().nullable().optional(),
    version: version(),
  }),
  response: one,
})

export const setRetentionContract = defineContract({
  params: fileParams,
  body: input({
    legalHold: z.boolean().optional(),
    /** Only ever later than the current date. */
    retainUntil: instant().optional(),
    /** Why (for the audit log). */
    reason: z.string().trim().min(3).max(500),
    version: version(),
  }),
  response: one,
})

export const deleteFileContract = defineContract({
  params: fileParams,
  querystring: input({ version: z.coerce.number().int().min(1).optional(), reason: z.string().trim().min(3).max(500).optional() }),
  response: one,
})

const tokenQuery = input({ token: z.string().min(16).max(4096) })
/** The local store's upload: the raw body, checked against the token's grant. */
export const localUploadContract = defineContract({ querystring: tokenQuery, response: { 200: output({ status: z.literal('stored') }) } })
/** The local store's download: the raw bytes, as an attachment. */
export const localDownloadContract = defineContract({ querystring: tokenQuery, response: {} })
