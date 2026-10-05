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
import { etsyListingSchema } from '../pim/channel-specs/etsy-listing-schema.js'

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

/** E2 — every `updateListing` field Nexus holds and may send to a listing Etsy already has. */
export type EtsyListingPatchKey = 'title' | 'description' | 'tags' | 'materials' | 'taxonomy_id' | 'who_made' | 'when_made' | 'is_supply' | 'type'
  | 'shop_section_id' | 'shipping_profile_id' | 'return_policy_id' | 'item_weight' | 'item_weight_unit' | 'item_length' | 'item_width' | 'item_height'
  | 'item_dimensions_unit' | 'is_taxable' | 'should_auto_renew' | 'production_partner_ids'
export type EtsyListingPatch = Partial<Record<EtsyListingPatchKey, string | number | boolean | Array<string | number>>>

export interface EtsyListingContent {
  title?: string
  description?: string
  /** `null` clears the tags; an empty array does too. `undefined` leaves them alone. */
  tags?: string[] | null
  materials?: string[] | null
  /** The image order. Etsy takes up to 20 ids; the first is the listing's main image. */
  imageIds?: number[]
  /** E2 — the studio's `updateListing` fields, exactly as the review showed them. */
  listing?: EtsyListingPatch
  /** E2 — the person's yes to `should_auto_renew: true` (a recurring Etsy charge); required to send it. */
  acceptAutoRenewCharge?: boolean
}

function named(field: string, value: string, disallowed: RegExp): void {
  const bad = value.match(disallowed)
  if (bad) {
    // Name the character. "Invalid title" sends an operator back to Etsy's docs; "the character
    // «*» is not allowed" sends them to the character.
    throw new EtsyListingContentError(`Etsy does not allow the character «${bad[0]}» in a ${field}; nothing was sent.`)
  }
}

/** The form fields a content write sends. `undefined` is left out and `null` sent empty (`encodeEtsyForm`). */
export type EtsyListingFormFields = Record<string, string | number | boolean | Array<string | number> | null | undefined>

/** The text fields that may come at the top level or inside `listing` — one set of checks for both. */
const TEXT_KEYS = ['title', 'description', 'tags', 'materials'] as const
type TextKey = typeof TEXT_KEYS[number]

/** Etsy's ids that name a shop or catalogue thing: a positive whole number (Etsy's schema: `minimum: 1`). */
const ID_KEYS = ['taxonomy_id', 'shop_section_id', 'shipping_profile_id', 'return_policy_id'] as const
const BOOLEAN_KEYS = ['is_supply', 'is_taxable', 'should_auto_renew'] as const
/** A measure Etsy takes "> 0 when set" (R1 §1); clearing one is not something Nexus sends. */
const MEASURE_KEYS = ['item_weight', 'item_length', 'item_width', 'item_height'] as const
/** Etsy's own enums (its OpenAPI document, `etsy-listing-schema.ts`). A unit also takes '' — updateListing's "clear" (R1 §2). */
const ENUMS: Record<'who_made' | 'when_made' | 'item_weight_unit' | 'item_dimensions_unit', readonly string[]> = {
  who_made: etsyListingSchema.create.properties.who_made.enum,
  when_made: etsyListingSchema.create.properties.when_made.enum,
  item_weight_unit: [...etsyListingSchema.create.properties.item_weight_unit.enum, ''],
  item_dimensions_unit: [...etsyListingSchema.create.properties.item_dimensions_unit.enum, ''],
}
/** Etsy: `who_made`, `when_made` and `is_supply` "require" each other — sent together or not at all (R1 §1). */
const CLASSIFICATION_KEYS = ['who_made', 'when_made', 'is_supply'] as const
/** Every `updateListing` key `listing` may carry; anything else (state, image_ids, price, quantity, styles, sku…) is refused. */
const PATCH_KEYS: ReadonlySet<string> = new Set<EtsyListingPatchKey>([...TEXT_KEYS, ...ID_KEYS, ...BOOLEAN_KEYS, ...MEASURE_KEYS,
  'who_made', 'when_made', 'type', 'item_weight_unit', 'item_dimensions_unit', 'production_partner_ids'])

function refuse(message: string): never { throw new EtsyListingContentError(message) }
const isPositiveWhole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1
const stringList = (key: string, value: unknown): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : refuse(`Etsy ${key} must be a list of words; nothing was sent.`)

