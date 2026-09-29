import { describe, expect, it } from 'vitest'
import { IMPACT_LINKED_SHOWN_LIMIT, matchColourProducts, planColourProducts, SHOPIFY_LINKED_LIST_LIMIT, SHOPIFY_VARIANT_LIMIT, type ColourCandidate, type ColourPlanFamily, type ColourPlanVariant } from './shopify-colour-products.js'

// A GALE-shaped family: 2 colours × 10 sizes. Children arrive in SKU order, which is NOT the size order.
const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL']
const SKU_ORDER = ['3XL', '4XL', '5XL', 'L', 'M', 'S', 'XL', 'XS', 'XXL', 'XXS']
const size = (s: string) => `size:${s.toLowerCase()}`
const COLOURS = [{ key: 'color:black', label: 'Nero', sku: 'BLACK' }, { key: 'color:yellow', label: 'Giallo', sku: 'YELLOW' }]
const variant = (colour: typeof COLOURS[number], s: string, extra: Record<string, string> = {}): ColourPlanVariant =>
  ({ productId: `p-${colour.sku}-${s}`, sku: `GALE-JACKET-${colour.sku}-MEN-${s}`, values: { color: colour.key, size: size(s), ...extra } })
const gale = (patch: Partial<ColourPlanFamily> = {}): ColourPlanFamily => ({
  familyId: 'gale',
  axes: [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }],
  variants: COLOURS.flatMap(c => SKU_ORDER.map(s => variant(c, s))),
  valueOrder: { color: COLOURS.map(c => c.key), size: SIZES.map(size) },
  valueLabels: { ...Object.fromEntries(COLOURS.map(c => [c.key, c.label])), ...Object.fromEntries(SIZES.map(s => [size(s), s])) },
  unmapped: [],
  ...patch,
})
const COLOUR_SPLIT = { splitAxis: 'color', optionNames: { size: 'Size' } } as const
const codes = (plan: ReturnType<typeof planColourProducts>) => plan.issues.map(i => i.code)

