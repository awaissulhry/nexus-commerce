/**
 * Meta ads changes, step 35 (lane C4) — catalog items, feeds and Instagram product tags (D7: Shopify keeps writing the
 * catalog; Nexus adds data only where step 12's writer check lets it, and never fights Shopify for a field):
 *   set-meta-catalog-items            items of a catalog Nexus writes (no Shopify, no partner, no feed): create, update
 *                                     (every documented PRODUCT_ITEM field), country / language overrides and their
 *                                     removal, an item group's default item — CT-030–039, CT-041–044, CT-052, CT-054,
 *                                     CT-100–103. CT-034 (quantity_to_sell_on_facebook), CT-047 / CT-048 (single-item
 *                                     calls), CT-049 (a preview token, not a write path) and CT-053 (an explicit group
 *                                     create: groups come from item_group_id) are answered in words.
 *   set-meta-catalog-feed             feeds: make (primary, supplementary, offers, ratings & reviews, local inventory,
 *                                     country / language overrides; rules at create; migrated), change (schedules, settings,
 *                                     deletion on — one-way), labels (D7: an update-only file of id + the D7 columns to the
 *                                     Shopify feed or Nexus's own supplementary feed), uploads (a file of items Nexus makes,
 *                                     or a public address), rules (add, remove, change = remove + add), an update-only upload
 *                                     schedule, an upload's full error report — CT-074–078, CT-081, CT-083–085, CT-087–090,
 *                                     CT-092, CT-094, CT-096, CT-097, CT-099, CT-104, CT-191 (CT-093 answered in words).
 *   set-meta-instagram-product-tags   tags on a published post of the chosen Instagram account (add or move), an appeal of a
 *                                     rejected product — CT-155, CT-158 (CT-154: a new post's tags go with
 *                                     create-meta-instagram-post's productTags; CT-156: Meta cannot remove a tag by API
 *                                     — answered).
 * Each a Nexus change like set-meta-status (meta-ads-kit.ts): a preview from the live state, an approvalId, a person approves
 * it, it runs as that person, and undo puts back what it changed where Meta lets it (said where it cannot). Every catalog is
 * checked by step 12's writableCatalog in the draft (so at the preview AND when the approved change runs) and by the gateway
 * (meta-catalog-items-owner.ts); every Instagram media by step 10's / step 26's owner checks.
 *
 * Meta's own MCP: ads_catalog_product_create / ads_catalog_update_product (one item, cents + currency) are matched by
 * items_batch (many items, with the D7 writer check, a before → after preview and an undo); ads_catalog_create_product_feed,
 * ads_catalog_update_product_feed, ads_catalog_create_product_feed_upload_session, ads_catalog_create_feed_rule and
 * ads_catalog_product_feed_delete_rule are matched with the D7 check and the one-way deletion warning; Meta's MCP has none
 * for overrides, labels files, upload schedules or Instagram product tags.
 */
import { z } from 'zod'
import { FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolContext, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { catalogUse, chosenOf, common, guarded, head, httpsArg, onlyArgs, recordOf, strictText, typedText } from './meta-ads-catalog-admin.tools.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import type { MetaChangeAccount } from '../../marketing/meta-ads/change-account.js'
import { MetaLiveRefusal, type MetaChosenAccount } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import { createdIdOf, type MetaChangeResult } from '../../marketing/meta-ads/write-client.js'
import { liveCatalogItems } from '../../marketing/meta-ads/live-catalog.js'
import {
  catalogPriceText, d7RulesCheck, d7WriteCheck, feedWriteCheck, itemsWriteCheck, liveFeedNow, liveFeedRules, liveFeedUpload, liveGroup, liveItemOverrides,
  liveItemsNow, liveLabelsNow, livePrimarySources, ownCatalogFeedIds, ownCatalogFeeds, type FeedSchedule,
} from '../../marketing/meta-ads/live-catalog-items.js'
import {
  errorReportDraft, FEED_KINDS, feedChangeDraft, feedCreateDraft, feedRemoveMadeDraft, fileUploadDraft, groupDefaultDraft, itemsCreateDraft, itemsRemoveMadeDraft,
  itemsUpdateDraft, d7LabelsDraft, overridesDraft, rulesDraft, sameValue, uploadScheduleDraft, urlUploadDraft,
  type FeedChangeAsk, type FeedCreateAsk, type FeedKind, type FeedRecord, type FeedRuleAsk, type ItemAsk, type ItemsRecord, type OverrideAsk, type OverridesRecord,
} from '../../marketing/meta-ads/change-catalog-items.js'
import { appealDraft, four, tagDraft, type IgTagsRecord } from '../../marketing/meta-ads/change-instagram-tags.js'
import { liveIgAppealState, liveIgMayTag, liveIgProduct, liveIgTagCatalogs, liveIgTagPost, taggedPostsLastDay, type IgProduct } from '../../marketing/meta-ads/live-instagram-tags.js'
import { instagramOf } from '../../marketing/meta-ads/live-media.js'
import { META_NAME_TEXT, META_STRICT_TEXT } from '../../gateway/meta-write-text.js'
import { META_RETAILER_ID_MAX } from '../../gateway/meta-catalog-rules.js'
import {
  MAX_FEED_RULES, MAX_INTERNAL_LABELS, MAX_ITEM_IMAGES, MAX_ITEM_VIDEOS, MAX_ITEMS_PER_CHANGE, MAX_MEDIA_TAGS, MAX_OVERRIDES_PER_CHANGE, MAX_PRIMARY_FEEDS, MAX_SHIPPING_RULES,
  MAX_VALUE_MAPPINGS, MAX_VARIANT_ATTRIBUTES, META_CUSTOM_LABEL_MAX, META_CUSTOM_NUMBER_MAX, META_D7_COLUMNS, META_DESCRIPTION_MAX, META_FEED_DAYS, META_FEED_DELIMITERS,
  META_FEED_ENCODINGS, META_FEED_INTERVALS, META_FEED_NAME_MAX, META_FEED_QUOTED, META_FEED_RULE_TYPES, META_INTERNAL_LABEL_MAX, META_ITEM_AGE_GROUPS, META_ITEM_AVAILABILITY,
  META_ITEM_CAPABILITIES, META_ITEM_CONDITIONS, META_ITEM_GENDERS, META_ITEM_STATUSES, META_ITEM_SUB_TYPES, META_LETTER_CASES, META_OVERRIDE_TYPES, META_RICH_TEXT_MAX,
  META_RULE_ATTRIBUTES, META_TITLE_MAX, META_WEIGHT_UNITS, metaDayOk, metaInternalLabelOk, metaItemDataProblem, metaOverrideValueOk, metaPublicFetchUrlProblem,
  metaRuleParamsProblem, metaScheduleProblem, metaVariantAttributesOk, overrideFieldsOf, type MetaOverrideType,
} from '../../gateway/meta-catalog-items-rules.js'
import { META_IG_APPEAL_REASON_MAX, META_IG_TAG_LIMITS, metaIgCoordinateOk, type MetaIgProductTag } from '../../gateway/meta-instagram-tags.js'

type Args = Record<string, unknown>
type Fields = Record<string, unknown>
type Done = Array<{ request: MetaChangeRequest; result: MetaChangeResult; notAsAsked?: string }>

// ── the plain answers of the rows Nexus does not send ───────────────────────────────────────────────────────────────

/** CT-034 — the plain answer (master row: only for onsite checkout, which Shops ads no longer use, CT-147). */
export const QUANTITY_NOT_SENT = 'Nexus does not send quantity_to_sell_on_facebook: it matters only for checkout on Facebook and Instagram, which Meta\'s Shops ads no longer use (Meta: it must be at least 1 to be buyable there). Stock goes to Meta as availability (in stock / out of stock).'
/** CT-047 / CT-048 / CT-049 / CT-053 — the plain answers (RECHECK-C4). */
export const SINGLE_ITEM_CALLS = 'Nexus writes items through items_batch only (many items in one request, with Meta\'s answer per item): the single-item calls (POST /{catalog}/products, POST /{item}) take other names and cents, and the catalog:{id}:{base64 SKU} id is a token for ad previews only, not a write path (RECHECK CT-049).'
export const GROUP_CREATE_NOT_BUILT = 'Meta makes a variant group from the items that share an item_group_id (the documented way, items_batch): an explicit group create is in Meta\'s SDK only and its page says it cannot be done, so Nexus does not send one. Give the variants the same itemGroupId.'
/** CT-093 — the plain answer (RECHECK-C4: SDK only, its keys on no page, no unlink anywhere). */
export const FEED_LINKS_NOT_BUILT = 'A supplementary feed\'s primary feeds are set when it is made (primaryFeedIds): Meta documents no change of them (supplementary_feed_assocs is in its SDK only, with no documented keys and no unlink). To link it elsewhere, delete it (remove-meta-catalog-items kind feed) and make it again.'
/** CT-154 — Q9: tags on a NEW post are a field of its publish (step 24's create-meta-instagram-post). */
export const NEW_POST_TAGS = 'Tags on a new post go with create-meta-instagram-post: productTags on an image or a reel, items[].productTags on a carousel (sent with the post when it is published). This tool tags posts that are published already.'
/** CT-156 — NOT-AVAILABLE (RECHECK): no removal in Meta's API. */
export const TAG_REMOVE_NOT_AVAILABLE = 'Meta cannot remove a product tag through its API: "Tagging media is additive until the tag limit has been reached", updated_tags only adds or moves tags, and the product-tags reference has no delete (instagram-platform product-tagging, ig-media/product_tags). A person removes it in the Instagram app.'
/** Feed fields Meta does not update (product-feed "Updating"). */
export const FEED_NOT_UPDATABLE = 'A feed\'s country, feed type, source type (primary / supplementary) and override type cannot change (Meta does not update them): make a new feed with set-meta-catalog-feed action create.'

const PRICE_REFUSED = 'A price change is shown with the items\' current prices: only a person who may see revenue in Nexus asks for one (or approves it). Ask a person who may see revenue.'
/** Review A-F2 — a feed change that can set prices buyers see: only for a person who may see revenue. */
const FEED_PRICE_REFUSED = (what: string) => `${what} can change the prices buyers see: only a person who may see revenue in Nexus asks for it (or approves it). Ask a person who may see revenue.`
/** The fields (and feed-rule attributes) that are money: a price, a sale price or its window, shipping prices. */
const MONEY_ATTRIBUTES: ReadonlySet<string> = new Set(['price', 'sale_price', 'sale_price_effective_date', 'shipping'])
/** Who may change or see a price (the same rule as step 13's price filters: revenue view or the whole financial view). */
const mayPrice = (ctx: ToolContext) => ctx.can(FIELDS.financialsRevenueView) || ctx.can(FIELDS.financialsView)

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────────

const currencyArg = z.string().trim().regex(/^[A-Za-z]{3}$/).transform((v) => v.toUpperCase()).describe('ISO 4217 currency code (EUR)')
const moneyArg = (what: string) => z.object({
  amountMinor: z.number().int().min(0).max(1_000_000_000_000).describe('the amount in minor units of the currency (4990 = 49.90 EUR)'),
  currency: currencyArg,
}).describe(what)
const saleTimeArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{4}$/, 'as 2026-11-01T00:00+0100').describe(what)
const mediaArg = (what: string, max: number) => z.array(z.object({
  url: httpsArg(`the ${what}'s address (https)`),
  tags: z.array(strictText(100)).min(1).max(MAX_MEDIA_TAGS).optional().describe('words for what is in it (optional)'),
})).min(1).max(max).describe(`the item's ${what}s, at most ${max} (the WHOLE list it should have)`)
const labelText = z.string().trim().max(META_INTERNAL_LABEL_MAX).refine(metaInternalLabelOk, 'plain characters, no quotes, commas or brackets')
const customLabel = (n: number) => strictText(META_CUSTOM_LABEL_MAX).optional().describe(`custom_label_${n} (≤ 100; changing it sends the item through Meta's review again)`)
const customNumber = (n: number) => z.number().int().min(0).max(META_CUSTOM_NUMBER_MAX).optional().describe(`custom_number_${n} (0–4294967295)`)
const countryArg = z.string().trim().regex(/^[A-Za-z]{2}$/).transform((v) => v.toUpperCase()).describe('two-letter country code (IT)')

