import { announcedView, completedView, datedView, openedView, photosView, type DeleteOnBody, type PhotosView, type PhotoView } from '@nexus/factory-domain/sales/mtm-photos/contracts'
import type { MtmPhotoView } from '@nexus/factory-domain/sales/mtm-photos/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { putToStore, sha256Hex } from '../../../../record-panels/store'

/**
 * The made-to-measure office photos' calls (B-W2b-371, XF2:01; B-W2b-371's modules/sales/mtm/photos): the chain's office and fitting
 * photos, a photo added (announced, its bytes PUT straight to the store, confirmed: one Idempotency-Key per attempt for the pair),
 * opened (its stripped copy for 60 seconds), its delete date moved at the photo's version. Answers are checked against factory-domain's
 * own contracts; the API's English is never shown (model.ts says it from codes and paths).
 */

export type { PhotosView, PhotoView }
export type PhotoTarget = { readonly kind: 'profile'; readonly id: string } | { readonly kind: 'fitting'; readonly id: string }

const enc = encodeURIComponent
const base = (target: PhotoTarget): string => (target.kind === 'profile' ? `/sales/mtm/profiles/${enc(target.id)}/photos` : `/sales/fittings/results/${enc(target.id)}/photos`)

/** The chain's office and fitting photos (any revision's id answers it). */
export function readPhotos(api: ApiClient, profileId: string, signal?: AbortSignal): Promise<PhotosView> {
  return api.get(`/sales/mtm/profiles/${enc(profileId)}/photos`, { schema: photosView, signal })
}

/** One photo added: announced with its view and delete date, the bytes to the store, then confirmed. */
export async function uploadPhoto(api: ApiClient, target: PhotoTarget, file: File, body: { readonly view: MtmPhotoView; readonly deleteOn: string | null }, idempotencyKey: string = newIdempotencyKey()): Promise<PhotoView> {
  const bytes = await file.arrayBuffer()
  const announced = await api.post(base(target), {
    body: { view: body.view, contentType: file.type || 'application/octet-stream', sizeBytes: file.size, sha256: await sha256Hex(bytes), ...(body.deleteOn ? { deleteOn: body.deleteOn } : {}) },
    schema: announcedView,
    idempotencyKey,
  })
  await putToStore({ ...announced.upload, method: 'PUT' }, bytes)
  return (await api.post(`${base(target)}/${enc(announced.file.id)}/complete`, { body: {}, schema: completedView, idempotencyKey: `${idempotencyKey}-c` })).photo
}

/** One photo, its stripped copy (no location data) for 60 seconds; the opening is recorded on the profile. */
export function openPhoto(api: ApiClient, fileId: string) {
  return api.post(`/sales/mtm/photos/${enc(fileId)}/open`, { body: {}, schema: openedView })
}

/** The photo's delete date moved (earlier or later; today: within the hour), with why, at its version. */
export async function datePhoto(api: ApiClient, target: PhotoTarget, photo: Pick<PhotoView, 'id'>, body: DeleteOnBody, idempotencyKey: string = newIdempotencyKey()): Promise<PhotoView> {
  return (await api.request('PUT', `${base(target)}/${enc(photo.id)}/delete-after`, { body, schema: datedView, idempotencyKey })).photo
}
