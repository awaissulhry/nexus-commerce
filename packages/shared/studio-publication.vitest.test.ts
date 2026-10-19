import { describe, expect, it } from 'vitest'

import { blockedChanges, blockingIssues, differsSentence, differsSummary, fullUpdateChange, isPhotoChangeId, leftOutReason, publishGateContext, sendableChanges,
  sendUnit, type PublishGateContext, type StudioPublishChange, type StudioPublishIssue, type StudioPublishReview } from './studio-publication.js'

const id = (field: string, productId = 'parent') => JSON.stringify([productId, field])
const season: StudioPublishIssue = { productId: 'parent', field: 'aspect:season', severity: 'error', message: 'Season: Season contains an unaccepted value.' }
const account: StudioPublishIssue = { severity: 'error', message: 'Reconnect this account before publishing.' }
const ebay: PublishGateContext = { channel: 'EBAY' }
const amazon: PublishGateContext = { channel: 'AMAZON' }
const etsy: PublishGateContext = { channel: 'ETSY' }

describe('photos-only publishing (Images rebuild P4c)', () => {
  it('knows the photo fields of the change review', () => {
    expect([id('pictures'), id('Pictures'), id('variationPictures')].every(isPhotoChangeId)).toBe(true)
    expect(isPhotoChangeId(id('title'))).toBe(false)
    expect(isPhotoChangeId('not json')).toBe(false)
  })
  it('an error on another field blocks neither photos nor any other field it does not send (Owner 2026-10-19: was "photos only")', () => {
    expect(blockingIssues([season], [id('pictures'), id('Pictures')], ebay)).toEqual([])
    // On purpose since 2026-10-19: an off-list item specific no longer blocks the pictures and the title sent with them.
    expect(blockingIssues([season], [id('pictures'), id('title')], ebay)).toEqual([])
    expect(blockingIssues([season], [id('pictures'), id('aspect:brand')], ebay)).toEqual([season])
    expect(blockingIssues([season], [], ebay)).toEqual([season])
  })
  it('an error that names no field and no product blocks everything; warnings never block; no context = every error', () => {
    expect(blockingIssues([season, account], [id('pictures')], ebay)).toEqual([account])
    expect(blockingIssues([{ ...season, severity: 'warning' }], [id('aspect:season')], ebay)).toEqual([])
    expect(blockingIssues([season], [id('pictures')])).toEqual([season])
    expect(blockingIssues([account], ['not an id'], ebay)).toEqual([account])
  })
})

// Owner 2026-10-17 — missing German package sizes blocked the new MOSS title on the DE listings already on Amazon.
describe('Amazon: per SKU, per attribute', () => {
  const de = (root: string, productId = 'parent') => id(`${root}:["A1PA6795UKMFR9","de_DE"]`, productId)
  const height: StudioPublishIssue = { productId: 'parent', sku: 'SKU-M', field: 'item_package_dimensions__height', severity: 'error', message: 'Item package height: required.' }
  const bullets: StudioPublishIssue = { productId: 'parent', sku: 'SKU-M', field: 'bullet_point', severity: 'error', message: 'Bullet point: too long.' }
  it('an error on another attribute does not block a title, description, bullets or keywords selection', () => {
    expect(blockingIssues([height], [de('item_name'), de('product_description'), de('bullet_point'), de('generic_keyword')], amazon)).toEqual([])
  })
  it('an error on a selected attribute blocks it, in either field form and under the content checks\' names', () => {
    expect(blockingIssues([height, bullets], [de('item_name'), de('bullet_point')], amazon)).toEqual([bullets])
    expect(blockingIssues([{ ...bullets, field: 'bullet_point:["A1PA6795UKMFR9","de_DE"]' }], [de('bullet_point')], amazon)).toHaveLength(1)
    expect(blockingIssues([height], [de('item_name'), id('item_package_dimensions')], amazon)).toEqual([height])
    const review: StudioPublishIssue = { productId: 'parent', field: 'title', severity: 'error', message: 'Review the German (de) title before publishing.' }
    expect(blockingIssues([review], [de('item_name')], amazon)).toEqual([review])
  })
  it('only on the SKU it names: another SKU\'s same attribute goes', () => {
    expect(blockingIssues([bullets], [de('bullet_point', 'child')], amazon)).toEqual([])
    expect(blockingIssues([{ ...bullets, productId: undefined }], [de('bullet_point', 'child')], amazon)).toHaveLength(1)
  })
  it('a create or a Full update of a SKU is one message: any error of that SKU blocks it, other SKUs still go', () => {
    expect(blockingIssues([height], [id('$create')], amazon)).toEqual([height])
    expect(blockingIssues([height], [de('item_name'), id('$create')], amazon)).toEqual([height])
    expect(blockingIssues([height], [id('$create', 'child')], amazon)).toEqual([])
    const full: PublishGateContext = { channel: 'AMAZON', changes: [{ id: id('brand'), productId: 'parent', field: 'brand', locked: true }] }
    expect(blockingIssues([height], [id('brand')], full)).toEqual([height])
    expect(blockingIssues([height], [id('brand')], amazon)).toEqual([])
  })
  it('a problem that names a product but no field blocks every change of that product', () => {
    const row: StudioPublishIssue = { productId: 'parent', sku: 'SKU-M', severity: 'error', message: 'SKU-M: the seller SKU is too long.' }
    expect(blockingIssues([row], [de('item_name')], amazon)).toEqual([row])
    expect(blockingIssues([row], [de('item_name', 'child')], amazon)).toEqual([])
  })
})