/** One item's fields as the tools take them (each optional; a create needs Meta's required ones). */
const itemShape = {
  retailerId: strictText(META_RETAILER_ID_MAX).describe('the item\'s retailer id (its SKU, Meta\'s id field)'),
  title: typedText(META_TITLE_MAX).optional().describe(`title (≤ ${META_TITLE_MAX})`),
  description: typedText(META_DESCRIPTION_MAX).optional().describe(`description (≤ ${META_DESCRIPTION_MAX})`),
  richTextDescription: typedText(META_RICH_TEXT_MAX).optional().describe('rich-text (HTML) description; description stays required'),
  availability: z.enum(META_ITEM_AVAILABILITY).optional().describe('in stock | out of stock | available for order | discontinued (out of stock does not show in ads)'),
  condition: z.enum(META_ITEM_CONDITIONS).optional().describe('new | refurbished | used'),
  price: moneyArg('the price (MONEY: buyers see it)').optional(),
  salePrice: moneyArg('the sale price (MONEY)').optional(),
  saleStart: saleTimeArg('when the sale price starts (with saleEnd)').optional(),
  saleEnd: saleTimeArg('when the sale price ends (with saleStart)').optional(),
  link: httpsArg('the item\'s page on the website (https)').optional(),
  mobileLink: httpsArg('the item\'s mobile page (https)').optional(),
  images: mediaArg('image', MAX_ITEM_IMAGES).optional(),
  videos: mediaArg('video', MAX_ITEM_VIDEOS).optional(),
  brand: typedText(100).optional().describe('brand'),
  gtin: z.string().trim().regex(/^\d{8,14}$/, '8 to 14 digits').optional().describe('GTIN (UPC, EAN, JAN, ISBN), digits only'),
  mpn: strictText(70).optional().describe('manufacturer part number'),
  googleProductCategory: strictText(250).optional().describe('Google product category (name or id)'),
  fbProductCategory: strictText(250).optional().describe('Facebook product category (name or id)'),
  productType: typedText(750).optional().describe('your own category path (Clothing > Jackets)'),
  itemGroupId: strictText(META_RETAILER_ID_MAX).optional().describe('the variant group: the parent SKU every variant shares (never a Meta id)'),
  size: typedText(100).optional().describe('size'),
  color: typedText(100).optional().describe('color'),
  gender: z.enum(META_ITEM_GENDERS).optional().describe('female | male | unisex'),
  ageGroup: z.enum(META_ITEM_AGE_GROUPS).optional().describe('adult | infant | kids | newborn | toddler'),
  material: typedText(200).optional().describe('material'),
  pattern: typedText(100).optional().describe('pattern'),
  variantAttributes: z.array(z.object({ name: strictText(100).describe('attribute name'), value: strictText(100).describe('its value') })).min(1).max(MAX_VARIANT_ATTRIBUTES).optional().describe('more variant attributes (Scent: Fruity)'),
  internalLabels: z.array(labelText).max(MAX_INTERNAL_LABELS).optional().describe('internal labels for product sets (the WHOLE list; no review again)'),
  customLabel0: customLabel(0), customLabel1: customLabel(1), customLabel2: customLabel(2), customLabel3: customLabel(3), customLabel4: customLabel(4),
  customNumber0: customNumber(0), customNumber1: customNumber(1), customNumber2: customNumber(2), customNumber3: customNumber(3), customNumber4: customNumber(4),
  hideFrom: z.array(z.enum(META_ITEM_CAPABILITIES)).max(META_ITEM_CAPABILITIES.length).optional().describe('the surfaces the item is kept off (the WHOLE list; da = catalog ads; [] = everywhere)'),
  status: z.enum(META_ITEM_STATUSES).optional().describe('active | archived (archived shows nowhere)'),
  expirationDate: z.string().trim().refine(metaDayOk, 'YYYY-MM-DD').optional().describe('after this day the item shows nowhere on Facebook'),
  shipping: z.array(z.object({
    country: countryArg, region: strictText(50).optional().describe('region'), service: strictText(100).describe('the service (Home delivery)'),
    price: moneyArg('its price'),
  })).min(1).max(MAX_SHIPPING_RULES).optional().describe('shipping rules (the WHOLE list)'),
  shippingWeight: z.object({ value: z.number().min(0).max(999_999).describe('weight'), unit: z.enum(META_WEIGHT_UNITS).describe('lb | oz | g | kg') }).optional().describe('shipping weight'),
  originCountry: countryArg.optional(),
  importerName: typedText(200).optional().describe('the EU importer\'s name'),
  importerAddress: z.object({
    street1: strictText(100).describe('street'), street2: strictText(100).optional().describe('street, line 2'), city: strictText(100).describe('city'),
    region: strictText(100).optional().describe('region'), postalCode: strictText(100).optional().describe('postal code'), country: countryArg,
  }).optional().describe('the EU importer\'s address'),
  userRating: z.number().min(1).max(5).optional().describe('the business\'s own real average rating (1.0–5.0, one decimal; with ratingCount)'),
  ratingCount: z.number().int().min(1).max(1_000_000_000).optional().describe('how many real reviews it rests on (1 or more; with userRating)'),
}
const itemArg = z.object(itemShape)
type ItemArg = z.infer<typeof itemArg>

/** Typed item args → Meta's PRODUCT_ITEM write fields (the ONE conversion: price helper, sale window, shipping, labels). */
function itemFieldsOf(a: Partial<ItemArg>): Fields | { refusal: string } {
  const f: Fields = {}
  const money = (m: { amountMinor?: number; currency?: string }, what: string): string | { refusal: string } => catalogPriceText(m.amountMinor, m.currency) ?? { refusal: `${what} names an amount in minor units and a currency (${m.currency ?? 'none named'}).` }
  const put = (key: string, v: unknown) => { if (v !== undefined) f[key] = v }
  put('title', a.title); put('description', a.description); put('rich_text_description', a.richTextDescription)
  put('availability', a.availability); put('condition', a.condition)
  if (a.price) { const p = money(a.price, 'price'); if (typeof p !== 'string') return p; f.price = p }
  if (a.salePrice) { const p = money(a.salePrice, 'salePrice'); if (typeof p !== 'string') return p; f.sale_price = p }
  if (!!a.saleStart !== !!a.saleEnd) return { refusal: 'A sale window takes both saleStart and saleEnd (Meta: both ends).' }
  if (a.saleStart && a.saleEnd) f.sale_price_effective_date = `${a.saleStart}/${a.saleEnd}`
  put('link', a.link); put('mobile_link', a.mobileLink)
  if (a.images) f.image = a.images.map((m) => ({ url: m.url, ...(m.tags ? { tag: m.tags } : {}) }))
  if (a.videos) f.video = a.videos.map((m) => ({ url: m.url, ...(m.tags ? { tag: m.tags } : {}) }))
  put('brand', a.brand); put('gtin', a.gtin); put('mpn', a.mpn); put('google_product_category', a.googleProductCategory); put('fb_product_category', a.fbProductCategory)
  put('product_type', a.productType); put('item_group_id', a.itemGroupId); put('size', a.size); put('color', a.color); put('gender', a.gender); put('age_group', a.ageGroup)
  put('material', a.material); put('pattern', a.pattern)
  if (a.variantAttributes) {
    const text = a.variantAttributes.map((v) => `${v.name}:${v.value}`).join(',')
    if (!metaVariantAttributesOk(text)) return { refusal: 'variantAttributes: each name and value without ":" or ",", each name once.' }
    f.additional_variant_attribute = text
  }
  if (a.internalLabels) {
    if (new Set(a.internalLabels.map((l) => l.toLowerCase())).size !== a.internalLabels.length) return { refusal: 'internalLabels names each label once (Meta stores them in lower case).' }
    // Meta stores internal labels in lower case (catalog/reference): sent so, the read-back and the undo compare alike.
    f.internal_label = a.internalLabels.map((l) => l.toLowerCase())
  }
  for (const n of [0, 1, 2, 3, 4] as const) { put(`custom_label_${n}`, a[`customLabel${n}`]); put(`custom_number_${n}`, a[`customNumber${n}`]) }
  if (a.hideFrom) f.disabled_capabilities = [...new Set(a.hideFrom)]
  put('status', a.status); put('expiration_date', a.expirationDate)
  if (a.shipping) {
    const rules: Fields[] = []
    for (const s of a.shipping) {
      const p = money(s.price, 'a shipping price')
      if (typeof p !== 'string') return p
      rules.push({ shipping_country: s.country, ...(s.region ? { shipping_region: s.region } : {}), shipping_service: s.service, shipping_price_value: p.split(' ')[0], shipping_price_currency: p.split(' ')[1] })
    }
    f.shipping = rules
  }
  if (a.shippingWeight) f.shipping_weight = `${Math.round(a.shippingWeight.value * 1000) / 1000} ${a.shippingWeight.unit}`
  put('origin_country', a.originCountry); put('importer_name', a.importerName)
  if (a.importerAddress) {
    const ad = a.importerAddress
    f.importer_address = { street1: ad.street1, ...(ad.street2 ? { street2: ad.street2 } : {}), city: ad.city, ...(ad.region ? { region: ad.region } : {}), ...(ad.postalCode ? { postal_code: ad.postalCode } : {}), country: ad.country }
  }
  // Meta (items_batch): user_rating 1.0–5.0 with one decimal, "used in conjunction with rating_count" (review B-F1).
  if ((a.userRating === undefined) !== (a.ratingCount === undefined)) return { refusal: 'userRating and ratingCount go together (Meta uses a rating with its count): give both or neither.' }
  if (a.userRating !== undefined) f.user_rating = Math.round(a.userRating * 10) / 10
  put('rating_count', a.ratingCount)
  return f
}
const hasPrice = (f: Fields) => 'price' in f || 'sale_price' in f || 'sale_price_effective_date' in f || 'shipping' in f

/** Every item of the request, converted and judged as the gateway judges it (so a refusal is said before any call). */
function itemsOf(items: unknown, verb: 'CREATE' | 'UPDATE'): ItemAsk[] | { refusal: string } {
  const out: ItemAsk[] = []
  const seen = new Set<string>()
  for (const a of (items ?? []) as ItemArg[]) {
    if (seen.has(a.retailerId)) return { refusal: `${a.retailerId} is named twice: Meta ignores every copy of a repeated id.` }
    seen.add(a.retailerId)
    const fields = itemFieldsOf(a)
    if ('refusal' in fields) return { refusal: `${a.retailerId}: ${fields.refusal}` }
    const problem = metaItemDataProblem({ id: a.retailerId, ...fields }, verb)
    if (problem) return { refusal: problem }
    out.push({ sku: a.retailerId, fields })
  }
  return out
}

/** The catalog's use by ads (step 34's catalogUse: its sets and what of the chosen ad account delivers on them). */
const useOf = async (chosen: MetaChosenAccount, catalogId: string) => (await catalogUse(chosen, catalogId)).use

/** The Shopify words first on an items refusal (step 34's writableFor does it); a read Meta refused, said. */
const named = (catalog: { catalogId: string; name: string | null }) => ({ catalogId: catalog.catalogId, name: catalog.name })

// ── set-meta-catalog-items ──────────────────────────────────────────────────────────────────────────────────────────

const ITEM_ACTIONS = ['create', 'update', 'overrides', 'remove-overrides', 'group-default', 'remove-made'] as const

const overrideShape = {
  retailerId: itemShape.retailerId,
  type: z.enum(META_OVERRIDE_TYPES).describe('COUNTRY (price, sale, availability, link) | LANGUAGE (text) | LANGUAGE_AND_COUNTRY (text for one country)'),
  value: z.string().trim().min(2).max(12).describe('COUNTRY: IT · LANGUAGE: it_IT or it_XX · LANGUAGE_AND_COUNTRY: en_XX|CH'),
  price: itemShape.price, salePrice: itemShape.salePrice, saleStart: itemShape.saleStart, saleEnd: itemShape.saleEnd, availability: itemShape.availability, link: itemShape.link,
  title: itemShape.title, description: itemShape.description, shortDescription: typedText(1000).optional().describe('a short description (LANGUAGE)'),
  brand: itemShape.brand, color: itemShape.color, size: itemShape.size, material: itemShape.material, pattern: itemShape.pattern,
  variantAttributes: itemShape.variantAttributes, images: mediaArg('image', 1).optional(),
  customLabel0: itemShape.customLabel0, customLabel1: itemShape.customLabel1, customLabel2: itemShape.customLabel2, customLabel3: itemShape.customLabel3, customLabel4: itemShape.customLabel4,
}
const overrideArg = z.object(overrideShape)
type OverrideArg = z.infer<typeof overrideArg>
const overrideRefArg = z.object({ retailerId: itemShape.retailerId, type: overrideShape.type, value: overrideShape.value })

function overridesOf(list: unknown): OverrideAsk[] | { refusal: string } {
  const out: OverrideAsk[] = []
  for (const o of (list ?? []) as OverrideArg[]) {
    if (!metaOverrideValueOk(o.type, o.value)) return { refusal: `${o.retailerId}: a ${o.type} override's value is ${o.type === 'COUNTRY' ? 'a country (IT)' : o.type === 'LANGUAGE' ? 'a language (it_IT or it_XX)' : 'a language and a country (en_XX|CH)'}.` }
    const { retailerId, type, value, shortDescription, ...rest } = o
    const fields = itemFieldsOf(rest)
    if ('refusal' in fields) return { refusal: `${retailerId}: ${fields.refusal}` }
    if (shortDescription) fields.short_description = shortDescription
    const allowed = new Set(overrideFieldsOf(type))
    const outside = Object.keys(fields).filter((k) => !allowed.has(k))
    if (outside.length) return { refusal: `${retailerId}: a ${type} override takes ${[...allowed].join(', ')} — not ${outside.join(', ')} (Meta: price, sale price and availability only by country; text only by language).` }
    if (!Object.keys(fields).length) return { refusal: `${retailerId}: name at least one field of the ${type} override.` }
    out.push({ sku: retailerId, type: type as MetaOverrideType, value, fields })
  }
  return out
}

