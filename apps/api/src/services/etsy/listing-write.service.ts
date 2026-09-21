/**
 * P4.6d — listing content and images on Etsy.
 *
 * Three endpoints, and they do not share a body format. That is the single most surprising thing
 * about writing to Etsy, and it is why this file exists rather than callers building requests:
 *
 * | what | endpoint | body |
 * |---|---|---|
 * | stock / price (P4.6c) | `PUT /listings/{id}/inventory` | **JSON**, full replace |
 * | content | `PATCH /shops/{shop}/listings/{id}` | **form-encoded**, partial |
 * | an image | `POST /shops/{shop}/listings/{id}/images` | **multipart** |
 * | an image | `DELETE /shops/{shop}/listings/{id}/images/{image}` | none |
 *
 * A content write is **partial**, so unlike the inventory PUT it does not carry the
 * regional-pricing risk and does not need a read-back to be safe. It still refuses to send a
 * change that would change nothing, for the same reason a no-op inventory PUT is refused: a call
 * that cannot do anything useful can still fail, be rate-limited, or be misread as activity.
 */
import { etsyWriter } from './write-client.js'
import {
  etsyListingContentFields, etsyListingStateFields,
  type EtsyListingContent, type EtsyListingStateChange,
} from './listing-content.js'
import type { GatewayRequest } from '../gateway/gateway.js'

function assertListingId(listingId: number | string): string {
  const id = String(listingId)
  if (!/^[1-9]\d*$/.test(id)) throw new Error('That is not an Etsy listing id; nothing was sent.')
  return id
}

export interface EtsyListingWriteInput {
  accountId: string
  listingId: number | string
  pushLock?: GatewayRequest['pushLock']
  ledger?: GatewayRequest['ledger']
}

/** Change a listing's text, tags, materials or image order. Only the fields given are touched. */
export async function updateEtsyListingContent(
  input: EtsyListingWriteInput & { content: EtsyListingContent },
): Promise<{ sent: true; fields: Record<string, unknown> }> {
  const listingId = assertListingId(input.listingId)
  const fields = etsyListingContentFields(input.content)
  const writer = await etsyWriter(input.accountId)
  await writer.send({
    path: `/shops/${writer.shopId}/listings/${listingId}`,
    method: 'PATCH',
    form: fields,
    kind: 'write',
    pushLock: input.pushLock,
    ledger: input.ledger,
    operation: 'PATCH /shops/:id/listings/:id',
  })
  return { sent: true, fields }
}

/**
 * Show or hide a listing. Separate from content on purpose — see `listing-content.ts`: making a
 * sold-out listing active also sets its quantity to 1 and charges a renewal.
 */
export async function setEtsyListingState(
  input: EtsyListingWriteInput & { change: EtsyListingStateChange },
): Promise<{ sent: true; state: string }> {
  const listingId = assertListingId(input.listingId)
  const fields = etsyListingStateFields(input.change)
  const writer = await etsyWriter(input.accountId)
  await writer.send({
    path: `/shops/${writer.shopId}/listings/${listingId}`,
    method: 'PATCH',
    form: fields,
    kind: 'write',
    pushLock: input.pushLock,
    ledger: input.ledger,
    operation: 'PATCH /shops/:id/listings/:id (state)',
  })
  return { sent: true, state: input.change.state }
}

export interface EtsyImageUpload {
  bytes: Uint8Array | Blob
  fileName: string
  /** 1-based position. Etsy shows the image at rank 1 as the listing's main image. */
  rank?: number
  /** Replace whatever is already at that rank instead of inserting beside it. */
  overwrite?: boolean
  altText?: string
  isWatermarked?: boolean
}

/**
 * Add one image to a listing.
 *
 * 🔴 This is a POST with no idempotency key, so the write client does not retry it after a
 * transport failure — a retried upload is a **second copy of the same picture** on the seller's
 * listing, and Etsy caps a listing at 20. "It did not answer" is an unknown outcome, so the
 * safe move is to stop and let someone look.
 */
export async function uploadEtsyListingImage(
  input: EtsyListingWriteInput & { image: EtsyImageUpload },
): Promise<{ listing_image_id?: number }> {
  const listingId = assertListingId(input.listingId)
  const { image } = input
  if (!image.fileName.trim()) throw new Error('An Etsy image needs a file name; nothing was sent.')
  if (image.rank !== undefined && (!Number.isInteger(image.rank) || image.rank < 1)) {
    throw new Error('An Etsy image rank must be a positive whole number; nothing was sent.')
  }
  if (image.altText !== undefined && image.altText.length > 500) {
    // Etsy's documented cap. Refused rather than trimmed: a caption cut in half is a change the
    // operator did not make and cannot see.
    throw new Error(`Etsy allows 500 characters of alt text and this has ${image.altText.length}; nothing was sent.`)
  }

  const form = new FormData()
  const blob = image.bytes instanceof Blob ? image.bytes : new Blob([image.bytes])
  form.set('image', blob, image.fileName)
  if (image.rank !== undefined) form.set('rank', String(image.rank))
  if (image.overwrite !== undefined) form.set('overwrite', String(image.overwrite))
  if (image.isWatermarked !== undefined) form.set('is_watermarked', String(image.isWatermarked))
  if (image.altText !== undefined) form.set('alt_text', image.altText)

  const writer = await etsyWriter(input.accountId)
  return await writer.send<{ listing_image_id?: number }>({
    path: `/shops/${writer.shopId}/listings/${listingId}/images`,
    method: 'POST',
    body: form,
    kind: 'write',
    pushLock: input.pushLock,
    ledger: input.ledger,
    operation: 'POST /shops/:id/listings/:id/images',
  })
}

/** Remove one image from a listing. A DELETE, so the write client may repeat it safely. */
export async function deleteEtsyListingImage(
  input: EtsyListingWriteInput & { imageId: number | string },
): Promise<void> {
  const listingId = assertListingId(input.listingId)
  const imageId = String(input.imageId)
  if (!/^[1-9]\d*$/.test(imageId)) throw new Error('That is not an Etsy image id; nothing was sent.')
  const writer = await etsyWriter(input.accountId)
  await writer.send({
    path: `/shops/${writer.shopId}/listings/${listingId}/images/${imageId}`,
    method: 'DELETE',
    kind: 'write',
    pushLock: input.pushLock,
    ledger: input.ledger,
    operation: 'DELETE /shops/:id/listings/:id/images/:id',
  })
}
