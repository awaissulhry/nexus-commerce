import { describe, expect, it } from 'vitest'
import { variationFamilyFromMedia, type MediaFamilyRead } from './variationFamilyLoader'

/* Made-up family: Colore (Nero, Giallo, one value outside the dictionary) × Taglia. */
const read: MediaFamilyRead = {
  family: {
    defaultAxis: 'color',
    axes: [
      { code: 'color', label: 'Colore', dictionary: true, values: [{ key: 'color:black', label: 'Nero' }, { key: 'color:yellow', label: 'Giallo' }, { key: 'color:text:camo', label: 'Camo' }] },
      { code: 'size', label: 'Taglia', dictionary: true, values: [{ key: 'size:s', label: 'S' }, { key: 'size:m', label: 'M' }] },
    ],
    variants: [
      { productId: 'v1', sku: 'SAMPLE-NERO-S', values: { color: 'color:black', size: 'size:s' } },
      { productId: 'v2', sku: 'SAMPLE-NERO-M', values: { color: 'color:black', size: 'size:m' } },
      { productId: 'v3', sku: 'SAMPLE-GIALLO-S', values: { color: 'color:yellow', size: 'size:s' } },
      { productId: 'v4', sku: 'SAMPLE-CAMO', values: { color: 'color:text:camo' } },
    ],
  },
  library: [
    { id: 'a1', productId: 'v1', url: 'https://x/v1-side.png', isPrimary: false },
    { id: 'a2', productId: 'v1', url: 'https://x/v1-front.png', isPrimary: true },
    { id: 'a3', productId: 'v3', url: 'https://x/v3.png' },
    { id: 'a4', productId: 'root', url: 'https://x/plan-giallo.png' },
    { id: 'a5', productId: 'v2', url: 'https://x/v2.mp4', mediaType: 'VIDEO' },
  ],
  layers: [{ layer: 'SHARED', plan: { sets: { values: { 'color:yellow': [{ assetId: 'a4' }] } } } }],
}

describe('the family for the variation pop-up', () => {
  const view = variationFamilyFromMedia(read)
  it('keeps the axes and their values in the saved order, with counts and option codes', () => {
    const colore = view.axes[0]
    expect(colore.values.map(v => [v.label, v.option, v.count])).toEqual([['Nero', 'black', 2], ['Giallo', 'yellow', 1], ['Camo', null, 1]])
    expect(view.axes[1].values.map(v => v.count)).toEqual([2, 1])
  })
  it('gives a value the plan’s photo first, else the first carrier’s primary photo, else none', () => {
    const [nero, giallo, camo] = view.axes[0].values
    expect(nero.photo).toBe('https://x/v1-front.png')
    expect(giallo.photo).toBe('https://x/plan-giallo.png')
    expect(camo.photo).toBeNull()
  })
  it('gives photos to the photo axis only — sizes get plain chips', () => {
    expect(view.axes[1].values.map(v => v.photo)).toEqual([null, null])
    const planOnSize = variationFamilyFromMedia({ ...read, layers: [{ layer: 'SHARED', plan: { axis: 'size', sets: {} } }] })
    expect(planOnSize.axes[0].values.every(v => v.photo === null)).toBe(true)
    expect(planOnSize.axes[1].values[0].photo).toBe('https://x/v1-front.png')
    const oneGallery = variationFamilyFromMedia({ ...read, layers: [{ layer: 'SHARED', plan: { axis: null, sets: {} } }] })
    expect(oneGallery.axes.flatMap(a => a.values).every(v => v.photo === null)).toBe(true)
  })
  it('lists every variant with its values and its own photo, never a video', () => {
    expect(view.variants.map(v => [v.label, v.photo])).toEqual([
      ['Nero · S', 'https://x/v1-front.png'],
      ['Nero · M', null],
      ['Giallo · S', 'https://x/v3.png'],
      ['Camo', null],
    ])
  })
})
