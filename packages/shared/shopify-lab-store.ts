/**
 * A made-up Shopify store for the pop-up lab (/design/shopify-popup) and the Shopify tests (Lane B, slice B0;
 * docs/shopify-metafields/PLAN-2026-09-28.md §8).
 *
 * The repository is PUBLIC: every name, handle, picture and id here is invented. Ids keep Shopify's `gid://shopify/…`
 * shape so the real validation code accepts them, with small numbers no real store uses (a test pins ≤ 4 digits).
 * The one exception is Shopify's own standard entry kind `shopify--color-pattern` (Shopify's name, not a store's).
 *
 * Three parts:
 *   1. One product field per Shopify type (all 118 of `SHOPIFY_TYPE_CATALOG`), with rules that use what the type supports.
 *   2. A mirror of a real store's 39 fields and 23 entry kinds by TYPE and RULE only (the names are made up).
 *   3. The things fields point to: products, variants, collections, pages, articles, customers, companies, orders, files,
 *      taxonomy values and entries — plus, per type, a good value, bad values (one per rule) and odd old values.
 */
import type { ShopifyFieldDefinition, ShopifyMetaobjectDefinition, ShopifyReference, ShopifyStoreSchema } from './shopify-linked-products.js'
import { shopifyMeasurementUnits } from './shopify-field-codecs.js'
import { SHOPIFY_TYPE_CATALOG, shopifyBaseType } from './shopify-type-catalog.js'

export const labGid = (resource: string, n: number | string) => `gid://shopify/${resource}/${n}`
const ACCESS = { admin: 'MERCHANT_READ_WRITE', storefront: 'PUBLIC_READ' }

/* ── Pictures: drawn shapes with no text inside, so nothing falls back to a system font. ── */

/** A drawn garment outline. */
export const labPicture = (seed: string, ink = 'black') => {
  const n = [...seed].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 3 + 1
  const stripes = Array.from({ length: n }, (_, i) => `<rect x="70" y="${90 + i * 40}" width="60" height="14" rx="7" fill="${ink}"/>`).join('')
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/><path d="M60 40 L140 40 L170 80 L150 90 L150 170 L50 170 L50 90 L30 80 Z" fill="none" stroke="${ink}" stroke-width="6"/>${stripes}</svg>`)}`
}
/** A drawn icon: a ring with a dot. */
export const labIcon = (seed: string) => {
  const r = 20 + ([...seed].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 30)
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="white"/><circle cx="50" cy="50" r="40" fill="none" stroke="black" stroke-width="6"/><circle cx="50" cy="50" r="${r / 2}" fill="black"/></svg>`)}`
}

/* ── 3a. Things fields point to (names and pictures for pickers and cells). ── */

const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const resource = (resourceName: string, n: number, label: string, image: string | null = null, extra: Partial<ShopifyReference> = {}): ShopifyReference =>
  ({ id: labGid(resourceName, n), label, image, type: resourceName, handle: slug(label), available: true, ...extra })

export const LAB_PRODUCTS: ShopifyReference[] = ['Sample Jacket', 'Sample Jacket · Grey', 'Sample Jacket · Olive', 'Sample Pant', 'Sample Vest', 'Sample Gloves', 'Sample Boots', 'Sample Suit']
  .map((label, i) => resource('Product', 900 + i, label, labPicture(label, i % 2 ? 'dimgray' : 'black')))
export const LAB_VARIANTS: ShopifyReference[] = ['S', 'M', 'L', 'XL']
  .map((size, i) => resource('ProductVariant', 950 + i, `Sample Jacket / ${size}`, labPicture('Sample Jacket'), { handle: undefined }))
