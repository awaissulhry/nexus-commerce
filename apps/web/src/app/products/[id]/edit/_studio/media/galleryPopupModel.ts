import { productMediaCollectionSchema, type ProductMediaItem, type ProductMediaQuery, type ProductMediaWorkspace } from '@nexus/shared/product-media'
import { MEDIA_LIMITS } from '@nexus/shared/media-plan-channels'
import type { MediaStripItem } from '@/design-system/components'

import type { PopupCheckLine } from './popupParts'
import { POPUP_TEXT, problemWords } from './mediaPopupModel'

/**
 * Lane C, C2 (docs/product-media-popup/PLAN-2026-09-28.md §4.3) — the Product media pop-up of a product NOT on the photo
 * plan, as pure rules. Such a product keeps its own ordered list per language (on the Shared sheet) or a listing's Nexus
 * draft (on a channel sheet); the pop-up edits exactly that list with today's save: `PUT /product-media` with the
 * revision read when it opened (the server refuses a list that changed meanwhile). Pure: tested without a browser.
 */

export const GALLERY_TEXT = {
  max: 'A gallery can contain up to 250 files. Remove gallery references before adding more.',
  tooLarge: (name: string) => `${name}: images must be no larger than 20 MB.`,
  uploadUnread: 'uploaded to the library, but the list could not be read again. Reload the page, then add it.',
} as const
export const GALLERY_MAX = 250
export const VIDEO_FILE = /\.(mp4|mov|webm|mkv|m4v)$/i
const TEXT_MEDIA = new Set(['VIDEO', 'EXTERNAL_VIDEO', 'AUDIO'])

export interface GalleryDraft {
  /** The list, in order, with each item's alt text, captions and transcript (this language's). */
  items: ProductMediaItem[]
  /** Drop this language's (or this listing's) own list: the row shows the inherited list again. */
  reset: boolean
}

export const galleryDraft = (workspace: ProductMediaWorkspace): GalleryDraft => ({ items: workspace.collection.items.map(item => ({ ...item })), reset: false })

/** What Enter sends — today's body — or null when nothing changed (no request). */
export function gallerySaveBody(baseline: ProductMediaWorkspace, draft: GalleryDraft): { expectedRevision: string; collection: ProductMediaWorkspace['collection'] | null } | null {
  if (draft.reset) return baseline.hasOverride ? { expectedRevision: baseline.revision, collection: null } : null
  if (JSON.stringify(draft.items) === JSON.stringify(baseline.collection.items)) return null
  return { expectedRevision: baseline.revision, collection: { version: 1, items: draft.items } }
}

/** The list's own rules (the same schema the server parses), before any request. */
export function galleryRefusal(draft: GalleryDraft): string | null {
  if (draft.reset) return null
  const parsed = productMediaCollectionSchema.safeParse({ version: 1, items: draft.items })
  return parsed.success ? null : parsed.error.issues[0]?.message ?? 'Check the media details.'
}

// ── Draft edits ─────────────────────────────────────────────────────────────────────────────────────────────────

export function moveAsset(draft: GalleryDraft, id: string, index: number): GalleryDraft {
  const item = draft.items.find(i => i.assetId === id)
  if (!item) return draft
  const rest = draft.items.filter(i => i.assetId !== id)
  const at = Math.max(0, Math.min(index, rest.length))
  return { reset: false, items: [...rest.slice(0, at), item, ...rest.slice(at)] }
}
export function removeAsset(draft: GalleryDraft, id: string): GalleryDraft {
  return draft.items.some(i => i.assetId === id) ? { reset: false, items: draft.items.filter(i => i.assetId !== id) } : draft
}
/** Adds at the end; a file already in the list is not added twice. Refused past 250 (`null`). */
export function addAsset(draft: GalleryDraft, id: string): GalleryDraft | null {
  if (draft.items.some(i => i.assetId === id)) return draft
  if (draft.items.length >= GALLERY_MAX) return null
  return { reset: false, items: [...draft.items, { assetId: id }] }
}
export const inList = (draft: GalleryDraft, id: string) => draft.items.some(i => i.assetId === id)

/** This language's alt text of one item (empty = the file's own). */
export function setAlt(draft: GalleryDraft, id: string, alt: string): GalleryDraft {
  return { reset: false, items: draft.items.map(i => i.assetId === id ? withField(i, 'alt', alt) : i) }
}
export function setTranscript(draft: GalleryDraft, id: string, transcript: string): GalleryDraft {
  return { reset: false, items: draft.items.map(i => i.assetId === id ? withField(i, 'transcript', transcript) : i) }
}
/** One caption file per language; the other languages' tracks are kept (today's rule). */
export function setCaption(draft: GalleryDraft, id: string, locale: string, url: string): GalleryDraft {
  return { reset: false, items: draft.items.map(i => {
    if (i.assetId !== id) return i
    const others = (i.captions ?? []).filter(c => c.language !== locale)
    const captions: NonNullable<ProductMediaItem['captions']> = [...others, ...(url ? [{ url, language: locale, label: locale }] : [])]
    const { captions: _old, ...rest } = i
    return captions.length ? { ...rest, captions } : rest
  }) }
}
function withField(item: ProductMediaItem, key: 'alt' | 'transcript', value: string): ProductMediaItem {
  const { [key]: _old, ...rest } = item
  return value ? { ...rest, [key]: value } : rest
}
export const hasText = (type: string) => TEXT_MEDIA.has(type)

