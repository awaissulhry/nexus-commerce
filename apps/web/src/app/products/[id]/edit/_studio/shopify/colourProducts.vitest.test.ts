import { describe, expect, it } from 'vitest'
import { colourNameClash, colourNameToSend, colourRows, confirmBlockers, confirmWrites, defaultColourName, fullSyncEffects, sizeMapAxes, sizeMapOf, sizesInOrder, swatchGroupWords, syncWords, type ColourProposal, type ColourView } from './colourProducts'

// An invented family: two colours × three sizes; every id is made up.
const sizes = (colour: string) => ['S', 'M', 'L'].map(s => ({ productId: `p-${colour}-${s}`, sku: `JACKET-${colour}-${s}`, options: [s] }))
const proposal = (patch: Partial<ColourProposal> = {}): ColourProposal => ({
  method: 'operator', shopifyProductId: 'gid://shopify/Product/1', title: 'Jacket grey men', handle: 'jacket-grey-men', status: 'ACTIVE', shopifyColourName: 'Grey',
  variants: ['S', 'M'].map(s => ({ productId: `p-GREY-${s}`, sku: `JACKET-GREY-${s}`, shopifyVariantId: `v-${s}`, inventoryItemId: `i-${s}`, shopifySku: null, by: 'options' as const })),
  missing: [{ productId: 'p-GREY-L', sku: 'JACKET-GREY-L', options: ['L'] }], extra: [{ shopifyVariantId: 'v-XL', sku: null, options: ['XL'] }],
  skusToWrite: [{ shopifyVariantId: 'v-S', sku: 'JACKET-GREY-S' }, { shopifyVariantId: 'v-M', sku: 'JACKET-GREY-M' }], skusToReplace: [], chosenProductId: 'gid://shopify/Product/1', issues: [],
  ...patch,
})
const view = (rows: ColourView['colourProducts'], sync = { linked: false, adoptOnly: false }): ColourView => ({
  familyId: 'fam', accountId: 'acc', sync,
  settings: { enabled: true, method: 'theme-metafields', valueField: { namespace: 'custom', key: 'variation_value' }, listField: { namespace: 'custom', key: 'variation_products' }, revision: 'r1' },
  plan: { mode: 'colour-products', splitAxis: 'color', issues: [], products: [
    { key: 'color:grey', position: 0, nexusValue: 'Grigio | Uomo', colourName: 'Grigio | Uomo', variants: 3, sizes: sizes('GREY') },
    { key: 'color:black', position: 1, nexusValue: 'Nero | Uomo', colourName: 'Nero | Uomo', variants: 3, sizes: sizes('BLACK') },
  ] },
  colourProducts: rows,
})
const row = (valueKey: string, state: any, p: ColourProposal | null, shopifyProductId: string | null = null) => ({ id: `row-${valueKey}`, valueKey, colourName: null, state, shopifyProductId, remoteStatus: null, proposal: p })