describe('eBay Trading: Title, Description, PictureDetails one by one; ItemSpecifics one unit; Variations per SKU', () => {
  it('an item-specific error on any row blocks every item-specific change of the listing, nothing else', () => {
    const variation: StudioPublishIssue = { productId: 'child', field: 'aspect:material', severity: 'error', message: 'Material: too long.' }
    expect(blockingIssues([variation], [id('aspect:brand')], ebay)).toEqual([variation])
    expect(blockingIssues([{ ...variation, field: 'itemSpecifics.Material' }], [id('aspect:brand')], ebay)).toHaveLength(1)
    expect(blockingIssues([variation], [id('title'), id('description'), id('pictures')], ebay)).toEqual([])
  })
  it('a variation\'s problem blocks what sends that variation; a structural field (condition, price) blocks nothing of a narrow revise', () => {
    const sku: StudioPublishIssue = { productId: 'child', field: 'sellerSku', severity: 'error', message: 'Seller SKU is empty.' }
    expect(blockingIssues([sku], [id('variationSku', 'child')], ebay)).toEqual([sku])
    expect(blockingIssues([sku], [id('variationSku', 'other')], ebay)).toEqual([])
    const theme: StudioPublishIssue = { field: 'variationTheme', severity: 'error', message: 'Variation theme: set it.' }
    expect(blockingIssues([theme], [id('Pictures')], ebay)).toEqual([theme])
    const condition: StudioPublishIssue = { productId: 'parent', field: 'conditionId', severity: 'error', message: 'Condition is empty.' }
    const price: StudioPublishIssue = { productId: 'child', field: 'price', severity: 'error', message: 'Price: set a price above 0.' }
    expect(blockingIssues([condition, price], [id('title'), id('aspect:brand'), id('pictures')], ebay)).toEqual([])
  })
  it('a create or a Full update sends the whole listing: every error blocks it', () => {
    const price: StudioPublishIssue = { productId: 'child', field: 'price', severity: 'error', message: 'Price: set a price above 0.' }
    expect(blockingIssues([price], [id('__create__')], ebay)).toEqual([price])
    expect(blockingIssues([price], [id('title')], { channel: 'EBAY', changes: [{ id: id('title'), productId: 'parent', field: 'title', locked: true }] })).toEqual([price])
  })
  it('eBay Inventory sends the whole group: every error blocks every change', () => {
    expect(blockingIssues([season], [id('pictures')], { channel: 'EBAY', sendsWhole: true })).toEqual([season])
  })
})

describe('Etsy: listing fields one by one; the inventory PUT one unit', () => {
  const price: StudioPublishIssue = { productId: 'child', sku: 'SKU-S', field: 'price', severity: 'error', message: 'Price: set a price above 0.' }
  it('a variation\'s price, stock, SKU or value error blocks the inventory line, never the listing fields', () => {
    for (const field of ['price', 'quantity', 'sku', 'readiness', 'variationTheme', 'size']) expect(blockingIssues([{ ...price, field }], [id('inventory')], etsy)).toHaveLength(1)
    expect(blockingIssues([price], [id('title'), id('tags'), id('classification')], etsy)).toEqual([])
  })
  it('a listing field\'s error blocks that field (under the sheet\'s names too) and the translations that carry it', () => {
    const title: StudioPublishIssue = { productId: 'parent', field: 'title', severity: 'error', message: 'Title has 150 characters.' }
    expect(blockingIssues([title], [id('title')], etsy)).toEqual([title])
    expect(blockingIssues([title], [id('translation:de')], etsy)).toEqual([title])
    expect(blockingIssues([title], [id('description'), id('inventory')], etsy)).toEqual([])
    expect(blockingIssues([{ ...title, field: 'when_made' }], [id('classification')], etsy)).toHaveLength(1)
    expect(blockingIssues([{ ...title, field: 'item_dimensions_unit' }], [id('item_dimensions')], etsy)).toHaveLength(1)
    expect(blockingIssues([{ ...title, field: 'property_200' }], [id('property:200')], etsy)).toHaveLength(1)
    expect(blockingIssues([{ ...title, field: 'property_200__scale_id' }], [id('property:200')], etsy)).toHaveLength(1)
    expect(blockingIssues([{ ...title, field: 'property_513__scale_id' }], [id('inventory')], etsy)).toHaveLength(1)
  })
  it('a create sends the whole listing: every error blocks it', () => {
    expect(blockingIssues([price], [id('__create__')], etsy)).toEqual([price])
  })
})

