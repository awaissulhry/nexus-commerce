import { describe, expect, it } from 'vitest'
import { IMPACT_LINKED_SHOWN_LIMIT, matchColourProducts, planColourProducts, SHOPIFY_LINKED_LIST_LIMIT, SHOPIFY_VARIANT_LIMIT, swatchGroupsOf, type ColourCandidate, type ColourPlanFamily, type ColourPlanVariant, type ColourSwatch } from './shopify-colour-products.js'

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

  it('two colours with the same Shopify name are refused, each colour by its own key (neither name is the store\'s)', () => {
    const plan = planColourProducts(gale(), { ...COLOUR_SPLIT, colourNames: { 'color:black': 'Black', 'color:yellow': ' black' } })
    expect(plan.issues).toEqual([
      expect.objectContaining({ code: 'duplicate-colour-name', key: 'color:black', message: '"Nero" would be called "Black" on Shopify, like "Giallo" in the same swatch group. Give it its own name.' }),
      expect.objectContaining({ code: 'duplicate-colour-name', key: 'color:yellow', message: '"Giallo" would be called "black" on Shopify, like "Nero" in the same swatch group. Give it its own name.' }),
    ])
    expect(plan.issues.map(i => i.productIds.length)).toEqual([10, 10])
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

  it('the operator\'s chosen product outranks the name and group guesses; its sizes still match by SKU, then by option', () => {
    // A store that holds men's and women's colours in one group: no SKUs, the same colour names, so nothing is guessed.
    const noSkus = { ...black, variants: black.variants.map(v => ({ ...v, sku: null })) }
    const group = [...black.group, 'gid://shopify/Product/black-women']
    const women = { ...noSkus, id: 'gid://shopify/Product/black-women', title: 'GALE jacket women', group }
    const yellowOfGroup = { ...yellow, group }
    const named = planColourProducts(gale(), { ...COLOUR_SPLIT, colourNames: { 'color:black': 'Black', 'color:yellow': 'Yellow' } })
    expect(matchColourProducts(named, [noSkus, women, yellowOfGroup])[0]).toMatchObject({ shopifyProductId: null, method: null })
    const [nero, giallo] = matchColourProducts(named, [noSkus, women, yellowOfGroup], {}, { 'color:black': noSkus.id })
    expect(nero).toMatchObject({ shopifyProductId: noSkus.id, method: 'operator', issues: [] })
    expect(nero.skusToWrite).toHaveLength(9)
    expect(giallo).toMatchObject({ shopifyProductId: yellow.id, method: 'name' })
    // By SKU first: the chosen product's SKUs pair with their sizes, the SKU-less ones by option values.
    const [chosen] = matchColourProducts(plan, [black, yellow], {}, { 'color:black': black.id })
    expect(chosen.variants.filter(v => v.by === 'sku')).toHaveLength(7)
    expect(chosen.skusToWrite.map(s => s.sku)).toEqual(['GALE-JACKET-BLACK-MEN-S', 'GALE-JACKET-BLACK-MEN-3XL'])
    // A choice outranks the SKUs too, but a colour whose SKUs sit in another product is an issue, never a silent pick.
    const [elsewhere] = matchColourProducts(plan, [black, yellow], {}, { 'color:black': yellow.id })
    expect(elsewhere).toMatchObject({ shopifyProductId: yellow.id, method: 'operator', issues: [expect.objectContaining({ code: 'sku-outside-choice' })] })
    // An existing link still wins; a chosen product the store does not return is named.
    expect(matchColourProducts(plan, [black, yellow], { 'color:black': black.id }, { 'color:black': yellow.id })[0].method).toBe('linked')
    expect(matchColourProducts(plan, [black, yellow], {}, { 'color:yellow': 'gid://shopify/Product/404' })[1].issues.map(i => i.code)).toEqual(['chosen-not-found'])
  })

  it('a chosen product whose sizes carry other SKUs (another colour\'s, another prefix): offered for replacement, never a claim', () => {
    // The store's Yellow product holds the Black SKUs; Black's own product holds none.
    const blackNoSkus = { ...black, variants: black.variants.map(v => ({ ...v, sku: null })) }
    const yellowWithBlack = { ...yellow, variants: yellow.variants.map(v => ({ ...v, sku: `GALE-JACKET-BLACK-MEN-${v.options[0]}` })) }
    // Without a choice the Black SKUs pull Black onto the Yellow product, and Yellow's own sizes say so.
    expect(matchColourProducts(plan, [blackNoSkus, yellowWithBlack])[0]).toMatchObject({ shopifyProductId: yellowWithBlack.id, method: 'sku' })
    const [nero, giallo] = matchColourProducts(plan, [blackNoSkus, yellowWithBlack], {}, { 'color:yellow': yellowWithBlack.id, 'color:black': blackNoSkus.id })
    expect(giallo).toMatchObject({ shopifyProductId: yellowWithBlack.id, method: 'operator', issues: [], skusToWrite: [] })
    expect(giallo.skusToReplace).toHaveLength(9)
    expect(giallo.skusToReplace[0]).toEqual({ productId: 'p-YELLOW-XS', shopifyVariantId: `${yellow.id}/XS`, from: 'GALE-JACKET-BLACK-MEN-XS', to: 'GALE-JACKET-YELLOW-MEN-XS' })
    // The product chosen for Yellow is not Black's by its SKUs, and Black's SKUs there are Yellow's to replace.
    expect(nero).toMatchObject({ shopifyProductId: blackNoSkus.id, method: 'operator', issues: [] })
    expect(nero.skusToWrite).toHaveLength(9)
    // Only Yellow chosen: Black is not pulled onto it by its SKUs; the group's one product left is Black's.
    expect(matchColourProducts(plan, [blackNoSkus, yellowWithBlack], {}, { 'color:yellow': yellowWithBlack.id })[0]).toMatchObject({ shopifyProductId: blackNoSkus.id, method: 'group', issues: [] })
    // A prefix-only difference is the same offer.
    const prefixed = { ...black, variants: black.variants.map(v => ({ ...v, sku: `IT-GALE-JACKET-BLACK-MEN-${v.options[0]}` })) }
    const [prefixedNero] = matchColourProducts(plan, [prefixed, yellow], {}, { 'color:black': prefixed.id })
    expect(prefixedNero.issues).toEqual([])
    expect(prefixedNero.skusToReplace.map(r => `${r.from}>${r.to}`)).toContain('IT-GALE-JACKET-BLACK-MEN-M>GALE-JACKET-BLACK-MEN-M')
    // Not chosen by the operator: the same difference stays an issue, nothing is offered.
    const [guessed] = matchColourProducts(plan, [prefixed, yellow], { 'color:black': prefixed.id })
    expect(guessed.skusToReplace).toEqual([])
    expect(guessed.issues.map(i => i.code)).toContain('sku-differs')
  })

  it('a Shopify SKU that differs only in letter case: Nexus writes its own spelling there (Shopify follows Nexus; nothing is recorded from Shopify)', () => {
    const lower = { ...black, variants: black.variants.map(v => v.options[0] === 'M' ? { ...v, sku: 'gale-jacket-black-men-m' } : v) }
    const [nero] = matchColourProducts(plan, [lower, yellow])
    expect(nero.issues).toEqual([])
    expect(nero.variants.find(v => v.productId === 'p-BLACK-M')).toMatchObject({ by: 'sku', shopifySku: 'gale-jacket-black-men-m' })
    expect(nero.skusToWrite).toContainEqual({ shopifyVariantId: `${black.id}/M`, sku: 'GALE-JACKET-BLACK-MEN-M', from: 'gale-jacket-black-men-m' })
    expect(nero).not.toHaveProperty('skusToRecord')
    // Surrounding spaces are not a case difference: nothing is offered (Confirm refuses it, as before).
    const spaced = { ...black, variants: black.variants.map(v => v.options[0] === 'M' ? { ...v, sku: ' GALE-JACKET-BLACK-MEN-M' } : v) }
    expect(matchColourProducts(plan, [spaced, yellow])[0].skusToWrite.map(s => s.sku)).not.toContain('GALE-JACKET-BLACK-MEN-M')
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

/**
 * Feature 1 — the store's swatch groups and names. REGAL (invented ids): Nexus colours "Nero | Uomo", "Nero | Donna",
 * "Grigio | Uomo", "Grigio | Donna"; Shopify has two groups, men [Grey, Black] and women [Grey, Gray]. AIREON: one group
 * of four (two jackets, two pants) whose names repeat, "Crema e Vino" and "Nero Neo" twice each.
 */
describe('swatch groups — each colour keeps the group and the name the store shows', () => {
  const gid = (n: number) => `gid://shopify/Product/${n}`
  const family = (colours: Array<[string, string]>): ColourPlanFamily => ({
    familyId: 'f', axes: [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }],
    variants: colours.flatMap(([key]) => ['S', 'M'].map(s => ({ productId: `p-${key}-${s}`, sku: `${key}-${s}`, values: { color: key, size: size(s) } }))),
    valueOrder: { color: colours.map(([key]) => key), size: ['S', 'M'].map(size) },
    valueLabels: { ...Object.fromEntries(colours), 'size:s': 'S', 'size:m': 'M' }, unmapped: [],
  })
  const REGAL = family([['nero-uomo', 'Nero | Uomo'], ['nero-donna', 'Nero | Donna'], ['grigio-uomo', 'Grigio | Uomo'], ['grigio-donna', 'Grigio | Donna']])
  const MEN = [gid(11), gid(12)], WOMEN = [gid(21), gid(22)]
  const regalStore: Record<string, ColourSwatch> = {
    'grigio-uomo': { shopifyProductId: gid(11), group: MEN, name: 'Grey' }, 'nero-uomo': { shopifyProductId: gid(12), group: MEN, name: 'Black' },
    'grigio-donna': { shopifyProductId: gid(21), group: WOMEN, name: 'Grey' }, 'nero-donna': { shopifyProductId: gid(22), group: WOMEN, name: 'Gray' },
  }
  const storeNames = (store: Record<string, ColourSwatch>) => Object.fromEntries(Object.entries(store).map(([key, s]) => [key, s.name!]))

  it('REGAL: two groups as the store has them; the names default to the store\'s, so "Grey" in both groups passes', () => {
    const plan = planColourProducts(REGAL, { splitAxis: 'color', swatches: regalStore, colourNames: storeNames(regalStore) })
    expect(plan.issues).toEqual([])
    // Each group in the order the store lists it (men [Grey, Black]), not the Nexus colour order.
    expect(plan.swatchGroups).toEqual([['grigio-uomo', 'nero-uomo'], ['grigio-donna', 'nero-donna']])
    expect(plan.products.map(p => [p.key, p.colourName, p.swatchGroup])).toEqual([['nero-uomo', 'Black', 0], ['nero-donna', 'Gray', 1], ['grigio-uomo', 'Grey', 0], ['grigio-donna', 'Grey', 1]])
    expect(plan.grouped).toBe(true)
    // Without the store's groups the old rule holds: one group, and the two "Grey" are refused.
    expect(codes(planColourProducts(REGAL, { splitAxis: 'color', colourNames: storeNames(regalStore) }))).toEqual(['duplicate-colour-name', 'duplicate-colour-name'])
  })

  it('a typed duplicate inside one group is refused for that colour only; the store\'s own names are never the cause', () => {
    const plan = planColourProducts(REGAL, { splitAxis: 'color', swatches: regalStore, colourNames: { ...storeNames(regalStore), 'nero-donna': 'Grey' } })
    expect(plan.issues).toEqual([expect.objectContaining({ severity: 'error', code: 'duplicate-colour-name', key: 'nero-donna', productIds: ['p-nero-donna-S', 'p-nero-donna-M'],
      message: '"Nero | Donna" would be called "Grey" on Shopify, like "Grigio | Donna" in the same swatch group. Give it its own name.' })])
    // The same name typed in the OTHER group is no duplicate there.
    expect(planColourProducts(REGAL, { splitAxis: 'color', swatches: regalStore, colourNames: { ...storeNames(regalStore), 'nero-donna': 'Black' } }).issues).toEqual([])
  })

  it('AIREON: one group of four with the names the store repeats: adopted as they are', () => {
    const AIREON = family([['crema-giacca', 'Crema e Vino | Giacca'], ['nero-giacca', 'Nero Neo | Giacca'], ['crema-pantaloni', 'Crema e Vino | Pantaloni'], ['nero-pantaloni', 'Nero Neo | Pantaloni']])
    const group = [gid(31), gid(32), gid(33), gid(34)]
    const store: Record<string, ColourSwatch> = {
      'crema-giacca': { shopifyProductId: gid(31), group, name: 'Crema e Vino' }, 'nero-giacca': { shopifyProductId: gid(32), group, name: 'Nero Neo' },
      'crema-pantaloni': { shopifyProductId: gid(33), group, name: 'Crema e Vino' }, 'nero-pantaloni': { shopifyProductId: gid(34), group, name: 'Nero Neo' },
    }
    const plan = planColourProducts(AIREON, { splitAxis: 'color', swatches: store, colourNames: storeNames(store) })
    expect(plan.issues).toEqual([])
    expect(plan.swatchGroups).toEqual([['crema-giacca', 'nero-giacca', 'crema-pantaloni', 'nero-pantaloni']])
    // Renaming one jacket to the other jacket's name is Nexus's own duplicate: refused for it alone.
    expect(planColourProducts(AIREON, { splitAxis: 'color', swatches: store, colourNames: { ...storeNames(store), 'crema-giacca': 'Nero Neo' } }).issues.map(i => [i.code, i.key]))
      .toEqual([['duplicate-colour-name', 'crema-giacca']])
  })

  it('swatchGroupsOf: no group on the store = one group; a loose colour joins the only group; with two groups it is unplaced', () => {
    expect(swatchGroupsOf(['a', 'b'], {})).toEqual({ groups: [['a', 'b']], unplaced: [] })
    expect(swatchGroupsOf(['a', 'b', 'c'], { a: { shopifyProductId: gid(1), group: [gid(1), gid(2)] }, b: { shopifyProductId: gid(2), group: [gid(1), gid(2)] }, c: { shopifyProductId: gid(3), group: [] } }))
      .toEqual({ groups: [['a', 'b', 'c']], unplaced: [] })
    const two = { ...regalStore, extra: { shopifyProductId: gid(99), group: null } }
    expect(swatchGroupsOf(['nero-uomo', 'extra', 'grigio-uomo', 'grigio-donna', 'nero-donna'], two))
      .toEqual({ groups: [['grigio-uomo', 'nero-uomo'], ['grigio-donna', 'nero-donna']], unplaced: ['extra'] })
    // The store's order inside a group; a colour new to the group (no list names it) comes last.
    expect(swatchGroupsOf(['a', 'b', 'c'], { a: { shopifyProductId: gid(1), group: [gid(2), gid(1)] }, b: { shopifyProductId: gid(2), group: [gid(2), gid(1)] }, c: { shopifyProductId: gid(3), group: null } }))
      .toEqual({ groups: [['b', 'a', 'c']], unplaced: [] })
    // A product with no list of its own that another list names is in that group; a list of foreign products is a group of one.
    expect(swatchGroupsOf(['a', 'b', 'c'], { a: { shopifyProductId: gid(1), group: [gid(1), gid(2)] }, b: { shopifyProductId: gid(2), group: null }, c: { shopifyProductId: gid(3), group: [gid(77)] } }))
      .toEqual({ groups: [['a', 'b'], ['c']], unplaced: [] })
  })

  it('the group limits count per group', () => {
    const many = family(Array.from({ length: IMPACT_LINKED_SHOWN_LIMIT + 2 }, (_, i) => [`c${i}`, `Colour ${i}`] as [string, string]))
    const halves: Record<string, ColourSwatch> = Object.fromEntries(many.valueOrder.color.map((key, i) => {
      const half = i % 2 ? 'odd' : 'even', members = many.valueOrder.color.flatMap((_, j) => (j % 2 ? 'odd' : 'even') === half ? [gid(j)] : [])
      return [key, { shopifyProductId: gid(i), group: members }]
    }))
    expect(codes(planColourProducts(many, { splitAxis: 'color' }))).toEqual(['more-than-shown'])
    expect(codes(planColourProducts(many, { splitAxis: 'color', swatches: halves }))).toEqual([])
  })
})

/**
 * Feature 2 — the size map. MISANO (invented ids): Nexus sizes EU 44–60 (Nero 44–60, Marrone 44–54); the Shopify option
 * values are XS–5XL; no SKUs on Shopify.
 */
describe('the size map — a Nexus size paired with the Shopify value it is on the store', () => {
  const EU = ['44', '46', '48', '50', '52', '54', '56', '58', '60'], LETTERS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL']
  const MAP = { size: Object.fromEntries(EU.map((s, i) => [s, LETTERS[i]])) }
  const MISANO: ColourPlanFamily = {
    familyId: 'misano', axes: [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }],
    variants: [...EU.map(s => ({ productId: `p-nero-${s}`, sku: `MISANO-NERO-${s}`, values: { color: 'color:nero', size: `size:${s}` } })),
      ...EU.slice(0, 6).map(s => ({ productId: `p-marrone-${s}`, sku: `MISANO-MARRONE-${s}`, values: { color: 'color:marrone', size: `size:${s}` } }))],
    valueOrder: { color: ['color:nero', 'color:marrone'], size: EU.map(s => `size:${s}`) },
    valueLabels: { 'color:nero': 'Nero', 'color:marrone': 'Marrone', ...Object.fromEntries(EU.map(s => [`size:${s}`, s])) }, unmapped: [],
  }
  const candidate = (id: string, colourName: string, values: string[]): ColourCandidate => ({ id, title: `MISANO ${colourName}`, handle: id, status: 'ACTIVE', colourName, group: [],
    variants: values.map(v => ({ id: `${id}/${v}`, sku: null, inventoryItemId: `${id}/inv/${v}`, options: [v] })) })

  it('MISANO: the plan holds the Shopify values (XS…5XL) with the Nexus ones beside them, and Find pairs every size', () => {
    const plan = planColourProducts(MISANO, { splitAxis: 'color', sizeMap: MAP })
    expect(plan.issues).toEqual([])
    expect(plan.products[0].options).toEqual([{ axis: 'size', name: 'Taglia', values: LETTERS, nexusValues: EU }])
    expect(plan.products[1].variants[0]).toEqual({ productId: 'p-marrone-44', sku: 'MISANO-MARRONE-44', options: [{ name: 'Taglia', value: 'XS', nexusValue: '44' }] })
    const nero = candidate('gid://shopify/Product/41', 'Black', LETTERS), marrone = candidate('gid://shopify/Product/42', 'Brown', LETTERS.slice(0, 6))
    const matches = matchColourProducts(plan, [nero, marrone], {}, { 'color:nero': nero.id, 'color:marrone': marrone.id })
    expect(matches.map(m => [m.variants.length, m.missing.length, m.extra.length, m.issues.length])).toEqual([[9, 0, 0, 0], [6, 0, 0, 0]])
    expect(matches[0].skusToWrite[0]).toEqual({ shopifyVariantId: `${nero.id}/XS`, sku: 'MISANO-NERO-44' })
    // Without the map nothing pairs (the old refusal: "No size of … matches").
    const unmapped = matchColourProducts(planColourProducts(MISANO, { splitAxis: 'color' }), [nero, marrone], {}, { 'color:nero': nero.id, 'color:marrone': marrone.id })
    expect(unmapped.map(m => m.variants.length)).toEqual([0, 0])
  })

  it('a partial map pairs only what it names; two Nexus sizes on one Shopify value are refused', () => {
    const partial = planColourProducts(MISANO, { splitAxis: 'color', sizeMap: { size: { '44': 'XS' } } })
    expect(partial.products[1].options[0]).toEqual({ axis: 'size', name: 'Taglia', values: ['XS', '46', '48', '50', '52', '54'], nexusValues: EU.slice(0, 6) })
    const clash = planColourProducts(MISANO, { splitAxis: 'color', sizeMap: { size: { '44': 'S', '46': ' s ' } } })
    expect(clash.issues).toEqual([
      expect.objectContaining({ code: 'duplicate-option-value', key: 'color:nero', message: 'The size map pairs "44", "46" with one Shopify Taglia value, "S". Pair each with its own value.' }),
      expect.objectContaining({ code: 'duplicate-variant', key: 'color:nero' }),
      expect.objectContaining({ code: 'duplicate-option-value', key: 'color:marrone' }),
      expect.objectContaining({ code: 'duplicate-variant', key: 'color:marrone' }),
    ])
  })
})