/** One text field's checks, whichever level it came from. Writes the form value into `fields`. */
function textField(key: TextKey, value: unknown, fields: EtsyListingFormFields): void {
  if (key === 'title') {
    if (typeof value !== 'string') refuse('An Etsy title must be text; nothing was sent.')
    const title = (value as string).trim()
    if (!title) throw new EtsyListingContentError('An Etsy title cannot be empty; nothing was sent.')
    named('title', title, TITLE_DISALLOWED)
    for (const char of TITLE_ONCE_ONLY) {
      const count = title.split(char).length - 1
      if (count > 1) {
        throw new EtsyListingContentError(`Etsy allows the character «${char}» only once in a title, and this one has ${count}; nothing was sent.`)
      }
    }
    fields.title = title
    return
  }
  if (key === 'description') {
    // Etsy publishes no character rule for the description, so none is invented here. An empty
    // description is legal on Etsy and is passed through as the operator wrote it.
    if (typeof value !== 'string') refuse('An Etsy description must be text; nothing was sent.')
    fields.description = value as string
    return
  }
  // `null` clears the list; an empty array does too (`encodeEtsyForm` sends it as one empty value).
  if (value === null) { fields[key] = null; return }
  const list = stringList(key, value)
  for (const item of list) named(key === 'tags' ? 'tag' : 'material', item, key === 'tags' ? TAG_DISALLOWED : MATERIAL_DISALLOWED)
  fields[key] = list
}

/**
 * One listing key against Etsy's own rule, written into `fields` (E2's `updateListing` keys; E3's create calls it for every
 * key the two share, so the two can never drift). The caller has already refused a key it does not take.
 */
function listingKey(key: string, value: unknown, fields: EtsyListingFormFields): void {
  if ((TEXT_KEYS as readonly string[]).includes(key)) { textField(key as TextKey, value, fields); return }
  if ((ID_KEYS as readonly string[]).includes(key)) {
    if (!isPositiveWhole(value)) refuse(`Etsy ${key} must be a positive whole number; nothing was sent.`)
  } else if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
    if (typeof value !== 'boolean') refuse(`Etsy ${key} must be true or false; nothing was sent.`)
  } else if ((MEASURE_KEYS as readonly string[]).includes(key)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) refuse(`Etsy ${key} must be a number above 0; nothing was sent.`)
  } else if (key in ENUMS) {
    const allowed = ENUMS[key as keyof typeof ENUMS]
    if (typeof value !== 'string' || !allowed.includes(value)) {
      refuse(`Etsy does not take "${String(value)}" for ${key} (it takes ${allowed.filter(Boolean).join(', ')}${allowed.includes('') ? ', or nothing to clear it' : ''}); nothing was sent.`)
    }
  } else if (key === 'type') {
    if (value !== 'physical') refuse(`Nexus sends physical Etsy listings only, not "${String(value)}"; nothing was sent.`)
  } else if (key === 'production_partner_ids') {
    if (!Array.isArray(value) || !value.every(isPositiveWhole)) refuse('Etsy production partner ids must be positive whole numbers; nothing was sent.')
  }
  fields[key] = Array.isArray(value) ? [...value] : value as EtsyListingFormFields[string]
}

/** The rules across keys, for an update and a create alike: classification together, and auto-renew only with a yes. */
function listingRules(fields: EtsyListingFormFields, acceptAutoRenewCharge: boolean | undefined): void {
  const classification = CLASSIFICATION_KEYS.filter((key) => key in fields)
  if (classification.length && classification.length < CLASSIFICATION_KEYS.length) {
    refuse('Etsy takes who_made, when_made and is_supply together, and this change has only ' + classification.join(', ') + '; nothing was sent.')
  }
  // 🔴 Auto-renew commits the shop to a recurring Etsy charge (see `EtsyListingStateChange` below): only the person's
  // explicit yes sends it on. Turning it off costs nothing and needs no yes.
  if (fields.should_auto_renew === true && acceptAutoRenewCharge !== true) {
    refuse('Turning on auto-renew commits the shop to a recurring Etsy charge, so it needs an explicit yes; nothing was sent.')
  }
}

/**
 * E2 — the studio's `updateListing` fields (`listing`), each against Etsy's own rule. A key Etsy's update does not take
 * here — `state` (its own function, below), `image_ids`, price, quantity, `readiness_state_id`, styles, a SKU — is a
 * refusal, never a quiet drop: a field the review showed and the send left out is a change the person did not get.
 */
function listingFields(listing: EtsyListingPatch, acceptAutoRenewCharge: boolean | undefined, fields: EtsyListingFormFields): void {
  if (!listing || typeof listing !== 'object' || Array.isArray(listing)) refuse('Etsy listing fields must be a set of named values; nothing was sent.')
  const entries = Object.entries(listing).filter(([, value]) => value !== undefined)
  for (const [key, value] of entries) {
    if (!PATCH_KEYS.has(key)) refuse(`Etsy's listing update does not take «${key}» from a content change; nothing was sent.`)
    listingKey(key, value, fields)
  }
  listingRules(fields, acceptAutoRenewCharge)
}

// ── E3 — createDraftListing (R1 §1) ──────────────────────────────────────────────────────────────────────────────