/** The live state an overrides change compares: the items, and each named override's fields now (or none). */
async function overridesNow(chosen: MetaChosenAccount, catalogId: string, asked: Array<{ sku: string; type: MetaOverrideType; value: string }>) {
  const items = await liveItemsNow(chosen, catalogId, [...new Set(asked.map((o) => o.sku))])
  const now = new Map<string, Fields | null>()
  const reads = new Map<string, Map<string, Fields>>()
  for (const o of asked) {
    const item = items.get(o.sku)
    if (!item?.itemId) continue
    const key = `${item.itemId}|${o.type}`
    if (!reads.has(key)) reads.set(key, await liveItemOverrides(chosen, item.itemId, o.type))
    now.set(`${o.sku}|${o.type}|${o.value}`, reads.get(key)!.get(o.value) ?? null)
  }
  return { items: new Set(items.keys()), now }
}

/** The undo of a create: delete exactly the items that change made (its record), while Nexus may still write items there. */
async function removeMadeItems(args: Args, account: MetaChangeAccount): Promise<MetaChangeDraft | { refusal: string }> {
  const extra = onlyArgs(args, 'remove-made (the undo of an earlier set-meta-catalog-items create)', ['undoOf'])
  if (extra) return { refusal: extra }
  const record = await recordOf('set-meta-catalog-items', args.undoOf, account)
  if ('refusal' in record) return record
  const after = record.after as ItemsRecord
  if (after.op !== 'create' || !after.skus?.length) return { refusal: 'That change recorded no items it made, so there is nothing Nexus can delete.' }
  const chosen = await chosenOf(account)
  const { catalog } = await itemsWriteCheck(chosen, after.catalogId)
  const found = await liveItemsNow(chosen, catalog.catalogId, after.skus)
  return itemsRemoveMadeDraft({ catalog: named(catalog), skus: after.skus, found, use: await useOf(chosen, catalog.catalogId), undoOf: String(args.undoOf) })
}

const buildItems = (args: Args, ctx: ToolContext): MetaDraftBuilder => guarded(async (account) => {
  if (args.quantityToSellOnFacebook !== undefined) return { refusal: QUANTITY_NOT_SENT }
  if (args.singleItem !== undefined) return { refusal: SINGLE_ITEM_CALLS }
  if (args.createGroup !== undefined) return { refusal: GROUP_CREATE_NOT_BUILT }
  const action = String(args.action)
  if (action === 'remove-made') return removeMadeItems(args, account)
  if (args.undoOf !== undefined) return { refusal: 'undoOf goes only with action remove-made (the undo of an earlier create).' }
  const allowed: Record<string, string[]> = {
    create: ['catalogId', 'items', 'itemSubType'], update: ['catalogId', 'items'], overrides: ['catalogId', 'overrides'], 'remove-overrides': ['catalogId', 'remove'], 'group-default': ['catalogId', 'groupId', 'defaultItemId'],
  }
  const extra = onlyArgs(args, action, allowed[action] ?? [])
  if (extra) return { refusal: extra }
  const chosen = await chosenOf(account)
  if (action === 'group-default') {
    const groupId = typeof args.groupId === 'string' ? args.groupId : ''
    const itemId = typeof args.defaultItemId === 'string' ? args.defaultItemId : ''
    if (!groupId || !itemId) return { refusal: 'Name the item group (groupId: meta-catalog-items view groups) and its new default item (defaultItemId: one of its items).' }
    const group = await liveGroup(chosen, groupId, typeof args.catalogId === 'string' ? args.catalogId : null)
    const { catalog } = await itemsWriteCheck(chosen, group.catalogId)
    if (!group.itemIds.has(itemId)) return { refusal: `${itemId} is not an item of group ${group.groupId}${group.more ? ' among the first 500 Nexus read' : ''}: a group's default is one of its own items.` }
    return groupDefaultDraft({ catalog: named(catalog), groupId: group.groupId, groupSku: group.groupSku, itemId })
  }
  const catalogId = typeof args.catalogId === 'string' ? args.catalogId : ''
  if (!catalogId) return { refusal: 'Name the catalog (catalogId: meta-catalogs view list).' }
  if (action === 'create' || action === 'update') {
    const asked = itemsOf(args.items, action === 'create' ? 'CREATE' : 'UPDATE')
    if ('refusal' in asked) return asked
    if (!asked.length) return { refusal: 'items lists the items (retailerId and their fields).' }
    if (asked.some((a) => hasPrice(a.fields)) && !mayPrice(ctx)) return { refusal: PRICE_REFUSED }
    // D7 — items only where step 12's writer check lets Nexus write them (else "Shopify owns these items").
    const { catalog } = await itemsWriteCheck(chosen, catalogId)
    const now = await liveItemsNow(chosen, catalog.catalogId, asked.map((a) => a.sku))
    const use = await useOf(chosen, catalog.catalogId)
    if (action === 'create') return itemsCreateDraft({ catalog: named(catalog), asked, existing: new Set(now.keys()), itemSubType: (args.itemSubType as string | undefined) ?? null, use })
    return itemsUpdateDraft({ catalog: named(catalog), asked, now, use })
  }
  const asked: OverrideAsk[] | { refusal: string } = action === 'overrides'
    ? overridesOf(args.overrides)
    : ((args.remove ?? []) as Array<{ retailerId: string; type: MetaOverrideType; value: string }>).map((o) => ({ sku: o.retailerId, type: o.type, value: o.value, remove: true as const }))
  if ('refusal' in asked) return asked
  if (!asked.length) return { refusal: action === 'overrides' ? 'overrides lists the overrides to set.' : 'remove lists the overrides to remove.' }
  if (asked.some((o) => o.fields && hasPrice(o.fields)) && !mayPrice(ctx)) return { refusal: PRICE_REFUSED }
  const { catalog } = await itemsWriteCheck(chosen, catalogId)
  const state = await overridesNow(chosen, catalog.catalogId, asked)
  // Review A-F2 — taking a country price off is a price change too (buyers there see the item's own price again).
  if (!mayPrice(ctx) && asked.some((o) => o.remove && Object.keys(state.now.get(`${o.sku}|${o.type}|${o.value}`) ?? {}).some((k) => MONEY_ATTRIBUTES.has(k)))) return { refusal: PRICE_REFUSED }
  return overridesDraft({ catalog: named(catalog), asked, items: state.items, now: state.now, use: await useOf(chosen, catalog.catalogId), mayMoney: mayPrice(ctx) })
})

/** What the batch did, read once (step 12's batch-status view). */
async function batchAfter(account: MetaChangeAccount, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>): Promise<string> {
  const first = done[0]
  if (!first || !['catalog.items.write', 'catalog.items.localize', 'catalog.items.delete'].includes(first.request.operation ?? '')) return 'meta-catalog-items shows the items now.'
  const handles = Array.isArray(first.result.node?.handles) ? (first.result.node!.handles as unknown[]).filter((h): h is string => typeof h === 'string') : []
  if (!handles.length) return 'Meta answered no batch handle: it ingested nothing (its validation names why, per item).'
  const read = await liveCatalogItems({ connectionId: account.accountId, view: 'batch-status', catalogId: first.request.objectId, handle: handles[0] }) as { items?: Array<{ status: string | null; errorsTotal: number | null }> }
  const status = read.items?.[0]
  return status ? `Meta's batch ${handles[0]}: ${status.status ?? 'status not said'}${status.errorsTotal ? `, ${status.errorsTotal} request(s) refused` : ''} (meta-catalog-items view batch-status with this handle shows it later; Finished means done).` : `meta-catalog-items view batch-status with handle ${handles[0]} shows what Meta did.`
}

/** Meta's per-item answer of a batch: the items it refused, with its words (a sample of 5 each). */
function refusedOf(node: Record<string, unknown> | null): Array<{ sku: unknown; errors: string[] }> {
  const statuses = Array.isArray(node?.validation_status) ? node!.validation_status as Array<Record<string, unknown>> : []
  return statuses.filter((s) => Array.isArray(s.errors) && s.errors.length).map((s) => ({ sku: s.retailer_id ?? null, errors: (s.errors as Array<{ message?: unknown }>).map((e) => String(e.message ?? '')).slice(0, 5) }))
}

function itemsFinish(draft: MetaChangeDraft, done: Done) {
  const node = done[0].result.node ?? null
  const refused = refusedOf(node)
  const refusedSkus = new Set(refused.map((r) => String(r.sku)))
  const handles = Array.isArray(node?.handles) ? (node!.handles as unknown[]).filter((h): h is string => typeof h === 'string') : []
  const batch = { handle: handles[0] ?? null, refusedByMeta: refused, sentence: handles.length ? 'Meta took the batch as a job of its own; the run read its status (nexusRead).' : 'Meta answered no batch handle: it ingested nothing.' }
  const planned = draft.after as ItemsRecord | OverridesRecord | { op: string }
  // Only what Meta took is recorded as made or changed: an item Meta refused is not the undo's to delete or put back.
  if (planned.op === 'create') {
    const after = planned as ItemsRecord
    const made = handles.length ? (after.skus ?? []).filter((sku) => !refusedSkus.has(sku)) : []
    return { data: { batch, made }, before: draft.before, after: { ...after, skus: made } }
  }
  if (planned.op === 'update') {
    const after = planned as ItemsRecord
    const keep = (r: ItemsRecord) => ({ ...r, items: handles.length ? (r.items ?? []).filter((i) => !refusedSkus.has(i.sku)) : [] })
    return { data: { batch }, before: keep(draft.before as ItemsRecord), after: keep(after) }
  }
  if (planned.op === 'remove-made') return { data: { batch, deleted: (planned as ItemsRecord).skus }, before: draft.before, after: planned, noUndo: 'A deletion on Meta is final: nothing here can be put back.' }
  if (planned.op === 'overrides') {
    const keep = (r: OverridesRecord) => ({ ...r, entries: handles.length ? r.entries.filter((e) => !refusedSkus.has(e.sku)) : [] })
    return { data: { batch }, before: keep(draft.before as OverridesRecord), after: keep(planned as OverridesRecord) }
  }
  return { data: { groupId: done[0].request.objectId, defaultItemId: done[0].request.params.default_product_id }, before: draft.before, after: draft.after, noUndo: 'Meta lets Nexus read no group\'s default item, so this change has no undo.' }
}

// ── undo: what Meta holds now, compared like with like (review A-F4) ────────────────────────────────────────────────

const instantOf = (t: string): number | null => {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})([+-]\d{2})(\d{2})$/.exec(t)
  const ms = m ? Date.parse(`${m[1]}:00${m[2]}:${m[3]}`) : NaN
  return Number.isFinite(ms) ? ms : null
}
const windowOf = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const [a, b] = v.split('/')
  const from = a ? instantOf(a) : null
  const to = b ? instantOf(b) : null
  return from !== null && to !== null ? `${from}/${to}` : null
}
const amountOf = (v: unknown): string | null => {
  const m = typeof v === 'string' ? /^(\d+)(?:\.(\d+))? ([A-Z]{3})$/.exec(v) : null
  return m ? `${Number(`${m[1]}.${m[2] ?? '0'}`)} ${m[3]}` : null
}
const sortedText = (v: unknown[], lower = false) => v.map((x) => (lower ? String(x).toLowerCase() : String(x))).sort()
const urlsOf = (v: unknown): string[] | null => (Array.isArray(v) && v.every((m) => m && typeof m === 'object' && typeof (m as { url?: unknown }).url === 'string') ? v.map((m) => (m as { url: string }).url) : null)

/**
 * Is what Meta reads back now what the change wrote, in Meta's own spellings? Internal labels in lower case and any order
 * (Meta stores them so), surfaces in any order, images by their addresses (Meta reads no image tag), a sale window by its
 * two instants (Meta reads it in UTC), a price by its amount, a feed's enums in any case, a schedule by the keys Nexus sent.
 */
export function sameAsWritten(field: string, now: unknown, written: unknown): boolean {
  if (sameValue(now, written)) return true
  if (now === null || now === undefined || written === null || written === undefined) return false
  switch (field) {
    case 'internal_label': return Array.isArray(now) && Array.isArray(written) && sameValue(sortedText(now, true), sortedText(written, true))
    case 'disabled_capabilities': return Array.isArray(now) && Array.isArray(written) && sameValue(sortedText(now), sortedText(written))
    case 'image': case 'video': { const a = urlsOf(now); const b = urlsOf(written); return !!a && !!b && sameValue(a, b) }
    case 'sale_price_effective_date': return windowOf(now) !== null && windowOf(now) === windowOf(written)
    case 'price': case 'sale_price': return amountOf(now) !== null && amountOf(now) === amountOf(written)
    case 'default_currency': case 'delimiter': case 'encoding': case 'quoted_fields_mode': return typeof now === 'string' && typeof written === 'string' && now.toUpperCase() === written.toUpperCase()
    case 'schedule': case 'update_schedule': {
      if (typeof now !== 'object' || typeof written !== 'object') return false
      const n = now as Record<string, unknown>
      return Object.entries(written as Record<string, unknown>).every(([k, v]) => (typeof v === 'string' && typeof n[k] === 'string' && k !== 'url' ? v.toUpperCase() === (n[k] as string).toUpperCase() : sameValue(n[k], v)))
    }
  }
  return false
}
/** Each written field as Meta holds it now: the written value where it reads back the same OR Nexus cannot read it (that field is left out of the compare), else what Meta holds (null: none, or the item is gone). */
function asNow(written: Fields, state: Record<string, unknown> | null | undefined): Fields {
  return Object.fromEntries(Object.keys(written).map((k) => {
    if (!state) return [k, null]
    const v = state[k]
    return [k, v === undefined || sameAsWritten(k, v, written[k]) ? written[k] : v]
  }))
}

const itemsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as (ItemsRecord | OverridesRecord) & { accountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      const chosen = await chosenOf(account)
      if (after.op === 'update') {
        const r = after as ItemsRecord
        const now = await liveItemsNow(chosen, r.catalogId, (r.items ?? []).map((i) => i.sku))
        return { ...r, items: (r.items ?? []).map((i) => ({ sku: i.sku, fields: asNow(i.fields, now.get(i.sku)?.state) })) }
      }
      if (after.op === 'overrides') {
        const r = after as OverridesRecord
        const state = await overridesNow(chosen, r.catalogId, r.entries)
        // An override's field Meta lists no value for is none now (an override's values are all Meta reads of it).
        return { ...r, entries: r.entries.map((e) => { const f = state.now.get(`${e.sku}|${e.type}|${e.value}`) ?? null; return { ...e, existed: !!f, fields: e.fields ? (f ? asNow(e.fields, Object.fromEntries(Object.keys(e.fields).map((k) => [k, f[k] ?? null]))) : null) : null } }) }
      }
      return after
    } catch (err) {
      if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as { noUndo?: string[]; items?: ItemsRecord['items']; entries?: OverridesRecord['entries'] }
    const after = (change.after ?? {}) as (ItemsRecord | OverridesRecord) & { accountId?: string }
    const h = head(after, 'undo of an earlier set-meta-catalog-items change')
    const stays = (before.noUndo ?? []).join(' ')
    if (after.op === 'create') {
      if (!(after as ItemsRecord).skus?.length) return { refusal: 'This change made no item Meta took, so there is nothing to delete.' }
      return { tool: 'set-meta-catalog-items', args: { ...h, why: 'undo of an earlier set-meta-catalog-items create: delete the items it made', action: 'remove-made', ...(change.id ? { undoOf: change.id } : {}) } }
    }
    if (after.op === 'remove-made') return { refusal: 'This change deleted items an earlier change made: a deletion on Meta is final.' }
    if (after.op === 'update') {
      const items = (before.items ?? []).map((i) => ({ retailerId: i.sku, ...argsOfFields(i.fields) })).filter((i) => Object.keys(i).length > 1)
      if (!items.length) return { refusal: `Nothing Nexus can send back: ${stays || 'the earlier values were empty or not readable.'}` }
      return { tool: 'set-meta-catalog-items', args: { ...h, action: 'update', catalogId: after.catalogId, items } }
    }
    if (after.op === 'overrides') {
      const back = (before.entries ?? []).filter((e) => e.existed && e.fields).map((e) => ({ retailerId: e.sku, type: e.type, value: e.value, ...argsOfFields(e.fields ?? {}) })).filter((e) => Object.keys(e).length > 3)
      const remove = (before.entries ?? []).filter((e) => !e.existed).map((e) => ({ retailerId: e.sku, type: e.type, value: e.value }))
      if (back.length && remove.length) return { refusal: 'This change both changed and made overrides: undo them in two steps (set-meta-catalog-items overrides with the earlier values, then remove-overrides for the new ones).' }
      if (remove.length) return { tool: 'set-meta-catalog-items', args: { ...h, action: 'remove-overrides', catalogId: after.catalogId, remove } }
      if (back.length) return { tool: 'set-meta-catalog-items', args: { ...h, action: 'overrides', catalogId: after.catalogId, overrides: back } }
      return { refusal: `Nothing Nexus can send back: ${stays || 'the earlier overrides had none of these fields.'}` }
    }
    return { refusal: 'Meta lets Nexus read no group\'s default item, so this change has no undo.' }
  },
}

/** Meta's write fields → the tool's typed args (for an undo): only values Nexus can send back exactly. */
function argsOfFields(fields: Fields): Args {
  const out: Args = {}
  const price = (v: unknown) => {
    const m = typeof v === 'string' ? /^(\d+)(?:\.(\d+))? ([A-Z]{3})$/.exec(v) : null
    if (!m) return undefined
    const digits = `${m[1]}${m[2] ?? ''}`
    return { amountMinor: Number(digits), currency: m[3], decimals: (m[2] ?? '').length }
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue
    switch (k) {
      case 'title': out.title = v; break
      case 'description': out.description = v; break
      case 'rich_text_description': out.richTextDescription = v; break
      case 'short_description': out.shortDescription = v; break
      case 'availability': out.availability = v; break
      case 'condition': out.condition = v; break
      case 'price': case 'sale_price': {
        const p = price(v)
        if (p) out[k === 'price' ? 'price' : 'salePrice'] = { amountMinor: p.amountMinor, currency: p.currency }
        break
      }
      case 'sale_price_effective_date': { const [s, e] = String(v).split('/'); out.saleStart = s; out.saleEnd = e; break }
      case 'link': out.link = v; break
      case 'mobile_link': out.mobileLink = v; break
      case 'image': out.images = (v as Array<{ url: string; tag?: string[] }>).map((m) => ({ url: m.url, ...(m.tag?.length ? { tags: m.tag } : {}) })); break
      case 'brand': out.brand = v; break
      case 'gtin': out.gtin = v; break
      case 'mpn': out.mpn = v; break
      case 'fb_product_category': out.fbProductCategory = v; break
      case 'product_type': out.productType = v; break
      case 'item_group_id': out.itemGroupId = v; break
      case 'size': case 'color': case 'gender': case 'material': case 'pattern': out[k] = v; break
      case 'age_group': out.ageGroup = v; break
      case 'additional_variant_attribute': out.variantAttributes = String(v).split(',').map((p) => { const [name, value] = p.split(':'); return { name, value } }); break
      case 'internal_label': out.internalLabels = v; break
      case 'disabled_capabilities': out.hideFrom = v; break
      case 'status': out.status = v; break
      case 'expiration_date': out.expirationDate = v; break
      case 'shipping_weight': { const [value, unit] = String(v).split(' '); out.shippingWeight = { value: Number(value), unit }; break }
      case 'origin_country': out.originCountry = v; break
      case 'importer_name': out.importerName = v; break
      case 'importer_address': { const a = v as Record<string, string>; out.importerAddress = { street1: a.street1, ...(a.street2 ? { street2: a.street2 } : {}), city: a.city, ...(a.region ? { region: a.region } : {}), ...(a.postal_code ? { postalCode: a.postal_code } : {}), country: a.country }; break }
      default: {
        const label = /^custom_label_([0-4])$/.exec(k)
        const number = /^custom_number_([0-4])$/.exec(k)
        if (label) out[`customLabel${label[1]}`] = v
        if (number) out[`customNumber${number[1]}`] = v
      }
    }
  }
  return out
}

const setMetaCatalogItems: AgentTool = {
  ...common,
  name: 'set-meta-catalog-items',
  title: 'Change items of a Meta catalog',
  consequencesFor: (args) => (args.action === 'remove-made' || args.action === 'group-default' ? { reversibility: 'none' } : null),
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(ITEM_ACTIONS).describe('create (new items) | update (fields of items) | overrides (country / language values) | remove-overrides | group-default (a variant group\'s first item) | remove-made (ONLY the undo of an earlier create: undo-change asks for it)'),
    catalogId: metaIdArg('the catalog (meta-catalogs view list)').optional(),
    items: z.array(itemArg).min(1).max(MAX_ITEMS_PER_CHANGE).optional().describe(`create, update: at most ${MAX_ITEMS_PER_CHANGE} items, each its retailerId and the fields to set (create: title, description, availability, condition, price, link, images, brand)`),
    itemSubType: z.enum(META_ITEM_SUB_TYPES).optional().describe('create: Meta\'s sub vertical of the items (CLOTHING, SHOES_AND_FOOTWEAR, …)'),
    overrides: z.array(overrideArg).min(1).max(MAX_OVERRIDES_PER_CHANGE).optional().describe(`overrides: at most ${MAX_OVERRIDES_PER_CHANGE}, each an item, a country or language and its fields`),
    remove: z.array(overrideRefArg).min(1).max(MAX_OVERRIDES_PER_CHANGE).optional().describe('remove-overrides: the overrides to take off (the item\'s own values show again)'),
    groupId: metaIdArg('group-default: the item group (meta-catalog-items view groups)').optional(),
    defaultItemId: metaIdArg('group-default: the item (Meta\'s id) that becomes the group\'s default').optional(),
    quantityToSellOnFacebook: z.unknown().optional().describe('not sent: only for checkout on Meta, which Shops ads no longer use (the answer says what Nexus sends instead)'),
    singleItem: z.unknown().optional().describe('not offered: Nexus writes items through items_batch only (the answer says why)'),
    createGroup: z.unknown().optional().describe('not offered: a variant group comes from items sharing an itemGroupId (the answer says so)'),
    undoOf: z.string().trim().min(1).max(64).optional().describe('remove-made: the id of the change undone (its record names the items it made)'),
    why: metaWhyArg,
  }),
  description:
    'Change the items of one of the business\'s Meta catalogs — ONLY a catalog Nexus may write items in (D7: no Shopify, no '
    + 'partner, no feed writes it; else "Shopify owns these items" and the answer points to the labels Nexus may add with '
    + 'set-meta-catalog-feed). create: new items (Meta\'s required fields; never an item that exists); update: any '
    + 'documented field of existing items — price and sale price (MONEY: buyers see it; only for a person who may see revenue), '
    + 'stock (availability), text, images and videos, brand / GTIN / MPN / categories, variants (itemGroupId groups them), '
    + 'internal and custom labels and numbers, surfaces it is kept off (hideFrom; da = catalog ads), archived, expiry, '
    + 'shipping, EU importer, ratings (only real ones); overrides: country (price, sale, availability, link) or language '
    + '(text) values, or their removal; group-default: a variant group\'s first item (Meta\'s SDK only). One items_batch '
    + 'request with allow_upsert false (an update never makes an item); Meta answers per item and Nexus reads the batch\'s '
    + 'status. Items reach buyers in ads and shops; a change that brings items back into catalog ads while ads deliver on the '
    + 'catalog is SPENDS MONEY. Undo puts the earlier values back (deletes the items a create made); what Nexus cannot read '
    + 'back is said. quantity_to_sell_on_facebook is not sent (checkout only).'
    + META_CHANGE_RULES,
  undo: itemsUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildItems(args, ctx)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildItems(args, ctx), itemsFinish, batchAfter),
}

// ── set-meta-catalog-feed ───────────────────────────────────────────────────────────────────────────────────────────

const FEED_ACTIONS = ['create', 'change', 'labels', 'upload', 'rules', 'upload-schedule', 'error-report', 'remove-made'] as const

const scheduleArg = (what: string) => z.object({
  interval: z.enum(META_FEED_INTERVALS).describe('HOURLY | DAILY | WEEKLY | MONTHLY (Meta fetches at most once an hour)'),
  url: z.string().trim().max(2000).refine((v) => metaPublicFetchUrlProblem(v) === null, 'a public https address with no key in it').describe('the file\'s public https address (no user, password or key in it)'),
  intervalCount: z.number().int().min(1).max(1000).optional().describe('every this many intervals (default 1)'),
  hour: z.number().int().min(0).max(23).optional().describe('the hour (Pacific time unless timeZone)'),
  minute: z.number().int().min(0).max(59).optional().describe('the minute'),
  dayOfWeek: z.enum(META_FEED_DAYS).optional().describe('WEEKLY: the day'),
  dayOfMonth: z.number().int().min(1).max(31).optional().describe('MONTHLY: the day'),
  timeZone: z.string().trim().regex(/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$/).max(64).optional().describe('the time zone (Europe/Rome)'),
}).describe(what)
type ScheduleArg = z.infer<ReturnType<typeof scheduleArg>>
function scheduleOf(s: ScheduleArg): FeedSchedule {
  return { interval: s.interval, url: s.url, ...(s.intervalCount !== undefined ? { interval_count: s.intervalCount } : {}), ...(s.hour !== undefined ? { hour: s.hour } : {}), ...(s.minute !== undefined ? { minute: s.minute } : {}), ...(s.dayOfWeek ? { day_of_week: s.dayOfWeek } : {}), ...(s.dayOfMonth !== undefined ? { day_of_month: s.dayOfMonth } : {}), ...(s.timeZone ? { timezone: s.timeZone } : {}) }
}