describe('colour rows', () => {
  it('a chosen product: its title, status, the colour it shows, the size pairing, Shopify-only sizes, and what Confirm writes', () => {
    const [grey, black] = colourRows(view([row('color:grey', 'PROPOSED', proposal())]))
    expect(grey).toMatchObject({ status: 'proposed', chosenByOperator: true, matched: 2,
      product: { id: 'gid://shopify/Product/1', title: 'Jacket grey men', status: 'ACTIVE', showsColour: 'Grey', how: 'Chosen by you' } })
    expect(grey.pairs.map(p => [p.size, p.shopify?.by ?? null])).toEqual([['S', 'options'], ['M', 'options'], ['L', null]])
    expect(grey.shopifyOnly).toEqual(['XL'])
    expect(confirmBlockers(grey, false)).toEqual([])
    expect(confirmWrites(grey, false)).toMatchObject({ product: 'Jacket grey men', skus: [{ size: 'S', sku: 'JACKET-GREY-S' }, { size: 'M', sku: 'JACKET-GREY-M' }], replaced: [] })
    expect(black).toMatchObject({ status: 'none', product: null })
    expect(confirmBlockers(black, false)).toEqual(['Choose its Shopify product first.'])
  })

  it('no size matches (EU sizes against letter sizes): said plainly, with both size lists, and Confirm is blocked', () => {
    const p = proposal({ variants: [], skusToWrite: [], missing: sizes('GREY').map(s => ({ ...s })), extra: ['XS', 'M', '5XL'].map(s => ({ shopifyVariantId: `v-${s}`, sku: null, options: [s] })) })
    const [grey] = colourRows(view([row('color:grey', 'PROPOSED', p)]))
    expect(grey.noSizeMatch).toBe('No size of "Grigio | Uomo" matches a size of "Jacket grey men". Nexus sizes: S, M, L. Shopify sizes: XS, M, 5XL.')
    expect(confirmBlockers(grey, false)).toContain(grey.noSizeMatch)
  })

  it('other SKUs on the chosen product block Confirm until the operator asks to replace them; then the review lists each old → new', () => {
    const p = proposal({ skusToWrite: [], variants: proposal().variants.map(v => ({ ...v, shopifySku: v.sku.replace('GREY', 'BLACK') })),
      skusToReplace: [{ productId: 'p-GREY-S', shopifyVariantId: 'v-S', from: 'JACKET-BLACK-S', to: 'JACKET-GREY-S' }, { productId: 'p-GREY-M', shopifyVariantId: 'v-M', from: 'JACKET-BLACK-M', to: 'JACKET-GREY-M' }] })
    const [grey] = colourRows(view([row('color:grey', 'PROPOSED', p)]))
    expect(confirmBlockers(grey, false)).toEqual(['Its Shopify sizes carry other SKUs: choose to replace them with the Nexus SKUs, or change them in Shopify.'])
    expect(confirmBlockers(grey, true)).toEqual([])
    expect(confirmWrites(grey, true).replaced).toEqual([{ size: 'S', from: 'JACKET-BLACK-S', to: 'JACKET-GREY-S' }, { size: 'M', from: 'JACKET-BLACK-M', to: 'JACKET-GREY-M' }])
    expect(confirmWrites(grey, false).replaced).toEqual([])
  })

  it('a linked colour: no Confirm; issues of a proposal block it', () => {
    const [grey, black] = colourRows(view([row('color:grey', 'LINKED', proposal({ method: 'linked', chosenProductId: null }), 'gid://shopify/Product/1'),
      row('color:black', 'PROPOSED', proposal({ shopifyProductId: 'gid://shopify/Product/2', variants: proposal().variants.map(v => ({ ...v, productId: v.productId.replace('GREY', 'BLACK') })),
        issues: [{ message: 'Two products hold these SKUs.' }] }))], { linked: true, adoptOnly: true }))
    expect(grey).toMatchObject({ status: 'linked', chosenByOperator: false, product: { how: 'Linked' } })
    expect(confirmBlockers(grey, false)).toEqual(['Already linked.'])
    expect(confirmBlockers(black, false)).toEqual(['Two products hold these SKUs.'])
  })
})

describe('the family\'s sync state and Start full sync', () => {
  it('adopt only says nothing else is written; full sync says what runs', () => {
    expect(syncWords(view([])).label).toBe('Not linked')
    expect(syncWords(view([], { linked: true, adoptOnly: true }))).toMatchObject({ label: 'Linked (adopt only)', tone: 'info' })
    expect(syncWords(view([], { linked: true, adoptOnly: true })).text).toContain('no colour swatches')
    expect(syncWords(view([], { linked: true, adoptOnly: false })).label).toBe('Full sync')
  })
  it('the review says first what the swatch writer does: the store\'s two fields, one list per swatch group the store has, no merge', () => {
    const effects = fullSyncEffects(view([], { linked: true, adoptOnly: true }))
    expect(effects[0]).toContain('custom.variation_value')
    expect(effects[0]).toContain('custom.variation_products')
    expect(effects[0]).toContain('keeps the swatch group it has on the store today (for example men\'s and women\'s colours stay apart)')
    expect(effects[0]).toContain('each group gets one list of its own linked colours')
    expect(effects[0]).toContain('in the order the store lists them today (a colour new to the group goes last')
    expect(effects[0]).not.toMatch(/one swatch group with every colour|are replaced/)
    expect(effects.join(' ')).toMatch(/Stock and prices.*Sizes.*Archive.*paused yourself stays paused/)
  })
})

