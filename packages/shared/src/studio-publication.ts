/** Product studio publication uses an explicit account and listing coordinate. */
export interface StudioPublishScope {
  channel: string
  marketplace: string
  accountId: string
  listingId?: string
}

export interface StudioPublishIssue {
  productId?: string
  sku?: string
  field?: string
  message: string
  severity: 'error' | 'warning'
  /** The channel's own words behind `message` (eBay's check answers in its own text), shown as a detail. */
  detail?: string
}

export interface StudioPublishReview {
  id: string | null
  productId: string
  scope: StudioPublishScope
  accountLabel: string
  aliasLabel: string
  mode: string
  action: 'create' | 'update'
  /**
   * `mode` (build shape v2): how this row's content is reviewed and sent — 'partial' (only the changed fields, today's
   * Publish) or 'full' (every field Nexus manages, ticked and locked). `blocked`: the row asked for a mode this channel
   * cannot send yet (the sentence says why); nothing of the row is sent.
   */
  rows: Array<{ productId: string; sku: string; title: string; existing: boolean; mode?: StudioPublishMode; blocked?: string
    /** Delete and relist: Nexus deleted this row from the channel and its Status is Not listed, so nothing of it is sent (`blocked` says why). */
    deleted?: true
    /** Delete and relist: its Status was set to Active or Inactive after the delete, so this review lists the row again (whole). */
    relist?: StudioPublishRelist
    /**
     * New listings (Owner 2026-10-04): this review CREATES the row, and how it starts — 'active' (it sells) or 'inactive'
     * (Amazon: no offer in this market; eBay: quantity 0, stock sync held; Shopify: a Draft product). Absent on a row
     * that is on the channel, held, or not sent. The web says "Creates GALE-M (inactive)" (`createsSentence`).
     */
    startsAs?: 'active' | 'inactive'
    /** New listings: the row, or its family's main row, has Status Not listed — nothing of it is sent (`blocked` says why). */
    notListed?: true
    /**
     * S10 (per-channel SKU) — the SKU this review sends for the row when it is not the row's product SKU (`sku`): the
     * listing's own SKU. A create line and a relist line name it ("Creates GALE-M-IT (inactive)").
     */
    sendsSku?: string
    /** S10 — the channel holds this row under another SKU than the one Nexus sends: what this review does about it. */
    skuMove?: StudioPublishSkuMove }>
  excluded: number
  issues: StudioPublishIssue[]
  expiresAt: string
  locations?: Array<{ id: string; name: string }>
  visibility?: string
  previousPublicationId?: string
  /** Fresh channel comparison. Missing means this server cannot review sparse publication yet. */
  changes?: StudioPublishChange[]
  skipped?: Array<{ productId: string; sku: string; reason: string }>
  /** Historical content observations, not a live read or a list of changes to be sent. */
  overwrite?: StudioPublishOverwrite
  /**
   * Images rebuild P4c — kept for the publication history (its "Photos" kind reads it): some changes are left out by
   * problems (`blockedChanges`) and every change that can still go is a photo. The publish gate itself is
   * `blockedChanges` / `blockingIssues`, never this flag.
   */
  photosOnly?: boolean
  /**
   * eBay Inventory: the change review's fields go out in ONE whole-group PUT, so any error blocks every change of the
   * review (`blockedChanges`). Absent on every other review.
   */
  sendsWhole?: true
  /**
   * Build shape v2 — "Will be removed": what the channel holds that Nexus does not, on the rows reviewed as Full update.
   * Sending the review removes each of these from the channel. Absent when no row is a Full update.
   */
  removals?: StudioPublishRemoval[]
  /**
   * S10 (per-channel SKU, Owner D2 = A) — this review moves a live Amazon listing to a new SKU, which DELETES the old SKU
   * there once Amazon accepts the new one. The Publish window says so (`sentence`) and sends the move with `confirm:
   * 'DELETE'` (nothing is typed). Absent when nothing is deleted.
   */
  confirm?: StudioPublishConfirm
}

/** S10 — what a move deletes, and the body field its submit carries. */
export interface StudioPublishConfirm {
  /** The body field the submit needs: `confirm: 'DELETE'`. */
  token: 'DELETE'
  /** "This Publish deletes GALE-M on Amazon · IT once Amazon accepts its new SKU. … It cannot be undone." */
  sentence: string
}

/**
 * S10 (per-channel SKU) — a row the channel holds under one SKU (`from`, the SKU it holds now) while Nexus sends another
 * (`to`). `create-delete` (Amazon): NEW is created as a new offer on the same ASIN, and OLD is deleted there only after
 * Amazon accepts NEW. `rename` (eBay Trading, Shopify): the channel renames it in place. `none`: nothing moves it from
 * here (the sentence says why and what to do).
 */
