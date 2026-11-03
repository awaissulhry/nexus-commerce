import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { completeUpload, presignedSchema, requestUpload } from '../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../record-panels/store'

/**
 * A hide's photos (B-W2b-131; MES-060; design warehouse.hides "Photos" of the hide record and the grid's Photo column, pop-up
 * hd-photo): which photos each hide has and where each was taken (`GET /inventory/leather/photos`, inventory.stock.view; the
 * photos themselves need files.read: `canRead` false → none), the image's address (`GET /files/:fileId/download`, a presigned
 * GET that lives 60 seconds), and an office photo added to a hide through the generic files routes (files.upload). The API's
 * English is never drawn: the screens say where a photo was taken from `place` and `floor`.
 */

const seg = (value: string) => encodeURIComponent(value)

export const PHOTO_PLACES = ['CUTTING_TABLE', 'INSPECTION'] as const
export type PhotoPlace = (typeof PHOTO_PLACES)[number]

const photoSchema = z.object({
  fileId: z.string(),
  originalName: z.string(),
  contentType: z.string(),
  createdAt: z.string(),
  /** Where it was taken when a record says so (a cut log entry, an incoming inspection's mark); null: not recorded. */
  place: z.enum(PHOTO_PLACES).nullable(),
  /** Shared with the floor: taken on a tablet. */
  floor: z.boolean(),
  workOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
})
export type HidePhoto = z.infer<typeof photoSchema>

const photosSchema = z.object({
  canRead: z.boolean(),
  hides: z.array(z.object({ hideId: z.string(), photos: z.array(photoSchema) })),
})
export type HidePhotosAnswer = z.infer<typeof photosSchema>

/** The most hide ids one read takes (the route's limit). */
export const PHOTOS_PER_READ = 100

/** GET /inventory/leather/photos?hideIds=a,b: each hide's photos, newest first (AVAILABLE only). */
export async function hidePhotos(api: ApiClient, hideIds: readonly string[], signal?: AbortSignal): Promise<HidePhotosAnswer> {
  const ids = [...new Set(hideIds)]
  if (ids.length === 0) return { canRead: true, hides: [] }
  const answers: HidePhotosAnswer[] = []
  for (let start = 0; start < ids.length; start += PHOTOS_PER_READ) {
    answers.push(await api.get('/inventory/leather/photos', { query: { hideIds: ids.slice(start, start + PHOTOS_PER_READ).join(',') }, schema: photosSchema, signal }))
  }
  return { canRead: answers.every((answer) => answer.canRead), hides: answers.flatMap((answer) => answer.hides) }
}

/** A photo's address for an <img> (a same-origin path of the local store goes through this app's /api). */
export async function photoUrl(api: ApiClient, fileId: string, signal?: AbortSignal): Promise<string> {
  const answer = await api.get(`/files/${seg(fileId)}/download`, { schema: z.object({ download: presignedSchema }), signal })
  const url = answer.download.url
  return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url
}

/**
 * Adds a photo to a hide from the office: announced on the Hide (kind PHOTO, its company, office only), the bytes straight to
 * the store, then confirmed. Answers the file's status (AVAILABLE, or QUARANTINED when the store's check did not match).
 */
export async function uploadHidePhoto(api: ApiClient, hide: { id: string; companyId: string }, file: File): Promise<'AVAILABLE' | 'QUARANTINED' | string> {
  const bytes = await file.arrayBuffer()
  const contentType = file.type || 'image/jpeg'
  const { file: stored, upload } = await requestUpload(api, {
    companyId: hide.companyId,
    record: { type: 'Hide', id: hide.id },
    kind: 'PHOTO',
    name: file.name,
    contentType,
    sizeBytes: file.size,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, new Blob([bytes], { type: contentType }))
  const { file: done } = await completeUpload(api, stored.id)
  return done.status
}
