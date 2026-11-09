import { z } from 'zod'
import { BODY_ZONES, PHOTO_RULES, PHOTO_VIEWS, type MeasureForm, type PhotoView } from '@nexus/factory-domain/sales/measure-link/rules'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { presignedSchema } from '../../record-panels/api'
import { putToStore, readFromStore, sha256Hex } from '../../record-panels/store'

/**
 * Send measurements by link (apps/factory-api modules/sales/measure-link, B-W2b-171; a MEASUREMENTS link of one rider's
 * measurement profile). Reading uses nothing; the one send uses the link:
 *
 *   GET  /link/measure?language=                   the sender, the rider and garment, the public notice in force and whether
 *                                                  it was ticked on this link, photos required or optional, the points
 *   POST /link/measure/notice {noticeId}           "I have read how my measurements are used" (kept with its time)
 *   GET|PUT /link/draft                            the form kept with us (B-W2b-163), never on the device
 *   POST /link/measure/photos (+ /:fileId/complete)  a photo: announced with its SHA-256, PUT to the store, confirmed
 *   GET  /link/measure/photos/:fileId/preview      a photo taken earlier on this link (a resumed draft), without location
 *   POST /link/measure  (Idempotency-Key)          the send: a new revision of the profile
 *
 * The API's English is never shown: the page speaks its own catalogue from codes, paths and numbers. The token travels
 * only in `x-factory-link` (the client the link landing made).
 */

const words = z.object({ it: z.string(), en: z.string() })

export const measurePageSchema = z.object({
  sender: z.object({ companyId: z.string(), companyName: z.string() }),
  rider: z.object({ name: z.string() }),
  garment: z.object({ code: z.string(), name: words }),
  order: z.object({ number: z.string() }).nullable(),
  notice: z.object({ id: z.string(), label: z.string(), publishedAt: z.string().nullable() }).nullable(),
  noticeRead: z.object({ noticeId: z.string(), at: z.string() }).nullable(),
  photos: z.enum(PHOTO_RULES),
  points: z.array(
    z.object({
      code: z.string(),
      name: words,
      seq: z.number(),
      zone: z.enum(BODY_ZONES),
      required: z.boolean(),
      minCm: z.string().nullable(),
      maxCm: z.string().nullable(),
      howTo: z.string().nullable(),
    }),
  ),
  link: z.object({ expiresAt: z.string(), usesLeft: z.number(), live: z.boolean() }),
  locale: z.enum(['it', 'en']),
})
export type MeasurePage = z.infer<typeof measurePageSchema>
export type PagePoint = MeasurePage['points'][number]

export function readMeasurePage(api: ApiClient, language: 'it' | 'en', signal?: AbortSignal): Promise<MeasurePage> {
  return api.get('/link/measure', { query: { language }, schema: measurePageSchema, signal })
}

const noticeSchema = z.object({ noticeRead: z.object({ noticeId: z.string(), at: z.string() }) })

/** The tick of the notice in force: its time is kept by the API (a second tick answers the first). */
export function readNotice(api: ApiClient, noticeId: string): Promise<{ noticeId: string; at: string }> {
  return api.post('/link/measure/notice', { body: { noticeId }, schema: noticeSchema, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.noticeRead)
}

// ---- the draft kept with us (B-W2b-163) ---------------------------------------------------------------------------------

const draftSchema = z.object({
  draft: z.object({ data: z.record(z.string(), z.unknown()), version: z.number(), savedAt: z.string(), purgeAfter: z.string() }).nullable(),
  link: z.object({ expiresAt: z.string() }),
})
export type DraftRead = z.infer<typeof draftSchema>
const savedSchema = z.object({ draft: z.object({ version: z.number(), savedAt: z.string(), purgeAfter: z.string() }) })
export type DraftSaved = z.infer<typeof savedSchema>['draft']

export function readDraft(api: ApiClient, signal?: AbortSignal): Promise<DraftRead> {
  return api.get('/link/draft', { schema: draftSchema, signal })
}

/** A link write: each save its own Idempotency-Key (the API refuses a link write without one). */
export function saveDraft(api: ApiClient, data: Record<string, unknown>, version: number | null): Promise<DraftSaved> {
  return api.request('PUT', '/link/draft', { body: version === null ? { data } : { data, version }, schema: savedSchema, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.draft)
}

// ---- photos ---------------------------------------------------------------------------------------------------------------

const fileSchema = z.object({ id: z.string(), view: z.enum(PHOTO_VIEWS), sizeBytes: z.number(), status: z.string() })
const uploadSchema = z.object({ file: fileSchema, upload: presignedSchema })
const completeSchema = z.object({ file: fileSchema })
const previewSchema = z.object({ file: fileSchema, preview: presignedSchema })

/** One photo: announced with its SHA-256, its bytes PUT straight to the store, then confirmed (each step its own key). */
export async function uploadMeasurePhoto(api: ApiClient, view: PhotoView, photo: Blob, put: typeof putToStore = putToStore): Promise<{ fileId: string; status: string }> {
  const bytes = await photo.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const announced = await api.post('/link/measure/photos', {
    body: { view, originalName: `${view.toLowerCase()}.jpg`, contentType: photo.type || 'image/jpeg', sizeBytes: bytes.byteLength, sha256 },
    schema: uploadSchema,
    idempotencyKey: newIdempotencyKey(),
  })
  await put(announced.upload, bytes)
  const done = await api.post(`/link/measure/photos/${encodeURIComponent(announced.file.id)}/complete`, { schema: completeSchema, idempotencyKey: newIdempotencyKey() })
  return { fileId: done.file.id, status: done.file.status }
}

/** A photo taken earlier on this link: its bytes without location data, read once. */
export async function measurePhotoBytes(api: ApiClient, fileId: string): Promise<Uint8Array> {
  const answer = await api.get(`/link/measure/photos/${encodeURIComponent(fileId)}/preview`, { schema: previewSchema })
  return readFromStore(answer.preview)
}

// ---- the send -------------------------------------------------------------------------------------------------------------

const sentSchema = z.object({ sent: z.object({ profileId: z.string(), revision: z.number(), at: z.string(), photos: z.number() }), link: z.object({ usesLeft: z.number() }) })
export type MeasureSent = z.infer<typeof sentSchema>['sent']

export function sendMeasurements(api: ApiClient, form: MeasureForm, noticeId: string, typedName: string | null, idempotencyKey: string): Promise<MeasureSent> {
  return api.post('/link/measure', { body: { ...form, noticeId, typedName }, schema: sentSchema, idempotencyKey }).then((answer) => answer.sent)
}
