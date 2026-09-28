import { beforeEach, describe, expect, it } from 'vitest'
import { LAB_ENTRIES, LAB_FILES, LAB_PRODUCTS, LAB_SCHEMA, LAB_TAXONOMY_VALUES, labKind } from '@nexus/shared/shopify-lab-store'
import { answerLab, LAB_PRODUCT, resetLabStore, setLabRefusal } from './labStandIn'

/* Lane B slice B0: the lab's stand-in store answers like today's server, for the lab product only. */
const base = `http://127.0.0.1:3110/api/products/${LAB_PRODUCT}/shopify-linked`
const call = (method: string, suffix: string, params: Record<string, string> = {}, body?: unknown) => {
  const url = new URL(`${base}${suffix}`)
  for (const [key, value] of Object.entries({ accountId: 'lab', market: 'GLOBAL', ...params })) url.searchParams.set(key, value)
  return answerLab(method, url, body)!
}
const items = (answer: ReturnType<typeof call>) => (answer.body as { items: Array<{ id: string; type?: string }> }).items

beforeEach(() => resetLabStore())

describe('the lab stand-in store', () => {
  it('answers only the lab product; every other call goes to the real API', () => {
    expect(answerLab('GET', new URL('http://127.0.0.1:3110/api/products/other/shopify-linked/schema'), undefined)).toBeNull()
    expect(call('GET', '/schema').body).toBe(LAB_SCHEMA)
    expect(call('POST', '/cells').status).toBe(404)
  })
  it('searches entries by kind and refuses an entry search with no kind, like the server', () => {
    expect(call('GET', '/references', { type: 'list.metaobject_reference' }).status).toBe(400)
    const found = items(call('GET', '/references', { type: 'metaobject_reference', metaobjectType: 'lab_icon_text', query: 'air' }))
    expect(found.map(i => i.id)).toEqual([LAB_ENTRIES.find(e => e.name === 'Air vents')!.id])
  })
  it('lists only the file kinds a field allows, and every kind when it has no limit (gap G8, closed in B1)', () => {
    const kinds = (params: Record<string, string>) => [...new Set(items(call('GET', '/references', { type: 'file_reference', ...params })).map(i => i.type))].sort()
    expect(kinds({})).toEqual(['GenericFile', 'MediaImage', 'Video'])
    expect(kinds({ fileTypes: 'Image' })).toEqual(['MediaImage'])
    expect(kinds({ fileTypes: 'Image,Video' })).toEqual(['MediaImage', 'Video'])
  })
  it('finds a taxonomy value only by its raw id, as today (gap G12)', () => {
    const black = LAB_TAXONOMY_VALUES.find(v => v.label === 'Black')!
    expect(items(call('GET', '/references', { type: 'product_taxonomy_value_reference', query: 'Black' }))).toEqual([])
    expect(items(call('GET', '/references', { type: 'product_taxonomy_value_reference', query: black.id })).map(i => i.id)).toEqual([black.id])
  })
  it('pages a long list 40 at a time', () => {
    const first = call('GET', '/references', { type: 'metaobject_reference', metaobjectType: 'shopify--color-pattern' }).body as { items: unknown[]; cursor: string | null }
    expect(first.items).toHaveLength(16)
    expect(first.cursor).toBeNull()
  })
  it('names references and marks a missing one unavailable', () => {
    const answer = call('POST', '/reference-names', {}, { ids: [LAB_PRODUCTS[0].id, 'gid://shopify/Product/9'] }).body as Array<{ label: string; available?: boolean }>
    expect(answer.map(a => [a.label, a.available])).toEqual([[LAB_PRODUCTS[0].label, true], ['Unavailable reference', false]])
    expect(call('POST', '/reference-names', {}, { ids: Array.from({ length: 101 }, (_, i) => `gid://shopify/Product/${i}`) }).status).toBe(400)
  })
})