// ── What the pop-up shows ───────────────────────────────────────────────────────────────────────────────────────

export function languageName(locale: string) {
  if (locale === 'und') return 'All languages'
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale.toUpperCase() } catch { return locale.toUpperCase() }
}

/** Where the list comes from, in one line, and whether this language (or listing) owns it. */
export function gallerySource(workspace: ProductMediaWorkspace, draft: GalleryDraft): { label: string; own: boolean; note: string | null } {
  const channel = workspace.context.scope !== 'MASTER'
  const who = channel ? 'this listing' : languageName(workspace.context.locale)
  const label = workspace.source === 'locale' ? `${channel ? 'Own list for this listing' : `${languageName(workspace.context.locale)} · own list`}`
    : workspace.source === 'all-languages' ? 'Follows the all-languages list'
    : workspace.source === 'shared' ? 'Follows the shared product'
    : workspace.source === 'parent' ? 'Follows the parent product'
    : 'Not chosen yet · every library file'
  const changed = !draft.reset && JSON.stringify(draft.items) !== JSON.stringify(workspace.collection.items)
  const note = draft.reset ? `⏎ applies it: ${who} uses the inherited list again.`
    : !workspace.hasOverride && changed ? `A change here gives ${who} its own list; the list it follows stays as it is.` : null
  return { label, own: workspace.hasOverride, note }
}

/** Where Enter saves, in one line (today's contract). */
export function gallerySaveLine(context: ProductMediaQuery, channelLabel: string | null) {
  return context.scope === 'MASTER' ? 'Saves in Nexus · channels without their own list follow it' : `Saves a Nexus draft · Synchronize sends it to ${channelLabel ?? context.scope}`
}

export interface GalleryTile { id: string; src: string | null; label: string; mediaType: string; missing: boolean; problem: string | null }
export function galleryTiles(workspace: ProductMediaWorkspace, draft: GalleryDraft): GalleryTile[] {
  const assets = new Map(workspace.assets.map(a => [a.id, a]))
  return draft.items.map(item => {
    const asset = assets.get(item.assetId)
    return { id: item.assetId, src: asset?.preview ?? null, mediaType: asset?.type ?? 'FILE', label: (item.alt ?? asset?.alt) || (asset ? asset.type.toLowerCase() : 'Deleted file'),
      missing: !asset, problem: asset ? problemsOf(asset)[0] ?? null : 'Deleted from the library' }
  })
}

