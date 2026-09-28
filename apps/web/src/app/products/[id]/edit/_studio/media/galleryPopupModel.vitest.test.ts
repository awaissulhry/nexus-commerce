import { describe, expect, it } from 'vitest'
import type { ProductMediaAsset, ProductMediaQuery, ProductMediaWorkspace } from '@nexus/shared/product-media'

import {
  GALLERY_MAX, addAsset, adoptAfterUpload, galleryCards, galleryCell, galleryChecks, galleryDraft, galleryRefusal, gallerySaveBody, gallerySaveLine, gallerySource,
  galleryTiles, inList, moveAsset, removeAsset, setAlt, setCaption, setTranscript,
} from './galleryPopupModel'

// A made-up product with its own files; ids and addresses are invented.
const asset = (id: string, extra: Partial<ProductMediaAsset> = {}): ProductMediaAsset => ({ id, type: 'IMAGE', url: `https://cdn.test/${id}.jpg`, preview: `https://cdn.test/${id}.jpg`, alt: id,
  width: 1600, height: 1600, fileSize: 100_000, ...extra })
const SHARED: ProductMediaQuery = { scope: 'MASTER', market: 'GLOBAL', locale: 'it' }
const EBAY: ProductMediaQuery = { scope: 'EBAY', market: 'IT', locale: 'it', accountId: 'acc', aliasKey: '' }
function workspace(extra: Partial<ProductMediaWorkspace> = {}): ProductMediaWorkspace {
  return { revision: 'a'.repeat(64), productId: 'p', title: 'Lab cap', context: SHARED,
    assets: [asset('front'), asset('back'), asset('side'), asset('small', { width: 420, height: 300 }), asset('clip', { type: 'VIDEO', preview: null })],
    collection: { version: 1, items: [{ assetId: 'front' }, { assetId: 'back', alt: 'Retro' }] }, hasOverride: true, source: 'locale', missingAssetIds: [], ...extra }
}

describe('Enter sends today\'s body, once, bound to the revision the pop-up opened with', () => {
  it('no change, no request; a reorder sends the whole list with the opening revision', () => {
    const w = workspace()
    expect(gallerySaveBody(w, galleryDraft(w))).toBeNull()
    expect(gallerySaveBody(w, moveAsset(moveAsset(galleryDraft(w), 'back', 0), 'back', 1))).toBeNull()
    expect(gallerySaveBody(w, moveAsset(galleryDraft(w), 'back', 0))).toEqual({ expectedRevision: 'a'.repeat(64), collection: { version: 1, items: [{ assetId: 'back', alt: 'Retro' }, { assetId: 'front' }] } })
  })
  it('"Use the inherited list" drops this language\'s own list (collection: null); with no own list there is nothing to drop', () => {
    const w = workspace()
    expect(gallerySaveBody(w, { ...galleryDraft(w), reset: true })).toEqual({ expectedRevision: 'a'.repeat(64), collection: null })
    expect(gallerySaveBody(workspace({ hasOverride: false, source: 'all-languages' }), { ...galleryDraft(w), reset: true })).toBeNull()
  })
  it('adds at the end, never twice, and refuses past 250', () => {
    const w = workspace()
    expect(addAsset(galleryDraft(w), 'side')!.items.map(i => i.assetId)).toEqual(['front', 'back', 'side'])
    expect(addAsset(galleryDraft(w), 'front')).toEqual(galleryDraft(w))
    const full = { items: Array.from({ length: GALLERY_MAX }, (_, i) => ({ assetId: `f${i}` })), reset: false }
    expect(addAsset(full, 'one-more')).toBeNull()
    expect(inList(galleryDraft(w), 'back')).toBe(true)
    expect(removeAsset(galleryDraft(w), 'back').items).toEqual([{ assetId: 'front' }])
  })
  it('alt text, transcript and captions stay per item and per language; an empty field is dropped, not saved empty', () => {
    const w = workspace()
    let d = setAlt(galleryDraft(w), 'front', 'Red cap, front')
    expect(d.items[0]).toEqual({ assetId: 'front', alt: 'Red cap, front' })
    d = setAlt(d, 'back', '')
    expect(d.items[1]).toEqual({ assetId: 'back' })
    d = setTranscript(d, 'front', 'Spoken words')
    d = setCaption({ ...d, items: [{ ...d.items[0], captions: [{ url: 'https://cdn.test/de.vtt', language: 'de', label: 'de' }] }, d.items[1]] }, 'front', 'it', 'https://cdn.test/it.vtt')
    expect(d.items[0].captions).toEqual([{ url: 'https://cdn.test/de.vtt', language: 'de', label: 'de' }, { url: 'https://cdn.test/it.vtt', language: 'it', label: 'it' }])
    expect(setCaption(d, 'front', 'it', '').items[0].captions).toEqual([{ url: 'https://cdn.test/de.vtt', language: 'de', label: 'de' }])
    expect(d.items[0].transcript).toBe('Spoken words')
  })
  it('refuses what the server\'s own schema refuses, before any request', () => {
    const w = workspace()
    expect(galleryRefusal(galleryDraft(w))).toBeNull()
    expect(galleryRefusal(setCaption(galleryDraft(w), 'front', 'it', 'http://plain.test/it.vtt'))).toBe('Use a public HTTPS file URL.')
    expect(galleryRefusal({ items: [{ assetId: 'front' }, { assetId: 'front' }], reset: false })).toBe('A file can appear only once in a gallery.')
  })
})

