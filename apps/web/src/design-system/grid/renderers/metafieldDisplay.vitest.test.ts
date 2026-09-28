import { describe, expect, it } from 'vitest'
import { metafieldDisplay } from './metafieldDisplay'

/* Sheet pop-up rebuild P1: an entry carries its own picture or colour into the cell. Made-up ids. */
const green = 'gid://shopify/Metaobject/1', icon = 'gid://shopify/Metaobject/2', plain = 'gid://shopify/Metaobject/3'

describe('metafieldDisplay references', () => {
  it('carries each entry’s swatch and picture, and neither when it has none', () => {
    const d = metafieldDisplay('list.metaobject_reference', JSON.stringify([green, icon, plain]), {
      labels: { [green]: 'Green', [icon]: 'Water-repellent', [plain]: 'Plain' },
      images: { [icon]: 'https://cdn.shopify.com/s/files/icon.png' },
      swatches: { [green]: '#3c9a4b' },
    })
    expect(d.kind).toBe('references')
    if (d.kind !== 'references') return
    expect(d.items.map(i => [i.label, i.src, i.swatch, i.kind])).toEqual([
      ['Green', null, '#3c9a4b', 'entry'],
      ['Water-repellent', 'https://cdn.shopify.com/s/files/icon.png', null, 'entry'],
      ['Plain', null, null, 'entry'],
    ])
  })
  it('says the kind while names load, never the raw id', () => {
    const d = metafieldDisplay('metaobject_reference', green)
    expect(d.kind === 'references' && d.items[0]).toMatchObject({ label: 'Entry', named: false, swatch: null })
  })
})
