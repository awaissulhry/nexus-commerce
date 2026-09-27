import { describe, expect, it } from 'vitest'
import { emptyShopifyContent, resolveShopifyContent } from '@nexus/shared/shopify-content'
import { applyMediaPlanToShopifyContent } from './media-plan-content.js'

/** Images rebuild P2f — a media-plan family's Shopify gallery is exactly the plan's layout, through the real resolver. */
const files = ['cover', 'detail', 'n1', 'g1', 'model'].map(id => ({ id, url: `https://cdn.example/${id}.jpg`, mediaType: id === 'model' ? 'MODEL3D' : 'IMAGE', alt: `${id} alt` }))
const content = () => {
  const c = emptyShopifyContent(['Color'])
  c.assets = [{ id: 'cover', url: 'https://cdn.example/cover.jpg', alt: 'Edited alt', translations: { en: 'Edited EN' } }, { id: 'old', url: 'https://cdn.example/old.jpg', alt: '', translations: {} }]
  c.groups = [{ id: 'family-gallery', name: 'Family gallery', assetIds: ['old'], featuredId: 'old' }]
  c.assignments[0].gallery = { mode: 'replace', groupIds: ['family-gallery'], featuredId: null }
  return c
}
const layout = { media: ['cover', 'detail', 'n1', 'g1', 'model'], variantImages: { black: 'n1', yellow: 'g1', none: null }, checks: [] }

describe('Shopify content from the media plan', () => {
  it('the gallery is the plan in order; each variant shows its value\'s first photo; older galleries do not mix in', () => {
    const out = applyMediaPlanToShopifyContent(content(), layout, files)
    const variants = [{ id: 'black', sku: 'B', options: { Color: 'Nero' }, price: '10', stock: 1 }, { id: 'yellow', sku: 'Y', options: { Color: 'Giallo' }, price: '10', stock: 1 }]
    // The real resolver: the family sees the whole plan in order; each variant resolves to its own photo, with no conflict.
    const family = resolveShopifyContent(out, null), black = resolveShopifyContent(out, variants[0] as never), yellow = resolveShopifyContent(out, variants[1] as never)
    expect([family.conflicts, black.conflicts, yellow.conflicts]).toEqual([[], [], []])
    expect(family.assetIds).toEqual(['cover', 'detail', 'n1', 'g1', 'model'])
    expect([black.featuredId, yellow.featuredId]).toEqual(['n1', 'g1'])
    expect(out.groups[0]).toMatchObject({ id: 'media-plan', assetIds: ['cover', 'detail', 'n1', 'g1', 'model'], featuredId: 'cover' })
    expect(out.assignments.find(a => a.target?.kind === 'family')?.gallery).toEqual({ mode: 'replace', groupIds: ['media-plan'], featuredId: null, preserveOrder: true })
    expect(out.assignments.filter(a => a.target?.kind === 'variant').map(a => [(a.target as { variantId: string }).variantId, a.gallery?.featuredId])).toEqual([['black', 'n1'], ['yellow', 'g1']])
  })
  it('keeps alt text already edited in the content document, and stores 3D models as MODEL_3D', () => {
    const out = applyMediaPlanToShopifyContent(content(), layout, files)
    expect(out.assets.find(a => a.id === 'cover')).toMatchObject({ alt: 'Edited alt', translations: { en: 'Edited EN' } })
    expect(out.assets.find(a => a.id === 'model')?.type).toBe('MODEL_3D')
  })
  it('refuses a plan with a blocking problem, and a photo no longer in the library', () => {
    expect(() => applyMediaPlanToShopifyContent(content(), { ...layout, checks: [{ severity: 'error', code: 'over-limit', message: 'Too many.' }] }, files)).toThrow('Too many.')
    expect(() => applyMediaPlanToShopifyContent(content(), { ...layout, media: ['gone'] }, files)).toThrow('no longer in this product')
  })
})