describe('sendUnit — every name a problem comes under reaches the unit its change travels in', () => {
  it.each([
    ['AMAZON', 'title', 'item_name'], ['AMAZON', 'description', 'product_description'], ['AMAZON', 'bulletPoints', 'bullet_point'], ['AMAZON', 'keywords', 'generic_keyword'],
    ['AMAZON', 'item_name:["A1","it_IT"]', 'item_name'], ['AMAZON', 'item_package_dimensions__height', 'item_package_dimensions'], ['AMAZON', 'purchasable_offer__our_price', 'purchasable_offer'],
    ['AMAZON', 'variation_theme', 'family'], ['AMAZON', 'child_parent_sku_relationship__parent_sku', 'family'], ['AMAZON', 'parentage_level', 'family'],
    ['AMAZON', 'main_product_image_locator', 'photos'], ['AMAZON', 'other_product_image_locator_3', 'photos'], ['AMAZON', 'imageUrls', 'photos'], ['AMAZON', '$create', 'create'],
    ['EBAY', 'title', 'title'], ['EBAY', 'description', 'description'], ['EBAY', 'descriptionThemeId', 'description'], ['EBAY', 'pictures', 'photos'], ['EBAY', 'Pictures', 'photos'],
    ['EBAY', 'imageUrls', 'photos'], ['EBAY', 'variationPictures', 'photos'], ['EBAY', 'aspect:brand', 'aspects'], ['EBAY', 'itemSpecifics', 'aspects'], ['EBAY', 'itemSpecifics.Marca', 'aspects'],
    ['EBAY', 'categoryId', 'aspects'], ['EBAY', 'sellerSku', 'sku'], ['EBAY', 'SKU', 'sku'], ['EBAY', 'variationSku', 'sku'], ['EBAY', 'variationTheme', 'variations'], ['EBAY', '__create__', 'create'],
    ['ETSY', 'title', 'title'], ['ETSY', 'keywords', 'tags'], ['ETSY', 'who_made', 'classification'], ['ETSY', 'item_weight_unit', 'item_weight'], ['ETSY', 'property_200', 'property:200'],
    ['ETSY', 'translation:de', 'translation:de'], ['ETSY', 'price', 'inventory'], ['ETSY', 'sku', 'inventory'], ['ETSY', 'colour', 'inventory'],
  ])('%s %s → %s', (channel, field, unit) => {
    expect(sendUnit(channel, field)).toBe(unit)
  })
  it('fields a narrow update does not send stay their own (they block nothing it sends)', () => {
    expect(['conditionId', 'price', 'quantity', 'subtitle', 'returnPolicyId'].map(field => sendUnit('EBAY', field))).toEqual(['conditionId', 'price', 'quantity', 'subtitle', 'returnPolicyId'])
    expect(sendUnit('ETSY', 'bulletPoints')).toBe('bulletPoints')
  })
})

describe('the review\'s left-out changes (option A)', () => {
  const change = (field: string, productId = 'parent', extra: Partial<StudioPublishChange> = {}): StudioPublishChange => ({
    id: id(field, productId), productId, sku: productId.toUpperCase(), field, label: field, current: { state: 'value', value: 'N' }, lastAccepted: { state: 'unknown', reason: 'none' },
    channel: { state: 'value', value: 'C' }, status: 'SEND', localChanged: true, channelChanged: false, selectable: true, selectedByDefault: true, reason: 'r', operation: 'replace', ...extra })
  const review = (issues: StudioPublishIssue[], changes: StudioPublishChange[], channel = 'AMAZON'): Pick<StudioPublishReview, 'scope' | 'changes' | 'issues'> =>
    ({ scope: { channel, marketplace: 'IT', accountId: 'a' }, changes, issues })
  const brand: StudioPublishIssue = { productId: 'parent', sku: 'PARENT', field: 'brand', severity: 'error', message: 'Brand: required.' }
  it('names each blocked change with the problem that blocks it; the clean ones can go', () => {
    const r = review([brand], [change('brand'), change('item_name'), change('brand', 'child'), change('color', 'parent', { selectable: false })])
    expect([...blockedChanges(r)]).toEqual([[id('brand'), brand]])
    expect(sendableChanges(r).map(c => c.id)).toEqual([id('item_name'), id('brand', 'child')])
    expect(leftOutReason(brand)).toBe('Left out: Brand: required.')
  })
  it('a problem that names nothing leaves out every change; no problem leaves out none', () => {
    expect(blockedChanges(review([account], [change('brand'), change('item_name')])).size).toBe(2)
    expect(blockedChanges(review([], [change('brand')])).size).toBe(0)
    expect(blockedChanges(null).size).toBe(0)
  })
  it('the gate reads the review\'s channel, changes and whole-group send', () => {
    expect(publishGateContext({ scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'a' }, changes: undefined, sendsWhole: true })).toEqual({ channel: 'EBAY', changes: null, sendsWhole: true })
  })
})