export const LAB_COLLECTIONS: ShopifyReference[] = ['Jackets', 'Gloves', 'New in'].map((label, i) => resource('Collection', 60 + i, label, labPicture(label, 'navy')))
export const LAB_PAGES: ShopifyReference[] = ['Size guide (jackets)', 'Size guide (gloves)', 'Care and repair'].map((label, i) => resource('Page', 70 + i, label))
export const LAB_ARTICLES: ShopifyReference[] = ['How to measure', 'Wash guide'].map((label, i) => resource('Article', 80 + i, label))
export const LAB_CUSTOMERS: ShopifyReference[] = ['Sample Customer A', 'Sample Customer B'].map((label, i) => resource('Customer', 40 + i, label, null, { handle: undefined }))
export const LAB_COMPANIES: ShopifyReference[] = [resource('Company', 30, 'Sample Company', null, { handle: undefined })]
export const LAB_ORDERS: ShopifyReference[] = ['#1001', '#1002'].map((label, i) => resource('Order', 20 + i, label, null, { handle: undefined }))
/** Files keep Shopify's kinds: `MediaImage` (Image), `Video`, `GenericFile` (a PDF). Their name is the alt text. */
export const LAB_FILES: ShopifyReference[] = [
  ...['Size chart (IT)', 'Size chart (DE)', 'Care label', 'Detail photo'].map((label, i) => resource('MediaImage', 700 + i, label, labPicture(label, 'navy'), { handle: undefined })),
  ...['Fit video', 'Rain test video'].map((label, i) => resource('Video', 720 + i, label, labPicture(label, 'teal'), { handle: undefined })),
  resource('GenericFile', 740, 'Size table (PDF)', null, { handle: undefined }),
]
/** Taxonomy values carry the attribute they belong to (`color` / `pattern`), as Shopify's category Color entries need. */
export const LAB_TAXONOMY_VALUES: Array<ShopifyReference & { attribute: 'color' | 'pattern' }> = [
  ...['Beige', 'Black', 'Blue', 'Brown', 'Gold', 'Gray', 'Green', 'Navy', 'Orange', 'Pink', 'Red', 'White', 'Yellow']
    .map((label, i) => ({ ...resource('TaxonomyValue', 9001 + i, label, null, { handle: undefined }), attribute: 'color' as const })),
  ...['Solid', 'Striped', 'Camouflage', 'Floral']
    .map((label, i) => ({ ...resource('TaxonomyValue', 9101 + i, label, null, { handle: undefined }), attribute: 'pattern' as const })),
]
const taxonomy = (label: string) => LAB_TAXONOMY_VALUES.find(value => value.label === label)!.id
export const LAB_CATEGORIES = [labGid('TaxonomyCategory', 'lab-1'), labGid('TaxonomyCategory', 'lab-2')]

/* ── 2a. Entry kinds: a mirror of a real store's 23 kinds (field types, required, file limits), plus one for disclosures. ── */

const IMAGE = '["Image"]', IMAGE_VIDEO = '["Image","Video"]', VIDEO = '["Video"]'
type FieldSpec = [key: string, name: string, type: string, rules?: Array<[string, string]>, required?: boolean]
const kindDefinition = (n: number, type: string, name: string, fields: FieldSpec[], publishable = true): ShopifyMetaobjectDefinition => {
  const id = labGid('MetaobjectDefinition', n)
  return { id, name, type, description: null, access: ACCESS, publishable, fields: fields.map(([key, fieldName, fieldType, rules = [], required = false]) => ({
    id: `${id}/${key}`, name: fieldName, description: null, namespace: type, key, ownerType: 'METAOBJECT', type: fieldType,
    validations: rules.map(([rule, value]) => ({ name: rule, value })), access: ACCESS, required, readOnlyReason: null,
  })) }
}
const file = (key: string, name: string, limit?: string, required = false): FieldSpec => [key, name, 'file_reference', limit ? [['file_type_options', limit]] : [], required]
const text = (key: string, name: string, required = false): FieldSpec => [key, name, 'single_line_text_field', [], required]
const long = (key: string, name: string): FieldSpec => [key, name, 'multi_line_text_field']
const colour = (key: string, name: string): FieldSpec => [key, name, 'color']
const web = (key: string, name: string): FieldSpec => [key, name, 'url']
const bannerFields = (limit?: string): FieldSpec[] => [file('image', 'Image', limit), file('custom_icon', 'Custom icon', limit), text('subheading', 'Subheading'), text('heading', 'Heading'),
  long('content', 'Content'), text('button_text', 'Button text'), web('button_url', 'Button URL'), colour('background', 'Background'), colour('text', 'Text'),
  colour('button_background', 'Button background'), colour('button_text_color', 'Button text colour')]