export interface StudioPublishSkuMove {
  from: string
  to: string
  kind: 'create-delete' | 'rename' | 'none'
  /** "Creates GALE-M-IT on Amazon · IT as a new offer, then deletes GALE-M there." / "eBay renames GALE-M to GALE-M-IT." */
  sentence: string
  /** Read this first (an FBA move: Amazon's units stay under OLD), or null. */
  warning: string | null
}

/** A row this review lists again after Nexus deleted it (its Status was set to Active or Inactive): its create is ticked by default. */
export interface StudioPublishRelist {
  /** When the channel accepted the delete (ISO). */
  deletedAt: string
  /** The channel number the listing had before the delete (Amazon: its ASIN), or null. */
  oldReference: string | null
  /** Amazon: the ASIN this create names (`merchant_suggested_asin`, the product ID cell), or null. */
  asin: string | null
  /** "Lists GALE-M on ASIN B0NEW (was B0OLD)." (`relistSentence`, publish-actions.ts). */
  sentence: string
  /** Sent, but read this first: Amazon holds FBA units labelled for the old ASIN (`fbaNewAsinWarning`). Null otherwise. */
  warning: string | null
}

/**
 * How one review row's content is sent: only the changed fields (the default), or every field Nexus manages. `move`
 * (S10): a live Amazon listing moved to its own SKU — sent as the create of NEW, then the delete of OLD once Amazon accepts
 * NEW (`rows[].skuMove`); never a Partial or Full update of the listing.
 */
export type StudioPublishMode = 'partial' | 'full' | 'move'

/** S10 — the mode a moved row reads in the review and the Publish window: "Move to GALE-M-IT". */
export const moveModeLabel = (to: string) => `Move to ${to}`

/** One value a Full update removes from the channel (`StudioPublishReview.removals`). */
export interface StudioPublishRemoval {
  productId: string
  sku: string
  /** The review field (a change id's second part), or 'variation' for an eBay variation Nexus does not hold. */
  field: string
  label: string
  /** The channel's value now. */
  value: unknown
}

/** The blocking sentences of a Full update (the review shows them; nothing of that row is sent). */
export const FULL_AMAZON_PRODUCT_TYPE_DIFFERS = 'Product type differs on Amazon — use Delete, then Publish.'
export const FULL_NEEDS_LIVE_READ = (channel: string, error: string) =>
  `${channel} could not be read just now, so a Full update cannot be checked (${error}). Review again, or use Partial update.`
export const FULL_EBAY_SHAPE_DIFFERS = 'This listing\'s variations differ on eBay in a way a Full update cannot change — use Delete, then Publish.'

/**
 * A Full update row's field: ticked and locked (DIFFERS included), with a reason that says what Full sends. Only fields
 * Nexus can send are passed here; a field Nexus cannot prepare keeps its own reason and stays unticked.
 */
export function fullUpdateChange(change: StudioPublishChange): StudioPublishChange {
  const removes = change.current.state === 'absent' && change.channel.state === 'value'
  const reason = removes ? 'Full update removes it: Nexus holds no value here.'
    : change.status === 'SAME' ? 'Full update sends it again (it already matches the channel).'
      : change.status === 'DIFFERS' ? 'Full update replaces the channel\'s different value with Nexus\'s.'
        : 'Full update sends Nexus\'s value.'
  return { ...change, selectable: true, selectedByDefault: true, locked: true, reason }
}

/** The change-review fields that carry only photos (eBay Trading gallery and colour sets; eBay Inventory's). */
export const PUBLICATION_PHOTO_FIELDS: ReadonlySet<string> = new Set(['pictures', 'Pictures', 'variationPictures'])

/** Whether a change id (`["<productId>","<field>"]`) is a photo field. */
export function isPhotoChangeId(id: string): boolean {
  try {
    const parsed: unknown = JSON.parse(id)
    return Array.isArray(parsed) && typeof parsed[1] === 'string' && PUBLICATION_PHOTO_FIELDS.has(parsed[1])
  } catch { return false }
}

/** The attribute root of a review field or issue field: `bullet_point:["APJ6JRA9NG5V4","it_IT"]` and `bullet_point` → `bullet_point`. */
const fieldRoot = (field: string) => field.split(':')[0].split('__')[0]

/** A change id's product and field (`["<productId>","<field>"]`), or null when it is not one. */
export function parseChangeId(id: string): { productId: string; field: string } | null {
  try {
    const parsed: unknown = JSON.parse(id)
    return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string' ? { productId: parsed[0], field: parsed[1] } : null
  } catch { return null }
}