describe('planColourProducts — one Shopify product per colour', () => {
  it('GALE: two colour products, sizes as native variants in the Shared size order, the operator\'s colour names, grouped', () => {
    const plan = planColourProducts(gale(), { ...COLOUR_SPLIT, colourNames: { 'color:black': 'Black', 'color:yellow': 'Yellow' } })
    expect(plan).toMatchObject({ familyId: 'gale', mode: 'colour-products', splitAxis: 'color', grouped: true, issues: [] })
    expect(plan.products.map(p => [p.key, p.position, p.nexusValue, p.colourName, p.colourNameSource])).toEqual([
      ['color:black', 0, 'Nero', 'Black', 'operator'], ['color:yellow', 1, 'Giallo', 'Yellow', 'operator']])
    for (const product of plan.products) {
      expect(product.options).toEqual([{ axis: 'size', name: 'Size', values: SIZES }])
      expect(product.variants.map(v => v.options)).toEqual(SIZES.map(s => [{ name: 'Size', value: s }]))
    }
    expect(plan.products[1].variants[0]).toEqual({ productId: 'p-YELLOW-XXS', sku: 'GALE-JACKET-YELLOW-MEN-XXS', options: [{ name: 'Size', value: 'XXS' }] })
  })

  it('the colour order follows the family\'s value order, not the order of the children', () => {
    const plan = planColourProducts(gale({ valueOrder: { color: ['color:yellow', 'color:black'], size: SIZES.map(size) } }), COLOUR_SPLIT)
    expect(plan.products.map(p => [p.key, p.position])).toEqual([['color:yellow', 0], ['color:black', 1]])
  })

  it('a value the order does not name keeps its first use, after the named ones', () => {
    const family = gale({ valueOrder: { color: ['color:yellow'], size: ['size:s', 'size:m'] } })
    const plan = planColourProducts(family, COLOUR_SPLIT)
    expect(plan.products.map(p => p.key)).toEqual(['color:yellow', 'color:black'])
    expect(plan.products[0].options[0].values).toEqual(['S', 'M', ...SKU_ORDER.filter(s => s !== 'S' && s !== 'M')])
  })

  it('without an operator name the colour keeps its Nexus value; a blank name falls back too', () => {
    const plan = planColourProducts(gale(), { ...COLOUR_SPLIT, colourNames: { 'color:black': '   ' } })
    expect(plan.products.map(p => [p.colourName, p.colourNameSource])).toEqual([['Nero', 'nexus'], ['Giallo', 'nexus']])
    expect(plan.issues).toEqual([])
  })

  it('the GALE XXS fault: two children with the same colour and size are refused, naming both SKUs', () => {
    const family = gale()
    const variants = family.variants.map(v => v.sku.endsWith('-XXS') ? { ...v, values: { ...v.values, size: 'size:xs' } } : v)
    const plan = planColourProducts({ ...family, variants }, COLOUR_SPLIT)
    const duplicates = plan.issues.filter(i => i.code === 'duplicate-variant')
    expect(duplicates).toHaveLength(2)
    expect(duplicates[0]).toMatchObject({ severity: 'error', key: 'color:black', productIds: ['p-BLACK-XS', 'p-BLACK-XXS'],
      message: 'GALE-JACKET-BLACK-MEN-XS and GALE-JACKET-BLACK-MEN-XXS have the same Nero / XS. Each variant needs its own combination.' })
  })

  it('two value keys with the same text are one value on Shopify: refused', () => {
    const family = gale()
    // The XXS child holds an unmapped "xs": a different key from the mapped XS, but the same text for Shopify.
    const variants = family.variants.map(v => v.productId === 'p-BLACK-XXS' ? { ...v, values: { ...v.values, size: 'size:text:xs' } } : v)
    const plan = planColourProducts({ ...family, variants, valueLabels: { ...family.valueLabels, 'size:text:xs': 'xs' } }, COLOUR_SPLIT)
    expect(codes(plan)).toEqual(['duplicate-option-value', 'duplicate-variant'])
    expect(plan.issues[0]).toMatchObject({ key: 'color:black', productIds: ['p-BLACK-XS', 'p-BLACK-XXS'], message: 'Size would list "XS", "xs" as separate values, but Shopify reads them as one. Use one spelling.' })
    expect(plan.issues[1]).toMatchObject({ key: 'color:black', productIds: ['p-BLACK-XS', 'p-BLACK-XXS'] })
    // The yellow product is not affected.
    expect(plan.issues.every(i => i.key === 'color:black')).toBe(true)
  })

  it('a single colour is one product and is not grouped', () => {
    const family = gale()
    const plan = planColourProducts({ ...family, variants: family.variants.filter(v => v.values.color === 'color:black') }, COLOUR_SPLIT)
    expect(plan).toMatchObject({ mode: 'colour-products', grouped: false, issues: [] })
    expect(plan.products).toHaveLength(1)
  })

  it('colour + two more axes: colour splits, Size and Fit stay native options in their own order', () => {
    const family = gale({
      axes: [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }, { code: 'fit', label: 'Vestibilità' }],
      variants: [variant(COLOURS[0], 'M', { fit: 'fit:slim' }), variant(COLOURS[0], 'S', { fit: 'fit:regular' }), { ...variant(COLOURS[0], 'S', { fit: 'fit:slim' }), productId: 'p-slim-s' }],
      valueOrder: { color: ['color:black'], size: SIZES.map(size), fit: ['fit:regular', 'fit:slim'] },
      valueLabels: { 'color:black': 'Nero', 'size:s': 'S', 'size:m': 'M', 'fit:regular': 'Regular', 'fit:slim': 'Slim' },
    })
    const plan = planColourProducts(family, { splitAxis: 'color', optionNames: { size: 'Size', fit: 'Fit' } })
    expect(plan.issues).toEqual([])
    expect(plan.products[0].options).toEqual([{ axis: 'size', name: 'Size', values: ['S', 'M'] }, { axis: 'fit', name: 'Fit', values: ['Regular', 'Slim'] }])
    expect(plan.products[0].variants.map(v => v.options.map(o => o.value).join('/'))).toEqual(['S/Regular', 'S/Slim', 'M/Slim'])
  })

  it('no split axis: the family stays ONE product with every axis as an option, and the same checks apply', () => {
    const plan = planColourProducts(gale(), { splitAxis: null, optionNames: { color: 'Color', size: 'Size' } })
    expect(plan).toMatchObject({ mode: 'one-product', splitAxis: null, grouped: false, issues: [] })
    expect(plan.products).toHaveLength(1)
    expect(plan.products[0]).toMatchObject({ key: '', position: 0, nexusValue: '', colourName: '', colourNameSource: null })
    expect(plan.products[0].options.map(o => [o.name, o.values])).toEqual([['Color', ['Nero', 'Giallo']], ['Size', SIZES]])
    expect(plan.products[0].variants.slice(0, 2).map(v => v.sku)).toEqual(['GALE-JACKET-BLACK-MEN-XXS', 'GALE-JACKET-BLACK-MEN-XS'])
    expect(plan.products[0].variants).toHaveLength(20)
  })

  it('a variant without a value on an axis is refused and left out of every product', () => {
    const family = gale()
    const variants = family.variants.map(v => v.productId === 'p-BLACK-M' ? { ...v, values: { color: 'color:black', size: '' } } : v)
    const plan = planColourProducts({ ...family, variants }, COLOUR_SPLIT)
    expect(plan.issues).toEqual([{ severity: 'error', code: 'missing-value', productIds: ['p-BLACK-M'], message: 'GALE-JACKET-BLACK-MEN-M has no Taglia value.' }])
    expect(plan.products[0].variants).toHaveLength(9)
  })

  it('a colour that is not a dictionary option cannot be split: its product would lose its identity on a rename', () => {
    const plan = planColourProducts(gale({ unmapped: ['color:yellow'] }), COLOUR_SPLIT)
    expect(plan.issues).toEqual([expect.objectContaining({ severity: 'error', code: 'unmapped-split-value', key: 'color:yellow', productIds: expect.arrayContaining(['p-YELLOW-S']) })])
    expect(plan.issues[0].productIds).toHaveLength(10)
  })

  it('two colours with the same Shopify name are refused', () => {
    const plan = planColourProducts(gale(), { ...COLOUR_SPLIT, colourNames: { 'color:black': 'Black', 'color:yellow': ' black' } })
    expect(plan.issues).toEqual([expect.objectContaining({ code: 'duplicate-colour-name', message: '"Nero", "Giallo" would all be called "Black" on Shopify. Give each colour its own name.' })])
    expect(plan.issues[0].productIds).toHaveLength(20)
  })

  it('Shopify option limits: at most 3 options, each with its own non-blank name', () => {
    const axes = ['color', 'size', 'fit', 'length', 'hood'].map(code => ({ code, label: code }))
    const values = Object.fromEntries(axes.map(a => [a.code, `${a.code}:x`]))
    const family: ColourPlanFamily = { familyId: 'f', axes, variants: [{ productId: 'p', sku: 'S', values }], valueOrder: {}, valueLabels: {}, unmapped: [] }
    expect(codes(planColourProducts(family, { splitAxis: 'color' }))).toEqual(['too-many-options'])
    expect(codes(planColourProducts({ ...family, axes: axes.slice(0, 3) }, { splitAxis: 'color', optionNames: { size: 'Size', fit: ' size ' } }))).toEqual(['duplicate-option-name'])
    expect(codes(planColourProducts({ ...family, axes: axes.slice(0, 3) }, { splitAxis: 'color', optionNames: { fit: '  ' } }))).toEqual(['blank-option-name'])
  })

  it('an unknown split axis is refused before anything else', () => {
    expect(planColourProducts(gale(), { splitAxis: 'material' })).toMatchObject({ products: [], grouped: false, issues: [{ code: 'split-axis-unknown', severity: 'error' }] })
  })

  it('a colour product above the publisher\'s variant limit is refused', () => {
    const variants = Array.from({ length: SHOPIFY_VARIANT_LIMIT + 1 }, (_, i) => ({ productId: `p${i}`, sku: `S${i}`, values: { color: 'color:black', size: `size:${i}` } }))
    const plan = planColourProducts(gale({ variants, valueOrder: {}, valueLabels: { 'color:black': 'Nero' } }), COLOUR_SPLIT)
    expect(plan.issues).toEqual([expect.objectContaining({ code: 'too-many-variants', key: 'color:black', message: `"Nero" has ${SHOPIFY_VARIANT_LIMIT + 1} variants; Nexus publishes at most ${SHOPIFY_VARIANT_LIMIT} per Shopify product.` })])
  })

  it('group size: a warning above what the theme shows, an error above what Shopify can list', () => {
    const family = (count: number) => gale({ variants: Array.from({ length: count }, (_, i) => ({ productId: `p${i}`, sku: `S${i}`, values: { color: `color:c${i}`, size: 'size:m' } })),
      valueOrder: {}, valueLabels: { 'size:m': 'M' } })
    expect(codes(planColourProducts(family(IMPACT_LINKED_SHOWN_LIMIT), COLOUR_SPLIT))).toEqual([])
    expect(planColourProducts(family(IMPACT_LINKED_SHOWN_LIMIT + 1), COLOUR_SPLIT).issues).toEqual([expect.objectContaining({ severity: 'warning', code: 'more-than-shown' })])
    expect(planColourProducts(family(SHOPIFY_LINKED_LIST_LIMIT + 1), COLOUR_SPLIT).issues).toEqual([expect.objectContaining({ severity: 'error', code: 'too-many-products' })])
  })
})