describe('the size order', () => {
  // The GALE jacket family: a free-text size axis, so the plan lists its sizes A–Z by SKU.
  const az = ['3XL', '4XL', '5XL', 'L', 'M', 'S', 'XL', 'XS', 'XXL', 'XXS']
  const product = (axis: string, labels: string[]) => ({ key: 'colore:text:nero', position: 0, nexusValue: 'Nero', colourName: 'Nero', variants: labels.length,
    sizes: labels.map(s => ({ productId: `p-${s}`, sku: `GALE-JACKET-BLACK-MEN-${s}`, options: [s] })), options: [{ axis, name: 'Taglia', values: labels }] })

  it('a free-text size axis: the pairing lists garment size order (XXS … 5XL), not A–Z', () => {
    expect(sizesInOrder(product('taglia', az), []).map(s => s.options[0])).toEqual(['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'])
    const v = { ...view([]), plan: { ...view([]).plan, products: [product('taglia', az)], orderedAxes: [] } }
    expect(colourRows(v)[0].pairs.map(p => p.size)).toEqual(['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'])
  })

  it('an axis the family orders keeps the plan\'s order, whatever it is', () => {
    expect(sizesInOrder(product('size', ['L', 'S', 'M']), ['size']).map(s => s.options[0])).toEqual(['L', 'S', 'M'])
  })

})

describe('the colour name and the swatch groups (REGAL: men [Grey, Black], women [Grey, Gray])', () => {
  const regal = (): ColourView => ({ ...view([]), plan: { mode: 'colour-products', splitAxis: 'color', issues: [], swatchGroups: 2, products: [
    { key: 'nu', position: 0, nexusValue: 'Nero | Uomo', colourName: 'Black', variants: 1, swatchGroup: 0 },
    { key: 'nd', position: 1, nexusValue: 'Nero | Donna', colourName: 'Nero | Donna', variants: 1, swatchGroup: 1 },
    { key: 'gu', position: 2, nexusValue: 'Grigio | Uomo', colourName: 'Grey', variants: 1, swatchGroup: 0 },
    { key: 'gd', position: 3, nexusValue: 'Grigio | Donna', colourName: 'Grey', variants: 1, swatchGroup: 1 },
  ] }, colourProducts: [row('nd', 'PROPOSED', proposal({ shopifyColourName: 'Gray' }))] })

  it('the name starts as the one the product shows; a repeat inside the group is flagged, the store\'s own name and other groups are not', () => {
    const v = regal(), nd = colourRows(v).find(m => m.key === 'nd')!
    expect(defaultColourName(nd)).toBe('Gray')
    expect(colourNameClash(v, nd, 'Gray')).toBeNull()
    expect(colourNameClash(v, nd, 'Black')).toBeNull()
    expect(colourNameClash(v, nd, ' grey ')).toBe('"Nero | Donna" would be called "grey" on Shopify, like "Grigio | Donna" in the same swatch group. Give it its own name.')
    expect(swatchGroupWords(v, nd)).toBe('Group 2 of 2: Nero | Donna, Grigio | Donna')
    // Confirm sends the name shown, typed or not; a colour the store names nothing keeps following its Nexus value.
    expect([colourNameToSend(nd, ' Gray '), colourNameToSend(nd, 'Anthracite')]).toEqual(['Gray', 'Anthracite'])
    const unnamed = colourRows({ ...v, colourProducts: [row('nd', 'PROPOSED', proposal({ shopifyColourName: null }))] }).find(m => m.key === 'nd')!
    expect([defaultColourName(unnamed), colourNameToSend(unnamed, 'Nero | Donna'), colourNameToSend(unnamed, 'Black')]).toEqual(['Nero | Donna', undefined, 'Black'])
    expect(swatchGroupWords(view([]), colourRows(view([]))[0])).toBeNull()
  })
})

