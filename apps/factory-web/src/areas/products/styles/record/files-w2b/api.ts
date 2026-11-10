import { z } from 'zod'
import { downloadView, patternFilesView, type AddPatternFileBody, type PatternFilesView, type PatternFileView, type UpdatePatternFileBody } from '@nexus/factory-domain/product/images/contracts'
import { patternContentTypeOf } from '@nexus/factory-domain/product/images/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { presignedSchema } from '../../../../../record-panels/api'
import { putToStore, sha256Hex, storeUrl } from '../../../../../record-panels/store'

/**
 * A revision's pattern files (apps/factory-api modules/product/images, B-W2b-236; PRD-218): every call of Files & patterns ›
 * Pattern files. A pattern file is sent to the revision in parts (the files platform takes a DXF or an HP-GL plot only that
 * way: `POST /files/uploads` as a DOCUMENT of the StyleRevision, a presigned PUT per part, then complete), then named here
 * with its kind, format, sizes and note; a newer version goes the same way into the file's series
 * (`POST /files/<id>/versions/uploads`), then the row names it. Each answer is the whole section again.
 */

export type { PatternFilesView, PatternFileView }

const answer = z.object({ patternFiles: patternFilesView })
const base = (styleId: string, revisionId: string) => `/product/styles/${encodeURIComponent(styleId)}/revisions/${encodeURIComponent(revisionId)}/pattern-files`

export const readPatternFiles = (api: ApiClient, styleId: string, revisionId: string, signal?: AbortSignal): Promise<PatternFilesView> =>
  api.get(base(styleId, revisionId), { schema: answer, signal }).then((value) => value.patternFiles)

/** The file's type cannot be sent (a native Lectra or Gerber file: export it as DXF-AAMA or a PDF plot first). */
export class PatternTypeError extends Error {
  override name = 'PatternTypeError'
}

const started = z.object({ file: z.object({ id: z.string(), status: z.string() }), session: z.object({ id: z.string(), partSizeBytes: z.number(), partCount: z.number() }) })

/** Sends a pattern file in parts to the revision (or as a new version of `of`): its id and whether it is available. */
export async function sendPatternFile(api: ApiClient, target: { companyId: string | null; revisionId: string; of?: string }, file: File): Promise<{ fileId: string; available: boolean }> {
  const contentType = patternContentTypeOf(file.name, file.type)
  if (!contentType) throw new PatternTypeError(file.name)
  const bytes = await file.arrayBuffer()
  const common = { originalName: file.name, contentType, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) }
  const start = target.of
    ? await api.post(`/files/${encodeURIComponent(target.of)}/versions/uploads`, { body: common, schema: started, idempotencyKey: newIdempotencyKey() })
    : await api.post('/files/uploads', { body: { companyId: target.companyId, recordType: 'StyleRevision', recordId: target.revisionId, kind: 'DOCUMENT', ...common }, schema: started, idempotencyKey: newIdempotencyKey() })
  const session = `/files/uploads/${encodeURIComponent(start.session.id)}`
  for (let number = 1; number <= start.session.partCount; number++) {
    const part = bytes.slice((number - 1) * start.session.partSizeBytes, Math.min(bytes.byteLength, number * start.session.partSizeBytes))
    const signed = await api.post(`${session}/parts`, { body: { parts: [{ partNumber: number, sha256: await sha256Hex(part) }] }, schema: z.object({ parts: z.array(presignedSchema.extend({ partNumber: z.number() })) }) })
    await putToStore(signed.parts[0]!, part)
  }
  const done = await api.post(`${session}/complete`, { body: {}, schema: z.object({ file: z.object({ id: z.string(), status: z.string() }) }), idempotencyKey: newIdempotencyKey() })
  return { fileId: start.file.id, available: done.file.status === 'AVAILABLE' }
}

export const addPatternFile = (api: ApiClient, styleId: string, revisionId: string, body: AddPatternFileBody): Promise<PatternFilesView> =>
  api.post(base(styleId, revisionId), { body, schema: answer, idempotencyKey: newIdempotencyKey() }).then((value) => value.patternFiles)

export const updatePatternFile = (api: ApiClient, styleId: string, revisionId: string, id: string, body: UpdatePatternFileBody): Promise<PatternFilesView> =>
  api.request('PATCH', `${base(styleId, revisionId)}/${encodeURIComponent(id)}`, { body, schema: answer, idempotencyKey: newIdempotencyKey() }).then((value) => value.patternFiles)

export const setPatternFileVersion = (api: ApiClient, styleId: string, revisionId: string, row: Pick<PatternFileView, 'id' | 'version'>, fileId: string): Promise<PatternFilesView> =>
  api.request('PUT', `${base(styleId, revisionId)}/${encodeURIComponent(row.id)}/file`, { body: { version: row.version, fileId }, schema: answer, idempotencyKey: newIdempotencyKey() }).then((value) => value.patternFiles)

export const removePatternFiles = (api: ApiClient, styleId: string, revisionId: string, items: readonly Pick<PatternFileView, 'id' | 'version'>[]): Promise<PatternFilesView> =>
  api.post(`${base(styleId, revisionId)}/remove`, { body: { items: items.map((item) => ({ id: item.id, version: item.version })) }, schema: answer, idempotencyKey: newIdempotencyKey() }).then((value) => value.patternFiles)

/** The address the browser downloads the file (or one of its versions) from: a presigned attachment of 60 s. */
export async function patternDownloadAddress(api: ApiClient, styleId: string, revisionId: string, id: string, fileId?: string): Promise<string> {
  const answered = await api.get(`${base(styleId, revisionId)}/${encodeURIComponent(id)}/download`, { query: fileId ? { fileId } : {}, schema: downloadView })
  return storeUrl(answered.download.url)
}
