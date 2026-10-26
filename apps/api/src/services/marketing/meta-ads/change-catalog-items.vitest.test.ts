/**
 * Meta step 35 — the item, feed and Instagram tag drafts (pure): what each sends, what it skips, what it says (buyers see it,
 * a price is money, a one-way switch, what has no undo), SPENDS MONEY exactly when it can widen what delivering catalog ads
 * show (or Nexus could not see), and the records undo reads. Made-up ids only.
 */
import { describe, expect, it } from 'vitest'
import {
  d7LabelsDraft, feedChangeDraft, feedCreateDraft, fileFieldsOf, fileUploadDraft, groupDeleteDraft, itemsCreateDraft, itemsUpdateDraft, mayWiden, overridesDraft, rulesDraft, SUPPLEMENTARY_UNLISTED, widens,
} from './change-catalog-items.js'
import { appealDraft, tagDraft } from './change-instagram-tags.js'
import { parseNexusCsv } from '../../gateway/meta-catalog-items-rules.js'
import type { CatalogUse } from './live-catalog-admin.js'
import type { FeedNow, ItemNow } from './live-catalog-items.js'
import type { IgProduct, IgTagPost } from './live-instagram-tags.js'

const CATALOG = { catalogId: '120000000000100', name: 'Catalog A' }
const quiet: CatalogUse = { users: [], unseen: [] }
const delivering: CatalogUse = { users: [{ kind: 'adset', id: '120000000000210', name: 'Ad set A', effectiveStatus: 'ACTIVE', uses: 'catalog 120000000000100' }], unseen: [] }
const unseen: CatalogUse = { users: [], unseen: ['the ad account\'s ads (refused)'] }
const now = (sku: string, state: Record<string, unknown>, itemId = '120000000000120'): [string, ItemNow] => [sku, { itemId, sku, state, currency: 'EUR', name: 'Jacket A' }]
const feed = (more: Partial<FeedNow> = {}): FeedNow => ({
  feedId: '120000000000130', name: 'Feed A', supplementary: false, overrideType: null, deletionEnabled: false, defaultCurrency: 'EUR', delimiter: 'COMMA', encoding: 'UTF8',
  quotedFieldsMode: 'autodetect', productCount: 3, schedule: null, updateSchedule: null, ...more,
})