/** The field groups Claude's publish-listing tool names, plus the two it never names: a create, and stock, price or fulfilment. */
export type PublishFieldGroup = 'title' | 'description' | 'bullets' | 'keywords' | 'photos' | 'attributes' | 'create' | 'never'

/** The two fields that create a listing whole (Amazon's `$create`, eBay's and Etsy's `__create__`). */
const CREATE_FIELDS: ReadonlySet<string> = new Set(['$create', '__create__'])

/** The group of one reviewed field (Amazon roots and content coordinates, eBay Trading and Inventory fields, Etsy listing fields). */
export function publishFieldGroup(field: string): PublishFieldGroup {
  if (CREATE_FIELDS.has(field)) return 'create'
  if (/quantity|fulfil|purchasable_offer|price/i.test(field)) return 'never'
  if (PUBLICATION_PHOTO_FIELDS.has(field) || /image_locator/i.test(field)) return 'photos'
  const root = field.split(':')[0]
  if (root === 'item_name' || field === 'title') return 'title'
  if (root === 'product_description' || field === 'description') return 'description'
  if (root === 'bullet_point') return 'bullets'
  if (root === 'generic_keyword' || field === 'tags') return 'keywords'
  return 'attributes'
}

// ── The publish gate (Owner 2026-10-19, option A) ─────────────────────────────────────────────────────────────────
//
// On a PARTIAL update of a listing already on the channel, an error blocks only the changes that would send the field
// it names, on the SKU it names; the other changes go. A change an error blocks stays unticked and cannot be ticked
// ("Left out: <problem>", `leftOutReason`). An error that names no field and no product (the account, sending off, an
// earlier publish waiting…) blocks the whole destination; one that names a product but no field blocks every change of
// that product. A create, a Full update, an eBay Inventory group and a Shopify product are sent whole: every error of the
// listing blocks them (Amazon: every error of that SKU). Errors on fields the update does not send stay problems of
// their row, and block nothing.

/**
 * Amazon — the names the content checks give the text roots (`publishContentIssues`, the machine-text review), and the
 * family's structure: its three roots (theme, parentage, relationship) are one unit, so a problem with the variation
 * theme leaves out every change of the family's shape.
 */
const AMAZON_UNITS: Readonly<Record<string, string>> = { title: 'item_name', description: 'product_description', bulletPoints: 'bullet_point', keywords: 'generic_keyword',
  variation_theme: 'family', parentage_level: 'family', child_parent_sku_relationship: 'family' }
/** Photo fields by any of their names: the change review's, the sheet's (`imageUrls`) and the builders' (`photos`). */
const PHOTO_NAMES: ReadonlySet<string> = new Set([...PUBLICATION_PHOTO_FIELDS, 'imageUrls', 'photos', 'images'])
/**
 * eBay Trading — what a narrow ReviseFixedPriceItem sends: Title, Description, PictureDetails, ItemSpecifics (every live
 * item specific is sent again, so they are one unit) and Variations (renames, colour photo sets). The builders' and the
 * sheet's names for them. An item-specific column's problem reaches here as `aspect:<key>` (the review names it so).
 */
const EBAY_UNITS: Readonly<Record<string, string>> = {
  // The category decides which item specifics eBay takes: its problem leaves them out too.
  title: 'title', description: 'description', descriptionThemeId: 'description', itemSpecifics: 'aspects', categoryId: 'aspects',
  SKU: 'sku', sellerSku: 'sku', variationSku: 'sku', variationTheme: 'variations',
}
/** Etsy — the listing fields an update sends one by one (`ETSY_LISTING_FIELDS`), and the sheet's names that feed them. */
const ETSY_UNITS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(['title', 'description', 'tags', 'materials', 'taxonomy_id', 'classification', 'type', 'shop_section_id', 'shipping_profile_id',
    'return_policy_id', 'item_weight', 'item_dimensions', 'is_taxable', 'should_auto_renew', 'production_partner_ids', 'styles'].map(field => [field, field])),
  keywords: 'tags', who_made: 'classification', when_made: 'classification', is_supply: 'classification', item_weight_unit: 'item_weight',
  item_length: 'item_dimensions', item_width: 'item_dimensions', item_height: 'item_dimensions', item_dimensions_unit: 'item_dimensions',
  // Etsy has no bullet points: Publish never sends them.
  bulletPoints: 'bulletPoints',
}

