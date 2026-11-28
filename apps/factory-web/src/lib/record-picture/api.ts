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
  // owb-po7 (owb-po1): a request whose lines name no style but that has a chosen picture answers null style fields — read as '' (no words).
  styleId: z.string().nullable().transform((value) => value ?? ''),
  styleCode: z.string().nullable().transform((value) => value ?? ''),
  styleName: z.string().nullable().transform((value) => value ?? ''),
  styleCount: z.number(),
  fileId: z.string().nullable(),
  contentType: z.string().nullable(),
  small: z.object({ url: z.string(), expiresAt: z.string() }).nullable(),
})
const answerSchema = z.object({ pictures: z.array(pictureSchema), asOf: z.string() })

/**
 * The sources a batch route reads: every source but the floor's basket (owb-b4) — its picture comes from S5's basket read (a file
 * stamped for the device's site), given by the host as `held` or through its own `read`.
 */
export type BatchSource = Exclude<PictureSource, 'basket'>
export const isBatchSource = (source: PictureSource): source is BatchSource => source !== 'basket'

/** Each source's route and the body's id list. */
export const PICTURE_ROUTES: Readonly<Record<BatchSource, { readonly path: string; readonly key: string }>> = Object.freeze({
  order: { path: '/sales/orders/pictures', key: 'orderIds' },
  quote: { path: '/sales/quotes/pictures', key: 'quoteIds' },
  request: { path: '/sales/inquiries/pictures', key: 'inquiryIds' },
  // F-SA-283 (B-SA-074): a work order's style picture, walled as the work-order list (a mixed one only for every-customer people).
  workorder: { path: '/production/work-orders/pictures', key: 'workOrderIds' },
  // F-CQ-103 (B-CQ-030, customer page › Quotes & incoming): a portal order's (a draft's too) first style, walled as the drafts and
  // Incoming read it (orders.view over its company and customer) — never again a cart icon for a garment.
  portalOrder: { path: '/sales/order-requests/pictures', key: 'requestIds' },
  // pg-w2 (D4, Z12): the customer's portal list — the partner read finds the party's OWN orders among the ids, then their first style's
  // small picture (walled as the order page's lines); an order the party does not own is absent. The answer names no file (fileId null).
  customerOrder: { path: '/portal/sales-orders/pictures', key: 'orderIds' },
  // owb-po7 (owb-po1: body `{ orderIds?, requestIds? }`): the customer's draft or sent order (a portal order request) — its chosen picture
  // first, else its first live line's style. Same route, its own key; never an office series.
  customerRequest: { path: '/portal/sales-orders/pictures', key: 'requestIds' },
})

/**
 * pg-w2 (D4): the customer's answer never names a file (`fileId: null`), but the cache keeps a small address by its file: the
 * customer's picture is kept under its order instead — a key of this browser's cache only, never sent anywhere, never opened.
 */
const keyedOf = (source: PictureSource, picture: PictureAnswer): PictureAnswer => ((source === 'customerOrder' || source === 'customerRequest') && picture.fileId === null && picture.small ? { ...picture, fileId: `${source}:${picture.id}` } : picture)

/** One batch read (the page's own API client). owb-b4: the floor's basket has no batch route — nothing is asked, nothing answers. */
export async function readPictures(api: ApiClient, source: PictureSource, ids: readonly string[], signal?: AbortSignal): Promise<PictureAnswer[]> {
  if (!isBatchSource(source)) return []
  const route = PICTURE_ROUTES[source]
  const answer = await api.post(route.path, { body: { [route.key]: [...ids] }, schema: answerSchema, signal })
  // end check (#1649): the local store's path through /api.
  return answer.pictures.map((picture) => keyedOf(source, picture.small ? { ...picture, small: { url: browserAddress(picture.small.url), expiresAt: picture.small.expiresAt } } : picture))
}

/** The reader a page gives the part (its own API client): `const read = useMemo(() => pictureReader(api), [api])`. */
export const pictureReader =
  (api: ApiClient): ReadPictures =>
  (source, ids) =>
    readPictures(api, source, ids)

// ---- owb-b4 w4.3: the command `orders.picture.set` (owb-b23 "Shapes": POST …/picture) --------------------------------------------

/**
 * The four doors of the command (owb-b23 b3.2; S1 ask 23:36): the office's order and request (`orders.manage`), the customer's request
 * and order (`portal.orderDrafts.edit` for both, before and after Send). The host picks its door; the window never builds an address.
 */
export type PictureDoor = 'office' | 'portal'
export type PictureRecord = 'order' | 'request'
export function orderPicturePath(door: PictureDoor, record: PictureRecord, id: string): string {
  const key = encodeURIComponent(id)
  if (door === 'office') return record === 'order' ? `/sales/orders/${key}/picture` : `/sales/order-requests/${key}/picture`
  return record === 'order' ? `/portal/sales-orders/${key}/picture` : `/portal/order-requests/${key}/picture`
}

/** The body: the chosen file (null: back to the design of the first line) and the record's version the window opened with. */
export interface OrderPictureBody {
  readonly fileId: string | null
  readonly version: number
}

/** The answer, parsed with this web's own zod (a field the server adds later is ignored). */
export const orderPictureSavedSchema = z.object({ pictureFileId: z.string().nullable(), pictureSetAt: z.string().nullable().default(null), version: z.number() })
export type OrderPictureSaved = z.infer<typeof orderPictureSavedSchema>

/** The save port a host gives the window: its door's POST (a 409 stale version, 404 out of reach, 422 not an allowed file throw). */
export type SaveOrderPicture = (body: OrderPictureBody) => Promise<OrderPictureSaved>

/** The save port over the host's own API client and its door: `orderPictureSaver(api, orderPicturePath('office', 'order', id))`. */
export const orderPictureSaver =
  (api: ApiClient, path: string): SaveOrderPicture =>
  (body) =>
    api.post(path, { body: { fileId: body.fileId, version: body.version }, schema: orderPictureSavedSchema })