describe('entries in the stand-in store (same checks as saveLinkedEntry)', () => {
  const kind = labKind('lab_image_grid_text')
  const image = LAB_FILES[0].id
  it('creates an entry, then reads it back', () => {
    const saved = call('POST', '/entry', {}, { type: kind.type, handle: 'lab-new-block', fields: [{ key: 'image', value: image }, { key: 'heading', value: 'New block' }] })
    expect(saved.status).toBe(200)
    const entry = saved.body as { id: string; name: string; revision: string }
    expect(entry.name).toBe('New block')
    expect(call('GET', '/entry', { id: entry.id }).body).toMatchObject({ id: entry.id, name: 'New block', revision: entry.revision })
  })
  it('refuses a missing required field with the server’s words', () => {
    const answer = call('POST', '/entry', {}, { type: kind.type, handle: 'lab-no-heading', fields: [{ key: 'image', value: image }] })
    expect(answer).toEqual({ status: 422, body: { error: 'Heading: Enter a value. Shopify needs this field.' } })
  })
  it('refuses a video in an image-only field at save', () => {
    const colour = labKind('shopify--color-pattern')
    const video = LAB_FILES.find(f => f.type === 'Video')!.id
    const existing = LAB_ENTRIES.find(e => e.type === colour.type)!
    const read = call('GET', '/entry', { id: existing.id }).body as { revision: string }
    const answer = call('POST', '/entry', {}, { id: existing.id, expectedRevision: read.revision, type: colour.type, handle: existing.handle, fields: [{ key: 'image', value: video }] })
    expect(answer).toEqual({ status: 422, body: { error: 'Image: This field takes images only.' } })
  })
  it('refuses a stale save ("changed in Shopify")', () => {
    const existing = LAB_ENTRIES.find(e => e.type === 'lab_faq')!
    const answer = call('POST', '/entry', {}, { id: existing.id, expectedRevision: 'old', type: 'lab_faq', handle: existing.handle, fields: [{ key: 'question', value: 'Changed?' }] })
    expect(answer).toEqual({ status: 409, body: { error: 'This entry changed in Shopify. Reload it before saving.' } })
  })
  it('answers with Shopify’s refusal text when the lab switch is on', () => {
    setLabRefusal(true)
    const answer = call('POST', '/entry', {}, { type: 'lab_faq', handle: 'lab-refused', fields: [{ key: 'question', value: 'Why?' }] })
    expect(answer.status).toBe(502)
    expect((answer.body as { error: string }).error).toMatch(/^Create reusable entry: /)
  })
  it('forgets saved entries on reset', () => {
    const saved = call('POST', '/entry', {}, { type: 'lab_faq', handle: 'lab-temporary', fields: [{ key: 'question', value: 'Temporary' }] }).body as { id: string }
    resetLabStore()
    expect(call('GET', '/entry', { id: saved.id }).status).toBe(404)
  })
})

/* Lane B slice B3c (PLAN §6.3, G18): the searches the new pickers make are answered like the server answers them
   (`searchLinkedReferences`: entries by kind, resources by resource). */
import { LAB_ARTICLES, LAB_COLLECTIONS, LAB_COMPANIES, LAB_CUSTOMERS, LAB_ORDERS, LAB_VARIANTS } from '@nexus/shared/shopify-lab-store'

describe('B3c · the searches of the mixed, disclosure and resource pickers', () => {
  const names = (answer: ReturnType<typeof call>) => (answer.body as { items: Array<{ label: string }> }).items.map(i => i.label)
  it('a mixed field’s list, one kind at a time (the kind switch), and the same for its list form', () => {
    for (const type of ['mixed_reference', 'list.mixed_reference']) {
      expect(names(call('GET', '/references', { type, metaobjectType: 'lab_faq' })), type).toEqual(['FAQ 1', 'FAQ 2'])
      expect(names(call('GET', '/references', { type, metaobjectType: 'lab_press' })), type).toEqual(['Press quote 1', 'Press quote 2'])
    }
    const press = items(call('GET', '/references', { type: 'list.mixed_reference', metaobjectType: 'lab_press', query: '2' }))
    expect(press.map(i => i.id)).toEqual([LAB_ENTRIES.find(e => e.name === 'Press quote 2')!.id])
    expect((press[0] as { image?: string | null }).image).toMatch(/^data:image\/svg\+xml,/)
  })
  it('a disclosure field’s list; with no kind named, the server’s refusal', () => {
    expect(names(call('GET', '/references', { type: 'list.disclosure_reference', metaobjectType: 'shopify--disclosure-lab' }))).toEqual(['Disclosure (made up) 1', 'Disclosure (made up) 2'])
    for (const type of ['mixed_reference', 'list.mixed_reference', 'disclosure_reference']) expect(call('GET', '/references', { type }), type).toEqual({ status: 400, body: { error: 'Choose the reusable entry type.' } })
  })
  it('an entry saved in the tab is found at once under its kind', () => {
    const saved = call('POST', '/entry', {}, { type: 'lab_faq', handle: 'lab-sizes', fields: [{ key: 'question', value: 'Which size?' }] }).body as { id: string }
    expect(items(call('GET', '/references', { type: 'list.mixed_reference', metaobjectType: 'lab_faq' })).map(i => i.id)).toContain(saved.id)
  })
  it.each([
    ['variant_reference', LAB_VARIANTS], ['collection_reference', LAB_COLLECTIONS], ['article_reference', LAB_ARTICLES],
    ['customer_reference', LAB_CUSTOMERS], ['company_reference', LAB_COMPANIES], ['order_reference', LAB_ORDERS],
  ])('%s: every one of its kind, and only those, for the field and its list form', (type, all) => {
    for (const t of [type, `list.${type}`]) expect(items(call('GET', '/references', { type: t })).map(i => i.id), t).toEqual(all.map(r => r.id))
  })
  it('the resource search matches the typed words', () => {
    expect(names(call('GET', '/references', { type: 'variant_reference', query: '/ xl' }))).toEqual(['Sample Jacket / XL'])
    expect(names(call('GET', '/references', { type: 'list.order_reference', query: '1002' }))).toEqual(['#1002'])
    expect(names(call('GET', '/references', { type: 'customer_reference', query: 'nobody' }))).toEqual([])
  })
})