describe('matchColourProducts — Find: the Shopify product of each colour, the variant of each size', () => {
  // The live GALE shape: two linked products, 9 sizes each (no XXS), Black with SKUs on 7 variants, Yellow with none.
  const LIVE_SIZES = SIZES.filter(s => s !== 'XXS')
  const shopify = (id: string, colourName: string, skuFor: (s: string) => string | null): ColourCandidate => ({ id, title: 'GALE jacket', handle: id, status: 'ACTIVE', colourName,
    group: ['gid://shopify/Product/black', 'gid://shopify/Product/yellow'],
    variants: LIVE_SIZES.map(s => ({ id: `${id}/${s}`, sku: skuFor(s), inventoryItemId: `${id}/inv/${s}`, options: [s] })) })
  const black = shopify('gid://shopify/Product/black', 'Black', s => ['S', '3XL'].includes(s) ? null : `GALE-JACKET-BLACK-MEN-${s}`)
  const yellow = shopify('gid://shopify/Product/yellow', 'Yellow', () => null)
  const plan = planColourProducts(gale(), COLOUR_SPLIT)

  it('GALE: Black by its SKUs, Yellow as the one colour and the one product left in the group; XXS missing; SKUs to write', () => {
    const [nero, giallo] = matchColourProducts(plan, [black, yellow])
    expect(nero).toMatchObject({ key: 'color:black', shopifyProductId: black.id, method: 'sku', shopifyColourName: 'Black', extra: [], issues: [] })
    expect(nero.variants).toHaveLength(9)
    expect(nero.variants.filter(v => v.by === 'options').map(v => v.sku)).toEqual(['GALE-JACKET-BLACK-MEN-S', 'GALE-JACKET-BLACK-MEN-3XL'])
    expect(nero.skusToWrite).toEqual([{ shopifyVariantId: `${black.id}/S`, sku: 'GALE-JACKET-BLACK-MEN-S' }, { shopifyVariantId: `${black.id}/3XL`, sku: 'GALE-JACKET-BLACK-MEN-3XL' }])
    expect(nero.missing).toEqual([{ productId: 'p-BLACK-XXS', sku: 'GALE-JACKET-BLACK-MEN-XXS', options: ['XXS'] }])
    expect(giallo).toMatchObject({ key: 'color:yellow', shopifyProductId: yellow.id, method: 'group', shopifyColourName: 'Yellow', issues: [] })
    expect(giallo.variants.every(v => v.by === 'options')).toBe(true)
    expect(giallo.skusToWrite).toHaveLength(9)
    expect(giallo.missing.map(m => m.sku)).toEqual(['GALE-JACKET-YELLOW-MEN-XXS'])
    // Every matched variant carries its inventory item: stock sync needs it.
    expect(nero.variants.find(v => v.sku === 'GALE-JACKET-BLACK-MEN-M')).toMatchObject({ shopifyVariantId: `${black.id}/M`, inventoryItemId: `${black.id}/inv/M`, by: 'sku' })
  })

  it('an existing link wins; the operator\'s colour name matches a product by its colour', () => {
    const named = planColourProducts(gale(), { ...COLOUR_SPLIT, colourNames: { 'color:black': 'Black', 'color:yellow': 'Yellow' } })
    const noSkus = { ...black, variants: black.variants.map(v => ({ ...v, sku: null })) }
    expect(matchColourProducts(named, [noSkus, yellow]).map(m => [m.key, m.method, m.shopifyProductId])).toEqual([['color:black', 'name', black.id], ['color:yellow', 'name', yellow.id]])
    expect(matchColourProducts(plan, [noSkus, yellow], { 'color:yellow': black.id }).map(m => [m.method, m.shopifyProductId])).toEqual([['group', yellow.id], ['linked', black.id]])
  })

  it('nothing to go on: no product, every size missing, no guess', () => {
    const noSkus = { ...black, variants: black.variants.map(v => ({ ...v, sku: null })), colourName: 'Nero opaco' }
    const matches = matchColourProducts(plan, [noSkus])
    expect(matches.map(m => m.shopifyProductId)).toEqual([null, null])
    expect(matches[0].missing).toHaveLength(10)
  })

  it('refuses a colour whose SKUs sit in two products, and a product two colours claim', () => {
    const split = { ...yellow, id: 'gid://shopify/Product/other', variants: [{ id: 'o/1', sku: 'GALE-JACKET-BLACK-MEN-XL', inventoryItemId: null, options: ['XL'] }] }
    expect(matchColourProducts(plan, [black, split])[0]).toMatchObject({ shopifyProductId: null, issues: [expect.objectContaining({ code: 'sku-spread' })] })
    const both = { ...black, variants: [...black.variants, { id: 'b/y', sku: 'GALE-JACKET-YELLOW-MEN-M', inventoryItemId: null, options: ['Yellow M'] }] }
    const claimed = matchColourProducts(plan, [both, yellow])
    expect(claimed.map(m => [m.shopifyProductId, m.issues.map(i => i.code)])).toEqual([[null, ['product-claimed-twice']], [null, ['product-claimed-twice']]])
  })

  it('flags a Shopify SKU that differs from Nexus, or belongs to another colour; never counts it as a SKU to write', () => {
    const differs = { ...black, variants: black.variants.map(v => v.options[0] === 'S' ? { ...v, sku: 'OLD-S' } : v) }
    const [nero] = matchColourProducts(plan, [differs, yellow])
    expect(nero.issues).toEqual([expect.objectContaining({ code: 'sku-differs', productIds: ['p-BLACK-S'] })])
    expect(nero.skusToWrite.map(s => s.sku)).toEqual(['GALE-JACKET-BLACK-MEN-3XL'])
    // A Black SKU inside the Yellow product: Black's SKUs are then in two products, and that is said first.
    const mixed = { ...yellow, variants: yellow.variants.map(v => v.options[0] === 'L' ? { ...v, sku: 'GALE-JACKET-BLACK-MEN-XXS' } : v) }
    expect(matchColourProducts(plan, [black, mixed])[0].issues.map(i => i.code)).toEqual(['sku-spread'])
    // With both products already linked, the Yellow variant is said to carry another colour's SKU.
    const giallo = matchColourProducts(plan, [black, mixed], { 'color:black': black.id, 'color:yellow': mixed.id })[1]
    expect(giallo.issues).toEqual([expect.objectContaining({ code: 'sku-of-another-colour', productIds: ['p-YELLOW-L'] })])
    expect(giallo.skusToWrite.map(s => s.sku)).not.toContain('GALE-JACKET-YELLOW-MEN-L')
  })

  it('a colour-only family: each product\'s one "Default Title" variant is its variant', () => {
    const colourOnly = planColourProducts(gale({ axes: [{ code: 'color', label: 'Colore' }], variants: COLOURS.map(c => ({ productId: `p-${c.sku}`, sku: `CAP-${c.sku}`, values: { color: c.key } })) }), COLOUR_SPLIT)
    const cap = (id: string, colourName: string): ColourCandidate => ({ id, title: 'Cap', handle: id, status: 'ACTIVE', colourName, group: [], variants: [{ id: `${id}/v`, sku: null, inventoryItemId: null, options: ['Default Title'] }] })
    const [a, b] = matchColourProducts(planColourProducts(gale({ axes: [{ code: 'color', label: 'Colore' }], variants: COLOURS.map(c => ({ productId: `p-${c.sku}`, sku: `CAP-${c.sku}`, values: { color: c.key } })) }), { ...COLOUR_SPLIT, colourNames: { 'color:black': 'Black', 'color:yellow': 'Yellow' } }), [cap('c/1', 'Black'), cap('c/2', 'Yellow')])
    expect(colourOnly.products.map(p => p.options)).toEqual([[], []])
    expect([a.variants[0]?.shopifyVariantId, b.variants[0]?.shopifyVariantId]).toEqual(['c/1/v', 'c/2/v'])
    expect(a.skusToWrite).toEqual([{ shopifyVariantId: 'c/1/v', sku: 'CAP-BLACK' }])
  })
})