const ruleArg = z.object({
  attribute: z.enum(META_RULE_ATTRIBUTES as [string, ...string[]]).describe('the item field the rule changes (custom_label_0, title, …)'),
  ruleType: z.enum(META_FEED_RULE_TYPES).describe('mapping_rule | value_mapping_rule | letter_case_rule | fallback_rule | regex_replace_rule'),
  mapFrom: strictText(100).optional().describe('mapping_rule: the file\'s column it takes the value from'),
  values: z.array(z.object({ from: strictText(200).describe('the old value'), to: strictText(200).describe('the new one') })).min(1).max(MAX_VALUE_MAPPINGS).optional().describe('value_mapping_rule: old → new values'),
  letterCase: z.enum(META_LETTER_CASES).optional().describe('letter_case_rule: to_upper | to_lower | capitalize_all | capitalize_first'),
  defaultValue: strictText(500).optional().describe('fallback_rule: the value an empty field gets'),
  regex: z.string().trim().min(1).max(200).regex(/^[\x20-\x7e]+$/).optional().describe('regex_replace_rule: the pattern (Meta documents no other key)'),
})
type RuleArg = z.infer<typeof ruleArg>
function ruleOf(r: RuleArg): FeedRuleAsk | { refusal: string } {
  const params: Record<string, unknown> = r.ruleType === 'mapping_rule' ? { map_from: r.mapFrom }
    : r.ruleType === 'value_mapping_rule' ? Object.fromEntries((r.values ?? []).map((v) => [v.from, v.to]))
      : r.ruleType === 'letter_case_rule' ? { type: r.letterCase }
        : r.ruleType === 'fallback_rule' ? { user_default_value: r.defaultValue }
          : { regex: r.regex }
  const problem = metaRuleParamsProblem(r.ruleType, JSON.parse(JSON.stringify(params)))
  return problem ? { refusal: `A ${r.ruleType} on ${r.attribute}: ${problem}.` } : { attribute: r.attribute, ruleType: r.ruleType, params }
}
/** A rule Meta reads back → the tool's rule args (for an undo), or null when its params are not ones Nexus sends. */
function ruleArgOf(rule: { attribute: string | null; ruleType: string | null; params: Record<string, unknown> | null }): Args | null {
  if (!rule.attribute || !rule.ruleType || !rule.params || metaRuleParamsProblem(rule.ruleType, rule.params) || !META_RULE_ATTRIBUTES.includes(rule.attribute)) return null
  const p = rule.params
  switch (rule.ruleType) {
    case 'mapping_rule': return { attribute: rule.attribute, ruleType: rule.ruleType, mapFrom: p.map_from }
    case 'value_mapping_rule': return { attribute: rule.attribute, ruleType: rule.ruleType, values: Object.entries(p).map(([from, to]) => ({ from, to })) }
    case 'letter_case_rule': return { attribute: rule.attribute, ruleType: rule.ruleType, letterCase: p.type }
    case 'fallback_rule': return { attribute: rule.attribute, ruleType: rule.ruleType, defaultValue: p.user_default_value }
    case 'regex_replace_rule': return { attribute: rule.attribute, ruleType: rule.ruleType, regex: p.regex }
  }
  return null
}

/** A labels item: its retailer id and the D7 columns ('' or [] or null empties one — LIVE-PROBES CT35-03). */
const labelsItemArg = z.object({
  retailerId: itemShape.retailerId,
  internalLabels: z.array(labelText).max(MAX_INTERNAL_LABELS).optional().describe('internal labels (the WHOLE list; [] empties it)'),
  ...Object.fromEntries([0, 1, 2, 3, 4].map((n) => [`customLabel${n}`, z.string().trim().max(META_CUSTOM_LABEL_MAX).regex(META_STRICT_TEXT).optional().describe(`custom_label_${n} ("" empties it; a change sends the item to review again)`)])),
  ...Object.fromEntries([0, 1, 2, 3, 4].map((n) => [`customNumber${n}`, z.number().int().min(0).max(META_CUSTOM_NUMBER_MAX).nullable().optional().describe(`custom_number_${n} (null empties it)`)])),
}) as z.ZodObject<Record<string, z.ZodTypeAny>>
function labelsOf(list: unknown): Array<{ sku: string; fields: Fields }> | { refusal: string } {
  const out: Array<{ sku: string; fields: Fields }> = []
  const seen = new Set<string>()
  for (const a of (list ?? []) as Array<Record<string, unknown>>) {
    const sku = String(a.retailerId)
    if (seen.has(sku)) return { refusal: `${sku} is named twice.` }
    seen.add(sku)
    const fields: Fields = {}
    if (a.internalLabels !== undefined) {
      const labels = a.internalLabels as string[]
      if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) return { refusal: `${sku}: internalLabels names each label once.` }
      fields.internal_label = labels.map((l) => l.toLowerCase())
    }
    for (const n of [0, 1, 2, 3, 4]) {
      if (a[`customLabel${n}`] !== undefined) fields[`custom_label_${n}`] = a[`customLabel${n}`] === '' ? null : a[`customLabel${n}`]
      if (a[`customNumber${n}`] !== undefined) fields[`custom_number_${n}`] = a[`customNumber${n}`]
    }
    if (!Object.keys(fields).length) return { refusal: `${sku}: name at least one of internalLabels, customLabel0–4, customNumber0–4 (the D7 columns).` }
    out.push({ sku, fields })
  }
  return out
}

/** The feed of a catalog a change names, and whether Nexus made it (its own records). */
async function feedHere(chosen: MetaChosenAccount, catalogId: string, feedId: unknown, own: readonly string[]) {
  if (typeof feedId !== 'string' || !feedId) throw new MetaLiveRefusal('Name the feed (feedId: meta-catalog-feeds view list).')
  const feed = await liveFeedNow(chosen, catalogId, feedId)
  return { feed, mine: own.includes(feed.feedId) }
}
const NOT_OWN_FEED = (feedId: string) => `Feed ${feedId} is not one Nexus made: Nexus changes no other feed's settings, schedules, files or rules (a Shopify or partner feed is theirs — D7). Labels go to it with action labels.`

/** Re-review NF2 — feeds whose delete changes what buyers pay: discounts, store prices, country prices. */
const MONEY_FEED_KINDS: ReadonlySet<string> = new Set(['offers', 'local-inventory', 'country', 'language-and-country'])

async function removeMadeFeed(args: Args, account: MetaChangeAccount, ctx: ToolContext): Promise<MetaChangeDraft | { refusal: string }> {
  // catalogId is required by the tool's input (the undo names the record's own): it must be the record's catalog.
  const extra = onlyArgs(args, 'remove-made (the undo of an earlier set-meta-catalog-feed create)', ['undoOf', 'catalogId'])
  if (extra) return { refusal: extra }
  const record = await recordOf('set-meta-catalog-feed', args.undoOf, account)
  if ('refusal' in record) return record
  const after = record.after as FeedRecord
  if (args.catalogId !== undefined && args.catalogId !== after.catalogId) return { refusal: `That change made a feed in catalog ${after.catalogId}, not in ${String(args.catalogId)}.` }
  if (after.op !== 'create' || !after.feedId) return { refusal: 'That change recorded no feed it made, so there is nothing Nexus can delete.' }
  const money = MONEY_FEED_KINDS.has(String(after.kind))
  if (money && !mayPrice(ctx)) return { refusal: FEED_PRICE_REFUSED(`Deleting ${after.kind === 'offers' ? 'an offers feed (its discounts go)' : after.kind === 'local-inventory' ? 'a local inventory feed (its store prices and stock go)' : 'a country override feed (its country prices go)'}`) }
  const chosen = await chosenOf(account)
  const own = await ownCatalogFeedIds(after.catalogId, account.adAccountId)
  const { feed, mine } = await feedHere(chosen, after.catalogId, after.feedId, own)
  if (!mine) return { refusal: NOT_OWN_FEED(feed.feedId) }
  const { catalog } = await d7OrSettings(chosen, after.catalogId)
  return feedRemoveMadeDraft({ catalog: named(catalog), feed, undoOf: String(args.undoOf), money })
}

/** The catalog of a feed change, checked as step 34 checks a catalog's settings (the D7 checks come per action). */
async function d7OrSettings(chosen: MetaChosenAccount, catalogId: string) {
  const { writableFor } = await import('../../marketing/meta-ads/live-catalog-admin.js')
  return writableFor(chosen, catalogId, 'settings')
}