describe('what the pop-up says', () => {
  it('where the list comes from, and what a change does', () => {
    const w = workspace()
    expect(gallerySource(w, galleryDraft(w))).toEqual({ label: 'Italian · own list', own: true, note: null })
    const follows = workspace({ hasOverride: false, source: 'parent' })
    expect(gallerySource(follows, galleryDraft(follows)).label).toBe('Follows the parent product')
    expect(gallerySource(follows, removeAsset(galleryDraft(follows), 'back')).note).toBe('A change here gives Italian its own list; the list it follows stays as it is.')
    expect(gallerySource(w, { ...galleryDraft(w), reset: true }).note).toBe('⏎ applies it: Italian uses the inherited list again.')
    const listing = workspace({ context: EBAY, hasOverride: false, source: 'shared' })
    expect(gallerySource(listing, removeAsset(galleryDraft(listing), 'back')).note).toBe('A change here gives this listing its own list; the list it follows stays as it is.')
    expect(gallerySource(workspace({ source: 'library', hasOverride: false }), galleryDraft(w)).label).toBe('Not chosen yet · every library file')
  })
  it('where Enter saves (today\'s contract)', () => {
    expect(gallerySaveLine(SHARED, null)).toBe('Saves in Nexus · channels without their own list follow it')
    expect(gallerySaveLine(EBAY, 'eBay')).toBe('Saves a Nexus draft · Synchronize sends it to eBay')
  })
  it('channel sheet: that channel\'s limits and today\'s publisher rules (images only)', () => {
    const w = workspace({ context: EBAY })
    const d = addAsset(addAsset(galleryDraft(w), 'small')!, 'clip')!
    const found = galleryChecks(w, d)
    expect(found).toContainEqual({ severity: 'error', message: 'small is 420 px — eBay needs 500 px on the longest side.' })
    expect(found).toContainEqual({ severity: 'error', message: 'clip is a video. The eBay publish sends images only and stops on it.' })
    expect(galleryChecks(w, galleryDraft(w))).toEqual([])
    const shopify = workspace({ context: { ...EBAY, scope: 'SHOPIFY', market: 'GLOBAL' }, assets: [asset('huge', { width: 6000, height: 6000 })], collection: { version: 1, items: [{ assetId: 'huge' }] } })
    expect(galleryChecks(shopify, galleryDraft(shopify))).toEqual([{ severity: 'error', message: 'huge is over 20 megapixels — Shopify refuses it.' }])
  })
  it('Shared sheet: each file\'s own problems, and a deleted file', () => {
    const w = workspace({ collection: { version: 1, items: [{ assetId: 'front' }, { assetId: 'gone' }, { assetId: 'small' }] } })
    expect(galleryChecks(w, galleryDraft(w))).toEqual([
      { severity: 'error', message: 'A file in this list was deleted from the library. Take it out of the list, or add it again.' },
      { severity: 'error', message: 'small: 420 px — eBay and Amazon need 500 px on the longest side.' },
    ])
    expect(galleryTiles(w, galleryDraft(w))[1]).toMatchObject({ id: 'gone', missing: true, problem: 'Deleted from the library' })
  })
  it('the library: the product\'s files, searched; "not in this list" hides the list\'s own', () => {
    const w = workspace()
    expect(galleryCards(w, galleryDraft(w), 'not-in-set', '').map(a => a.id)).toEqual(['side', 'small', 'clip'])
    expect(galleryCards(w, galleryDraft(w), 'all', 'sid').map(a => a.id)).toEqual(['side'])
  })
  it('the cell after Enter: the list as the sheet draws it (the item\'s alt, else the file\'s)', () => {
    const w = workspace()
    expect(galleryCell(w, galleryDraft(w))).toEqual([
      { id: 'front', type: 'IMAGE', preview: 'https://cdn.test/front.jpg', alt: 'front' },
      { id: 'back', type: 'IMAGE', preview: 'https://cdn.test/back.jpg', alt: 'Retro' },
    ])
  })
  it('an upload moves the revision; it is adopted only when nothing but the library changed', () => {
    const w = workspace()
    const uploaded = workspace({ revision: 'b'.repeat(64), assets: [...w.assets, asset('new')] })
    expect(adoptAfterUpload(w, uploaded, ['new']).revision).toBe('b'.repeat(64))
    const listChanged = workspace({ revision: 'c'.repeat(64), collection: { version: 1, items: [{ assetId: 'back' }] } })
    expect(adoptAfterUpload(w, listChanged, ['new']).revision).toBe('a'.repeat(64))
    // A product with no list of its own shows every file: the new one joins the resolved list, and that is not a change.
    const library = workspace({ hasOverride: false, source: 'library', collection: { version: 1, items: [{ assetId: 'front' }] } })
    const libraryAfter = workspace({ hasOverride: false, source: 'library', revision: 'd'.repeat(64), collection: { version: 1, items: [{ assetId: 'front' }, { assetId: 'new' }] } })
    expect(adoptAfterUpload(library, libraryAfter, ['new']).revision).toBe('d'.repeat(64))
  })
  it('a re-upload of a file already there (nothing new) never adopts a colleague\'s change to the list', () => {
    const mine = workspace({ collection: { version: 1, items: [{ assetId: 'front' }, { assetId: 'back' }, { assetId: 'side' }] } })
    const theirs = workspace({ revision: 'e'.repeat(64), collection: { version: 1, items: [{ assetId: 'front' }, { assetId: 'side' }] } })
    expect(adoptAfterUpload(mine, theirs, []).revision).toBe('a'.repeat(64))
    // Passing the re-uploaded id as "new" would hide the difference (the review's finding) — so only NEW files are passed.
    expect(adoptAfterUpload(mine, theirs, ['back']).revision).toBe('e'.repeat(64))
  })
})
