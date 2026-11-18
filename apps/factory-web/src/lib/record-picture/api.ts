import { z } from 'zod'
import { browserAddress } from '../api/browser-address'
import type { ApiClient } from '../api/client'
import type { ReadPictures } from './cache'
import type { PictureAnswer, PictureSource } from './model'

/**
 * F-SA-211 — the batch picture reads (B-SA-011): POST /sales/orders/pictures, /sales/quotes/pictures, /sales/inquiries/pictures
 * (F-SA-283, B-SA-074: and /production/work-orders/pictures)
 * with the record ids (1–200, each once); ONE answer shape. A record the reader may not see, or with no style, is absent. The
 * small preview's address is opened through this app's `/api` when the API answers it as a path (the local store: #1649,
 * browserAddress); a store's absolute address is used as it is.
 */

const pictureSchema = z.object({
  id: z.string(),
  styleId: z.string(),
  styleCode: z.string(),
  styleName: z.string(),
  styleCount: z.number(),
  fileId: z.string().nullable(),
  contentType: z.string().nullable(),
  small: z.object({ url: z.string(), expiresAt: z.string() }).nullable(),
})
const answerSchema = z.object({ pictures: z.array(pictureSchema), asOf: z.string() })

/** Each source's route and the body's id list. */
export const PICTURE_ROUTES: Readonly<Record<PictureSource, { readonly path: string; readonly key: string }>> = Object.freeze({
  order: { path: '/sales/orders/pictures', key: 'orderIds' },
  quote: { path: '/sales/quotes/pictures', key: 'quoteIds' },
  request: { path: '/sales/inquiries/pictures', key: 'inquiryIds' },
  // F-SA-283 (B-SA-074): a work order's style picture, walled as the work-order list (a mixed one only for every-customer people).
  workorder: { path: '/production/work-orders/pictures', key: 'workOrderIds' },
})

/** One batch read (the page's own API client). */
export async function readPictures(api: ApiClient, source: PictureSource, ids: readonly string[], signal?: AbortSignal): Promise<PictureAnswer[]> {
  const route = PICTURE_ROUTES[source]
  const answer = await api.post(route.path, { body: { [route.key]: [...ids] }, schema: answerSchema, signal })
  // end check (#1649): the local store's path through /api.
  return answer.pictures.map((picture) => (picture.small ? { ...picture, small: { url: browserAddress(picture.small.url), expiresAt: picture.small.expiresAt } } : picture))
}

/** The reader a page gives the part (its own API client): `const read = useMemo(() => pictureReader(api), [api])`. */
export const pictureReader =
  (api: ApiClient): ReadPictures =>
  (source, ids) =>
    readPictures(api, source, ids)