describe('the size map (MISANO: EU sizes in Nexus, letter sizes on Shopify)', () => {
  const eu = ['44', '46', '48']
  const misano = (sizeMap = {}): ColourView => ({ ...view([row('nero', 'PROPOSED', proposal({ variants: [], skusToWrite: [], missing: [],
    extra: ['XS', 'S', 'M'].map(s => ({ shopifyVariantId: `v-${s}`, sku: null, options: [s] })) }))]), sizeMap,
  plan: { mode: 'colour-products', splitAxis: 'color', issues: [], orderedAxes: ['size'], products: [
    { key: 'nero', position: 0, nexusValue: 'Nero', colourName: 'Nero', variants: 3, options: [{ axis: 'size', name: 'Taglia', values: eu }], sizes: eu.map(s => ({ productId: `p-${s}`, sku: `MISANO-${s}`, options: [s] })) },
    { key: 'marrone', position: 1, nexusValue: 'Marrone', colourName: 'Marrone', variants: 2, options: [{ axis: 'size', name: 'Taglia', values: ['44', '50'] }] },
  ] } })

  it('nothing pairs: "Pair sizes…" is offered with every Nexus size of the family and the Shopify sizes as choices; the choices become the map', () => {
    const [nero] = colourRows(misano())
    expect(nero.canPairSizes).toBe(true)
    const axes = sizeMapAxes(misano(), nero)
    expect(axes).toEqual([{ axis: 'size', name: 'Taglia', values: ['44', '46', '48', '50'].map(nexus => ({ nexus, shopify: null })), choices: ['XS', 'S', 'M'] }])
    const chosen = [{ ...axes[0], values: axes[0].values.map(v => ({ ...v, shopify: ({ '44': 'XS', '46': 'S', '48': 'M', '50': '50' } as Record<string, string>)[v.nexus] })) }]
    expect(sizeMapOf(chosen)).toEqual({ size: { '44': 'XS', '46': 'S', '48': 'M' } })
    expect(sizeMapOf(axes)).toEqual({})
  })

  it('paired through the map: each size shows its Shopify size; the saved map is offered for editing', () => {
    const v = misano({ size: { '44': 'XS' } })
    v.plan.products[0].sizes![0].shopify = ['XS']
    const [nero] = colourRows(v)
    expect(nero.pairs[0]).toMatchObject({ size: '44', shopifySize: 'XS' })
    expect(sizeMapAxes(v, nero)[0].values[0]).toEqual({ nexus: '44', shopify: 'XS' })
    expect(nero.canPairSizes).toBe(true)
    // Every size paired and no map: nothing to pair.
    const [grey] = colourRows(view([row('color:grey', 'PROPOSED', proposal({ missing: [], extra: [] }))]))
    expect(grey.canPairSizes).toBe(false)
  })
})

describe('a Shopify SKU in another letter case', () => {
  it('is a SKU Nexus writes (its own spelling), shown with the one it replaces; nothing is recorded from Shopify', () => {
    const p = proposal({ skusToWrite: [{ shopifyVariantId: 'v-S', sku: 'JACKET-GREY-S' }, { shopifyVariantId: 'v-M', sku: 'JACKET-GREY-M', from: 'jacket-grey-m' }] })
    const [grey] = colourRows(view([row('color:grey', 'PROPOSED', p)]))
    expect(confirmBlockers(grey, false)).toEqual([])
    expect(confirmWrites(grey, false)).toEqual({ product: 'Jacket grey men', identity: expect.any(String), replaced: [],
      skus: [{ size: 'S', sku: 'JACKET-GREY-S' }, { size: 'M', sku: 'JACKET-GREY-M', from: 'jacket-grey-m' }] })
  })
})