const buildFeed = (args: Args, ctx: ToolContext): MetaDraftBuilder => guarded(async (account) => {
  if (args.linkPrimaryFeeds !== undefined) return { refusal: FEED_LINKS_NOT_BUILT }
  const action = String(args.action)
  if (action === 'remove-made') return removeMadeFeed(args, account, ctx)
  if (args.undoOf !== undefined) return { refusal: 'undoOf goes only with action remove-made (the undo of an earlier create).' }
  const allowed: Record<string, string[]> = {
    create: ['catalogId', 'kind', 'name', 'schedule', 'updateSchedule', 'country', 'defaultCurrency', 'deletionEnabled', 'delimiter', 'encoding', 'quotedFieldsMode', 'itemSubType', 'migratedFromFeedId', 'primaryFeedIds', 'rules'],
    change: ['catalogId', 'feedId', 'name', 'schedule', 'updateSchedule', 'defaultCurrency', 'delimiter', 'encoding', 'quotedFieldsMode', 'migratedFromFeedId', 'deletionEnabledOn', 'country', 'kind'],
    labels: ['catalogId', 'feedId', 'via', 'labelItems'],
    upload: ['catalogId', 'feedId', 'rows', 'url', 'updateOnly', 'replaceAll'],
    rules: ['catalogId', 'feedId', 'addRules', 'removeRules', 'changeRules'],
    'upload-schedule': ['catalogId', 'feedId', 'schedule'],
    'error-report': ['catalogId', 'feedId', 'uploadId'],
  }
  const extra = onlyArgs(args, action, allowed[action] ?? [])
  if (extra) return { refusal: extra }
  const catalogId = typeof args.catalogId === 'string' ? args.catalogId : ''
  if (!catalogId) return { refusal: 'Name the catalog (catalogId: meta-catalogs view list).' }
  // Review A-F2 — what can set the prices buyers see, only for a person who may see revenue: a feed's default currency, an
  // offers feed, a fetch from an address (a file Nexus never sees: any price), an upload schedule (the same).
  if (!mayPrice(ctx)) {
    if ((action === 'create' || action === 'change') && args.defaultCurrency !== undefined) return { refusal: FEED_PRICE_REFUSED('defaultCurrency (the currency of every price without one)') }
    if (action === 'create' && args.kind === 'offers') return { refusal: FEED_PRICE_REFUSED('An offers feed (discounts on the catalog\'s items)') }
    if ((action === 'create' || action === 'change') && (args.schedule !== undefined || args.updateSchedule !== undefined)) return { refusal: FEED_PRICE_REFUSED('A feed that fetches a file on a schedule (Nexus never sees the file, nor its prices)') }
    if (action === 'upload' && args.url !== undefined) return { refusal: FEED_PRICE_REFUSED('A fetch of a file from an address (Nexus never sees the file, nor its prices)') }
    if (action === 'upload-schedule') return { refusal: FEED_PRICE_REFUSED('An upload schedule (Nexus never sees the files it fetches, nor their prices)') }
    if (action === 'upload' && ((args.rows ?? []) as Array<Record<string, unknown>>).some((r) => ['price', 'salePrice', 'saleStart', 'saleEnd', 'shipping'].some((k) => r[k] !== undefined))) return { refusal: PRICE_REFUSED }
    if (action === 'create' && ((args.rules ?? []) as RuleArg[]).some((r) => MONEY_ATTRIBUTES.has(r.attribute))) return { refusal: FEED_PRICE_REFUSED('A rule on a price, a sale or shipping') }
  }
  const chosen = await chosenOf(account)
  // The feeds Nexus made on this catalog, each with the kind it was made as (its own records).
  const ownKinds = await ownCatalogFeeds(catalogId, account.adAccountId)
  const own = [...ownKinds.keys()]
  switch (action) {
    case 'create': {
      const kind = String(args.kind) as FeedKind
      if (typeof args.name !== 'string') return { refusal: 'Name the new feed (name).' }
      const ask: FeedCreateAsk = {
        kind, name: args.name,
        ...(args.schedule ? { schedule: scheduleOf(args.schedule as ScheduleArg) } : {}), ...(args.updateSchedule ? { updateSchedule: scheduleOf(args.updateSchedule as ScheduleArg) } : {}),
        ...(args.country ? { country: args.country as string } : {}), ...(args.defaultCurrency ? { defaultCurrency: args.defaultCurrency as string } : {}),
        ...(args.deletionEnabled !== undefined ? { deletionEnabled: args.deletionEnabled === true } : {}), ...(args.delimiter ? { delimiter: args.delimiter as string } : {}),
        ...(args.encoding ? { encoding: args.encoding as string } : {}), ...(args.quotedFieldsMode ? { quotedFieldsMode: args.quotedFieldsMode as string } : {}),
        ...(args.itemSubType ? { itemSubType: args.itemSubType as string } : {}), ...(args.migratedFromFeedId ? { migratedFromFeedId: args.migratedFromFeedId as string } : {}),
        ...(args.primaryFeedIds ? { primaryFeedIds: [...new Set(args.primaryFeedIds as string[])] } : {}),
      }
      if (args.rules) {
        const rules: FeedRuleAsk[] = []
        for (const r of args.rules as RuleArg[]) { const rule = ruleOf(r); if ('refusal' in rule) return rule; rules.push(rule) }
        ask.rules = rules
      }
      if (kind === 'supplementary') {
        if (!ask.primaryFeedIds?.length) return { refusal: 'A supplementary feed names the primary sources it adds labels to (primaryFeedIds: meta-catalogs view data-sources, type PRIMARY).' }
        if (ask.schedule || ask.updateSchedule || ask.migratedFromFeedId || ask.itemSubType || ask.deletionEnabled !== undefined || ask.country) return { refusal: 'Nexus\'s supplementary feed takes a name, its primary sources and rules on the D7 columns only: it fetches nothing on a schedule (Nexus writes into it with labels files).' }
        if (ask.rules?.some((r) => !(META_D7_COLUMNS as readonly string[]).includes(r.attribute))) return { refusal: `Nexus's supplementary feed adds only the D7 columns (${META_D7_COLUMNS.join(', ')}): a rule on another field is Shopify's to make.` }
        // D7 — Nexus may add the D7 columns here (step 12's { upload } purpose: Shopify, no writer yet, or Nexus alone), and
        // its rules on them (the { rules } purpose: the gateway runs both, so the preview does too — re-review nit b).
        const { catalog } = await d7WriteCheck(chosen, catalogId, ['id', 'internal_label'], own)
        if (ask.rules?.length) await d7RulesCheck(chosen, catalogId, [...new Set(ask.rules.map((r) => r.attribute))], own)
        const primaries = await livePrimarySources(chosen, catalog.catalogId)
        const foreign = ask.primaryFeedIds.filter((p) => !primaries.ids.has(p))
        if (foreign.length) return { refusal: `${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not a primary data source of this catalog${primaries.more ? ' among the first 100 Nexus read' : ''} (meta-catalogs view data-sources, type PRIMARY).` }
        return feedCreateDraft({ catalog: named(catalog), ask, use: await useOf(chosen, catalog.catalogId), d7: true })
      }
      if (ask.primaryFeedIds) return { refusal: 'primaryFeedIds go only with a supplementary feed.' }
      if (ask.deletionEnabled === undefined) return { refusal: 'Say whether the feed deletes items missing from a full upload (deletionEnabled true or false): Meta\'s default is true and once on it can never be turned off, so Nexus never leaves it to the default.' }
      if (['country', 'language', 'language-and-country'].includes(kind) && ask.deletionEnabled) return { refusal: 'An override feed carries values for items the catalog has: it is made with deletionEnabled false.' }
      if (ask.migratedFromFeedId && !own.includes(ask.migratedFromFeedId)) return { refusal: `Feed ${ask.migratedFromFeedId} is not one Nexus made on this catalog: Nexus moves items only out of its own feeds.` }
      // D7 — a feed that brings items: only where Nexus may write items, or writes them alone (its app and its own feeds).
      const { catalog } = await feedWriteCheck(chosen, catalogId, own)
      return feedCreateDraft({ catalog: named(catalog), ask, use: await useOf(chosen, catalog.catalogId), d7: false })
    }
    case 'change': {
      if (args.country !== undefined || args.kind !== undefined) return { refusal: FEED_NOT_UPDATABLE }
      const { feed, mine } = await feedHere(chosen, catalogId, args.feedId, own)
      if (!mine) return { refusal: NOT_OWN_FEED(feed.feedId) }
      const ask: FeedChangeAsk = {
        ...(args.name !== undefined ? { name: args.name as string } : {}), ...(args.schedule ? { schedule: scheduleOf(args.schedule as ScheduleArg) } : {}),
        ...(args.updateSchedule ? { updateSchedule: scheduleOf(args.updateSchedule as ScheduleArg) } : {}), ...(args.defaultCurrency ? { defaultCurrency: args.defaultCurrency as string } : {}),
        ...(args.delimiter ? { delimiter: args.delimiter as string } : {}), ...(args.encoding ? { encoding: args.encoding as string } : {}),
        ...(args.quotedFieldsMode ? { quotedFieldsMode: args.quotedFieldsMode as string } : {}), ...(args.migratedFromFeedId ? { migratedFromFeedId: args.migratedFromFeedId as string } : {}),
        ...(args.deletionEnabledOn === true ? { deletionEnabled: true as const } : {}),
      }
      if (!Object.keys(ask).length) return { refusal: 'change names what to change: name, schedule, updateSchedule, defaultCurrency, delimiter, encoding, quotedFieldsMode, migratedFromFeedId or deletionEnabledOn.' }
      if (ask.migratedFromFeedId && !own.includes(ask.migratedFromFeedId)) return { refusal: `Feed ${ask.migratedFromFeedId} is not one Nexus made on this catalog: Nexus moves items only out of its own feeds.` }
      const nameOnly = Object.keys(ask).every((k) => k === 'name')
      if (feed.supplementary === true && !nameOnly) return { refusal: 'Nexus\'s own supplementary feed takes a new name only: it fetches nothing on a schedule and has no items of its own (labels go in with action labels).' }
      // D7 — a rename of Nexus's own supplementary feed is a setting; anything else of a feed that brings items needs the
      // items check (or Nexus alone writes the catalog).
      const { catalog } = feed.supplementary === true ? await d7OrSettings(chosen, catalogId) : await feedWriteCheck(chosen, catalogId, own)
      return feedChangeDraft({ catalog: named(catalog), feed, ask, use: await useOf(chosen, catalog.catalogId) })
    }
    case 'labels': {
      const asked = labelsOf(args.labelItems)
      if ('refusal' in asked) return asked
      if (!asked.length) return { refusal: 'labelItems lists the items (retailerId) and the D7 columns to set.' }
      const via = args.via === 'own-feed' ? 'own-feed' : 'shopify-feed'
      const { feed, mine } = await feedHere(chosen, catalogId, args.feedId, own)
      if (via === 'own-feed' && !(mine && feed.supplementary === true)) return { refusal: `Feed ${feed.feedId} is not Nexus's own supplementary feed (make one with action create kind supplementary, or send the labels via the Shopify feed).` }
      if (via === 'shopify-feed' && feed.supplementary !== false) return { refusal: `Feed ${feed.feedId} is not a primary feed (or Meta does not say): an update-only labels file goes to the feed that brings the items (the Shopify feed), or to Nexus's own supplementary feed (via own-feed).` }
      if (via === 'shopify-feed' && feed.overrideType) return { refusal: `Feed ${feed.feedId} is a ${feed.overrideType.toLowerCase()} override feed: a labels file goes to the feed that brings the items (the Shopify feed), or to Nexus's own supplementary feed (via own-feed).` }
      const columns = ['id', ...META_D7_COLUMNS.filter((c) => asked.some((a) => c in a.fields))]
      // D7 — step 12's { upload } purpose with exactly these columns (frozen: the file is built from them).
      const { catalog, fields } = await d7WriteCheck(chosen, catalogId, columns, own)
      const allowedColumns = new Set(fields)
      if (!columns.every((c) => allowedColumns.has(c))) return { refusal: 'The labels file would carry a column the D7 check did not allow.' }
      const now = await liveLabelsNow(chosen, catalog.catalogId, asked.map((a) => a.sku))
      return d7LabelsDraft({ catalog: named(catalog), feed, via, asked, now, use: await useOf(chosen, catalog.catalogId) })
    }
    case 'upload': {
      const { feed, mine } = await feedHere(chosen, catalogId, args.feedId, own)
      if (!mine) return { refusal: `${NOT_OWN_FEED(feed.feedId)} An upload of items goes only to a feed Nexus made.` }
      if (feed.supplementary === true) return { refusal: 'Nexus\'s supplementary feed takes labels files only (action labels via own-feed).' }
      if (typeof args.updateOnly !== 'boolean') return { refusal: 'Say whether the upload only adds and updates (updateOnly true) or replaces the feed\'s items (false).' }
      if (!args.updateOnly && args.replaceAll !== true) return { refusal: 'A full upload REPLACES the feed\'s items (with deletion on, items missing from the file are deleted): send replaceAll true only when the person asked for that.' }
      if (!!args.rows === !!args.url) return { refusal: 'An upload is rows (a file Nexus makes) or url (a public address), one of them.' }
      // Review B-F5 — a file of item rows is a primary feed's (PRODUCT_ITEM columns): an override, offers, ratings or
      // local-inventory feed has columns of its own, so it takes a file from an address only.
      if (args.rows && (ownKinds.get(feed.feedId) !== 'products' || feed.supplementary !== false || feed.overrideType)) return { refusal: `Feed ${feed.feedId} is not a primary feed of items Nexus made (it was made as ${ownKinds.get(feed.feedId) ?? 'a kind Nexus did not record'}): rows (a file of items) go only to one. Other feeds take a file from a public address (url).` }
      const { catalog } = await feedWriteCheck(chosen, catalogId, own)
      const use = await useOf(chosen, catalog.catalogId)
      if (args.url) return urlUploadDraft({ catalog: named(catalog), feed, url: String(args.url), updateOnly: args.updateOnly === true, use })
      const rows = itemsOf(args.rows, args.updateOnly ? 'UPDATE' : 'CREATE')
      if ('refusal' in rows) return rows
      return fileUploadDraft({ catalog: named(catalog), feed, rows, updateOnly: args.updateOnly === true, use })
    }
    case 'rules': {
      const { feed, mine } = await feedHere(chosen, catalogId, args.feedId, own)
      const add: FeedRuleAsk[] = []
      for (const r of (args.addRules ?? []) as RuleArg[]) { const rule = ruleOf(r); if ('refusal' in rule) return rule; add.push(rule) }
      const change = ((args.changeRules ?? []) as Array<{ ruleId: string; rule: RuleArg }>)
      const rulesNow = await liveFeedRules(chosen, feed.feedId)
      const changed: Array<{ ruleId: string; params: Record<string, unknown> }> = []
      for (const c of change) {
        const rule = ruleOf(c.rule)
        if ('refusal' in rule) return rule
        const current = rulesNow.rules.find((r) => r.ruleId === c.ruleId)
        if (current && (current.attribute !== rule.attribute || current.ruleType !== rule.ruleType)) return { refusal: `Rule ${c.ruleId} is a ${current.ruleType} on ${current.attribute}: a change keeps its type and attribute (remove it and add another).` }
        changed.push({ ruleId: c.ruleId, params: rule.params })
      }
      const removed = [...new Set((args.removeRules ?? []) as string[])]
      if (!add.length && !changed.length && !removed.length) return { refusal: 'rules names rules to add (addRules), change (changeRules) or remove (removeRules).' }
      if (rulesNow.more) return { refusal: 'The feed has more rules than Nexus reads (100): change them in Commerce Manager.' }
      const attributes = [...new Set([...add.map((r) => r.attribute), ...change.map((c) => c.rule.attribute), ...removed.map((id) => rulesNow.rules.find((r) => r.ruleId === id)?.attribute ?? '')].filter(Boolean))]
      // Review A-F2 — a rule on a price, a sale or shipping (made, changed or removed) changes what buyers pay.
      if (!mayPrice(ctx) && attributes.some((a) => MONEY_ATTRIBUTES.has(a))) return { refusal: FEED_PRICE_REFUSED('A rule on a price, a sale or shipping') }
      const d7Only = attributes.every((a) => (META_D7_COLUMNS as readonly string[]).includes(a))
      // Review A-F1 (D7) — a supplementary feed's rules shape what it adds to the primary source's items: D7 columns only.
      if (feed.supplementary === true && !d7Only) return { refusal: `Feed ${feed.feedId} is a supplementary feed: its rules name the D7 columns only (${META_D7_COLUMNS.join(', ')}), never ${attributes.filter((a) => !(META_D7_COLUMNS as readonly string[]).includes(a)).join(', ')}.` }
      // D7 — rules on the D7 columns: step 12's { rules } purpose (the Shopify feed or Nexus's own supplementary feed); a
      // rule on any other field: only on a feed Nexus made, where it may write items or writes alone.
      if (d7Only) {
        if (feed.supplementary === true && !mine) return { refusal: `Feed ${feed.feedId} is a supplementary feed Nexus did not make: Nexus adds no rule to it.` }
        const { catalog } = await d7RulesCheck(chosen, catalogId, attributes, own)
        return rulesDraft({ catalog: named(catalog), feed, rulesNow: rulesNow.rules, ask: { add, remove: removed, change: changed }, use: await useOf(chosen, catalog.catalogId) })
      }
      if (!mine) return { refusal: `${NOT_OWN_FEED(feed.feedId)} A rule on ${attributes.filter((a) => !(META_D7_COLUMNS as readonly string[]).includes(a)).join(', ')} changes a field Shopify (or another source) writes.` }
      const { catalog } = await feedWriteCheck(chosen, catalogId, own)
      return rulesDraft({ catalog: named(catalog), feed, rulesNow: rulesNow.rules, ask: { add, remove: removed, change: changed }, use: await useOf(chosen, catalog.catalogId) })
    }
    case 'upload-schedule': {
      const { feed, mine } = await feedHere(chosen, catalogId, args.feedId, own)
      if (!mine) return { refusal: NOT_OWN_FEED(feed.feedId) }
      if (feed.supplementary === true) return { refusal: 'Nexus\'s supplementary feed fetches nothing on a schedule.' }
      if (!args.schedule) return { refusal: 'Name the schedule (schedule: interval and the file\'s public address).' }
      const { catalog } = await feedWriteCheck(chosen, catalogId, own)
      return uploadScheduleDraft({ catalog: named(catalog), feed, schedule: scheduleOf(args.schedule as ScheduleArg), use: await useOf(chosen, catalog.catalogId) })
    }
    case 'error-report': {
      const feedId = typeof args.feedId === 'string' ? args.feedId : ''
      const uploadId = typeof args.uploadId === 'string' ? args.uploadId : ''
      if (!feedId || !uploadId) return { refusal: 'Name the feed (feedId) and the upload (uploadId: meta-catalog-feeds view uploads).' }
      const { catalog } = await d7OrSettings(chosen, catalogId)
      const upload = await liveFeedUpload(chosen, catalog.catalogId, feedId, uploadId)
      return errorReportDraft({ catalog: named(catalog), feedId, uploadId: upload.uploadId })
    }
  }
  return { refusal: `action is ${FEED_ACTIONS.join(', ')}.` }
})