describe('items', () => {
  it('create: only items the catalog has not; CREATE records with allow_upsert false; SPENDS MONEY only with delivery (or unseen)', () => {
    const asked = [{ sku: 'SKU-A', fields: { title: 'Jacket A', availability: 'in stock' } }, { sku: 'SKU-B', fields: { title: 'Jacket B', availability: 'in stock' } }]
    const d = itemsCreateDraft({ catalog: CATALOG, asked, existing: new Set(['SKU-B']), use: quiet })
    expect(d.requests).toHaveLength(1)
    expect(d.requests[0]).toMatchObject({ objectKind: 'catalogitems', edge: 'items_batch', operation: 'catalog.items.write', params: { item_type: 'PRODUCT_ITEM', allow_upsert: 'false' } })
    expect(JSON.parse(d.requests[0].params.requests)).toEqual([{ method: 'CREATE', data: { id: 'SKU-A', title: 'Jacket A', availability: 'in stock' } }])
    expect(d.skipped[0]).toMatch(/SKU-B: an item of this catalog already/)
    expect(d.spendsMoney).toEqual([])
    expect(d.after).toMatchObject({ op: 'create', skus: ['SKU-A'] })
    expect(itemsCreateDraft({ catalog: CATALOG, asked, existing: new Set(), use: delivering }).spendsMoney[0]).toMatch(/delivering now .*2 new items in stock can show/)
    expect(itemsCreateDraft({ catalog: CATALOG, asked, existing: new Set(), use: unseen }).spendsMoney[0]).toMatch(/could not see everything/)
    expect(d.stands).toMatchObject({ absent: ['SKU-A'], uses: { delivering: [], unseen: false } })
  })
  it('update: unchanged fields skipped; old values recorded; what cannot be read or cleared is said; back in stock under delivery = SPENDS MONEY', () => {
    const d = itemsUpdateDraft({
      catalog: CATALOG,
      asked: [{ sku: 'SKU-A', fields: { availability: 'in stock', title: 'Jacket A', price: '44.90 EUR', google_product_category: 'Apparel', custom_label_0: 'Sale' } }, { sku: 'SKU-Z', fields: { size: 'M' } }],
      now: new Map([now('SKU-A', { availability: 'out of stock', title: 'Jacket A', price: '49.90 EUR', google_product_category: undefined, custom_label_0: null })]),
      use: delivering,
    })
    expect(JSON.parse(d.requests[0].params.requests)).toEqual([{ method: 'UPDATE', data: { id: 'SKU-A', availability: 'in stock', price: '44.90 EUR', google_product_category: 'Apparel', custom_label_0: 'Sale' } }])
    expect(d.skipped).toEqual(expect.arrayContaining([expect.stringMatching(/SKU-A: title is like that already/), expect.stringMatching(/SKU-Z: not an item of this catalog now/)]))
    expect(d.before).toMatchObject({ op: 'update', items: [{ sku: 'SKU-A', fields: { availability: 'out of stock', price: '49.90 EUR', google_product_category: undefined, custom_label_0: null } }] })
    expect((d.before as { noUndo: string[] }).noUndo).toEqual([expect.stringMatching(/cannot read google_product_category back/), expect.stringMatching(/had no custom_label_0/)])
    expect(d.spendsMoney[0]).toMatch(/SKU-A \(availability\) can show in its catalog ads again/)
    expect(d.requests[0].raisesSpend).toBe(true)
    expect(d.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^MONEY: buyers see the new price/), expect.stringMatching(/review again/)]))
    const narrow = itemsUpdateDraft({ catalog: CATALOG, asked: [{ sku: 'SKU-A', fields: { availability: 'out of stock' } }], now: new Map([now('SKU-A', { availability: 'in stock' })]), use: delivering })
    expect(narrow.spendsMoney).toEqual([])
    expect(narrow.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Fewer ads: out-of-stock/)]))
    expect(widens('disabled_capabilities', ['da', 'shops'], ['shops'])).toBe(true)
    expect(widens('status', 'archived', 'active')).toBe(true)
    expect(widens('expiration_date', '2026-01-01', '2025-01-01')).toBe(false)
    // Videos are not read back: undo can neither set nor clear them, and says so (review B-N2).
    const video = itemsUpdateDraft({ catalog: CATALOG, asked: [{ sku: 'SKU-A', fields: { video: [{ url: 'https://shop.example.com/a.mp4' }] } }], now: new Map([now('SKU-A', { video: undefined })]), use: quiet })
    expect((video.before as { noUndo: string[] }).noUndo).toEqual([expect.stringMatching(/cannot read an item's videos, so undo cannot set them back or clear them/)])
  })
  it('overrides: an existing override\'s old values, a new one\'s absence, a removal; never an item that is not there', () => {
    const d = overridesDraft({
      catalog: CATALOG,
      asked: [
        { sku: 'SKU-A', type: 'COUNTRY', value: 'IT', fields: { price: '44.90 EUR' } },
        { sku: 'SKU-A', type: 'LANGUAGE', value: 'it_IT', fields: { title: 'Giacca A' } },
        { sku: 'SKU-A', type: 'COUNTRY', value: 'DE', remove: true },
        { sku: 'SKU-Z', type: 'COUNTRY', value: 'IT', fields: { price: '1.00 EUR' } },
      ],
      items: new Set(['SKU-A']),
      now: new Map<string, Record<string, unknown> | null>([['SKU-A|COUNTRY|IT', { price: '49.90 EUR' }], ['SKU-A|COUNTRY|DE', { price: '47.90 EUR', availability: 'in stock' }]]),
      use: quiet,
    })
    expect(JSON.parse(d.requests[0].params.requests)).toEqual([
      { method: 'UPDATE', data: { id: 'SKU-A', price: '44.90 EUR' }, localization: { type: 'COUNTRY', value: 'IT' } },
      { method: 'UPDATE', data: { id: 'SKU-A', title: 'Giacca A' }, localization: { type: 'LANGUAGE', value: 'it_IT' } },
      { method: 'DELETE', data: { id: 'SKU-A' }, localization: { type: 'COUNTRY', value: 'DE' } },
    ])
    expect(d.before).toMatchObject({ entries: [
      { type: 'COUNTRY', value: 'IT', existed: true, fields: { price: '49.90 EUR' } },
      { type: 'LANGUAGE', value: 'it_IT', existed: false, fields: null },
      { type: 'COUNTRY', value: 'DE', existed: true, fields: { price: '47.90 EUR', availability: 'in stock' } },
    ] })
    expect(d.skipped[0]).toMatch(/SKU-Z: not an item of this catalog now/)
    // A country price taken off is a money change; without revenue view no price is printed (review A-F2).
    expect(d.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^MONEY: buyers see the new price/)]))
    const masked = overridesDraft({ catalog: CATALOG, asked: [{ sku: 'SKU-A', type: 'COUNTRY', value: 'DE', remove: true }], items: new Set(['SKU-A']), now: new Map([['SKU-A|COUNTRY|DE', { price: '47.90 EUR', availability: 'in stock' }]]), use: quiet, mayMoney: false })
    expect(JSON.stringify(masked.changes)).not.toContain('47.90')
    expect(JSON.stringify(masked.changes)).toContain('hidden (revenue view)')
    // An out-of-stock country override taken off: the item's own availability shows there — SPENDS MONEY under delivery (A-F3).
    const back = overridesDraft({ catalog: CATALOG, asked: [{ sku: 'SKU-A', type: 'COUNTRY', value: 'DE', remove: true }], items: new Set(['SKU-A']), now: new Map([['SKU-A|COUNTRY|DE', { availability: 'out of stock' }]]), use: delivering })
    expect(back.spendsMoney[0]).toMatch(/SKU-A in DE \(its out-of-stock override taken off\) can show/)
    expect(back.requests[0].raisesSpend).toBe(true)
  })
  it('an item group\'s delete: ONLY_IF_EMPTY unless the person asked for its items too', () => {
    const empty = groupDeleteDraft({ catalog: CATALOG, groupId: '120000000000115', groupSku: 'GROUP-A', items: 2, more: false, withItems: false, use: quiet })
    expect(empty.requests[0]).toMatchObject({ method: 'DELETE', objectKind: 'productgroup', params: { deletion_method: 'ONLY_IF_EMPTY' } })
    expect(empty.warnings.join(' ')).toMatch(/it holds 2 now, so Meta refuses/)
    expect(groupDeleteDraft({ catalog: CATALOG, groupId: '120000000000115', groupSku: null, items: 2, more: false, withItems: true, use: delivering }).requests[0].params).toEqual({ deletion_method: 'DELETE_ITEMS' })
  })
})