/** Etsy's seven required keys of a create (its OpenAPI document's `required`, R1 §1). */
const DRAFT_REQUIRED = ['quantity', 'title', 'description', 'price', 'who_made', 'when_made', 'taxonomy_id'] as const
/** Keys only a create takes: price and stock (an update sends them through the inventory), the processing profile, styles. */
const DRAFT_ONLY_KEYS = ['quantity', 'price', 'readiness_state_id', 'styles'] as const
const DRAFT_KEYS: ReadonlySet<string> = new Set<string>([...PATCH_KEYS, ...DRAFT_ONLY_KEYS])
/** Etsy's cap per offering (BELIEVED, R1 §3) — the POST's quantity is the draft's first product's. */
export const ETSY_MAX_QUANTITY = 999
/** Etsy: styles are at most 2, each at most 45 characters of letters, numbers and whitespace (R1 §1). */
const STYLES_MAX = 2
const STYLE_MAX = 45
const STYLE_DISALLOWED = /[^\p{L}\p{Nd}\p{Zs}]/u

/**
 * E3 — check a createDraftListing form against Etsy's published rules, and return the form fields to send (form-encoded).
 * Etsy's seven required keys must be there (`quantity` a whole number 1–999, `price` above 0, a non-empty title and
 * description); `readiness_state_id` and `styles` are a create's own; every key an update also takes goes through the
 * same per-key checks as an update (`listingKey`), with classification together and auto-renew only with a yes. Any
 * other key — `state` (a draft is what this makes; going live is its own step), `image_ids`, `sku`, `processing_min`… —
 * is refused, never dropped. A `null` value is absent (a new listing has nothing to clear). Every throw is an
 * `EtsyListingContentError` ending "nothing was sent."
 */
export function etsyDraftListingFields(form: Record<string, unknown>, acceptAutoRenewCharge?: boolean): EtsyListingFormFields {
  if (!form || typeof form !== 'object' || Array.isArray(form)) refuse('An Etsy listing to create must be a set of named values; nothing was sent.')
  const entries = Object.entries(form).filter(([, value]) => value !== undefined && value !== null)
  for (const key of DRAFT_REQUIRED) if (!entries.some(([name]) => name === key)) refuse(`Etsy needs ${key} to create a listing; nothing was sent.`)
  const fields: EtsyListingFormFields = {}
  for (const [key, value] of entries) {
    if (!DRAFT_KEYS.has(key)) refuse(`Etsy's create does not take «${key}» from Nexus; nothing was sent.`)
    if (key === 'quantity') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > ETSY_MAX_QUANTITY) {
        refuse(`Etsy creates a listing with a quantity from 1 to ${ETSY_MAX_QUANTITY}, not ${String(value)}; nothing was sent.`)
      }
      fields.quantity = value
    } else if (key === 'price') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) refuse(`Etsy needs a price above 0 to create a listing, not ${String(value)}; nothing was sent.`)
      fields.price = value
    } else if (key === 'readiness_state_id') {
      if (!isPositiveWhole(value)) refuse('Etsy readiness_state_id (the processing profile) must be a positive whole number; nothing was sent.')
      fields.readiness_state_id = value
    } else if (key === 'styles') {
      const styles = stringList('styles', value)
      if (styles.length > STYLES_MAX) refuse(`Etsy takes at most ${STYLES_MAX} styles, and this listing has ${styles.length}; nothing was sent.`)
      for (const style of styles) {
        if ([...style].length > STYLE_MAX) refuse(`Etsy takes a style of at most ${STYLE_MAX} characters, and "${style}" is longer; nothing was sent.`)
        named('style', style, STYLE_DISALLOWED)
      }
      fields.styles = [...styles]
    } else {
      listingKey(key, value, fields)
    }
  }
  // A create needs words in both: an update may leave a description empty, a new listing may not (Etsy's `required`).
  if (typeof fields.description !== 'string' || !fields.description.trim()) refuse('Etsy needs description to create a listing; nothing was sent.')
  listingRules(fields, acceptAutoRenewCharge)
  return fields
}

/**
 * Check a content change against Etsy's published rules, and return the form fields to send.
 *
 * Throws rather than trimming. A title silently cut to fit is a change the operator did not make
 * and cannot see, and this programme has met that shape before — banked: *a change whose correct
 * value cannot be stated in advance is not a fix.*
 */
export function etsyListingContentFields(content: EtsyListingContent): EtsyListingFormFields {
  const fields: EtsyListingFormFields = {}

  for (const key of TEXT_KEYS) if (content[key] !== undefined) textField(key, content[key], fields)

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

  if (content.listing !== undefined) {
    // One field, one instruction: the same key at both levels could disagree, and neither may silently win.
    const twice = TEXT_KEYS.filter((key) => content[key] !== undefined && (content.listing as EtsyListingPatch | null)?.[key] !== undefined)
    if (twice.length) refuse(`${twice.join(', ')} came twice in one Etsy change; nothing was sent.`)
    listingFields(content.listing, content.acceptAutoRenewCharge, fields)
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
 * accident. The same reasoning guards `should_auto_renew`: it also commits the shop to a
 * recurring charge, so E2's `listing` sends `true` only with `acceptAutoRenewCharge` — the
 * person's tick in the publish review is that yes.
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