function feedFinish(draft: MetaChangeDraft, done: Done) {
  const planned = draft.after as FeedRecord
  const node = done[0]?.result.node ?? null
  if (planned.op === 'create') {
    const feedId = createdIdOf(node)
    const after: FeedRecord = { ...planned, feedId, ...(feedId ? {} : { noUndo: ['Meta did not answer the new feed\'s id, so undo cannot tell it apart.'] }) }
    return { data: { feedId, note: 'meta-catalog-feeds view feed shows it.' }, before: draft.before, after }
  }
  if (planned.op === 'remove-made') return { data: { deleted: { feedId: planned.feedId } }, before: draft.before, after: planned, noUndo: 'A deletion on Meta is final: nothing here can be put back.' }
  if (planned.op === 'rules') {
    // The rules this run made, with the ids Meta gave them (their undo deletes exactly these); the deletes that happened.
    const made = done.filter((d) => d.request.operation === 'catalog.feed.rule.create').map((d) => ({ ruleId: createdIdOf(d.result.node), attribute: d.request.params.attribute, ruleType: d.request.params.rule_type, params: JSON.parse(d.request.params.params) as Record<string, unknown> }))
    const removedIds = new Set(done.filter((d) => d.request.operation === 'catalog.feed.rule.delete').map((d) => d.request.objectId))
    const before = draft.before as FeedRecord
    return { data: { made: made.map((r) => r.ruleId), removed: [...removedIds] }, before: { ...before, rules: (before.rules ?? []).filter((r) => r.ruleId && removedIds.has(r.ruleId)) }, after: { ...planned, rules: made } }
  }
  if (planned.op === 'labels' || planned.op === 'upload') {
    const uploadId = createdIdOf(node)
    return { data: { uploadId, upload: node ? { itemsDetected: node.num_detected_items ?? null, itemsSaved: node.num_persisted_items ?? null, itemsInvalid: node.num_invalid_items ?? null, itemsDeleted: node.num_deleted_items ?? null, errors: node.error_count ?? null } : null, note: 'Meta ingests the file in the background: meta-catalog-feeds view upload with this uploadId shows its result (upload-errors its errors).' }, before: draft.before, after: { ...planned, uploadId }, ...(planned.op === 'upload' ? { noUndo: 'An upload has no undo: Meta keeps no earlier file.' } : {}) }
  }
  if (planned.op === 'upload-schedule' || planned.op === 'error-report') return { data: { feedId: planned.feedId, ...(planned.uploadId ? { uploadId: planned.uploadId } : {}) }, before: draft.before, after: planned, noUndo: planned.op === 'error-report' ? 'An error report changes nothing in the catalog: there is nothing to undo.' : 'Meta documents no way to remove an upload schedule through the API (Commerce Manager removes it).' }
  return { data: { feedId: planned.feedId }, before: draft.before, after: planned }
}

const feedUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as FeedRecord & { accountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      const chosen = await chosenOf(account)
      if (after.op === 'change' && after.feedId) {
        const feed = await liveFeedNow(chosen, after.catalogId, after.feedId)
        const { feedFieldsOf } = await import('../../marketing/meta-ads/change-catalog-items.js')
        const now = feedFieldsOf(feed)
        const written = after.fields ?? {}
        // A field Meta reads no value for is left out of the compare (re-review nit e), as an item's unreadable field is.
        return { ...after, fields: Object.fromEntries(Object.keys(written).map((k) => [k, now[k] === null || now[k] === undefined || sameAsWritten(k, now[k], written[k]) ? written[k] : now[k]])) }
      }
      if (after.op === 'labels') {
        const now = await liveLabelsNow(chosen, after.catalogId, (after.items ?? []).map((i) => i.sku))
        return { ...after, items: (after.items ?? []).map((i) => ({ sku: i.sku, fields: asNow(i.fields, now.get(i.sku)?.state) })) }
      }
      if (after.op === 'rules' && after.feedId) {
        const now = await liveFeedRules(chosen, after.feedId)
        return { ...after, rules: (after.rules ?? []).map((r) => now.rules.find((x) => x.ruleId === r.ruleId) ?? { ...r, ruleId: null }).map((r) => ({ ruleId: r.ruleId, attribute: r.attribute, ruleType: r.ruleType, params: r.params })) }
      }
      return after
    } catch (err) {
      if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as FeedRecord
    const after = (change.after ?? {}) as FeedRecord & { accountId?: string }
    const h = head(after, 'undo of an earlier set-meta-catalog-feed change')
    const stays = (before.noUndo ?? after.noUndo ?? []).join(' ')
    const base = { ...h, catalogId: after.catalogId }
    switch (after.op) {
      case 'create':
        if (!after.feedId) return { refusal: `This change recorded no feed it made${stays ? ` (${stays})` : ''}.` }
        return { tool: 'set-meta-catalog-feed', args: { ...h, why: 'undo of an earlier set-meta-catalog-feed create: delete the feed it made', action: 'remove-made', catalogId: after.catalogId, ...(change.id ? { undoOf: change.id } : {}) } }
      case 'change': {
        const old = before.fields ?? {}
        const back: Args = {}
        if (typeof old.name === 'string' && 'name' in (after.fields ?? {})) back.name = old.name
        const sched = (k: 'schedule' | 'update_schedule', arg: string) => {
          const s = old[k] as FeedSchedule | null | undefined
          if (s && k in (after.fields ?? {}) && s.interval && s.url && metaPublicFetchUrlProblem(s.url) === null && metaScheduleProblem(JSON.stringify(s)) === null) {
            back[arg] = { interval: s.interval, url: s.url, ...(s.interval_count !== undefined ? { intervalCount: s.interval_count } : {}), ...(s.hour !== undefined ? { hour: s.hour } : {}), ...(s.minute !== undefined ? { minute: s.minute } : {}), ...(s.day_of_week ? { dayOfWeek: s.day_of_week } : {}), ...(s.day_of_month !== undefined ? { dayOfMonth: s.day_of_month } : {}), ...(s.timezone ? { timeZone: s.timezone } : {}) }
          }
        }
        sched('schedule', 'schedule'); sched('update_schedule', 'updateSchedule')
        for (const [k, arg] of [['default_currency', 'defaultCurrency'], ['delimiter', 'delimiter'], ['encoding', 'encoding'], ['quoted_fields_mode', 'quotedFieldsMode']] as const) {
          if (typeof old[k] === 'string' && k in (after.fields ?? {})) back[arg] = k === 'default_currency' ? old[k] : String(old[k]).toUpperCase() === 'AUTODETECT' && k === 'quoted_fields_mode' ? 'autodetect' : k === 'quoted_fields_mode' ? String(old[k]).toLowerCase() : String(old[k]).toUpperCase()
        }
        if (!Object.keys(back).length) return { refusal: `Nothing Nexus can send back: ${stays || 'the earlier values were empty.'}` }
        return { tool: 'set-meta-catalog-feed', args: { ...base, action: 'change', feedId: after.feedId, ...back } }
      }
      case 'labels': {
        const items = (before.items ?? []).map((i) => {
          const out: Args = { retailerId: i.sku }
          for (const [k, v] of Object.entries(i.fields)) {
            if (k === 'internal_label') out.internalLabels = Array.isArray(v) ? v : []
            const label = /^custom_label_([0-4])$/.exec(k)
            const number = /^custom_number_([0-4])$/.exec(k)
            if (label) out[`customLabel${label[1]}`] = typeof v === 'string' ? v : ''
            if (number) out[`customNumber${number[1]}`] = typeof v === 'number' ? v : null
          }
          return out
        }).filter((i) => Object.keys(i).length > 1)
        if (!items.length) return { refusal: `Nothing Nexus can send back: ${stays || 'the earlier labels were not readable.'}` }
        return { tool: 'set-meta-catalog-feed', args: { ...base, action: 'labels', feedId: after.feedId, via: (after as FeedRecord & { via?: string }).via === 'own-feed' ? 'own-feed' : 'shopify-feed', labelItems: items } }
      }
      case 'rules': {
        const removeRules = (after.rules ?? []).map((r) => r.ruleId).filter((id): id is string => !!id)
        // Review A-F6 — never a silent drop: a removed rule Nexus cannot make again refuses the whole undo, said.
        const lost = (before.rules ?? []).filter((r) => !ruleArgOf(r))
        if (lost.length) return { refusal: `This change removed ${lost.map((r) => `rule ${r.ruleId ?? '?'} (${r.ruleType ?? '?'} on ${r.attribute ?? '?'})`).join(', ')}, whose params Nexus does not send: undo cannot put ${lost.length === 1 ? 'it' : 'them'} back (Commerce Manager can).` }
        const addRules = (before.rules ?? []).map(ruleArgOf).filter((r): r is Args => !!r)
        if (!removeRules.length && !addRules.length) return { refusal: 'Nothing Nexus can put back: the rules this change made have no id Meta answered.' }
        return { tool: 'set-meta-catalog-feed', args: { ...base, action: 'rules', feedId: after.feedId, ...(removeRules.length ? { removeRules } : {}), ...(addRules.length ? { addRules } : {}) } }
      }
      case 'remove-made': return { refusal: 'This change deleted a feed an earlier change made: a deletion on Meta is final.' }
      case 'error-report': return { refusal: 'An error report changes nothing in the catalog: there is nothing to undo.' }
      case 'upload-schedule': return { refusal: 'Meta documents no way to remove an upload schedule through the API: Commerce Manager removes it.' }
      case 'upload': return { refusal: 'An upload has no undo: Meta keeps no earlier file (upload the earlier values again).' }
      default: return { refusal: stays || 'This change has no undo.' }
    }
  },
}

