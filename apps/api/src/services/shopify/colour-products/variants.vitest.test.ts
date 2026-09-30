import { expect, it } from 'vitest'
import { planColourVariants, colourIsPublished, readOnlineStorePublication } from './variants.js'
const wanted = () => ({ key: 'color:black', position: 0, nexusValue: 'Black', colourName: 'Black', colourNameSource: 'operator' as const,
  options: [{ axis: 'size', name: 'Taglia', values: ['XS', 'S', 'M'] }],
  variants: ['XS', 'S', 'M'].map(s => ({ productId: s, sku: `BLACK-${s}`, options: [{ name: 'Taglia', value: s }] })) })
const remote = () => ({ id: 'gid://shopify/Product/1', status: 'ACTIVE', onlineStorePublished: true, identity: { value: 'family' },
  options: [{ id: 'gid://shopify/ProductOption/1', name: 'Size', values: ['M', 'S', 'OLD'] }],
  variants: { nodes: ['S', 'M', 'OLD'].map((s, i) => ({ id: `gid://shopify/ProductVariant/${i + 1}`, sku: `BLACK-${s}`, selectedOptions: [{ name: 'Size', value: s }], inventoryItem: { id: `gid://shopify/InventoryItem/${i + 1}` } })), pageInfo: { hasNextPage: false } } })
it('uses explicit publication on a password-protected store whose URL is null', () => {
  const product = { status: 'ACTIVE', onlineStoreUrl: null, onlineStorePublished: true }
  expect(colourIsPublished(product)).toBe(true)
})
it('finds the Online Store publication by its app handle on a later page', async () => {
  const read = async (_q: string, vars: any) => ({ publications: { nodes: vars.after ? [{ id: 'online', catalog: { apps: { nodes: [{ handle: 'online_store' }], pageInfo: { hasNextPage: false } } } }] : [],
    pageInfo: { hasNextPage: !vars.after, endCursor: vars.after ? null : 'next' } } })
  expect(await readOnlineStorePublication(read as never)).toBe('online')
})
it('refuses two possible Online Store publications instead of choosing one', async () => {
  const read = async () => ({ publications: { nodes: ['one', 'two'].map(id => ({ id, catalog: { apps: { nodes: [{ handle: 'online_store' }] } } })), pageInfo: { hasNextPage: false } } })
  await expect(readOnlineStorePublication(read as never)).rejects.toThrow('no single Online Store')
})
it('keeps the sole Default Title variant of a colour-only product', () => {
  const p = { ...wanted(), options: [], variants: [{ productId: 'only', sku: 'BLACK', options: [] }] }
  const r = { ...remote(), options: [{ id: 'gid://shopify/ProductOption/1', name: 'Title', values: ['Default Title'] }],
    variants: { nodes: [{ id: 'gid://shopify/ProductVariant/1', sku: 'BLACK', selectedOptions: [{ name: 'Title', value: 'Default Title' }], inventoryItem: { id: 'gid://shopify/InventoryItem/1' } }], pageInfo: { hasNextPage: false } } }
  const planned = planColourVariants(p, r, new Map())
  expect(planned.matched.map(v => v.remote.id)).toEqual(['gid://shopify/ProductVariant/1'])
  expect(planned.missing).toEqual([]); expect(planned.reordered).toBe(false)
})
it('adds only missing sizes and keeps unknown remote variants in the order', () => {
  const plan = planColourVariants(wanted(), remote(), new Map())
  expect(plan.missing.map(v => v.sku)).toEqual(['BLACK-XS'])
  expect(plan.matched.map(v => v.remote.id)).toEqual(['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'])
  expect(plan.order).toEqual([{ id: 'gid://shopify/ProductOption/1', values: [{ name: 'XS' }, { name: 'S' }, { name: 'M' }, { name: 'OLD' }] }])
})
it('recovers a create that reached Shopify before the local mapping was saved', () => {
  const r = remote(); r.variants.nodes.push({ ...r.variants.nodes[0], id: 'gid://shopify/ProductVariant/4', sku: 'BLACK-XS', selectedOptions: [{ name: 'Size', value: 'XS' }] })
  expect(planColourVariants(wanted(), r, new Map()).missing).toEqual([])
})
it('refuses a missing stored variant instead of silently replacing it', () => {
  expect(() => planColourVariants(wanted(), remote(), new Map([['S', { variantId: '99', inventoryItemId: '1' }]]))).toThrow(/stored variant/i)
})
it('refuses an existing option tuple owned by another SKU', () => {
  const r = remote(); r.variants.nodes[0].sku = 'SOMEONE-ELSE'
  expect(() => planColourVariants(wanted(), r, new Map())).toThrow(/another SKU/i)
})
it('refuses duplicate SKUs and an incomplete variant read', () => {
  const r = remote(); r.variants.nodes.push({ ...r.variants.nodes[0], id: 'gid://shopify/ProductVariant/9' })
  expect(() => planColourVariants(wanted(), r, new Map())).toThrow(/more than once/i)
  r.variants.pageInfo.hasNextPage = true
  expect(() => planColourVariants(wanted(), r, new Map())).toThrow(/250/)
})
it('maps Size and Fit by name when Shopify has a different option order', () => {
  const p = wanted(); p.options.push({ axis: 'fit', name: 'Fit', values: ['Regular'] })
  p.variants.forEach(v => v.options.push({ name: 'Fit', value: 'Regular' }))
  const r = remote(); r.options.unshift({ id: 'gid://shopify/ProductOption/2', name: 'Fit', values: ['Regular'] })
  r.variants.nodes.forEach(v => v.selectedOptions.unshift({ name: 'Fit', value: 'Regular' }))
  const plan = planColourVariants(p, r, new Map())
  expect(plan.matched).toHaveLength(2)
  expect(plan.missing[0].optionValues).toEqual([{ optionId: 'gid://shopify/ProductOption/1', name: 'XS' }, { optionId: 'gid://shopify/ProductOption/2', name: 'Regular' }])
})
