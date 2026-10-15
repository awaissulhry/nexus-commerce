import { expect, it } from 'vitest'
import { planColourProducts, type ColourSizeMap } from '@nexus/shared/shopify-colour-products'
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
it('size map: EU sizes pair with the letter variants by their Shopify value; the missing one is created and ordered under it', () => {
  const misano = (sizeMap?: Record<string, Record<string, string>>) => planColourProducts({ familyId: 'f', axes: [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }],
    variants: ['44', '46', '48'].map(s => ({ productId: s, sku: `MISANO-${s}`, values: { color: 'color:nero', size: `size:${s}` } })),
    valueOrder: { color: ['color:nero'], size: ['size:44', 'size:46', 'size:48'] }, valueLabels: { 'color:nero': 'Nero', 'size:44': '44', 'size:46': '46', 'size:48': '48' }, unmapped: [] },
  { splitAxis: 'color', sizeMap }).products[0]
  const r = { ...remote(), options: [{ id: 'gid://shopify/ProductOption/1', name: 'Size', values: ['S', 'M'] }],
    variants: { nodes: [['46', 'S'], ['48', 'M']].map(([eu, letter], i) => ({ id: `gid://shopify/ProductVariant/${i + 1}`, sku: `MISANO-${eu}`, selectedOptions: [{ name: 'Size', value: letter }], inventoryItem: { id: `gid://shopify/InventoryItem/${i + 1}` } })), pageInfo: { hasNextPage: false } } }
  const saved = new Map([['46', { variantId: '1', inventoryItemId: '1' }], ['48', { variantId: '2', inventoryItemId: '2' }]])
  const planned = planColourVariants(misano({ size: { '44': 'XS', '46': 'S', '48': 'M' } }), r, saved)
  expect(planned.matched.map(v => v.remote.id)).toEqual(['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'])
  expect(planned.missing).toEqual([{ productId: '44', sku: 'MISANO-44', optionValues: [{ optionId: 'gid://shopify/ProductOption/1', name: 'XS' }] }])
  expect(planned.order).toEqual([{ id: 'gid://shopify/ProductOption/1', values: [{ name: 'XS' }, { name: 'S' }, { name: 'M' }] }])
  // No map: the sizes Shopify holds are not the Nexus values, so the stored ones read as changed (as before).
  expect(() => planColourVariants(misano(), r, saved)).toThrow('MISANO-46: Shopify changed the size identity or options. Review the mapping.')
})
it('an axis not on Shopify (XRACING, invented ids: Fit Type "Regular" on every variant, the store has Size only): the identity check passes, a new size is Size only; no choice = refused as before', () => {
  const xracing = (sizeMap?: ColourSizeMap) => planColourProducts({ familyId: 'f', axes: [{ code: 'color', label: 'Color' }, { code: 'fit_type', label: 'Fit Type' }, { code: 'size_name', label: 'Size Name' }],
    variants: ['46', '48', '50'].map(s => ({ productId: s, sku: `XR-SUIT-NERO-${s}`, values: { color: 'color:nero', fit_type: 'fit:regular', size_name: `size_name:${s}` } })),
    valueOrder: { color: ['color:nero'], fit_type: ['fit:regular'], size_name: ['size_name:46', 'size_name:48', 'size_name:50'] },
    valueLabels: { 'color:nero': 'Nero', 'fit:regular': 'Regular', 'size_name:46': '46', 'size_name:48': '48', 'size_name:50': '50' }, unmapped: [] },
  { splitAxis: 'color', sizeMap }).products[0]
  const option = 'gid://shopify/ProductOption/900000000001'
  const r = { ...remote(), options: [{ id: option, name: 'Size', values: ['48', '50'] }],
    variants: { nodes: ['48', '50'].map((s, i) => ({ id: `gid://shopify/ProductVariant/90000000010${i}`, sku: `XR-SUIT-NERO-${s}`, selectedOptions: [{ name: 'Size', value: s }], inventoryItem: { id: `gid://shopify/InventoryItem/90000000010${i}` } })), pageInfo: { hasNextPage: false } } }
  const saved = new Map([['48', { variantId: '900000000100', inventoryItemId: '900000000100' }], ['50', { variantId: '900000000101', inventoryItemId: '900000000101' }]])
  const planned = planColourVariants(xracing({ fit_type: null }), r, saved)
  expect(planned.matched.map(v => v.remote.id)).toEqual(['gid://shopify/ProductVariant/900000000100', 'gid://shopify/ProductVariant/900000000101'])
  expect(planned.missing).toEqual([{ productId: '46', sku: 'XR-SUIT-NERO-46', optionValues: [{ optionId: option, name: '46' }] }])
  expect(planned.order).toEqual([{ id: option, values: [{ name: '46' }, { name: '48' }, { name: '50' }] }])
  // Without the choice Fit Type is a Shopify option the store does not have: refused before any write, as before.
  expect(() => planColourVariants(xracing(), r, saved)).toThrow('The Shopify option for Fit Type changed. Review the variation theme before syncing sizes.')
  // The choice on a store whose product DOES carry Fit: the option axes differ, refused.
  const withFit = { ...r, options: [{ id: 'gid://shopify/ProductOption/900000000002', name: 'Fit', values: ['Regular'] }, ...r.options],
    variants: { ...r.variants, nodes: r.variants.nodes.map(v => ({ ...v, selectedOptions: [{ name: 'Fit', value: 'Regular' }, ...v.selectedOptions] })) } }
  expect(() => planColourVariants(xracing({ fit_type: null }), withFit, saved)).toThrow('The Shopify option axes differ from the confirmed family. Review the variation theme.')
})