/**
 * The part of a channel's send a field travels in — for a change's field and for a problem's field alike: a problem
 * blocks the changes whose unit it is (`carries`). Amazon: the attribute root (one PATCH per root; the content checks'
 * `title` is `item_name`…; the family's three structure roots are `family`); photos are one unit everywhere. eBay: `title`, `description`, `photos`, `aspects` (the item
 * specifics, one unit), `sku`, `variations`; any other field is not sent by a narrow revise. Etsy: each listing field,
 * `property:<id>`, `translation:<lang>`, and `inventory` — the one PUT of every variation's SKU, price, stock and values,
 * where every field that is not a listing field travels. Exported for its tests: a name it does not translate would stop
 * blocking silently.
 */
export function sendUnit(channel: string, field: string): string {
  if (CREATE_FIELDS.has(field)) return 'create'
  if (PHOTO_NAMES.has(field) || /image_locator/i.test(field)) return 'photos'
  switch (channel.toUpperCase()) {
    case 'AMAZON': { const root = fieldRoot(field); return AMAZON_UNITS[root] ?? root }
    case 'EBAY':
      if (field.startsWith('aspect:') || field.startsWith('itemSpecifics.')) return 'aspects'
      return EBAY_UNITS[field] ?? field
    case 'ETSY': {
      if (field.startsWith('translation:') || field.startsWith('property:')) return field
      const property = /^property_(\d+)(__scale_id)?$/.exec(field)
      if (property) return property[2] ? `scale:${property[1]}` : `property:${property[1]}`
      return ETSY_UNITS[field] ?? 'inventory'
    }
    default: return field
  }
}

/**
 * Whether a change's field sends a unit: its own, and what travels with it — an Etsy translation line carries that
 * language's title, description and tags; Etsy's inventory and a listing property carry their property scales; eBay's
 * colour photo sets and a variation's rename go inside `<Variations>`.
 */
function carries(channel: string, changeField: string, unit: string): boolean {
  if (sendUnit(channel, changeField) === unit) return true
  if (channel === 'ETSY') {
    if (changeField.startsWith('translation:')) return unit === 'title' || unit === 'description' || unit === 'tags'
    if (changeField === 'inventory') return unit.startsWith('scale:')
    if (changeField.startsWith('property:')) return unit === `scale:${changeField.slice('property:'.length)}`
  }
  if (channel === 'EBAY') return (changeField === 'Pictures' || changeField === 'variationSku') && unit === 'variations'
  return false
}

/** A unit the listing sends once for all its rows: a problem on any row of it blocks it (eBay's title, Etsy's inventory…). */
const listingWide = (channel: string, unit: string) => channel === 'ETSY' || (channel === 'EBAY' && unit !== 'sku' && unit !== 'variations')

/** What the gate reads of a review. */
export interface PublishGateContext {
  /** The review's channel ("AMAZON"). */
  channel: string
  /** The review's changes: a Full update's are `locked` (sent whole). A selected id the list lacks is read from the id. */
  changes?: ReadonlyArray<Pick<StudioPublishChange, 'id' | 'productId' | 'field' | 'locked'>> | null
  /** eBay Inventory: the whole group is one send (`StudioPublishReview.sendsWhole`). */
  sendsWhole?: boolean
}

type GateChange = Pick<StudioPublishChange, 'productId' | 'field' | 'locked'>

/** The rule (above) for one error and one change. */
function blocks(error: StudioPublishIssue, change: GateChange, context: PublishGateContext): boolean {
  if (!error.field && !error.productId) return true
  const channel = context.channel.toUpperCase()
  const sameRow = !error.productId || error.productId === change.productId
  if (context.sendsWhole || channel === 'SHOPIFY' || change.locked || CREATE_FIELDS.has(change.field)) return channel === 'AMAZON' ? sameRow : true
  if (!error.field) return error.productId === change.productId
  const unit = sendUnit(channel, error.field)
  return carries(channel, change.field, unit) && (sameRow || listingWide(channel, unit))
}

/** What the gate reads of a review: its channel, its changes, and whether it is sent whole. */
export const publishGateContext = (review: Pick<StudioPublishReview, 'scope' | 'changes'> & Partial<Pick<StudioPublishReview, 'sendsWhole'>>): PublishGateContext =>
  ({ channel: review.scope.channel, changes: review.changes ?? null, sendsWhole: !!review.sendsWhole })

/**
 * The problems that block a selection: every error that blocks one of the selected changes (the rule above), and every
 * error that names no field and no product. Without a selection or a context (a summary of why a review cannot be sent,
 * Shopify's whole product), every error. Warnings never block.
 */
export function blockingIssues(issues: readonly StudioPublishIssue[], selectedIds?: readonly string[] | null, context?: PublishGateContext | null): StudioPublishIssue[] {
  const errors = issues.filter(i => i.severity === 'error')
  if (!errors.length || !selectedIds?.length || !context) return errors
  const known = new Map((context.changes ?? []).map(change => [change.id, change]))
  const selected = selectedIds.map(id => known.get(id) ?? parseChangeId(id)).filter((change): change is GateChange => !!change)
  return errors.filter(error => (!error.field && !error.productId) || selected.some(change => blocks(error, change, context)))
}