// Build shape v2 P4 — a Full update row's field is ticked and locked, DIFFERS and unchanged fields included, and its
// reason says what Full sends.
describe('fullUpdateChange', () => {
  const change = (status: StudioPublishChange['status'], current: StudioPublishChange['current'], channel: StudioPublishChange['channel']): StudioPublishChange => ({
    id: id('brand'), productId: 'parent', sku: 'SKU', field: 'brand', label: 'Brand', current, lastAccepted: { state: 'unknown', reason: 'none' }, channel, status,
    localChanged: null, channelChanged: null, selectable: false, selectedByDefault: false, reason: 'Partial reason', operation: 'replace' })
  const value = (v: string) => ({ state: 'value' as const, value: v })
  it.each([
    ['SAME', value('A'), value('A'), 'Full update sends it again (it already matches the channel).'],
    ['DIFFERS', value('A'), value('B'), 'Full update replaces the channel\'s different value with Nexus\'s.'],
    ['SEND', value('A'), value('B'), 'Full update sends Nexus\'s value.'],
    ['DIFFERS', { state: 'absent' as const }, value('B'), 'Full update removes it: Nexus holds no value here.'],
  ] as const)('%s → ticked, locked, with its own reason', (status, current, channel, reason) => {
    expect(fullUpdateChange(change(status, current, channel))).toMatchObject({ selectable: true, selectedByDefault: true, locked: true, reason, status })
  })
})

describe('one-click "Nexus wins" summary (Owner 2026-10-04)', () => {
  const line = (field: string, status: StudioPublishChange['status'], selectable = true, selectedByDefault = selectable): StudioPublishChange => ({
    id: id(field), productId: 'parent', sku: 'PARENT', field, label: field, current: { state: 'value', value: 'N' }, lastAccepted: { state: 'unknown', reason: 'none' },
    channel: { state: 'value', value: 'C' }, status, localChanged: null, channelChanged: null, selectable, selectedByDefault, reason: 'r', operation: 'replace',
  })
  const many = Array.from({ length: 12 }, (_, i) => line(`f${i}`, 'DIFFERS'))

  it('counts the selectable DIFFERS lines of a market: "12 values … differ … replaces them"', () => {
    const changes = [...many, line('send', 'SEND'), line('same', 'SAME', false), line('unread', 'CANNOT_COMPARE', false), line('refused', 'DIFFERS', false)]
    expect(differsSummary(changes, 'Amazon · IT')).toEqual({ count: 12, ticked: 12, sentence: '12 values on Amazon · IT differ from Nexus. Publish replaces them.' })
  })
  it('one value: singular words', () => {
    expect(differsSummary([line('title', 'DIFFERS')], 'eBay · IT')).toEqual({ count: 1, ticked: 1, sentence: '1 value on eBay · IT differs from Nexus. Publish replaces it.' })
  })
  it('"Keep Amazon\'s values" (none ticked) and a partial choice say what Publish does', () => {
    expect(differsSummary(many, 'Amazon · IT', [])!.sentence).toBe('12 values on Amazon · IT differ from Nexus. Publish keeps them.')
    expect(differsSummary(many, 'Amazon · IT', [id('f0'), id('f1'), 'other'])).toEqual({ count: 12, ticked: 2, sentence: '12 values on Amazon · IT differ from Nexus. Publish replaces 2 of them.' })
  })
  it('nothing differs → null', () => {
    expect(differsSummary([line('send', 'SEND')], 'Amazon · IT')).toBeNull()
    expect(differsSummary(undefined, 'Amazon · IT')).toBeNull()
  })
  it('the same words from counts alone (the products list has only each row\'s counts), ticks clamped', () => {
    expect(differsSentence(12, 12, 'Amazon · IT')).toBe(differsSummary(many, 'Amazon · IT')!.sentence)
    expect(differsSentence(1, 0, 'eBay · IT')).toBe('1 value on eBay · IT differs from Nexus. Publish keeps it.')
    expect(differsSentence(1200, 3, 'Amazon · DE')).toBe('1,200 values on Amazon · DE differ from Nexus. Publish replaces 3 of them.')
    expect(differsSentence(3, 9, 'eBay · IT')).toBe('3 values on eBay · IT differ from Nexus. Publish replaces them.')
  })
})
