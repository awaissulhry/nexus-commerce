import { z } from 'zod'
import { stylePicturesView, type AddPictureBody, type PictureView, type StylePicturesView, type UpdatePictureBody } from '@nexus/factory-domain/product/images/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { presignedSchema } from '../../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../../record-panels/store'

/**
 * A style's Sketches and pictures (apps/factory-api modules/product/images, B-W2b-236): every call of the section. A
 * picture's bytes never pass through the API: announced as a PHOTO of the Style (`POST /files`), PUT to the store with the
 * presigned request, confirmed (`POST /files/<id>/complete`), then named a picture (`POST …/pictures`). Each answer is
 * the whole section again (each look is the picture's own address on the API).
 */

export type { PictureView, StylePicturesView }

const answer = z.object({ pictures: stylePicturesView })
const base = (styleId: string) => `/product/styles/${encodeURIComponent(styleId)}/pictures`

export const readPictures = (api: ApiClient, styleId: string, signal?: AbortSignal): Promise<StylePicturesView> => api.get(base(styleId), { schema: answer, signal }).then((value) => value.pictures)

/** A picture file of the style: announced, sent, confirmed. Answers its id and whether it is available (a scanner may hold it). */
export async function uploadPictureFile(api: ApiClient, style: { id: string; companyId: string | null }, file: File): Promise<{ fileId: string; available: boolean }> {
  const bytes = await file.arrayBuffer()
  const announced = await api.post('/files', {
    body: { companyId: style.companyId, recordType: 'Style', recordId: style.id, kind: 'PHOTO', originalName: file.name, contentType: file.type, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) },
    schema: z.object({ file: z.object({ id: z.string() }), upload: presignedSchema }),
    idempotencyKey: newIdempotencyKey(),
  })
  await putToStore(announced.upload, bytes)
  const done = await api.post(`/files/${encodeURIComponent(announced.file.id)}/complete`, { body: {}, schema: z.object({ file: z.object({ id: z.string(), status: z.string() }) }), idempotencyKey: newIdempotencyKey() })
  return { fileId: announced.file.id, available: done.file.status === 'AVAILABLE' }
}

export const addPicture = (api: ApiClient, styleId: string, body: AddPictureBody): Promise<StylePicturesView> =>
  api.post(base(styleId), { body, schema: answer, idempotencyKey: newIdempotencyKey() }).then((value) => value.pictures)

export const updatePicture = (api: ApiClient, styleId: string, pictureId: string, body: UpdatePictureBody): Promise<StylePicturesView> =>
  api.request('PATCH', `${base(styleId)}/${encodeURIComponent(pictureId)}`, { body, schema: answer, idempotencyKey: newIdempotencyKey() }).then((value) => value.pictures)

export const setMainPicture = (api: ApiClient, styleId: string, picture: Pick<PictureView, 'id' | 'version'>): Promise<StylePicturesView> =>
  api.post(`${base(styleId)}/${encodeURIComponent(picture.id)}/main`, { body: { version: picture.version }, schema: answer, idempotencyKey: newIdempotencyKey() }).then((value) => value.pictures)

export const orderPictures = (api: ApiClient, styleId: string, ids: readonly string[]): Promise<StylePicturesView> =>
  api.request('PUT', `${base(styleId)}/order`, { body: { ids }, schema: answer, idempotencyKey: newIdempotencyKey() }).then((value) => value.pictures)

export const removePicture = (api: ApiClient, styleId: string, picture: Pick<PictureView, 'id' | 'version'>): Promise<StylePicturesView> =>
  api.request('DELETE', `${base(styleId)}/${encodeURIComponent(picture.id)}`, { query: { version: picture.version }, schema: answer, idempotencyKey: newIdempotencyKey() }).then((value) => value.pictures)