export const LAB_ENTRY_KINDS: ShopifyMetaobjectDefinition[] = [
  kindDefinition(1, 'shopify--color-pattern', 'Color', [
    ['label', 'Label', 'single_line_text_field', [['max', '255']], true], colour('color', 'Color'), file('image', 'Image', IMAGE),
    ['color_taxonomy_reference', 'Base color', 'list.product_taxonomy_value_reference', [['product_taxonomy_attribute_handle', 'color'], ['list.min', '1'], ['list.max', '4']], true],
    ['pattern_taxonomy_reference', 'Base pattern', 'product_taxonomy_value_reference', [['product_taxonomy_attribute_handle', 'pattern']], true],
  ], false),
  kindDefinition(2, 'lab_highlights', 'Highlights', [file('image', 'Image', IMAGE_VIDEO), text('title', 'Title'), long('description', 'Description')]),
  kindDefinition(3, 'lab_short_text', 'Short text', [long('text', 'Text')]),
  kindDefinition(4, 'lab_summary', 'Short summary', [long('text', 'Text')]),
  kindDefinition(5, 'lab_icon_text', 'Icon with text', [file('image', 'Icon', IMAGE_VIDEO), text('heading', 'Heading'), long('content', 'Content')]),
  kindDefinition(6, 'lab_media_text', 'Media and text', [file('image', 'Image', IMAGE_VIDEO, true), ...bannerFields(IMAGE_VIDEO).slice(1)]),
  kindDefinition(7, 'lab_heading', 'Heading', [text('heading', 'Heading')]),
  kindDefinition(8, 'lab_ticker', 'Ticker text', [text('text', 'Text'), colour('background', 'Background'), colour('text_color', 'Text colour')]),
  kindDefinition(9, 'lab_video', 'Video block', [file('video', 'Video', VIDEO), file('mobile_video', 'Mobile video', VIDEO), colour('text_color', 'Text colour'), colour('overlay', 'Overlay'), text('text', 'Text')]),
  kindDefinition(10, 'lab_press', 'Press quote', [file('logo', 'Logo', IMAGE_VIDEO), text('author', 'Author'), text('quote', 'Quote')]),
  kindDefinition(11, 'lab_image_grid_text', 'Image grid with text', [file('image', 'Image', IMAGE_VIDEO, true), text('subheading', 'Subheading'), text('heading', 'Heading', true),
    long('content', 'Content'), web('button_url', 'Button URL'), text('button_text', 'Button text')]),
  kindDefinition(12, 'lab_media_grid', 'Media grid', [file('image', 'Image', IMAGE_VIDEO), text('heading', 'Heading'), web('link_url', 'Link URL'), text('link_text', 'Link text'),
    colour('background', 'Background'), colour('text', 'Text'), colour('button_background', 'Button background'), colour('button_text', 'Button text'), colour('overlay', 'Overlay')]),
  kindDefinition(13, 'lab_slideshow', 'Slideshow', [file('image', 'Image', IMAGE_VIDEO), file('mobile_image', 'Mobile image', IMAGE_VIDEO), text('subheading', 'Subheading'), text('heading', 'Heading'),
    text('button_text', 'Button text'), web('button_link', 'Button link'), colour('text', 'Text'), colour('button_background', 'Button background'), colour('button_text_color', 'Button text colour'), colour('overlay', 'Overlay')]),
  kindDefinition(14, 'lab_collection_banner', 'Collection banner', [file('image', 'Image', IMAGE_VIDEO), file('mobile_image', 'Mobile image', IMAGE_VIDEO), text('heading', 'Heading'),
    ['product', 'Product', 'product_reference'], colour('text', 'Text'), colour('overlay', 'Overlay')]),
  kindDefinition(15, 'lab_fold_out', 'Fold-out text', [file('icon', 'Icon', IMAGE_VIDEO), text('title', 'Title'), long('content', 'Content')]),
  kindDefinition(16, 'lab_team', 'Team', bannerFields(IMAGE_VIDEO)),
  kindDefinition(17, 'lab_faq', 'FAQ', [text('question', 'Question'), text('answer', 'Answer')]),
  kindDefinition(18, 'lab_size_guide', 'Size guide', bannerFields(IMAGE_VIDEO)),
  kindDefinition(19, 'lab_community', 'Community block', [...bannerFields(), colour('background_gradient', 'Background gradient')]),
  kindDefinition(20, 'lab_banner_images', 'Banner images', [file('image', 'Image', IMAGE), file('mobile_image', 'Mobile image', IMAGE)]),
  kindDefinition(21, 'lab_shortcuts', 'Shortcuts and lists', [text('subheading', 'Section subheading'), text('section_heading', 'Section heading'), text('section_content', 'Section content'),
    web('link_url', 'Link URL'), text('link_text', 'Link text'), file('avatar', 'Avatar', IMAGE), text('author', 'Author'), text('heading', 'Heading'), long('content', 'Content')]),
  kindDefinition(22, 'lab_button', 'Button', [web('link', 'Link'), text('text', 'Text'), colour('background', 'Background'), colour('text_color', 'Text colour')]),
  kindDefinition(23, 'lab_facts', 'Knowledge facts', [['external_id', 'External ID', 'id'], ['published', 'Published', 'boolean', [], true],
    ['category', 'Category', 'single_line_text_field', [['choices', '["basic","shipping","returns"]']]], text('title', 'Title', true), long('value_text', 'Value'),
    ['value_list', 'Value list', 'list.single_line_text_field'], ['value_flag', 'Yes or no value', 'boolean']], false),
  /* Not a mirror: Shopify's disclosure fields pick only `shopify--disclosure-…` kinds, so the lab needs one (made up). */
  kindDefinition(24, 'shopify--disclosure-lab', 'Disclosure (made up)', [text('text', 'Text', true)], false),
]
export const labKind = (type: string) => LAB_ENTRY_KINDS.find(kind => kind.type === type)!

/* ── 3b. Entries. ── */

