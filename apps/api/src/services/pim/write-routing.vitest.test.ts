/**
 * PES.5 — where a studio cell's edit LANDS.
 *
 * This is the most dangerous field in the studio payload. The first version
 * derived it from `projection.id !== null`, which is FALSE for the primary
 * listing — so every cell on a channel scope reported `writeTarget: 'master'`,
 * and a pin routed by it would have edited the SHARED master record and changed
 * every channel at once. PES.3's 409 rehearsal caught it against live data:
 * 441/441 eBay·IT cells said `master` while three simultaneously said
 * `follows: true`, which cannot both be true.
 *
 * Expected values below are written from the WRITE ENDPOINT's own capability —
 * `CHANNEL_FIELD_MAP` in products.routes.ts routes exactly six field names — not
 * by running the function and recording what it said.
 */
import { describe, it, expect } from 'vitest'
import { resolveWriteRouting } from './studio-sheet.service.js'
import { isChannelWritable } from './channel-field-map.js'

const col = (key: string, writeField = key, storage: any = 'categoryAttributes') => ({ key, writeField, storage })
const EBAY = { channel: 'EBAY' }
const AMAZON = { channel: 'AMAZON' }
const SHOPIFY = { channel: 'SHOPIFY' }

describe('channel scope — the six routable fields', () => {
  it('routes a title to the channel, with the PREFIXED field name', () => {
    const r = resolveWriteRouting(col('name'), EBAY, null)
    expect(r.writeTarget).toBe('channelListing')
    // The endpoint keys off the prefix. Handing back the master name ('name')
    // with a channel target would land the write on master anyway.
    expect(r.writeField).toBe('ebay_title')
    expect(r.affectsAllChannels).toBe(false)
  })

  it('uses the right prefix per channel', () => {
    expect(resolveWriteRouting(col('item_name'), AMAZON, null).writeField).toBe('amazon_title')
    expect(resolveWriteRouting(col('product_description'), EBAY, null).writeField).toBe('ebay_description')
  })

  /**
   * VT.1 (2026-09-13, D-VT3) - the variation theme left the bulk PATCH. It used to be the third prefixed route
   * (`amazon_variationTheme` / `ebay_variationTheme`); the assertion for it lived one line above this block. It now
   * has ONE writer with a lock, a keys-the-variants check and a collision rule - `PATCH /studio/projection` on a
   * coordinate, `PATCH /studio/variation-axes` on master - named per cell in `cell.value.write.endpoint`.
   */
  it('the variation theme is NOT a bulk-PATCH field any more, and the write gate says so', () => {
    // The gate: both prefixed names are refused by the ordinary channel writer.
    expect(isChannelWritable('amazon_variationTheme')).toBe(false)
    expect(isChannelWritable('ebay_variationTheme')).toBe(false)
    // The positive control in the same run: the two surviving prefixed routes are still accepted.
    expect(isChannelWritable('amazon_title')).toBe(true)
    expect(isChannelWritable('ebay_description')).toBe(true)
    // And the engine column routes to its OWN field name, never a prefixed one, on every channel.
    const theme = { key: 'variation_theme', writeField: 'variation_theme', storage: 'listing' as const, kind: 'variationTheme' as const }
    for (const coordinate of [AMAZON, EBAY, SHOPIFY]) {
      const r = resolveWriteRouting(theme, coordinate, null)
      expect(r.writeField).toBe('variation_theme')
      expect(r.writeTarget).toBe('channelListing')
      expect(r.writeVerb).toBe('channel')
      expect(r.affectsAllChannels).toBe(false)
    }
    // On master it is the shared structure.
    const master = resolveWriteRouting(theme, null, null)
    expect(master.writeTarget).toBe('master')
    expect(master.writeVerb).toBe('master')
  })

  it('an attribute now routes to the LISTING via the override bag (#169)', () => {
    // Before #169 this was `master` and the cell rendered not-writable — the
    // Owner's "I'm unable to edit them all". The field name is NOT prefixed:
    // there is no `ebay_material`, and inventing one yields a name the endpoint
    // rejects. It routes by `target: 'channel'` instead.
    const r = resolveWriteRouting(col('material', 'attr_material'), EBAY, null)
    expect(r.writeTarget).toBe('channelListing')
    expect(r.writeField).toBe('attr_material')
    expect(r.writeVerb).toBe('channel')
    // No longer a shared-record edit.
    expect(r.affectsAllChannels).toBe(false)
  })

  it('the six prefixed fields keep the PREFIX route and do NOT also send target', () => {
    // Sending both would be ambiguous: the endpoint would see a channel field
    // name AND a channel target for a column-backed write.
    const r = resolveWriteRouting(col('name', 'name', 'column'), EBAY, null)
    expect(r.writeField).toBe('ebay_title')
    expect(r.writeVerb).toBe('master')
    expect(r.writeTarget).toBe('channelListing')
  })

  it('identity columns stay MASTER and are still flagged shared (#171.4)', () => {
    // sku/gtin/status are master truth; a per-channel SKU is a different
    // feature. These are the cells that legitimately still warn.
    const r = resolveWriteRouting(col('sku', 'sku', 'column'), EBAY, null)
    expect(r.writeTarget).toBe('master')
    expect(r.affectsAllChannels).toBe(true)
  })

  it('Shopify edits stay on their listing coordinate', () => {
    for (const c of [col('name', 'name', 'column'), col('material', 'attr_material')]) {
      const r = resolveWriteRouting(c, SHOPIFY, null)
      expect(r.writeTarget).toBe('channelListing')
      expect(r.affectsAllChannels).toBe(false)
    }
  })
})

describe('master scope', () => {
  it('everything writes to master and nothing is flagged', () => {
    for (const key of ['name', 'material', 'basePrice', 'variationTheme']) {
      const r = resolveWriteRouting(col(key, key, 'column'), null, null)
      expect(r.writeTarget).toBe('master')
      expect(r.writeField).toBe(key)
      // Not a cross-channel edit: master IS the scope being edited.
      expect(r.affectsAllChannels).toBe(false)
      expect(r.writable).toBe(true)
    }
  })
})

describe('the regression itself — the primary listing is not master', () => {
  it('a PRIMARY-listing title routes to the channel (aliasId null is not "no channel")', () => {
    // The exact bug: aliasId === null means "the primary listing", NOT "master".
    const r = resolveWriteRouting(col('name'), EBAY, null)
    expect(r.writeTarget).toBe('channelListing')
  })

  it('a routable field is never simultaneously channel-routed and flagged shared', () => {
    const r = resolveWriteRouting(col('name'), EBAY, null)
    expect(r.writeTarget === 'channelListing' && r.affectsAllChannels).toBe(false)
  })
})

describe('alias rows are writable now (#169)', () => {
  it('a non-primary alias cell is writable — aliasKey carries the coordinate', () => {
    // Previously blocked: the write path had no aliasId, so a merge would have
    // landed on the PRIMARY listing. `marketplaceContexts[].aliasKey` plus the
    // upsert's ON CONFLICT naming `aliasKey` routes it to the right row.
    const r = resolveWriteRouting(col('material', 'attr_material'), EBAY, 'alias_123')
    expect(r.writable).toBe(true)
    expect(r.writeBlockedReason).toBeNull()
    expect(r.writeTarget).toBe('channelListing')
  })
})