const setMetaCatalogFeed: AgentTool = {
  ...common,
  name: 'set-meta-catalog-feed',
  title: 'Change Meta catalog feeds',
  consequencesFor: (args) => (['upload', 'upload-schedule', 'error-report', 'remove-made'].includes(String(args.action)) || args.deletionEnabledOn === true ? { reversibility: 'none' } : null),
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(FEED_ACTIONS).describe('create | change (a feed Nexus made) | labels (D7 columns, update-only) | upload (a file of items, or a public address, to a feed Nexus made) | rules | upload-schedule | error-report | remove-made (ONLY the undo of an earlier create)'),
    catalogId: metaIdArg('the catalog (meta-catalogs view list)'),
    feedId: metaIdArg('the feed (meta-catalog-feeds view list)').optional(),
    kind: z.enum(FEED_KINDS).optional().describe('create: products | supplementary (Nexus\'s own, for labels) | offers | ratings | local-inventory | country | language | language-and-country'),
    name: typedText(META_FEED_NAME_MAX).optional().describe('create, change: the feed\'s name'),
    schedule: scheduleArg('create, change: a full-replace fetch (each fetch replaces the feed\'s items with the file)').optional(),
    updateSchedule: scheduleArg('create, change: an update-only fetch (adds and updates, never deletes)').optional(),
    country: countryArg.optional().describe('create: where the items can be sold (Meta\'s default US); not changeable later'),
    defaultCurrency: currencyArg.optional().describe('create, change: the currency of prices without one (Meta\'s default USD)'),
    deletionEnabled: z.boolean().optional().describe('create (required for a feed of items): true = a full upload deletes items missing from the file — ONE-WAY, never off again'),
    deletionEnabledOn: z.literal(true).optional().describe('change: turn deletion on — ONE-WAY (Meta never turns it off again): only when the person asked'),
    delimiter: z.enum(META_FEED_DELIMITERS).optional().describe('the file\'s delimiter'),
    encoding: z.enum(META_FEED_ENCODINGS).optional().describe('the file\'s encoding'),
    quotedFieldsMode: z.enum(META_FEED_QUOTED).optional().describe('TSV only: whether fields are quoted'),
    itemSubType: z.enum(META_ITEM_SUB_TYPES).optional().describe('create: Meta\'s sub vertical of the feed\'s items'),
    migratedFromFeedId: metaIdArg('create, change: a feed Nexus made whose items this feed takes over (a split)').optional(),
    primaryFeedIds: z.array(metaIdArg('a primary data source of the catalog (meta-catalogs view data-sources)')).min(1).max(MAX_PRIMARY_FEEDS).optional().describe('create kind supplementary: the primary sources it adds labels to (set for good: Meta changes no link)'),
    rules: z.array(ruleArg).min(1).max(MAX_FEED_RULES).optional().describe('create: rules applied to the feed\'s uploads'),
    via: z.enum(['shopify-feed', 'own-feed']).optional().describe('labels: shopify-feed (an update-only file to the feed that brings the items) | own-feed (Nexus\'s own supplementary feed)'),
    labelItems: z.array(labelsItemArg).min(1).max(MAX_ITEMS_PER_CHANGE).optional().describe(`labels: at most ${MAX_ITEMS_PER_CHANGE} items, each its retailerId and the D7 columns`),
    rows: z.array(itemArg).min(1).max(MAX_ITEMS_PER_CHANGE).optional().describe('upload: the items of the file Nexus makes (a feed Nexus made)'),
    url: z.string().trim().max(2000).refine((v) => metaPublicFetchUrlProblem(v) === null, 'a public https address with no key in it').optional().describe('upload: a public https address of a file Meta fetches once'),
    updateOnly: z.boolean().optional().describe('upload: true adds and updates only; false REPLACES the feed\'s items'),
    replaceAll: z.literal(true).optional().describe('upload with updateOnly false: true ONLY when the person asked to replace the feed\'s items'),
    addRules: z.array(ruleArg).min(1).max(MAX_FEED_RULES).optional().describe('rules: rules to add'),
    removeRules: z.array(metaIdArg('a rule of the feed (meta-catalog-feeds view rules)')).min(1).max(MAX_FEED_RULES).optional().describe('rules: rules to remove'),
    changeRules: z.array(z.object({ ruleId: metaIdArg('a rule of the feed'), rule: ruleArg })).min(1).max(MAX_FEED_RULES).optional().describe('rules: rules to change (removed, then made again: Meta documents no update)'),
    uploadId: metaIdArg('error-report: the upload (meta-catalog-feeds view uploads)').optional(),
    linkPrimaryFeeds: z.unknown().optional().describe('not offered: a supplementary feed\'s links are set at create (the answer says how to change them)'),
    undoOf: z.string().trim().min(1).max(64).optional().describe('remove-made: the id of the change undone (its record names the feed it made)'),
    why: metaWhyArg,
  }),
  description:
    'Feeds of one of the business\'s Meta catalogs. D7: on a catalog Shopify (or a partner) writes, Nexus adds ONLY the D7 '
    + 'columns (internal_label, custom_label_0–4, custom_number_0–4): action labels sends an UPDATE-ONLY file (id + those '
    + 'columns) to the Shopify feed or to Nexus\'s own supplementary feed (create kind supplementary: it adds fields, never an '
    + 'item), and rules may change those columns only. Everything that brings items — a primary, offers, ratings & reviews '
    + '(only real reviews; stars in ads are not promised), local inventory or country / language override feed, its '
    + 'schedules and settings, a file of items Nexus makes or a public address, an update-only upload schedule, rules on '
    + 'other fields — only on a catalog Nexus may write items in or writes alone, and only on feeds Nexus made. deletion is '
    + 'always sent and ONE-WAY (never off again); a full upload replaces the feed\'s items. An upload\'s full error report '
    + 'changes nothing. Undo deletes a feed it made, puts settings, labels and rules back; uploads and upload schedules '
    + 'have no undo (said). A feed\'s country, type and source type cannot change; a supplementary feed\'s links are set at '
    + 'create.'
    + META_CHANGE_RULES,
  undo: feedUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildFeed(args, ctx)),
  execute: (args, ctx) => {
    // A labels record names the way it went (its undo goes the same way).
    return runMetaChange(args, ctx, buildFeed(args, ctx), (draft, done) => {
      const out = feedFinish(draft, done)
      if ((draft.after as FeedRecord).op === 'labels') out.after = { ...(out.after as FeedRecord), via: args.via === 'own-feed' ? 'own-feed' : 'shopify-feed' } as FeedRecord
      return out
    })
  },
}

// ── set-meta-instagram-product-tags ─────────────────────────────────────────────────────────────────────────────────

const TAG_ACTIONS = ['tag', 'appeal', 'new-post', 'remove'] as const

const buildTags = (args: Args): MetaDraftBuilder => guarded(async (account) => {
  const action = String(args.action)
  if (action === 'new-post') return { refusal: NEW_POST_TAGS }
  if (action === 'remove') return { refusal: TAG_REMOVE_NOT_AVAILABLE }
  const allowed: Record<string, string[]> = { tag: ['mediaId', 'slideId', 'tags'], appeal: ['rejectedProductId', 'reason'] }
  const extra = onlyArgs(args, action, allowed[action] ?? [])
  if (extra) return { refusal: extra }
  const chosen = await chosenOf(account)
  const instagramId = instagramOf(chosen)
  if (action === 'appeal') {
    if (typeof args.rejectedProductId !== 'string' || typeof args.reason !== 'string') return { refusal: 'Name the rejected product (rejectedProductId: Meta\'s product id) and why it should be approved (reason).' }
    const product = await liveIgProduct(chosen, args.rejectedProductId)
    const catalogs = await liveIgTagCatalogs(chosen)
    if (!catalogs.has(product.catalogId)) return { refusal: `Product ${product.productId} is not in a catalog the chosen Instagram account tags from (meta-instagram-product-tags view catalogs).` }
    return appealDraft({ instagramId, product, state: await liveIgAppealState(chosen, product.productId), reason: args.reason })
  }
  const tags = (args.tags ?? []) as MetaIgProductTag[]
  if (typeof args.mediaId !== 'string' || !tags.length) return { refusal: 'Name the post (mediaId: meta-instagram-media view media) and the tags (productId, and x / y on a photo).' }
  if (new Set(tags.map((t) => t.productId)).size !== tags.length) return { refusal: 'tags names each product once (Meta: tags and product ids are unique).' }
  const mayTag = await liveIgMayTag(chosen)
  if (mayTag === false) return { refusal: 'This Instagram account may not tag products: Meta finds no approved Instagram Shop linked to it (Creator accounts cannot tag).' }
  const post = await liveIgTagPost(chosen, args.mediaId, typeof args.slideId === 'string' ? args.slideId : null)
  const placed = post.target === 'image' || post.target === 'carousel-image'
  if (placed && tags.some((t) => !metaIgCoordinateOk(t.x) || !metaIgCoordinateOk(t.y))) return { refusal: 'On a photo every tag has its place: x and y from 0 to 1 (at most 4 decimals), from the top-left (Meta needs both).' }
  if (!placed && tags.some((t) => t.x !== undefined || t.y !== undefined)) return { refusal: 'A video or a Reel takes tags without a place (x and y are for photos only).' }
  const catalogs = await liveIgTagCatalogs(chosen)
  const products = new Map<string, IgProduct>()
  for (const t of tags) {
    const product = await liveIgProduct(chosen, t.productId)
    if (!catalogs.has(product.catalogId)) return { refusal: `Product ${t.productId} is not in a catalog the chosen Instagram account tags from that this business may read (meta-instagram-product-tags view catalogs).` }
    products.set(product.productId, product)
  }
  const draft = tagDraft({ post, asked: tags.map((t) => ({ productId: t.productId, ...(placed ? { x: t.x, y: t.y } : {}) })), products, taggedToday: await taggedPostsLastDay(instagramId), instagramId })
  if (!mayTag && 'warnings' in draft) draft.warnings.unshift('Meta did not say whether this account may tag products (shopping_product_tag_eligibility): its answer decides.')
  return draft
})

function tagsFinish(draft: MetaChangeDraft, done: Done) {
  const after = draft.after as IgTagsRecord | { op: 'appeal' }
  if (after.op === 'appeal') return { data: { appealed: done[0].request.params.product_id, note: 'Meta answers an appeal with success only: meta-instagram-product-tags view appeal shows its state later.' }, before: draft.before, after: draft.after, noUndo: 'An appeal cannot be withdrawn: there is no undo.' }
  return { data: { mediaId: after.mediaId, targetId: after.targetId, added: after.added, moved: after.moved.map((m) => m.productId) }, before: draft.before, after: draft.after, ...(after.added.length && !after.moved.length ? { noUndo: 'Meta cannot remove a product tag through its API: the tags added stay until a person removes them in the Instagram app.' } : {}) }
}

const tagsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as IgTagsRecord & { accountId?: string }
    const account = await recordAccount(after)
    if (!account || after.op !== 'tag') return account ? after : null
    try {
      const chosen = await chosenOf(account)
      const post = await liveIgTagPost(chosen, after.mediaId, after.targetId !== after.mediaId ? after.targetId : null)
      if (!post.tagsNow) return after
      // Meta reads a place back as a 32-bit float (0.8 → 0.800000011920929): rounded to the 4 decimals Nexus sent and recorded.
      return { ...after, moved: after.moved.map((m) => { const t = post.tagsNow!.get(m.productId); return { productId: m.productId, x: t ? four(t.x) : null, y: t ? four(t.y) : null } }) }
    } catch (err) {
      if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as IgTagsRecord
    const after = (change.after ?? {}) as IgTagsRecord & { accountId?: string }
    if ((after as { op?: string }).op === 'appeal') return { refusal: 'An appeal cannot be withdrawn: there is no undo.' }
    const back = (before.moved ?? []).filter((m) => (after.target === 'image' || after.target === 'carousel-image') && m.x !== null && m.y !== null)
    if (!back.length) return { refusal: TAG_REMOVE_NOT_AVAILABLE }
    return {
      tool: 'set-meta-instagram-product-tags',
      args: { ...head(after, after.added?.length ? 'undo of an earlier set-meta-instagram-product-tags change: move the moved tags back (the added ones stay: Meta cannot remove a tag by API)' : 'undo of an earlier set-meta-instagram-product-tags change: move the tags back'), action: 'tag', mediaId: after.mediaId, ...(after.targetId !== after.mediaId ? { slideId: after.targetId } : {}), tags: back.map((m) => ({ productId: m.productId, x: m.x, y: m.y })) },
    }
  },
}

const setMetaInstagramProductTags: AgentTool = {
  ...common,
  name: 'set-meta-instagram-product-tags',
  title: 'Tag products on Instagram posts',
  consequencesFor: (args) => (args.action === 'appeal' ? { reversibility: 'none' } : null),
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(TAG_ACTIONS).describe('tag (add or move product tags on a published post) | appeal (a product Meta rejected for tagging) | new-post / remove (answered: what to use instead)'),
    mediaId: metaIdArg('tag: the post of the chosen Instagram account (meta-instagram-media view media)').optional(),
    slideId: metaIdArg('tag, a carousel: the slide (meta-instagram-product-tags view tags with slides)').optional(),
    tags: z.array(z.object({
      productId: metaIdArg('the product (meta-instagram-product-tags view search)'),
      x: z.number().min(0).max(1).optional().describe('a photo: from the left, 0–1 (required on a photo)'),
      y: z.number().min(0).max(1).optional().describe('a photo: from the top, 0–1 (required on a photo)'),
    })).min(1).max(META_IG_TAG_LIMITS.reel).optional().describe(`tag: the tags (a product already tagged moves; Meta: ${META_IG_TAG_LIMITS.feedPost} on a post, ${META_IG_TAG_LIMITS.carouselSlide} a carousel slide, ${META_IG_TAG_LIMITS.reel} on a Reel)`),
    // Not `productId`: that name is a Nexus product in every tool (the deleted-product check reads the registry).
    rejectedProductId: metaIdArg('appeal: the rejected product (Meta\'s product id)').optional(),
    reason: z.string().trim().min(1).max(META_IG_APPEAL_REASON_MAX).regex(META_NAME_TEXT, 'no control or format characters').optional().describe('appeal: why the product should be approved (Meta reads it)'),
    why: metaWhyArg,
  }),
  description:
    'Product tags on a PUBLISHED post of the business\'s chosen Instagram account (a photo or video post, one slide of a '
    + 'carousel, a Reel): add tags of products from a catalog the account tags from (and this business may read), or move a '
    + 'tag that is there (Meta\'s tagging is additive: a product already tagged moves). Meta\'s limits: 20 tags on a post, '
    + '5 on a carousel slide (20 per carousel), 30 on a Reel, x / y only on photos, 25 tagged posts per account in 24 hours; '
    + 'no Stories, Live or Creator accounts; a product not yet approved is tagged but does not show until approved. Tags '
    + 'show on the public post at once. Meta cannot remove a tag through its API (the Instagram app does): undo moves moved '
    + 'tags back and says the added ones stay. appeal: ask Meta to review a rejected product again (answered with success '
    + 'only; it cannot be withdrawn). Meta: since 2023-08-10 some businesses without checkout-enabled Shops can no longer tag '
    + 'products (its eligibility read decides). Tags on a NEW post go with create-meta-instagram-post (productTags).'
    + META_CHANGE_RULES,
  undo: tagsUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildTags(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildTags(args), tagsFinish),
}

export const META_ADS_CATALOG_ITEMS_TOOLS: AgentTool[] = [setMetaCatalogItems, setMetaCatalogFeed, setMetaInstagramProductTags]

/** For the tests: the conversions the tools use. */
export const __catalogItemsTest = { itemFieldsOf, argsOfFields, labelsOf, ruleOf, ruleArgOf, scheduleOf }