/**
 * Every change of a review that a problem leaves out, with the first error that blocks it (its "Left out: …" words).
 * Only selectable changes: one the channel cannot take already says why. Empty for a review without errors.
 */
export function blockedChanges(review: (Pick<StudioPublishReview, 'scope' | 'changes'> & Partial<Pick<StudioPublishReview, 'issues' | 'sendsWhole'>>) | null | undefined): Map<string, StudioPublishIssue> {
  const out = new Map<string, StudioPublishIssue>()
  const errors = (review?.issues ?? []).filter(i => i.severity === 'error')
  if (!review?.changes || !errors.length) return out
  const context = publishGateContext(review)
  for (const change of review.changes) {
    if (!change.selectable) continue
    const found = errors.find(error => blocks(error, change, context))
    if (found) out.set(change.id, found)
  }
  return out
}

/** The ids of the changes a problem leaves out (`blockedChanges`). */
export const blockedChangeIds = (review: Parameters<typeof blockedChanges>[0]): Set<string> => new Set(blockedChanges(review).keys())

/** A left-out change's words: "Left out: Item package height is required." */
export const leftOutReason = (issue: Pick<StudioPublishIssue, 'message'>) => `Left out: ${issue.message}`

/** The changes that can go: selectable and not left out by a problem. */
export function sendableChanges(review: Parameters<typeof blockedChanges>[0]): StudioPublishChange[] {
  if (!review?.changes) return []
  const blocked = blockedChangeIds(review)
  return review.changes.filter(change => change.selectable && !blocked.has(change.id))
}

export interface StudioPublishOverwrite {
  requiresConfirmation: boolean
  products: Array<{
    productId: string
    sku: string
    status: 'new' | 'not_read' | 'not_compared' | 'compared'
    checkedAt: string | null
    reason?: string
    differing: number
    notCompared: number | null
    omittedDifferences: number
    fields: Array<{ field: string; nexusAtRead: unknown; channelAtRead: unknown; checkedAt: string }>
  }>
}

/** Absence is a known cleared value; unknown never means unchanged or cleared. */
export type StudioPublishValue = { state: 'value'; value: unknown } | { state: 'absent' } | { state: 'unknown'; reason: string }

/** An intentional field write; required preserved collection siblings are not adopted as Nexus changes. */
export interface StudioPublishFieldWrite {
  field: string
  value: Exclude<StudioPublishValue, { state: 'unknown' }>
}

export interface StudioPublishChange {
  id: string
  productId: string
  sku: string
  field: string
  label: string
  current: StudioPublishValue
  lastAccepted: StudioPublishValue
  channel: StudioPublishValue
  status: 'SEND' | 'DIFFERS' | 'CANNOT_COMPARE' | 'SAME'
  localChanged: boolean | null
  channelChanged: boolean | null
  selectable: boolean
  selectedByDefault: boolean
  reason: string
  operation: 'replace' | 'delete' | null
  /**
   * Amazon sheet gaps (D4=B) — an Amazon offer draft line shows three values in words instead of the raw ones: the
   * saved value that waits for Publish, the value live in Nexus, and what Amazon shows now. `note` carries a warning
   * (Automate Pricing, Always available) or "Live changed since you saved".
   */
  display?: StudioPublishChangeDisplay
  /**
   * Build shape v2 — a Full update row's field: always ticked. A selection takes every locked field of a product or none
   * of them (the row tick), never some.
   */
  locked?: boolean
  /**
   * One-click "Nexus wins" (Owner 2026-10-04) — on a selectable DIFFERS line (ticked by default): what Publish replaces
   * on the channel. `channel` / `nexus` are the two values in words (cut to 60 characters; null when there is none),
   * `sentence` the line's warning ("Changed on Amazon since the last publish. Amazon has 129.00 — Publish sets 149.00."),
   * `note` an extra warning or null (price lines: "Amazon's Automate Pricing can change it again.").
   */
  replaces?: StudioPublishReplaces
}

/** Why a DIFFERS line replaces the channel's value: changed there, changed on both sides, never published, or a removal. */
export type StudioPublishReplacesKind = 'channel_changed' | 'both_changed' | 'never_published' | 'removes'

export interface StudioPublishReplaces {
  kind: StudioPublishReplacesKind
  channel: string | null
  nexus: string | null
  sentence: string
  note: string | null
}

