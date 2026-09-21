/**
 * P4.6d — Etsy listing content: the rules, as Etsy publishes them.
 *
 * `updateListing` (`PATCH /shops/{shop_id}/listings/{listing_id}`) is **partial** — unlike the
 * inventory PUT, a field left out is left alone — and **form-encoded**, which is a second body
 * format one path away from the JSON one. Both facts come from Etsy's OpenAPI document, read
 * 2026-09-21.
 *
 * ## Why the validation is here and not left to Etsy
 *
 * Etsy publishes an exact regex for each text field, and a value that breaks it is a 400. Checking
 * locally is not distrust of Etsy — it is that a rejected write costs a live call, a ledger row
 * and an operator's confusion, and the reason ("what is wrong with my title?") is much clearer
 * when the character that broke it can be named. The regexes below are **copied from Etsy's own
 * field descriptions**, quoted beside each one, so a reader can check them without leaving the file.
 */

/**
 * Etsy: *"valid title strings contain only letters, numbers, punctuation marks, mathematical
 * symbols, whitespace characters, ™, © and ®"* — `/[^\p{L}\p{Nd}\p{P}\p{Sm}\p{Zs}™©®]/u`.
 */
const TITLE_DISALLOWED = /[^\p{L}\p{Nd}\p{P}\p{Sm}\p{Zs}™©®]/u

/**
 * Etsy: *"You can only use the %, :, & and + characters once each."* A separate rule from the
 * character set, and the one most likely to bite a generated title ("50% off, 2 for 1 & free
 * shipping" breaks it on `&`… no — on nothing; "A & B & C" breaks it on the second `&`).
 */
const TITLE_ONCE_ONLY = ['%', ':', '&', '+'] as const

/** Etsy: tags contain *"only letters, numbers, whitespace characters, -, ', ™, © and ®"*. */
const TAG_DISALLOWED = /[^\p{L}\p{Nd}\p{Zs}\-'™©®]/u

/** Etsy: materials contain *"only letters, numbers, and whitespace characters"*. */
const MATERIAL_DISALLOWED = /[^\p{L}\p{Nd}\p{Zs}]/u

/** Etsy's documented cap on a listing's images. */
export const ETSY_MAX_IMAGES = 20

export class EtsyListingContentError extends Error {
  constructor(message: string) { super(message); this.name = 'EtsyListingContentError' }
}

export interface EtsyListingContent {
  title?: string
  description?: string
  /** `null` clears the tags; an empty array does too. `undefined` leaves them alone. */
  tags?: string[] | null
  materials?: string[] | null
  /** The image order. Etsy takes up to 20 ids; the first is the listing's main image. */
  imageIds?: number[]
}

function named(field: string, value: string, disallowed: RegExp): void {
  const bad = value.match(disallowed)
  if (bad) {
    // Name the character. "Invalid title" sends an operator back to Etsy's docs; "the character
    // «*» is not allowed" sends them to the character.
    throw new EtsyListingContentError(`Etsy does not allow the character «${bad[0]}» in a ${field}; nothing was sent.`)
  }
}

/**
 * Check a content change against Etsy's published rules, and return the form fields to send.
 *
 * Throws rather than trimming. A title silently cut to fit is a change the operator did not make
 * and cannot see, and this programme has met that shape before — banked: *a change whose correct
 * value cannot be stated in advance is not a fix.*
 */
export function etsyListingContentFields(content: EtsyListingContent): Record<string, string | number | Array<string | number> | null | undefined> {
  const fields: Record<string, string | number | Array<string | number> | null | undefined> = {}

  if (content.title !== undefined) {
    const title = content.title.trim()
    if (!title) throw new EtsyListingContentError('An Etsy title cannot be empty; nothing was sent.')
    named('title', title, TITLE_DISALLOWED)
    for (const char of TITLE_ONCE_ONLY) {
      const count = title.split(char).length - 1
      if (count > 1) {
        throw new EtsyListingContentError(`Etsy allows the character «${char}» only once in a title, and this one has ${count}; nothing was sent.`)
      }
    }
    fields.title = title
  }

  if (content.description !== undefined) {
    // Etsy publishes no character rule for the description, so none is invented here. An empty
    // description is legal on Etsy and is passed through as the operator wrote it.
    fields.description = content.description
  }

  if (content.tags !== undefined) {
    if (content.tags === null) fields.tags = null
    else {
      for (const tag of content.tags) named('tag', tag, TAG_DISALLOWED)
      fields.tags = content.tags
    }
  }

  if (content.materials !== undefined) {
    if (content.materials === null) fields.materials = null
    else {
      for (const material of content.materials) named('material', material, MATERIAL_DISALLOWED)
      fields.materials = content.materials
    }
  }

  if (content.imageIds !== undefined) {
    if (content.imageIds.length > ETSY_MAX_IMAGES) {
      throw new EtsyListingContentError(`Etsy allows at most ${ETSY_MAX_IMAGES} images on a listing, and this order has ${content.imageIds.length}; nothing was sent.`)
    }
    if (content.imageIds.some((id) => !Number.isInteger(id) || id < 1)) {
      throw new EtsyListingContentError('An Etsy image id must be a positive whole number; nothing was sent.')
    }
    if (new Set(content.imageIds).size !== content.imageIds.length) {
      throw new EtsyListingContentError('The same Etsy image appears twice in this order; nothing was sent.')
    }
    fields.image_ids = content.imageIds
  }

  if (Object.keys(fields).length === 0) {
    throw new EtsyListingContentError('There is nothing to change on this Etsy listing; nothing was sent.')
  }
  return fields
}

/**
 * 🔴 The reason `state` is NOT part of `EtsyListingContent`.
 *
 * Etsy's own words on `updateListing`'s `state` field: *"Setting a `sold_out` listing to active
 * will **update the quantity to 1** and **renew** the listing on etsy.com."*
 *
 * So a field that reads like "show this listing again" is, on a sold-out listing, three things at
 * once: a state change, a **stock write Nexus never made** — straight past the quantity resolver,
 * the shared-stock pool and the audit — and a **renewal, which Etsy charges the seller for**.
 *
 * Putting it beside `title` would mean an operator editing a title could do all three by adding
 * one field to an object. It is its own function, with its own name, so that cannot happen by
 * accident. The same reasoning keeps `should_auto_renew` out: it also commits the shop to a
 * recurring charge.
 */
export interface EtsyListingStateChange {
  state: 'active' | 'inactive'
  /**
   * Required to set a listing `active`. The caller states that it knows Etsy may set the quantity
   * to 1 and charge a renewal. There is no default: a caller that has not thought about it cannot
   * accidentally agree to it.
   */
  acceptRenewalAndQuantityReset?: boolean
}

export function etsyListingStateFields(change: EtsyListingStateChange): Record<string, string> {
  if (change.state === 'active' && change.acceptRenewalAndQuantityReset !== true) {
    throw new EtsyListingContentError(
      'Making an Etsy listing active can set its quantity to 1 and charge a renewal, so it needs an explicit yes; nothing was sent.',
    )
  }
  return { state: change.state }
}