describe('feeds', () => {
  it('create: a supplementary feed names its primaries; a feed of items always sends deletion_enabled; ratings promise no stars', () => {
    const supp = feedCreateDraft({ catalog: CATALOG, ask: { kind: 'supplementary', name: 'Nexus labels', primaryFeedIds: ['120000000000130'] }, use: quiet, d7: true })
    expect(supp.requests[0]).toMatchObject({ objectKind: 'catalogfeeds', edge: 'product_feeds', params: { name: 'Nexus labels', ingestion_source_type: 'SUPPLEMENTARY_FEED', primary_feed_ids: '["120000000000130"]' } })
    expect(supp.requests[0].params.deletion_enabled).toBeUndefined()
    const items = feedCreateDraft({ catalog: CATALOG, ask: { kind: 'products', name: 'Feed A', deletionEnabled: true, schedule: { interval: 'DAILY', url: 'https://feeds.example.com/a.csv', hour: 3 } }, use: delivering, d7: false })
    expect(items.requests[0].params).toMatchObject({ feed_type: 'PRODUCTS', deletion_enabled: 'true', schedule: '{"interval":"DAILY","url":"https://feeds.example.com/a.csv","hour":3}' })
    expect(items.warnings.join(' ')).toMatch(/NEVER lets it be turned off again/)
    expect(items.changes['Fetch (full replace)'].to).toBe('daily at 03:00 Pacific time (Meta\'s default) from feeds.example.com')
    expect(items.spendsMoney).toHaveLength(1)
    const reviews = feedCreateDraft({ catalog: CATALOG, ask: { kind: 'ratings', name: 'Reviews', deletionEnabled: false }, use: quiet, d7: false })
    expect(reviews.warnings.join(' ')).toMatch(/states nowhere that stars show in catalog ads/)
    expect(reviews.requests[0].params).toMatchObject({ feed_type: 'PRODUCT_RATINGS_AND_REVIEWS', deletion_enabled: 'false' })
    const country = feedCreateDraft({ catalog: CATALOG, ask: { kind: 'country', name: 'IT', deletionEnabled: false }, use: quiet, d7: false })
    expect(country.requests[0].params).toEqual({ name: 'IT', override_type: 'COUNTRY', deletion_enabled: 'false' })
    // Review B-F2: rules at create are Meta's list<JSON-encoded string> — each rule its own JSON string.
    const ruled = feedCreateDraft({ catalog: CATALOG, ask: { kind: 'products', name: 'Feed R', deletionEnabled: false, rules: [{ attribute: 'custom_label_0', ruleType: 'fallback_rule', params: { user_default_value: 'none' } }] }, use: quiet, d7: false })
    expect(JSON.parse(ruled.requests[0].params.rules)).toEqual(['{"attribute":"custom_label_0","rule_type":"fallback_rule","params":{"user_default_value":"none"}}'])
    // Review A-F3: an update-only fetch brings items too.
    expect(feedCreateDraft({ catalog: CATALOG, ask: { kind: 'products', name: 'Feed U', deletionEnabled: false, updateSchedule: { interval: 'HOURLY', url: 'https://feeds.example.com/u.csv' } }, use: delivering, d7: false }).spendsMoney).toHaveLength(1)
    // Review B-F3: Meta does not list internal_label / custom_number as supplementary-feed fields — said.
    expect(supp.warnings).toContain(SUPPLEMENTARY_UNLISTED)
  })
  it('change: deletion only on (one-way, no undo); unchanged skipped; a schedule shown by its host', () => {
    const d = feedChangeDraft({ catalog: CATALOG, feed: feed({ name: 'Feed A' }), ask: { name: 'Feed A', deletionEnabled: true, updateSchedule: { interval: 'HOURLY', url: 'https://feeds.example.com/p.csv' } }, use: quiet })
    expect(d.requests[0].params).toEqual({ update_schedule: '{"interval":"HOURLY","url":"https://feeds.example.com/p.csv"}', deletion_enabled: 'true' })
    expect(d.skipped).toEqual(['name is like that already.'])
    expect((d.before as { noUndo: string[] }).noUndo.join(' ')).toMatch(/deletion_enabled cannot be turned off again/)
    expect(d.warnings[0]).toMatch(/^ONE-WAY/)
  })
  it('labels: an update-only CSV of id + the D7 columns, every row carrying every column (its current value where unchanged)', () => {
    const d = d7LabelsDraft({
      catalog: CATALOG, feed: feed(), via: 'shopify-feed', use: quiet,
      asked: [{ sku: 'SKU-A', fields: { internal_label: ['summer', 'sale'] } }, { sku: 'SKU-B', fields: { custom_label_0: 'Sale' } }],
      now: new Map([now('SKU-A', { internal_label: ['summer'], custom_label_0: 'Old' }), now('SKU-B', { internal_label: [], custom_label_0: null }, '120000000000121')]),
    })
    const file = d.requests[0].params.file
    expect(d.requests[0]).toMatchObject({ objectKind: 'catalogfeed', edge: 'uploads', parent: { kind: 'catalog', id: CATALOG.catalogId }, params: { file_part_name: 'nexus-labels.csv', update_only: 'true' } })
    expect(parseNexusCsv(file)).toEqual([['id', 'internal_label', 'custom_label_0'], ['SKU-A', "['summer','sale']", 'Old'], ['SKU-B', '[]', 'Sale']])
    expect(d.before).toMatchObject({ op: 'labels', items: [{ sku: 'SKU-A', fields: { internal_label: ['summer'] } }, { sku: 'SKU-B', fields: { custom_label_0: null } }] })
    expect(d.warnings.join(' ')).toMatch(/UPDATE-ONLY file \(id \+ internal_label, custom_label_0\)/)
    expect(d.warnings.join(' ')).toMatch(/send.* the item through Meta's review again|review again/)
    const unreadable = d7LabelsDraft({ catalog: CATALOG, feed: feed(), via: 'shopify-feed', use: quiet, asked: [{ sku: 'SKU-A', fields: { internal_label: ['a'] } }, { sku: 'SKU-B', fields: { custom_label_0: 'x' } }], now: new Map([now('SKU-A', { internal_label: [], custom_label_0: undefined }), now('SKU-B', { internal_label: [], custom_label_0: null })]) })
    expect(unreadable.requests).toEqual([])
    expect(unreadable.skipped.join(' ')).toMatch(/cannot read SKU-A's other D7 columns exactly/)
    // Review A-N5: an empty cell is "sent", never "done" (CT35-03); B-F3: own-feed with internal_label says Meta's list.
    const empty = d7LabelsDraft({ catalog: CATALOG, feed: feed({ supplementary: true }), via: 'own-feed', use: quiet, asked: [{ sku: 'SKU-A', fields: { internal_label: [] } }], now: new Map([now('SKU-A', { internal_label: ['summer'] })]) })
    expect(empty.requests[0].doneSentence!({ node: { id: '120000000000140' } } as never)).toMatch(/upload 120000000000140\. Its empty cells were sent; whether they cleared those values is not verified \(LIVE-PROBES CT35-03\)/)
    expect(empty.warnings).toContain(SUPPLEMENTARY_UNLISTED)
    const filled = d7LabelsDraft({ catalog: CATALOG, feed: feed(), via: 'shopify-feed', use: quiet, asked: [{ sku: 'SKU-A', fields: { custom_label_0: 'New' } }], now: new Map([now('SKU-A', { custom_label_0: 'Old' })]) })
    expect(filled.requests[0].doneSentence).toBeUndefined()
  })
  it('a file of items: update-only needs the same fields on every row; a full replace says what it deletes', () => {
    const rows = [{ sku: 'SKU-A', fields: { availability: 'in stock' } }, { sku: 'SKU-B', fields: { title: 'B' } }]
    expect(fileUploadDraft({ catalog: CATALOG, feed: feed(), rows, updateOnly: true, use: quiet })).toEqual({ refusal: expect.stringMatching(/names the same fields for every item/) })
    const full = fileUploadDraft({ catalog: CATALOG, feed: feed({ deletionEnabled: true }), rows: [{ sku: 'SKU-A', fields: { title: 'A', availability: 'in stock' } }], updateOnly: false, use: quiet })
    expect('warnings' in full && full.warnings.join(' ')).toMatch(/FULL REPLACE.*deletion_enabled is ON/)
    // Review B-F4: a file writes image[0] as image_link and the others as additional_image_link; no image tags in a file.
    expect(fileFieldsOf({ title: 'A', image: [{ url: 'https://shop.example.com/a.jpg' }, { url: 'https://shop.example.com/b.jpg' }, { url: 'https://shop.example.com/c.jpg' }] })).toEqual({ title: 'A', image_link: 'https://shop.example.com/a.jpg', additional_image_link: 'https://shop.example.com/b.jpg,https://shop.example.com/c.jpg' })
    expect(fileFieldsOf({ image: [{ url: 'https://shop.example.com/a.jpg', tag: ['front'] }] })).toEqual({ refusal: expect.stringMatching(/image addresses only/) })
    const imaged = fileUploadDraft({ catalog: CATALOG, feed: feed(), rows: [{ sku: 'SKU-A', fields: { image: [{ url: 'https://shop.example.com/a.jpg' }] } }], updateOnly: true, use: quiet })
    expect('requests' in imaged && parseNexusCsv(imaged.requests[0].params.file)).toEqual([['id', 'image_link'], ['SKU-A', 'https://shop.example.com/a.jpg']])
    // Review A-F3: an update-only file widens by each value (active, `da` out of hideFrom, labels), not only availability.
    for (const fields of [{ status: 'active' }, { disabled_capabilities: ['shops'] }, { custom_label_0: 'Sale' }, { expiration_date: '2027-01-01' }]) {
      const d = fileUploadDraft({ catalog: CATALOG, feed: feed(), rows: [{ sku: 'SKU-A', fields }], updateOnly: true, use: delivering })
      expect('spendsMoney' in d && d.spendsMoney, JSON.stringify(fields)).toHaveLength(1)
    }
    expect(fileUploadDraft({ catalog: CATALOG, feed: feed(), rows: [{ sku: 'SKU-A', fields: { status: 'archived' } }], updateOnly: true, use: delivering })).toMatchObject({ spendsMoney: [] })
    expect(mayWiden('disabled_capabilities', ['da'])).toBe(false)
  })
  it('rules: a change is a delete then a create that stands on it; a second rule of the same type and attribute is refused', () => {
    const rulesNow = [{ ruleId: '120000000000135', attribute: 'custom_label_0', ruleType: 'fallback_rule', params: { user_default_value: 'none' } }]
    const d = rulesDraft({ catalog: CATALOG, feed: feed(), rulesNow, ask: { change: [{ ruleId: '120000000000135', params: { user_default_value: 'all' } }] }, use: quiet })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.requests.map((r) => [r.step, r.method ?? 'POST', r.objectKind, r.needs ?? null])).toEqual([[1, 'DELETE', 'feedrule', null], [2, 'POST', 'catalogfeed', [1]]])
    expect(d.requests[1].params).toEqual({ attribute: 'custom_label_0', rule_type: 'fallback_rule', params: '{"user_default_value":"all"}' })
    expect(rulesDraft({ catalog: CATALOG, feed: feed(), rulesNow, ask: { add: [{ attribute: 'custom_label_0', ruleType: 'fallback_rule', params: { user_default_value: 'x' } }] }, use: quiet })).toEqual({ refusal: expect.stringMatching(/one rule per type and attribute/) })
    // Review A-F3: a rule changes every item of the feed — SPENDS MONEY under delivery, its premise in stands.
    expect(d.spendsMoney).toEqual([])
    expect(d.stands).toMatchObject({ uses: { delivering: [], unseen: false } })
    const spent = rulesDraft({ catalog: CATALOG, feed: feed(), rulesNow, ask: { remove: ['120000000000135'] }, use: delivering })
    expect('spendsMoney' in spent && spent.spendsMoney[0]).toMatch(/delivering now .*rules change a field of every item of the feed/)
    expect(spent).toMatchObject({ stands: { uses: { delivering: ['adset:120000000000210'] } } })
    // Review A-F6: a rule Nexus could not make again is never removed (nor changed: a change removes it first).
    const foreign = [{ ruleId: '120000000000137', attribute: 'color', ruleType: 'value_mapping_rule', params: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`v${i}`, `w${i}`])) }]
    expect(rulesDraft({ catalog: CATALOG, feed: feed(), rulesNow: foreign, ask: { remove: ['120000000000137'] }, use: quiet })).toEqual({ refusal: expect.stringMatching(/params Nexus does not send.*removes nothing/) })
    expect(rulesDraft({ catalog: CATALOG, feed: feed(), rulesNow: foreign, ask: { change: [{ ruleId: '120000000000137', params: { a: 'b' } }] }, use: quiet })).toEqual({ refusal: expect.stringMatching(/params Nexus does not send.*changes nothing/) })
    expect(rulesDraft({ catalog: CATALOG, feed: feed(), rulesNow: [{ ruleId: '120000000000138', attribute: 'title', ruleType: 'fallback_rule', params: null }], ask: { remove: ['120000000000138'] }, use: quiet })).toEqual({ refusal: expect.stringMatching(/cannot read its attribute, type and params whole/) })
  })
})