/**
 * One-click "Nexus wins" — the one summary line of a market's tab: "12 values on Amazon · IT differ from Nexus. Publish
 * replaces them." (1 → "1 value on Amazon · IT differs from Nexus. Publish replaces it."). Counts the selectable
 * DIFFERS lines; `ticked` = how many of them are ticked (`selectedIds` when given, else the default ticks). When some or
 * all are unticked ("Keep Amazon's values") the sentence says so. Null when no value differs.
 */
export function differsSummary(changes: readonly StudioPublishChange[] | null | undefined, channelLabel: string,
  selectedIds?: readonly string[] | null): { count: number; ticked: number; sentence: string } | null {
  const differs = (changes ?? []).filter(c => c.status === 'DIFFERS' && c.selectable)
  if (!differs.length) return null
  const selected = selectedIds ? new Set(selectedIds) : null
  const count = differs.length
  const ticked = differs.filter(c => (selected ? selected.has(c.id) : c.selectedByDefault)).length
  return { count, ticked, sentence: differsSentence(count, ticked, channelLabel) }
}

/**
 * The words of `differsSummary` from counts alone — for a window that has only each row's counts (the products list's
 * Publish…: `PublishPlanBatchChild.differs`). `count` must be at least 1; `ticked` is clamped to 0…count.
 */
export function differsSentence(count: number, ticked: number, channelLabel: string): string {
  const shown = Math.max(0, Math.min(ticked, count))
  const one = count === 1
  const head = `${count.toLocaleString('en')} ${one ? 'value' : 'values'} on ${channelLabel} ${one ? 'differs' : 'differ'} from Nexus.`
  const tail = shown === count ? `Publish replaces ${one ? 'it' : 'them'}.`
    : shown === 0 ? `Publish keeps ${one ? 'it' : 'them'}.`
      : `Publish replaces ${shown.toLocaleString('en')} of them.`
  return `${head} ${tail}`
}

export interface StudioPublishChangeDisplay { current: string; lastAccepted: string; channel: string; note?: string }

/** The sheet's words for an offer draft whose Publish was sent but whose result Amazon never gave (UNVERIFIED). */
export const OFFER_DRAFT_UNVERIFIED = 'Sent — Amazon\'s answer is unknown. Check Amazon, then publish again or discard.'

export interface StudioPublishResult {
  id: string
  status: 'SUBMITTED' | 'ACCEPTED' | 'VERIFIED' | 'PARTIAL' | 'FAILED' | 'PUBLISHING' | 'UNVERIFIED'
  message: string
  warnings?: string[]
  results: Array<{ sku: string; status: 'SUBMITTED' | 'ACCEPTED' | 'VERIFIED' | 'FAILED'; message: string; reference?: string
    /** The channel's own issues for this SKU, one per issue (an Amazon processing report keeps them apart). */
    issues?: StudioChannelIssue[] }>
}

/** One channel issue on one SKU of a publication result: the channel's code, words and named attributes. */
export interface StudioChannelIssue {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  attributeNames: string[]
}

/**
 * Sheet publish parity, step 3 (item 2) — what became of the last publish of each sheet row on one destination:
 * `GET /api/products/:id/studio/publication-status?channel&market&accountId&aliasKey`. Shaped for the design
 * system's `PublishStatusValue` (`grid/renderers/publishStatus.ts`); the browser maps `attributeNames` to columns.
 */
export interface StudioRowLastPublish {
  publicationId: string
  /** What the last send was: a content publish, a Full update, or a selling change (`LAST_PUBLISH_KIND_LABEL`, publication-history). */
  kind?: 'publish' | 'full_update' | 'pause' | 'resume' | 'end' | 'relist' | 'delete'
  /** The publication's status (`StudioPublishResult['status']`). */
  status: string
  /** This row's own result inside it: the stored per-SKU result, else the publish journal's outcome; null = not known. */
  outcome: 'SUBMITTED' | 'ACCEPTED' | 'VERIFIED' | 'FAILED' | 'UNKNOWN' | null
  /** ISO time the publish was sent. */
  at: string
  userName: string | null
  message: string | null
  /** Feed id, ItemID or product id on the channel. */
  reference: string | null
  /** Field names the publish carried for this row; `['$create']` = a complete new listing; empty = not recorded. */
  sentFields: string[]
  /** The channel's issues for this row in that publish. */
  issues: StudioChannelIssue[]
}

/** An issue the channel reports for the listing NOW (open `ListingIssue`), whatever produced it. */
export interface StudioRowOpenIssue extends StudioChannelIssue {
  source: string
  /** ISO time the channel last reported it. */
  seenAt: string
}

export interface StudioRowPublicationStatus {
  productId: string
  listingId: string
  sku: string
  last: StudioRowLastPublish | null
  issues: StudioRowOpenIssue[]
}