function problemsOf(asset: ProductMediaWorkspace['assets'][number]): string[] {
  if (asset.type !== 'IMAGE') return []
  const problems: string[] = []
  if (asset.width == null || asset.height == null) problems.push('Size unknown')
  else if (Math.max(asset.width, asset.height) < 500) problems.push(`${Math.max(asset.width, asset.height)} px`)
  if (!/^https:\/\//i.test(asset.url)) problems.push('Not HTTPS')
  return problems
}

/**
 * The problems this list would have. On a channel sheet: that channel's limits (`MEDIA_LIMITS`, the photo plan's own
 * numbers) and today's publisher rules for this list (images only, public HTTPS — `studio-publication-media.ts`). On the
 * Shared sheet: each file's own problems.
 */
export function galleryChecks(workspace: ProductMediaWorkspace, draft: GalleryDraft): PopupCheckLine[] {
  if (draft.reset) return []
  const assets = new Map(workspace.assets.map(a => [a.id, a]))
  const out: PopupCheckLine[] = []
  const add = (check: PopupCheckLine) => { if (!out.some(c => c.message === check.message)) out.push(check) }
  const channel = workspace.context.scope
  const files = draft.items.map(i => ({ item: i, asset: assets.get(i.assetId) }))
  if (files.some(f => !f.asset)) add({ severity: 'error', message: 'A file in this list was deleted from the library. Take it out of the list, or add it again.' })
  const name = (f: typeof files[number]) => (f.item.alt ?? f.asset?.alt) || 'a photo'
  const images = files.filter(f => f.asset?.type === 'IMAGE')
  if (channel === 'MASTER') {
    for (const f of images) for (const problem of problemsOf(f.asset!)) add({ severity: problem === 'Size unknown' ? 'warning' : 'error', message: `${name(f)}: ${problemWords(problem)}` })
    return out
  }
  const edge = (f: typeof files[number]) => f.asset?.width != null && f.asset.height != null ? Math.max(f.asset.width, f.asset.height) : null
  for (const f of files) if (f.asset && f.asset.type !== 'IMAGE' && (channel === 'EBAY' || channel === 'AMAZON'))
    add({ severity: 'error', message: `${name(f)} is a ${f.asset.type === 'VIDEO' ? 'video' : 'file that is not an image'}. The ${label(channel)} publish sends images only and stops on it.` })
  for (const f of images) {
    const a = f.asset!, e = edge(f)
    if (!/^https:\/\//i.test(a.url)) add({ severity: 'error', message: `${name(f)} is not on a public HTTPS address — no channel accepts it.` })
    if (e == null) add({ severity: 'warning', message: `${name(f)}: size unknown — cannot check it.` })
    if (channel === 'EBAY') {
      if (e != null && e < MEDIA_LIMITS.EBAY.minLongEdge) add({ severity: 'error', message: `${name(f)} is ${e} px — eBay needs ${MEDIA_LIMITS.EBAY.minLongEdge} px on the longest side.` })
      if (a.fileSize && a.fileSize > MEDIA_LIMITS.EBAY.maxBytes) add({ severity: 'error', message: `${name(f)} is over 12 MB — eBay refuses it.` })
    }
    if (channel === 'AMAZON' && e != null) {
      if (e < MEDIA_LIMITS.AMAZON.minLongEdge) add({ severity: 'error', message: `${name(f)} is ${e} px — Amazon needs ${MEDIA_LIMITS.AMAZON.minLongEdge} px.` })
      else if (e < MEDIA_LIMITS.AMAZON.zoomLongEdge) add({ severity: 'warning', message: `${name(f)} is ${e} px — buyers cannot zoom below ${MEDIA_LIMITS.AMAZON.zoomLongEdge} px.` })
    }
    if (channel === 'SHOPIFY') {
      if (a.width && a.height && a.width * a.height > MEDIA_LIMITS.SHOPIFY.maxPixels) add({ severity: 'error', message: `${name(f)} is over 20 megapixels — Shopify refuses it.` })
      if (a.fileSize && a.fileSize > MEDIA_LIMITS.SHOPIFY.maxBytes) add({ severity: 'error', message: `${name(f)} is over 20 MB — Shopify refuses it.` })
    }
  }
  const count = images.length
  if (channel === 'EBAY' && count > MEDIA_LIMITS.EBAY.gallery) add({ severity: 'error', message: `This list has ${count} photos; eBay allows ${MEDIA_LIMITS.EBAY.gallery}.` })
  if (channel === 'AMAZON' && count > 9) add({ severity: 'warning', message: `Amazon shows 9 photos — ${count - 9} do not fit.` })
  if (channel === 'SHOPIFY' && count > MEDIA_LIMITS.SHOPIFY.storefrontGallery) add({ severity: 'error', message: `Nexus publishes at most ${MEDIA_LIMITS.SHOPIFY.storefrontGallery} photos in a Shopify gallery; this has ${count}.` })
  if (channel === 'ETSY' && count > MEDIA_LIMITS.ETSY.images) add({ severity: 'warning', message: `Etsy shows ${MEDIA_LIMITS.ETSY.images} photos — ${count - MEDIA_LIMITS.ETSY.images} do not fit.` })
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
}
const label = (channel: string) => ({ EBAY: 'eBay', AMAZON: 'Amazon', SHOPIFY: 'Shopify', ETSY: 'Etsy' } as Record<string, string>)[channel] ?? channel

export type GalleryShow = 'not-in-set' | 'all'
/** The files the row may use (its own and its parent's), filtered by the search words; "not in this list" hides the list's. */
export function galleryCards(workspace: ProductMediaWorkspace, draft: GalleryDraft, show: GalleryShow, search: string) {
  const text = search.trim().toLowerCase()
  return workspace.assets.filter(a => {
    if (text && !`${a.alt} ${a.type} ${a.url.split('/').pop() ?? ''}`.toLowerCase().includes(text)) return false
    return show === 'all' || !inList(draft, a.id)
  })
}

/** The cell after Enter: the list as the sheet draws it (`studio-sheet.service.ts`: preview, alt of the item or the file). */
export function galleryCell(workspace: ProductMediaWorkspace, draft: GalleryDraft): MediaStripItem[] {
  const assets = new Map(workspace.assets.map(a => [a.id, a]))
  return draft.items.map(item => { const a = assets.get(item.assetId); return { id: item.assetId, type: a?.type ?? 'FILE', preview: a?.preview ?? null, alt: item.alt ?? a?.alt ?? '' } })
}

/** After an upload the revision moves (the library changed). Keep the list the pop-up opened with as the baseline
 *  unless ONLY the library changed — then the new revision is adopted (today's dialog did the same). */
export function adoptAfterUpload(baseline: ProductMediaWorkspace, fresh: ProductMediaWorkspace, added: readonly string[]): ProductMediaWorkspace {
  const without = (w: ProductMediaWorkspace) => JSON.stringify(w.collection.items.filter(i => !added.includes(i.assetId)))
  return without(fresh) === without(baseline) && fresh.source === baseline.source && fresh.hasOverride === baseline.hasOverride ? fresh : baseline
}

export { POPUP_TEXT }