export interface LabEntry { id: string; type: string; handle: string; name: string; status: 'ACTIVE' | 'DRAFT' | null; fields: Record<string, string | null>; image?: string | null; swatch?: string | null }
const entry = (n: number, type: string, name: string, fields: Record<string, string | null>, look: { image?: string | null; swatch?: string | null } = {}): LabEntry =>
  ({ id: labGid('Metaobject', n), type, handle: slug(name), name, status: labKind(type).publishable ? 'ACTIVE' : null, fields, ...look })
const COLOURS: Array<[string, string, string]> = [['Green', '#3c9a4b', 'Green'], ['Black', '#111111', 'Black'], ['Beige', '#e6d8b0', 'Beige'], ['Blue', '#2458d6', 'Blue'],
  ['Bronze', '#b8733a', 'Brown'], ['Brown', '#7a4a2a', 'Brown'], ['Clear', '#ffffff', 'White'], ['Gold', '#caa03a', 'Gold'], ['Gray', '#8a8a8a', 'Gray'], ['Navy', '#232a8f', 'Navy'],
  ['Orange', '#e8742a', 'Orange'], ['Pink', '#e58fb3', 'Pink'], ['Purple', '#7a3fb0', 'Pink'], ['Red', '#c8312f', 'Red'], ['White', '#fafafa', 'White'], ['Yellow', '#e9c92e', 'Yellow']]
const photo = (n: number) => LAB_FILES[n % 4].id

export const LAB_ENTRIES: LabEntry[] = [
  ...COLOURS.map(([label, hex, base], i) => entry(100 + i, 'shopify--color-pattern', label,
    { label, color: hex, image: null, color_taxonomy_reference: JSON.stringify([taxonomy(base)]), pattern_taxonomy_reference: taxonomy('Solid') }, { swatch: hex })),
  ...['Water-repellent', 'Regular fit', 'Air vents', 'Tough fabric'].map((label, i) => entry(200 + i, 'lab_icon_text', label,
    { image: photo(i), heading: label, content: `${label}: made-up text for the lab.` }, { image: labIcon(label) })),
  ...['Moss', 'Airmesh', 'Ventra', 'Classic'].map((label, i) => entry(300 + i, 'lab_summary', label, { text: `${label} — a short made-up summary.\nSecond line.` })),
]
/* Two made-up entries for every other kind, with every required field filled. */
for (const [k, kind] of LAB_ENTRY_KINDS.entries()) {
  if (['shopify--color-pattern', 'lab_icon_text', 'lab_summary'].includes(kind.type)) continue
  for (const i of [0, 1]) {
    const name = `${kind.name} ${i + 1}`
    const fields: Record<string, string | null> = {}
    for (const field of kind.fields) {
      const base = shopifyBaseType(field.type)
      const limit = field.validations.find(rule => rule.name === 'file_type_options')?.value
      fields[field.key] = field.type === 'list.single_line_text_field' ? JSON.stringify(['one', 'two'])
        : base === 'single_line_text_field' ? (field.validations.some(rule => rule.name === 'choices') ? 'basic' : `${field.name} ${i + 1}`)
        : base === 'multi_line_text_field' ? `${field.name} ${i + 1}: made-up text.`
        : base === 'color' ? (i ? '#232a8f' : '#e8742a')
        : base === 'url' ? `https://example.com/${slug(name)}`
        : base === 'file_reference' ? (limit === VIDEO ? LAB_FILES[4 + i].id : photo(i + k))
        : base === 'product_reference' ? LAB_PRODUCTS[i].id
        : base === 'boolean' ? (i ? 'false' : 'true')
        : base === 'id' ? `LAB-${k}-${i}`
        : null
    }
    LAB_ENTRIES.push(entry(400 + k * 10 + i, kind.type, name, fields, { image: kind.fields.some(f => f.type === 'file_reference') ? labPicture(name, 'navy') : null }))
  }
}

/** An entry as a reference (a picker row, a cell chip). */
export const labEntryReference = (e: LabEntry): ShopifyReference => ({ id: e.id, label: e.name, image: e.image ?? null, ...(e.swatch ? { swatch: e.swatch } : {}), type: e.type, handle: e.handle, available: true })

/** Every reference the made-up store holds. */
export const labReferences = (entries: readonly LabEntry[] = LAB_ENTRIES): ShopifyReference[] => [
  ...entries.map(labEntryReference), ...LAB_PRODUCTS, ...LAB_VARIANTS, ...LAB_COLLECTIONS, ...LAB_PAGES, ...LAB_ARTICLES, ...LAB_CUSTOMERS, ...LAB_COMPANIES, ...LAB_ORDERS,
  ...LAB_FILES, ...LAB_TAXONOMY_VALUES.map(({ attribute: _attribute, ...value }) => value),
]

/* ── 1. One product field per Shopify type. ── */