export interface StudioPublicationStatus {
  destination: { channel: string; marketplace: string; accountId: string; aliasKey: string }
  /** A publication to this destination that has not settled; the sheet re-reads while it is set. */
  inFlight: { publicationId: string; status: string } | null
  /** The newest sent publication to this destination, with its counts (for the toolbar status). */
  latest: { publicationId: string; status: string; at: string; completedAt: string | null; summary: Record<string, unknown> | null } | null
  rows: StudioRowPublicationStatus[]
  /** ISO time of this read. */
  readAt: string
}

/**
 * Sheet publish parity T1 — one saved review read back (`GET /api/products/:id/studio-publication/:reviewId/review`),
 * for a row of the many-product dialog. The same review the preview returned, the fields ticked so far, and whether
 * the ticks can still change (through the selection route). It never carries the exact channel request.
 */
export interface StudioPublishStoredReview {
  review: StudioPublishReview
  /** The review row's status: PREVIEW while it waits, BLOCKED when it can never be sent, or a later status. */
  status: string
  /** The fields ticked so far (a batch's default ticks, or the person's choice); null when none were ticked yet. */
  selectedIds: string[] | null
  fieldCount: number | null
  /** The ticks can still change: the review waits (PREVIEW), has not expired, and lists its fields. */
  editable: boolean
}

/** Exact request for one explicit selection, bound to a durable review. */
export interface StudioPublishSelection {
  reviewId: string
  token: string
  selectedIds: string[]
  products: Array<{ productId: string; sku: string }>
  fieldCount: number
  payload: { format: 'json' | 'xml'; content: string }
}

/**
 * Sheet publish parity, D3 (Owner, 2026-10-01) — a person checked a publication that is still waiting for a result:
 * `POST /api/products/:id/studio-publication/:reviewId/mark-checked` with `{ note?: string }` (500 characters at most).
 * The status stays what it was (Nexus never invents a result); the publication is closed, stops blocking its
 * destination and is no longer swept. In the stored summary: `checkedAt`, `checkedBy` (user id), `checkedNote`.
 */
export interface StudioPublicationCheck {
  publicationId: string
  /** Unchanged by the check: still PUBLISHING, SUBMITTED or UNVERIFIED, unless a real result arrived since. */
  status: StudioPublishResult['status']
  /** ISO time of the check. */
  checkedAt: string
  checkedBy: { id: string; name: string | null } | null
  note: string | null
  /** No other unsettled publication blocks this destination: a new publish can start. */
  destinationOpen: boolean
}

/**
 * "Publish failed products again…" — what to pre-tick in a NEW review of the same destination:
 * `GET /api/products/:id/studio-publication/:reviewId/retry-selection`. Nothing is sent and no stored request is
 * replayed; the new review compares the current saved values again. Change ids are `["<productId>","<field>"]`, the
 * same in every review of the destination, so `fieldIds` can be matched against the new review's `changes`.
 */
export interface StudioRetrySelection {
  publicationId: string
  status: StudioPublishResult['status']
  /** The destination of the failed publication: open the Publish dialog on it. */
  destination: StudioPublishScope & { aliasKey: string }
  /** The products that failed (or were never sent), by product id. Empty when every product was accepted. */
  productIds: string[]
  /** The selected change ids of those products in the failed publication (every field the channel did not apply). */
  fieldIds: string[]
  products: Array<{
    productId: string
    sku: string
    /** The channel's (or Nexus's) words for this product's failure. */
    message: string | null
    /** Attributes the channel named in its issues for this product. */
    attributeNames: string[]
    fieldIds: string[]
    /** The subset of `fieldIds` whose field the channel named; empty when it named none. */
    flaggedFieldIds: string[]
  }>
  /** Failed SKUs the publication's records could not tie to a product; the review cannot pre-tick them. */
  unmatchedSkus: string[]
  /** True when nothing reached the channel (a refusal before sending): every delivered product is listed. */
  notSent: boolean
}

/**
 * Sheet publish parity, step 5 (item 3) — one action that publishes a family to several destinations (markets or
 * accounts). Each destination keeps its own review (its own change plan and ticks); the batch only sends them, in the
 * background, so closing the dialog does not stop it. `POST /api/publication-batches` with `PublicationBatchRequest`
 * answers 202 `{ batchId }`; `GET /api/publication-batches/:id` and `POST /api/publication-batches/:id/cancel` answer
 * `PublicationBatchView`. Every route needs products.publish.
 */
export interface PublicationBatchRequest {
  reviews: Array<{ reviewId: string; selectionToken?: string; confirmOverwrite?: boolean; locationId?: string }>
}

