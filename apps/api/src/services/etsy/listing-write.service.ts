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
 * | an attribute (E2) | `PUT` / `DELETE /shops/{shop}/listings/{id}/properties/{property}` | **form-encoded** / none |
 * | a translation (E2) | `POST` / `PUT /shops/{shop}/listings/{id}/translations/{language}` | **form-encoded** |
 *
 * A content write is **partial**, so unlike the inventory PUT it does not carry the
 * regional-pricing risk and does not need a read-back to be safe. It still refuses to send a
 * change that would change nothing, for the same reason a no-op inventory PUT is refused: a call
 * that cannot do anything useful can still fail, be rate-limited, or be misread as activity.
 */
import { etsyWriter } from './write-client.js'
import { EtsyReadError, etsyReader } from './read-client.js'
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

// ── E2 — attributes and translations (R1 §4, §6) ─────────────────────────────────────────────────────────────────
// The studio passes no push lock (D10): its content goes to a paused listing too, as eBay's studio send does; a caller
// that passes one has it honoured by the gateway. Each write is one call; the studio journals its exact body first.

/** E2 — one listing attribute (`updateListingProperty`), as the studio's review showed it. */
export interface EtsyPropertyWrite { propertyId: number; valueIds: number[]; values: string[]; scaleId?: number | null }

function assertPropertyId(propertyId: number): number {
  if (!Number.isInteger(propertyId) || propertyId < 1) throw new Error('That is not an Etsy property id; nothing was sent.')
  return propertyId
}

/**
 * Set one attribute: `PUT /shops/{shop}/listings/{id}/properties/{property}`, form-encoded `value_ids`, `values` and
 * `scale_id` (only when there is one). A PUT, so the write client may repeat it once after no answer.
 */
export async function setEtsyListingProperty(input: EtsyListingWriteInput & { property: EtsyPropertyWrite }): Promise<{ sent: true }> {
  const listingId = assertListingId(input.listingId)
  const { property } = input
  const propertyId = assertPropertyId(property.propertyId)
  if (!Array.isArray(property.valueIds) || property.valueIds.some((id) => !Number.isInteger(id) || id < 1)) {
    throw new Error(`Etsy property ${propertyId}: a value id must be a positive whole number; nothing was sent.`)
  }
  if (!Array.isArray(property.values) || !property.values.length || property.values.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error(`Etsy property ${propertyId} needs at least one value, and none may be empty; nothing was sent.`)
  }
  // Etsy refuses ( and ) in a value a seller writes (a custom value, no value ids; R1 §3) — the review's own rule
  // (studio-publication-etsy-build.ts), named here, not a 400 with no hint. A value that carries Etsy's value ids is
  // Etsy's own choice and is sent exactly as Etsy names it.
  const bracketed = property.valueIds.length ? undefined : property.values.find((value) => /[()]/.test(value))
  if (bracketed !== undefined) throw new Error(`Etsy does not take ( or ) in a custom property value, and "${bracketed}" has one; nothing was sent.`)
  const scaleId = property.scaleId ?? null
  if (scaleId !== null && (!Number.isInteger(scaleId) || scaleId < 1)) throw new Error(`Etsy property ${propertyId}: the scale id must be a positive whole number; nothing was sent.`)

  const writer = await etsyWriter(input.accountId)
  await writer.send({
    path: `/shops/${writer.shopId}/listings/${listingId}/properties/${propertyId}`,
    method: 'PUT',
    form: { value_ids: [...property.valueIds], values: [...property.values], ...(scaleId !== null ? { scale_id: scaleId } : {}) },
    kind: 'write',
    pushLock: input.pushLock,
    ledger: input.ledger,
    operation: 'PUT /shops/:id/listings/:id/properties/:id',
  })
  return { sent: true }
}

/** Remove one attribute: `DELETE /shops/{shop}/listings/{id}/properties/{property}` (Etsy answers 204). */
export async function deleteEtsyListingProperty(input: EtsyListingWriteInput & { propertyId: number }): Promise<{ sent: true }> {
  const listingId = assertListingId(input.listingId)
  const propertyId = assertPropertyId(input.propertyId)
  const writer = await etsyWriter(input.accountId)
  await writer.send({
    path: `/shops/${writer.shopId}/listings/${listingId}/properties/${propertyId}`,
    method: 'DELETE',
    kind: 'write',
    pushLock: input.pushLock,
    ledger: input.ledger,
    operation: 'DELETE /shops/:id/listings/:id/properties/:id',
  })
  return { sent: true }
}

/** E2 — one listing translation, as the studio's review showed it. */
export interface EtsyTranslationWrite { language: string; title: string; description: string; tags: string[] }

/** An IETF tag as Etsy lists them (`de`, `en`, `pt-BR`…) — and nothing that could leave the path. */
const TRANSLATION_LANGUAGE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/

/**
 * Create or replace one translation (R1 §6). Etsy has `createListingTranslation` (POST) and `updateListingTranslation`
 * (PUT) on one path and no delete; which one a send needs is decided by a GET just before it, through the read client:
 * 200 → PUT, 404 → POST, any other answer → nothing is written (the error is thrown as it came). `beforeSend` gets the
 * method and the exact form before the write; its throw sends nothing.
 *
 * 🔴 A POST is never repeated (write-client.ts): a create that got no answer is an unknown outcome, not a failure.
 */
export async function writeEtsyTranslation(input: EtsyListingWriteInput & { translation: EtsyTranslationWrite
  beforeSend?: (method: 'POST' | 'PUT', form: Record<string, unknown>) => Promise<void> }): Promise<{ sent: true; method: 'POST' | 'PUT' }> {
  const listingId = assertListingId(input.listingId)
  const { translation } = input
  const language = typeof translation.language === 'string' ? translation.language : ''
  if (!TRANSLATION_LANGUAGE.test(language)) throw new Error(`"${language}" is not a language Etsy takes for a translation; nothing was sent.`)
  if (typeof translation.title !== 'string' || !translation.title.trim()) throw new Error(`The ${language} translation needs a title; nothing was sent.`)
  if (typeof translation.description !== 'string' || !translation.description.trim()) throw new Error(`The ${language} translation needs a description; nothing was sent.`)
  if (!Array.isArray(translation.tags) || translation.tags.some((tag) => typeof tag !== 'string')) throw new Error(`The ${language} translation's tags must be a list of words; nothing was sent.`)

  const reader = await etsyReader(input.accountId)
  let method: 'POST' | 'PUT'
  try {
    await reader.get<unknown>(`/shops/${reader.shopId}/listings/${listingId}/translations/${language}`)
    method = 'PUT'
  } catch (error) {
    if (!(error instanceof EtsyReadError && error.status === 404)) throw error
    method = 'POST'
  }
  const form = { title: translation.title, description: translation.description, tags: [...translation.tags] }
  const writer = await etsyWriter(input.accountId)
  await input.beforeSend?.(method, form)
  await writer.send({
    path: `/shops/${writer.shopId}/listings/${listingId}/translations/${language}`,
    method,
    form,
    kind: 'write',
    pushLock: input.pushLock,
    ledger: input.ledger,
    operation: `${method} /shops/:id/listings/:id/translations/:language`,
  })
  return { sent: true, method }
}
