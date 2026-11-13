import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import { fileSchema } from '../../../../../record-panels/api'
import { pickerReasons } from '../../../../_shared/reasons/api'

/**
 * What a supplier's document is (B-W2b-382 on B-W2b-377's route; SCM-020): the tenant's SUPPLIER_DOCUMENT_TYPE codes
 * (`GET /reasons?list=SUPPLIER_DOCUMENT_TYPE`, their own words in Italian and English), the file's version as read now
 * (`GET /files/:id`), and the type (`PUT /purchasing/suppliers/:partyId/documents/:fileId/type {version, documentTypeCode |
 * null}`, files.upload over the file's company + parties.view: a code of the list, a current vault file).
 */

export const documentTypes = (api: ApiClient, signal?: AbortSignal) => pickerReasons(api, ['SUPPLIER_DOCUMENT_TYPE'], signal)

export const fileVersion = async (api: ApiClient, fileId: string, signal?: AbortSignal): Promise<number> =>
  (await api.get(`/files/${encodeURIComponent(fileId)}`, { schema: z.object({ file: fileSchema }), signal })).file.version

export const setDocumentType = (api: ApiClient, partyId: string, fileId: string, body: { readonly version: number; readonly documentTypeCode: string | null }, idempotencyKey: string) =>
  api.request('PUT', `/purchasing/suppliers/${encodeURIComponent(partyId)}/documents/${encodeURIComponent(fileId)}/type`, {
    body,
    schema: z.object({ fileId: z.string(), documentTypeCode: z.string().nullable(), version: z.number() }),
    idempotencyKey,
  })