/**
 * Sheet publish parity, step 6 (item 6) — many families from the products list. `POST /api/publication-batches` with
 * this body answers 202 `{ batchId }`; the batch first REVIEWS every family × destination in the background (phase
 * REVIEWING), with the default ticks (only the fields Nexus changed; fields the channel holds differently only with
 * `replaceDiffers`), then waits (REVIEWED) until `POST /api/publication-batches/:id/submit`. A selected variation
 * means its family. At most 200 products and 25 destinations; at most 1,000 reviews.
 */
export interface PublicationBatchFamiliesRequest {
  productIds: string[]
  destinations: StudioPublishScope[]
  options?: { replaceDiffers?: boolean }
}

/** `POST /api/publication-batches/:id/submit` — send what the batch reviewed. */
export interface PublicationBatchSubmitRequest {
  /** Reviews whose overwrite warning the person confirmed (Shopify). */
  confirmOverwrite?: string[]
  /** The Shopify inventory location per Shopify account. */
  shopifyLocations?: Record<string, string>
}

/** What the batch itself is doing. The children's results are counted, never stored twice. */
export type PublicationBatchPhase = 'REVIEWING' | 'REVIEWED' | 'QUEUED' | 'RUNNING' | 'SENT' | 'CANCELLING' | 'CANCELLED'

/**
 * One destination of a batch. `status` is the publication's own status (`StudioPublishResult['status']`) or, for a
 * review the batch did not send: PREVIEW (still waiting its turn), NOT_SENT (refused before sending, `message` says
 * why), CANCELLED (the batch was cancelled before its turn) or BLOCKED (its review could not be sent).
 */
export interface PublicationBatchChild {
  publicationId: string
  productId: string | null
  channel: string | null
  marketplace: string | null
  accountId: string | null
  aliasKey: string | null
  status: string
  /** Nothing more will happen to it: a final result, not sent, cancelled, blocked, or a person marked it checked. */
  terminal: boolean
  /** Still waiting for a result, but a person marked it checked (it no longer blocks its destination). */
  checked: boolean
  message: string | null
  summary: Record<string, unknown> | null
  /** Step 6 — the family this row publishes (its main product), for one row per family × destination. */
  familySku?: string | null
  familyTitle?: string | null
  /** Products in this review (the family's main product and its included variations). */
  productCount?: number | null
  /** Fields ticked to send (null when the channel has no field ticks, e.g. Shopify). */
  selectedCount?: number | null
  /** The review's own problems: errors block it, warnings do not. At most five messages are listed. */
  problems?: { errors: number; warnings: number; messages: string[] }
  /** When the review stops being sendable (a batch review lives 2 hours). */
  expiresAt?: string | null
  /** Not sent because every ticked field already matches the channel. */
  nothingToSend?: boolean
  /** New listings (ND4 B): the rows this review creates and how each starts ("Creates GALE-M (inactive)", `createsSentence`). */
  creates?: Array<{ productId: string; sku: string; startsAs: 'active' | 'inactive' }>
}

/** Step 6 — how long the rest of the batch should take, from the channels' rates. Null when nothing is left. */
export interface PublicationBatchEstimate {
  seconds: number | null
  /** Rounded up; at least 1 while anything is left. */
  minutes: number | null
  /** One plain sentence on the rates the estimate uses. */
  basis: string
}

export interface PublicationBatchCounts {
  total: number
  /** Not sent yet: waiting its turn. */
  waiting: number
  /** Being sent now. */
  sending: number
  /** Sent; the channel has not answered yet. */
  awaitingChannel: number
  succeeded: number
  partial: number
  failed: number
  notSent: number
  cancelled: number
  blocked: number
  /** Marked checked by a person while its result was still unknown. */
  checked: number
}

export interface PublicationBatchView {
  batchId: string
  phase: PublicationBatchPhase
  createdAt: string
  /** ISO time every destination had its turn (phase SENT or CANCELLED); null while sending. */
  sentAt: string | null
  cancelRequestedAt: string | null
  /** Every destination is final (see `PublicationBatchChild.terminal`) and the batch is no longer sending. */
  done: boolean
  outcome: 'IN_PROGRESS' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED'
  counts: PublicationBatchCounts
  children: PublicationBatchChild[]
  /** Step 6 — 'review' while a many-family batch is reviewing or waiting for the person; 'send' once sent. */
  stage?: 'review' | 'send'
  /** Step 6 — what a many-family batch was asked to review. Null for a batch of reviews made in the dialog. */
  request?: { families: number; destinations: number; reviews: number; reviewed: number } | null
  /** Step 6 — time left for the current stage (when REVIEWED: for the send that submit starts). */
  estimate?: PublicationBatchEstimate
}
