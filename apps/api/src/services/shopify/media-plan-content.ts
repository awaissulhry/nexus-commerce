import type { ShopifyContent } from '@nexus/shared/shopify-content'
import type { ShopifyMediaLayout } from '@nexus/shared/media-plan-channels'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

type File = { id: string; url: string; mediaType: string | null; alt: string | null }
const GALLERY = 'media-plan'

/**
 * Images rebuild P2f — a family on the media plan publishes the plan's Shopify layout: the product gallery is the plan's
 * media in order, and each variant shows its value's first photo. It replaces every other gallery assignment, so no older
 * gallery (a sheet overlay, a hand-made group) can mix in. Alt text already edited in the content document is kept.
 */
export function applyMediaPlanToShopifyContent(content: ShopifyContent, layout: ShopifyMediaLayout, files: File[]): ShopifyContent {
  const errors = layout.checks.filter(c => c.severity === 'error').map(c => c.message)
  if (errors.length) throw new WorkspaceScopeError(errors.join(' '), 422)
  const result = structuredClone(content)
  const assets = layout.media.map(id => {
    const file = files.find(f => f.id === id)
    if (!file) throw new WorkspaceScopeError('A photo in the plan is no longer in this product\'s library. Review the Media page.', 422)
    if (!file.url.startsWith('https://')) throw new WorkspaceScopeError('Shopify media import requires a public HTTPS source.', 422)
    const kept = content.assets.find(a => a.id === id)
    const type = file.mediaType === 'MODEL3D' || file.mediaType === 'MODEL_3D' ? 'MODEL_3D' as const : file.mediaType === 'VIDEO' ? 'VIDEO' as const : 'IMAGE' as const
    return { ...(kept ?? { alt: file.alt ?? '', translations: {} }), id, url: file.url, type }
  })
  result.assets = [...assets, ...content.assets.filter(a => !layout.media.includes(a.id))]
  const featured = assets.find(a => a.type === 'IMAGE')?.id ?? null
  const variantGroups = Object.entries(layout.variantImages).flatMap(([variantId, id]) => id ? [{ variantId, id }] : [])
  result.groups = [
    { id: GALLERY, name: 'Media plan', assetIds: layout.media, featuredId: featured },
    ...variantGroups.map(v => ({ id: `${GALLERY}-${v.variantId}`, name: 'Variant photo', assetIds: [v.id], featuredId: v.id })),
    ...content.groups.filter(g => g.id !== GALLERY && !g.id.startsWith(`${GALLERY}-`)),
  ]
  // Only the plan's galleries remain: every other assignment keeps its values but loses its gallery.
  const others: ShopifyContent['assignments'] = content.assignments.filter(a => !a.id.startsWith(GALLERY)).map(a => { const copy = { ...a }; delete copy.gallery; return copy })
  const family = others.find(a => a.target?.kind === 'family')
  if (!family) throw new WorkspaceScopeError('The Shopify content document has no family defaults. Reload it.', 422)
  family.gallery = { mode: 'replace', groupIds: [GALLERY], featuredId: null, preserveOrder: true }
  result.assignments = [...others, ...variantGroups.map(v => ({ id: `${GALLERY}-${v.variantId}`, name: 'Variant photo', target: { kind: 'variant' as const, variantId: v.variantId },
    priority: 100, values: {}, gallery: { mode: 'replace' as const, groupIds: [`${GALLERY}-${v.variantId}`], featuredId: v.id, preserveOrder: true } }))]
  return result
}
