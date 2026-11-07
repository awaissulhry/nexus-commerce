import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { fileView, presignedView } from '../contract'
import { FILE_AUDIENCES, FILE_KINDS, RECORD_TYPE } from '../rules'
import { PART_SIZE_MAX, PART_SIZE_MIN, PARTS_PER_REQUEST } from './rules'

/**
 * The large uploads' contracts (COL-052; B-W2b-160). The SHA-256 of the WHOLE file is announced up front (hashed on the
 * device), each part's SHA-256 when its presigned PUT is asked for. The store's upload id stays inside the API.
 */

/** An upload in parts as the caller sees it: the parts the store took, the ones still missing. */
export const sessionView = output({
  id: id(),
  fileId: id(),
  status: z.enum(['OPEN', 'COMPLETED', 'ABORTED', 'EXPIRED']),
  partSizeBytes: z.number().int(),
  partCount: z.number().int(),
  partsDone: z.array(output({ partNumber: z.number().int(), sizeBytes: z.number().int() })),
  missing: z.array(z.number().int()),
  expiresAt: instant(),
  endedAt: instant().nullable(),
  version: z.number().int(),
})

const both = output({ file: fileView, session: sessionView })
const sessionParams = input({ sessionId: id() })

const common = {
  originalName: z.string().min(1).max(500),
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1),
  /** SHA-256 of the whole file, 64 lower-case hex digits. */
  sha256: z.string(),
  /** Every part but the last; default 8 MiB. */
  partSizeBytes: z.number().int().min(PART_SIZE_MIN).max(PART_SIZE_MAX).optional(),
  /** Default office only (a new version: the current version's sharing). OFFICE is always added. */
  visibility: z.array(z.enum(FILE_AUDIENCES)).max(FILE_AUDIENCES.length).optional(),
  floorSiteId: id().nullable().optional(),
  partyId: id().nullable().optional(),
}

export const startLargeUploadContract = defineContract({
  body: input({ companyId: id().nullable().optional(), recordType: z.string().regex(RECORD_TYPE), recordId: id(), kind: z.enum(FILE_KINDS), ...common }),
  response: { 201: both },
})

export const startLargeVersionContract = defineContract({ params: input({ fileId: id() }), body: input(common), response: { 201: both } })

export const getLargeUploadContract = defineContract({ params: sessionParams, response: { 200: both } })

export const presignPartsContract = defineContract({
  params: sessionParams,
  body: input({ parts: z.array(input({ partNumber: z.number().int().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(PARTS_PER_REQUEST) }),
  response: { 200: output({ parts: z.array(presignedView.extend({ partNumber: z.number().int(), sizeBytes: z.number().int() })) }) },
})

export const syncLargeUploadContract = defineContract({ params: sessionParams, response: { 200: both } })
export const completeLargeUploadContract = defineContract({ params: sessionParams, response: { 200: both } })
export const abortLargeUploadContract = defineContract({ params: sessionParams, response: { 200: both } })