const definition = (n: number, namespace: string, key: string, name: string, type: string, rules: Array<[string, string]>, ownerType = 'PRODUCT', extra: Partial<ShopifyFieldDefinition> = {}): ShopifyFieldDefinition =>
  ({ id: labGid('MetafieldDefinition', n), name, description: null, namespace, key, ownerType, type, validations: rules.map(([rule, value]) => ({ name: rule, value })), access: ACCESS, ...extra })

const bound = (unit: string, value: number) => JSON.stringify({ unit, value })
/** The rules a lab field of each base type carries — only rules that type supports (checked by a test). */
const ITEM_RULES: Record<string, Array<[string, string]>> = {
  single_line_text_field: [['min', '2'], ['max', '40']],
  multi_line_text_field: [['max', '500']],
  number_integer: [['min', '0'], ['max', '999']],
  number_decimal: [['min', '0'], ['max', '100'], ['max_precision', '2']],
  date: [['min', '2020-01-01'], ['max', '2030-12-31']],
  date_time: [['min', '2020-01-01T00:00:00'], ['max', '2030-12-31T23:59:59']],
  url: [['allowed_domains', '["example.com"]']],
  link: [['allowed_domains', '["example.com"]']],
  rating: [['scale_min', '1.0'], ['scale_max', '5.0']],
  json: [['schema', JSON.stringify({ type: 'object', required: ['fit'], properties: { fit: { type: 'string' } } })]],
  id: [['max', '20']],
  dimension: [['min', bound('cm', 1)], ['max', bound('m', 3)]],
  weight: [['min', bound('g', 10)], ['max', bound('kg', 25)]],
  volume: [['min', bound('ml', 5)], ['max', bound('l', 20)]],
  file_reference: [['file_type_options', IMAGE]],
  product_taxonomy_value_reference: [['product_taxonomy_attribute_handle', 'pattern']],
  metaobject_reference: [['metaobject_definition_id', labKind('lab_summary').id]],
  mixed_reference: [['metaobject_definition_ids', JSON.stringify([labKind('lab_faq').id, labKind('lab_press').id])]],
  disclosure_reference: [['metaobject_definition_types', '["shopify--disclosure-lab"]']],
}
const LIST_RULES: Record<string, Array<[string, string]>> = {
  file_reference: [['file_type_options', IMAGE_VIDEO], ['list.max', '6']],
  product_taxonomy_value_reference: [['product_taxonomy_attribute_handle', 'color'], ['list.min', '1'], ['list.max', '4']],
  metaobject_reference: [['metaobject_definition_id', labKind('lab_icon_text').id], ['list.max', '5']],
  rating: [...ITEM_RULES.rating, ['list.max', '3']],
}
const typeRules = (type: string): Array<[string, string]> => {
  const base = shopifyBaseType(type)
  if (!type.startsWith('list.')) return ITEM_RULES[base] ?? []
  return LIST_RULES[base] ?? [...(ITEM_RULES[base] ?? []), ['list.max', '5']]
}
const typeLabel = (type: string) => {
  const base = shopifyBaseType(type).replace(/_reference$/, ' reference').replace(/_field$/, '').replace(/_/g, ' ')
  const name = base.charAt(0).toUpperCase() + base.slice(1)
  return type.startsWith('list.') ? `List of ${base}` : name
}
/** Field key for a type: `list.weight` → `type_list_weight`. */
export const labTypeKey = (type: string) => `type_${type.replace(/\./g, '_')}`

export const LAB_TYPE_FIELDS: ShopifyFieldDefinition[] = SHOPIFY_TYPE_CATALOG.map((info, i) =>
  definition(1000 + i, 'lab_type', labTypeKey(info.name), typeLabel(info.name), info.name, typeRules(info.name)))
export const labTypeField = (type: string) => LAB_TYPE_FIELDS.find(field => field.type === type)!

/* ── 2b. A mirror of a real store's 39 fields: types and rules as measured 2026-09-28; names made up. ── */

const S = (n: number, key: string, name: string, type: string, rules: Array<[string, string]> = [], owner = 'PRODUCT', extra: Partial<ShopifyFieldDefinition> = {}) =>
  definition(n, 'lab_store', key, name, type, rules, owner, extra)
