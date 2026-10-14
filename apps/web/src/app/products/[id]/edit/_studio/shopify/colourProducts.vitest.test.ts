import { describe, expect, it } from 'vitest'
import { colourRows, confirmBlockers, confirmWrites, fullSyncEffects, sizesInOrder, syncWords, type ColourProposal, type ColourView } from './colourProducts'

// An invented family: two colours × three sizes; every id is made up.
const sizes = (colour: string) => ['S', 'M', 'L'].map(s => ({ productId: `p-${colour}-${s}`, sku: `JACKET-${colour}-${s}`, options: [s] }))
const proposal = (patch: Partial<ColourProposal> = {}): ColourProposal => ({
  method: 'operator', shopifyProductId: 'gid://shopify/Product/1', title: 'Jacket grey men', handle: 'jacket-grey-men', status: 'ACTIVE', shopifyColourName: 'Grey',
  variants: ['S', 'M'].map(s => ({ productId: `p-GREY-${s}`, sku: `JACKET-GREY-${s}`, shopifyVariantId: `v-${s}`, inventoryItemId: `i-${s}`, shopifySku: null, by: 'options' as const })),
  missing: [{ productId: 'p-GREY-L', sku: 'JACKET-GREY-L', options: ['L'] }], extra: [{ shopifyVariantId: 'v-XL', sku: null, options: ['XL'] }],
  skusToWrite: [{ shopifyVariantId: 'v-S', sku: 'JACKET-GREY-S' }, { shopifyVariantId: 'v-M', sku: 'JACKET-GREY-M' }], skusToRecord: [], skusToReplace: [], chosenProductId: 'gid://shopify/Product/1', issues: [],
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
    expect(confirmWrites(grey, false)).toMatchObject({ product: 'Jacket grey men', skus: [{ size: 'S', sku: 'JACKET-GREY-S' }, { size: 'M', sku: 'JACKET-GREY-M' }], replaced: [], recorded: [] })
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
  it('the review warns first that the swatch names and groups are rewritten, naming the store\'s two fields', () => {
    const effects = fullSyncEffects(view([], { linked: true, adoptOnly: true }))
    expect(effects[0]).toContain('custom.variation_value')
    expect(effects[0]).toContain('custom.variation_products')
    expect(effects[0]).toContain('are replaced')
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
