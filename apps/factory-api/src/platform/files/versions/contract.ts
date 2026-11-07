import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { fileView, presignedView } from '../contract'
import { FILE_AUDIENCES } from '../rules'

/**
 * The versions routes' contracts (COL-046, PLT-216; B-W2b-160). A new version is announced like an upload (its bytes go
 * straight to the store with the presigned PUT, then POST /files/:id/complete confirms it); its record, company and kind
 * are its series'. Sharing left out: the current version's.
 */

const fileParams = input({ fileId: id() })

export const requestVersionContract = defineContract({
  params: fileParams,
  body: input({
    originalName: z.string().min(1).max(500),
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(1),
    /** SHA-256 of the content, 64 lower-case hex digits. */
    sha256: z.string(),
    /** Default: the current version's sharing. OFFICE is always added. */
    visibility: z.array(z.enum(FILE_AUDIENCES)).max(FILE_AUDIENCES.length).optional(),
    floorSiteId: id().nullable().optional(),
    partyId: id().nullable().optional(),
  }),
  response: { 201: output({ file: fileView, upload: presignedView }) },
})

/** A version in its series: `current` = AVAILABLE and not superseded (the one in force). */
export const versionView = fileView.extend({ current: z.boolean() })

export const listVersionsContract = defineContract({ params: fileParams, response: { 200: output({ versions: z.array(versionView) }) } })

export const restoreVersionContract = defineContract({ params: fileParams, response: { 201: output({ file: fileView }) } })