const entries = (kindType: string): Array<[string, string]> => [['metaobject_definition_id', labKind(kindType).id]]
export const LAB_STORE_FIELDS: ShopifyFieldDefinition[] = [
  S(1, 'average_rating', 'Average rating', 'rating', [['scale_min', '1.0'], ['scale_max', '5.0']]),
  S(2, 'rating_count', 'Rating count', 'number_integer', [['min', '0']]),
  S(3, 'feed_custom_product', 'Feed: custom product', 'boolean'),
  S(4, 'colour_category', 'Colour (category)', 'list.metaobject_reference', entries('shopify--color-pattern'), 'PRODUCT', { constraints: { key: 'category', values: LAB_CATEGORIES } }),
  S(5, 'swatch_app_settings', 'Swatch app settings', 'single_line_text_field'),
  S(6, 'highlights', 'Highlights', 'list.metaobject_reference', entries('lab_highlights')),
  S(7, 'short_summary', 'Short summary', 'metaobject_reference', entries('lab_summary')),
  S(8, 'icons_with_text', 'Icons with text', 'list.metaobject_reference', entries('lab_icon_text')),
  S(9, 'media_and_text', 'Media and text blocks', 'list.metaobject_reference', entries('lab_media_text')),
  S(10, 'search_words', 'Search words', 'list.single_line_text_field', [['max', '100'], ['list.max', '10']]),
  S(11, 'related_items', 'Related items', 'list.product_reference', [['list.max', '10']]),
  S(12, 'related_items_display', 'Related items display', 'single_line_text_field', [['choices', '["ahead","only manual"]']]),
  S(13, 'matching_items', 'Matching items', 'list.product_reference', [['list.max', '10']]),
  S(14, 'matching_items_heading', 'Matching items heading', 'metaobject_reference', entries('lab_heading')),
  S(15, 'ticker_text', 'Ticker text', 'metaobject_reference', entries('lab_ticker')),
  S(16, 'video_block', 'Video block', 'metaobject_reference', entries('lab_video')),
  S(17, 'press_quotes', 'Press quotes', 'list.metaobject_reference', entries('lab_press')),
  S(18, 'image_grid_text', 'Image grid with text', 'list.metaobject_reference', entries('lab_image_grid_text')),
  S(19, 'media_grid', 'Media grid', 'list.metaobject_reference', entries('lab_media_grid')),
  S(20, 'slideshow', 'Slideshow', 'list.metaobject_reference', entries('lab_slideshow')),
  S(21, 'variation_label', 'Variation label', 'single_line_text_field'),
  S(22, 'sibling_products', 'Sibling products', 'list.product_reference'),
  S(23, 'fold_out_text', 'Fold-out text', 'list.metaobject_reference', entries('lab_fold_out')),
  S(24, 'size_guide_page', 'Size guide page', 'page_reference'),
  S(25, 'call_to_action', 'Call-to-action button', 'metaobject_reference', entries('lab_button')),
  ...['Feed label 0', 'Feed label 1', 'Feed label 2', 'Feed label 3', 'Feed label 4', 'Size system', 'Size type', 'Part number', 'Gender', 'Condition', 'Age group']
    .map((name, i) => S(26 + i, slug(name).replace(/-/g, '_'), name, 'single_line_text_field', [], 'PRODUCTVARIANT')),
  S(37, 'swatch_picture', 'Swatch picture', 'file_reference', [], 'PRODUCTVARIANT'),
  S(38, 'swatch_colour', 'Swatch colour', 'color', [], 'PRODUCTVARIANT'),
  S(39, 'sort_position', 'Sort position', 'number_integer', [], 'PRODUCTVARIANT'),
]

/* ── 3c. Values: per type a good value, bad values (one per rule) and odd old values. ── */

const firstEntry = (kindType: string, n = 0) => LAB_ENTRIES.filter(e => e.type === kindType)[n].id
const RATING = (value: string) => JSON.stringify({ value, scale_min: '1.0', scale_max: '5.0' })
const MEASURE: Record<string, { value: number; unit: string }> = { dimension: { value: 25, unit: 'centimeters' }, weight: { value: 1.2, unit: 'kilograms' }, volume: { value: 500, unit: 'milliliters' } }
const measure = (kind: string) => MEASURE[kind] ?? { value: 2.5, unit: shopifyMeasurementUnits[kind][0] }