describe('Instagram tags', () => {
  const post = (more: Partial<IgTagPost> = {}): IgTagPost => ({ mediaId: '170000000000001', targetId: '170000000000001', target: 'image', tagsNow: new Map([['120000000000120', { x: 0.80000001192093, y: 0.2 }]]), otherSlidesTagged: 0, slidesNotRead: [], ...more })
  const product = (id: string, review = 'approved'): [string, IgProduct] => [id, { productId: id, catalogId: '120000000000100', sku: 'SKU', name: 'Jacket', reviewStatus: review }]
  it('adds new tags and moves existing ones; the move is undoable (place kept to 4 decimals), the add is not', () => {
    const d = tagDraft({ post: post(), asked: [{ productId: '120000000000120', x: 0.5, y: 0.5 }, { productId: '120000000000121', x: 0.1, y: 0.1 }], products: new Map([product('120000000000120'), product('120000000000121', 'pending')]), taggedToday: 3, instagramId: '170000000000000' })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.requests[0]).toMatchObject({ objectKind: 'igmedia', edge: 'product_tags', params: { updated_tags: '[{"product_id":"120000000000120","x":0.5,"y":0.5},{"product_id":"120000000000121","x":0.1,"y":0.1}]' }, readBackOf: '170000000000001/product_tags' })
    expect(d.before).toMatchObject({ moved: [{ productId: '120000000000120', x: 0.8, y: 0.2 }] })
    expect(d.after).toMatchObject({ added: ['120000000000121'], moved: [{ productId: '120000000000120', x: 0.5, y: 0.5 }] })
    expect(d.warnings.join(' ')).toMatch(/Not approved for tagging yet \(120000000000121\)/)
    expect(d.warnings.join(' ')).toMatch(/cannot remove a product tag through its API/)
    expect(d.warnings.join(' ')).toMatch(/Nexus tagged 3 of this account in the last 24 hours/)
    // Review A-N1: the record names the Instagram account (the 25-a-day count is per account).
    expect(d.after).toMatchObject({ instagramId: '170000000000000' })
    expect(d.spendsMoney).toEqual([])
    // Meta reads 0.8 back as a 32-bit float: the same place, so asking it again changes nothing.
    const same = tagDraft({ post: post(), asked: [{ productId: '120000000000120', x: 0.8, y: 0.2 }], products: new Map([product('120000000000120')]), taggedToday: 0 })
    expect('requests' in same && same.requests).toEqual([])
    const judge = d.requests[0].judge!
    expect(judge({ data: [{ product_id: 120000000000120, x: 0.5, y: 0.50000001 }, { product_id: '120000000000121', x: 0.1, y: 0.1 }] }).moved).toEqual([])
    expect(judge({ data: [{ product_id: '120000000000120', x: 0.5, y: 0.5 }] }).moved).toEqual(['120000000000121'])
  })
  it('refuses past Meta\'s room; a Reel is tagged without places and read back by nobody', () => {
    const full = post({ tagsNow: new Map(Array.from({ length: 20 }, (_, i) => [`1200000000002${String(i).padStart(2, '0')}`, { x: 0.1, y: 0.1 }])) })
    expect(tagDraft({ post: full, asked: [{ productId: '120000000000120', x: 0.5, y: 0.5 }], products: new Map([product('120000000000120')]), taggedToday: 0 })).toEqual({ refusal: expect.stringMatching(/at most 20/) })
    const reel = tagDraft({ post: post({ target: 'reel', tagsNow: null }), asked: [{ productId: '120000000000120' }], products: new Map([product('120000000000120')]), taggedToday: 0 })
    if ('refusal' in reel) throw new Error(reel.refusal)
    expect(reel.requests[0].params.updated_tags).toBe('[{"product_id":"120000000000120"}]')
    expect(reel.requests[0].judge).toBeUndefined()
    expect(reel.warnings.join(' ')).toMatch(/does not cover Reels/)
  })
  it('an appeal: only of a rejected product Meta lets be appealed; no undo', () => {
    const p = product('120000000000120', 'rejected')[1]
    expect(appealDraft({ instagramId: '170000000000000', product: p, state: { eligible: false, reviewStatus: 'rejected' }, reason: 'A toy.' })).toEqual({ refusal: expect.stringMatching(/cannot be appealed now/) })
    expect(appealDraft({ instagramId: '170000000000000', product: p, state: { eligible: true, reviewStatus: 'approved' }, reason: 'A toy.' })).toEqual({ refusal: expect.stringMatching(/not rejected/) })
    const d = appealDraft({ instagramId: '170000000000000', product: p, state: { eligible: true, reviewStatus: 'rejected' }, reason: 'A toy.' })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.requests[0]).toMatchObject({ objectId: '170000000000000', objectKind: 'iguser', edge: 'product_appeal', params: { appeal_reason: 'A toy.', product_id: '120000000000120' }, undoable: false })
    expect(d.warnings.join(' ')).toMatch(/cannot be withdrawn/)
  })
})