/** One good item value, as the list's JSON item (not the stored string). */
function goodItem(base: string, n = 0): unknown {
  switch (base) {
    case 'single_line_text_field': return ['Racing fit', 'Touring fit'][n]
    case 'multi_line_text_field': return 'First line\nSecond line'
    case 'rich_text_field': return { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'Made-up ', bold: true }, { type: 'text', value: 'rich text.' }] }] }
    case 'number_integer': return [42, 7][n]
    case 'number_decimal': return [12.5, 3.25][n]
    case 'boolean': return true
    case 'color': return ['#1f6fde', '#e2b33c'][n]
    case 'date': return ['2026-09-28', '2027-01-15'][n]
    case 'date_time': return ['2026-09-28T12:30:00', '2027-01-15T08:00:00'][n]
    case 'url': return ['https://example.com/size-guide', 'https://example.com/care'][n]
    case 'link': return { text: ['Size guide', 'Care'][n], url: ['https://example.com/size-guide', 'https://example.com/care'][n] }
    case 'money': return { amount: '149.90', currency_code: 'EUR' }
    case 'rating': return { value: ['4.5', '3.0'][n], scale_min: '1.0', scale_max: '5.0' }
    case 'json': return { fit: 'regular' }
    case 'id': return ['LAB-100', 'LAB-200'][n]
    case 'language': return ['it', 'en-GB'][n]
    case 'jurisdiction': return ['IT', 'US-CA'][n]
    case 'product_reference': return LAB_PRODUCTS[n].id
    case 'variant_reference': return LAB_VARIANTS[n].id
    case 'collection_reference': return LAB_COLLECTIONS[n].id
    case 'page_reference': return LAB_PAGES[n].id
    case 'article_reference': return LAB_ARTICLES[n].id
    case 'customer_reference': return LAB_CUSTOMERS[n].id
    case 'company_reference': return LAB_COMPANIES[0].id
    case 'order_reference': return LAB_ORDERS[n].id
    case 'file_reference': return LAB_FILES[n].id
    case 'product_taxonomy_value_reference': return n ? taxonomy('Navy') : taxonomy('Solid')
    case 'product_taxonomy_disclosure_reference': return labGid('TaxonomyDisclosure', 1)
    case 'metaobject_reference': return firstEntry('lab_summary', n)
    case 'mixed_reference': return n ? firstEntry('lab_press') : firstEntry('lab_faq')
    case 'disclosure_reference': return firstEntry('shopify--disclosure-lab', n)
    default: return shopifyMeasurementUnits[base] ? { ...measure(base), value: measure(base).value + n } : null
  }
}
const LIST_ITEMS: Record<string, [unknown, unknown]> = {
  file_reference: [LAB_FILES[0].id, LAB_FILES[4].id],
  product_taxonomy_value_reference: [taxonomy('Black'), taxonomy('Navy')],
  metaobject_reference: [firstEntry('lab_icon_text', 0), firstEntry('lab_icon_text', 1)],
  company_reference: [LAB_COMPANIES[0].id, null],
}
const stored = (value: unknown) => value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value)

/** The good value of a lab type field, as Shopify stores it (a string; JSON for lists and structured kinds). */
export function labGoodValue(type: string): string | null {
  const base = shopifyBaseType(type)
  if (!type.startsWith('list.')) return stored(goodItem(base))
  const items = LIST_ITEMS[base] ?? [goodItem(base, 0), goodItem(base, 1)]
  return JSON.stringify(items.filter(item => item !== null))
}

export interface LabBadValue {
  /** The rule this value breaks, e.g. `max`, `list.max`, `format`. */
  rule: string
  value: string
  /** Set when TODAY's code accepts this value: the gap in docs/shopify-metafields/PLAN-2026-09-28.md §3 that refuses it. */
  gap?: string
}
/** Values each lab type field must refuse (one per rule), as Shopify stores them. */
export function labBadValues(type: string): LabBadValue[] {
  const base = shopifyBaseType(type), list = type.startsWith('list.')
  const one = (value: unknown): string => list ? JSON.stringify([value]) : stored(value)!
  const out: LabBadValue[] = []
  const add = (rule: string, value: unknown, gap?: string) => out.push({ rule, value: one(value), ...(gap ? { gap } : {}) })
  switch (base) {
    case 'single_line_text_field': add('min', 'A'); add('max', 'x'.repeat(41)); add('one line', 'two\nlines'); break
    case 'multi_line_text_field': add('max', 'x'.repeat(501)); break
    case 'rich_text_field': add('format', { type: 'paragraph' }); break
    case 'number_integer': add('min', list ? -1 : '-1'); add('max', list ? 1000 : '1000'); add('format', '1.5'); break
    case 'number_decimal': add('max', list ? 101 : '101'); add('max_precision', list ? 1.234 : '1.234'); add('format', 'twelve'); break
    case 'boolean': add('format', 'yes'); break
    case 'color': add('format', '#12345'); break
    case 'date': add('format', '2026-13-40'); add('min', '2019-12-31'); break
    case 'date_time': add('format', 'tomorrow'); add('loose format', 'Sep 28 2026 12:30', 'G15'); add('max', '2031-01-01T00:00:00'); break
    case 'url': add('format', 'example.com'); add('allowed_domains', 'https://other.test/size-guide'); break
    case 'link': add('format', { text: '', url: 'https://example.com' }); add('allowed_domains', { text: 'Elsewhere', url: 'https://other.test/' }, 'G17'); break
    case 'money': add('format', { amount: 'abc', currency_code: 'EUR' }); break
    case 'rating': add('scale', { value: '6', scale_min: '1.0', scale_max: '5.0' }); break
    case 'json': add('format', '{"fit":'); add('schema', { size: 'M' }); break
    case 'id': add('max', 'x'.repeat(21)); break
    case 'language': add('format', 'english'); break
    case 'jurisdiction': add('format', 'Italy'); break
    case 'file_reference': add('file_type_options', list ? LAB_FILES[6].id : LAB_FILES[4].id, 'G8'); add('resource', LAB_PRODUCTS[0].id); break
    case 'product_taxonomy_value_reference': add('product_taxonomy_attribute_handle', list ? taxonomy('Solid') : taxonomy('Black'), 'G12'); break
    case 'metaobject_reference': case 'mixed_reference': case 'disclosure_reference': add('resource', LAB_PRODUCTS[0].id); break
    case 'product_taxonomy_disclosure_reference': break
    default:
      if (base.endsWith('_reference')) add('resource', base === 'page_reference' ? LAB_PRODUCTS[0].id : LAB_PAGES[0].id)
      else if (shopifyMeasurementUnits[base]) {
        add('unit', { value: 1, unit: 'parsecs' })
        if (MEASURE[base]) add('max', { value: 30, unit: base === 'weight' ? 'kilograms' : base === 'dimension' ? 'meters' : 'liters' })
      }
  }
  if (list) {
    const max = Number(typeRules(type).find(([rule]) => rule === 'list.max')?.[1])
    const good = JSON.parse(labGoodValue(type) ?? '[]') as unknown[]
    if (max && good.length) out.push({ rule: 'list.max', value: JSON.stringify(Array.from({ length: max + 1 }, (_, i) => base.endsWith('_reference') ? `${String(good[0]).replace(/\d+$/, '')}${i + 1}` : good[i % good.length])) })
    if (base.endsWith('_reference') && good.length) out.push({ rule: 'duplicate', value: JSON.stringify([good[0], good[0]]) })
  }
  return out
}

/** Old or odd stored values a field must still show and repair without crashing. */
export const LAB_ODD_VALUES: Array<{ type: string; note: string; value: string }> = [
  { type: 'weight', note: 'an old short unit (kg)', value: '{"value":12.3,"unit":"kg"}' },
  { type: 'boolean', note: 'not true or false', value: 'legacy' },
  { type: 'list.metaobject_reference', note: 'a list that does not parse', value: '[1,' },
  { type: 'list.product_reference', note: 'a product that was deleted', value: JSON.stringify([LAB_PRODUCTS[0].id, labGid('Product', 999)]) },
  { type: 'date_time', note: 'a moment with a time zone', value: '2026-09-28T12:30:00+02:00' },
  { type: 'temperature', note: 'a measurement kind the cell shows as raw JSON today (G13)', value: '{"value":21.5,"unit":"celsius"}' },
  { type: 'rating', note: 'another scale than the store’s', value: '{"value":"8","scale_min":"0","scale_max":"10"}' },
  { type: 'color', note: 'a three-digit colour', value: '#abc' },
]

/** The lab's starting values for the store mirror (39 fields). */
export const LAB_STORE_START: Record<string, string | null> = Object.fromEntries(LAB_STORE_FIELDS.map(field => {
  const key = field.key
  const value = key === 'average_rating' ? RATING('4.5')
    : key === 'rating_count' ? '12'
    : key === 'feed_custom_product' ? 'false'
    : key === 'colour_category' ? JSON.stringify([firstEntry('shopify--color-pattern', 1)])
    : key === 'highlights' ? JSON.stringify([firstEntry('lab_highlights')])
    : key === 'short_summary' ? firstEntry('lab_summary')
    : key === 'icons_with_text' ? JSON.stringify([0, 1, 2].map(i => firstEntry('lab_icon_text', i)))
    : key === 'search_words' ? JSON.stringify(['rain jacket', 'touring'])
    : key === 'related_items' ? JSON.stringify([LAB_PRODUCTS[3].id, LAB_PRODUCTS[4].id])
    : key === 'related_items_display' ? 'ahead'
    : key === 'sibling_products' ? JSON.stringify([0, 1, 2].map(i => LAB_PRODUCTS[i].id))
    : key === 'size_guide_page' ? LAB_PAGES[0].id
    : key === 'call_to_action' ? firstEntry('lab_button')
    : key === 'variation_label' ? 'Black'
    : key === 'swatch_picture' ? LAB_FILES[0].id
    : key === 'swatch_colour' ? '#2458d6'
    : key === 'sort_position' ? '1'
    : key === 'size_system' ? 'EU'
    : null
  return [field.id, value]
}))

export const LAB_SCHEMA: ShopifyStoreSchema = {
  definitions: [...LAB_STORE_FIELDS, ...LAB_TYPE_FIELDS],
  metaobjectDefinitions: LAB_ENTRY_KINDS,
  types: SHOPIFY_TYPE_CATALOG.map(({ name, category }) => ({ name, category })),
  locales: [{ locale: 'en', primary: true, published: true }],
  currency: 'EUR',
  revision: 'lab-2026-09-28',
}
