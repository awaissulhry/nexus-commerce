import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentResolverEnabled, contentSourceHash, resolveContent, resolveContentBatch, type ContentProduct, type ResolveContentInput } from './content-resolver.js'

const product = (): ContentProduct => ({ id: 'p', parentId: null, name: 'Fonte', description: 'Descrizione', bulletPoints: ['Uno'], keywords: ['fonte'], categoryAttributes: { material: 'pelle' }, translations: [] })
const coordinate = { channel: 'AMAZON', market: 'BE', accountId: 'a' }
const listing = () => ({ id: 'l', productId: 'p', coordinate, languages: ['nl', 'fr'], title: 'Nederlands', description: 'Beschrijving' })
const input = (extra: Partial<ResolveContentInput> = {}): ResolveContentInput => ({ product: product(), field: 'title', address: { requested: 'de' }, ...extra })
afterEach(() => vi.unstubAllEnvs())

describe('LX.7 pure content resolution', () => {
  it('defaults to v2 and honors an explicit disable', () => {
    vi.stubEnv('NEXUS_CONTENT_RESOLVER', '')
    expect(contentResolverEnabled()).toBe(false)
    vi.stubEnv('NEXUS_CONTENT_RESOLVER', 'v2')
    expect(contentResolverEnabled()).toBe(true)
  })
  it('returns native source with its actual language on fallback', () => {
    expect(resolveContent(input())).toEqual({ value: 'Fonte', tier: 'source', language: 'it', requested: 'de', provenance: { member: 'inherited', from: 'Italian · source' }, ownerId: 'p' })
  })
  it('uses columns for the primary language even when a translation row exists', () => {
    const p = product(); p.translations = [{ language: 'it', name: 'Stale copy' }]
    expect(resolveContent(input({ product: p, address: { requested: 'it_IT' } }))).toMatchObject({ value: 'Fonte', tier: 'source', language: 'it', requested: 'it', provenance: { member: 'own' } })
  })
  it('reads a regional table key in memory and leaves every input byte unchanged', () => {
    const p = product(); p.translations = [{ language: 'DE-de', name: 'Titel', source: 'manual' }]
    const before = JSON.stringify(p)
    expect(resolveContent(input({ product: p, address: { requested: 'de_DE' } }))).toMatchObject({ value: 'Titel', tier: 'language', language: 'de', requested: 'de', provenance: { member: 'own' } })
    expect(JSON.stringify(p)).toBe(before)
  })
  it('never touches legacy JSON or the outbound and factual bags', () => {
    const p = product(), l = listing()
    Object.defineProperty(p, 'localizedContent', { get: () => { throw new Error('Legacy read') } })
    for (const key of ['platformAttributes', 'overrideData']) Object.defineProperty(l, key, { get: () => { throw new Error('Outbound read') } })
    expect(resolveContent(input({ product: p, listing: l, address: { requested: 'fr', coordinate } })).value).toBe('Fonte')
  })
  it.each(['nl', 'nl-BE'])('keeps the default-language listing title and description as legacy pins: %s', requested => {
    for (const [field, value] of [['title', 'Nederlands'], ['description', 'Beschrijving']]) expect(resolveContent(input({ listing: listing(), field, address: { requested, coordinate } }))).toMatchObject({ value, tier: 'pin', language: 'nl', provenance: { member: 'inherited' }, follows: true, drift: true })
  })
  it('does not serve a Dutch legacy pin as French', () => {
    const p = product(); p.translations = [{ language: 'fr', name: 'Français' }]
    expect(resolveContent(input({ product: p, listing: listing(), address: { requested: 'fr', coordinate } }))).toMatchObject({ value: 'Français', tier: 'language', language: 'fr', provenance: { member: 'inherited' } })
  })
  it('prefers an explicit pin row to legacy pins and the language tier', () => {
    const p = product(); p.translations = [{ language: 'nl', name: 'Shared' }]
    const l = { ...listing(), translations: [{ language: 'nl', name: 'Pin', channelListingId: 'l' }] }
    expect(resolveContent(input({ product: p, listing: l, address: { requested: 'nl', coordinate } }))).toMatchObject({ value: 'Pin', tier: 'pin' })
  })
  it('uses explicit legacy overrides when inheritance was broken', () => {
    const l = { ...listing(), followMasterTitle: false, titleOverride: 'Override' }
    expect(resolveContent(input({ listing: l, address: { requested: 'nl', coordinate } })).value).toBe('Override')
    l.followMasterTitle = true
    expect(resolveContent(input({ listing: l, address: { requested: 'nl', coordinate } })).value).toBe('Nederlands')
  })
  it('uses child then parent within each tier, with language ahead of source', () => {
    const parent = product(), child = { ...product(), id: 'child', parentId: parent.id, name: 'Child source' }
    parent.translations = [{ language: 'de', name: 'Eltern', description: 'Beschreibung' }]
    child.translations = [{ language: 'de', name: 'Kind', description: null, bulletPoints: [] }]
    expect(resolveContent(input({ product: child, parent })).value).toBe('Kind')
    expect(resolveContent(input({ product: child, parent, field: 'description' }))).toMatchObject({ value: 'Beschreibung', tier: 'language', provenance: { member: 'inherited' } })
    child.translations = []
    expect(resolveContent(input({ product: child, parent })).value).toBe('Eltern')
  })
  it('falls back field by field; schema-default empty lists do not hide source', () => {
    const p = product(); p.translations = [{ language: 'de', name: 'Titel', description: '', bulletPoints: [], keywords: null }]
    for (const field of ['description', 'bulletPoints', 'keywords']) expect(resolveContent(input({ product: p, field })).tier).toBe('source')
  })
  it('limits custom translations to family-declared localizable fields', () => {
    const p = product(); p.translations = [{ language: 'de', attributes: { material: 'Leder', price: 99 } }]
    expect(resolveContent(input({ product: p, field: 'material', localizableKeys: ['material'] })).value).toBe('Leder')
    expect(() => resolveContent(input({ product: p, field: 'price' }))).toThrow('not declared localizable')
  })
  it('preserves a family-declared field supplied by native variant attributes', () => {
    const p = { ...product(), variantAttributes: { style: 'Da motociclista' } }
    expect(resolveContent(input({ product: p, field: 'style', localizableKeys: ['style'] }))).toMatchObject({ value: 'Da motociclista', tier: 'source', language: 'it' })
    expect(resolveContent(input({ product: { ...product(), variantAttributes: { Style: 'Racing' } }, field: 'style', localizableKeys: ['style'] })).value).toBe('Racing')
  })
  it('preserves an explicit child attribute clear instead of resurrecting parent text', () => {
    const parent = { ...product(), categoryAttributes: { weave_type: 'Not applicable' } }
    const child = { ...product(), id: 'child', parentId: parent.id, categoryAttributes: { weave_type: null }, variantAttributes: { weave_type: 'Obsolete alias' } }
    expect(resolveContent(input({ product: child, parent, field: 'weave_type', localizableKeys: ['weave_type'] }))).toMatchObject({ value: null, tier: 'source', language: 'it' })
  })
  it('checks an inherited translation against its authoring owner’s source', () => {
    const parent = product(), child = { ...product(), id: 'child', parentId: parent.id, name: 'Different child source' }
    parent.translations = [{ language: 'de', name: 'Eltern', sourceHash: contentSourceHash(parent), source: 'manual' }]
    expect(resolveContent(input({ product: child, parent })).translation?.outdated).toBe(false)
    parent.name = 'Changed parent source'
    expect(resolveContent(input({ product: child, parent })).translation?.outdated).toBe(true)
  })
  it.each(['manual', 'ai', 'translated'] as const)('carries review and source freshness for %s', source => {
    const p = product(), sourceHash = contentSourceHash(p), reviewedAt = new Date('2026-09-01T00:00:00Z')
    p.translations = [{ language: 'de', name: 'Titel', source, sourceHash, reviewedAt }]
    expect(resolveContent(input({ product: p }))).toMatchObject({ translation: { source, reviewedAt: reviewedAt.toISOString(), outdated: false } })
    p.name = 'Changed source'
    expect(resolveContent(input({ product: p }))).toMatchObject({ provenance: { member: 'outdated' }, translation: { outdated: true } })
  })
  it.each(['ai', 'translated'] as const)('keeps unreviewed %s visibly machine-authored, including staleness', source => {
    const p = product(); p.translations = [{ language: 'de', name: 'Titel', source, sourceHash: contentSourceHash(p) }]
    expect(resolveContent(input({ product: p })).provenance.member).toBe('ai')
    p.name = 'New'
    expect(resolveContent(input({ product: p })).provenance.member).toBe('aiStale')
  })
  it('does not invent a source fingerprint or human review for historical translations', () => {
    const p = product(); p.translations = [{ language: 'de', name: 'Titel', source: 'ai' }]
    expect(resolveContent(input({ product: p })).translation).toEqual({ source: 'ai', reviewedAt: null, outdated: false })
  })
  it('lets a computed value answer only after all stored tiers are absent', () => {
    const computed = { value: 'Formula', language: 'de-DE', provenance: { member: 'formula' as const, from: 'formula-id' } }
    expect(resolveContent(input({ computed })).tier).toBe('source')
    expect(resolveContent(input({ product: { id: 'p' }, computed }))).toMatchObject({ value: 'Formula', tier: 'computed', language: 'de', provenance: { member: 'formula' } })
    expect(resolveContent(input({ product: { id: 'p' } })).value).toBeNull()
  })
  it('refuses foreign parents, listings and coordinates', () => {
    expect(() => resolveContent(input({ parent: { id: 'other' } }))).toThrow('parent')
    expect(() => resolveContent(input({ listing: { ...listing(), workspaceId: 'foreign' } }))).toThrow('listing')
    for (const change of [{ channel: 'EBAY' }, { market: 'DE' }, { accountId: 'other' }, { aliasId: 'alias' }]) expect(() => resolveContent(input({ listing: listing(), address: { requested: 'nl', coordinate: { ...coordinate, ...change } } }))).toThrow('coordinate')
  })
  it('does not inherit another workspace or product translation', () => {
    const p = product(); p.translations = [{ language: 'de', name: 'Foreign', workspaceId: 'other' }, { language: 'de', name: 'Wrong product', productId: 'other' }]
    expect(resolveContent(input({ product: p })).tier).toBe('source')
  })
  it('gives canonical language keys precedence over regional keys', () => {
    const rows = [{ language: 'de-DE', name: 'Regional' }, { language: 'de', name: 'Canonical' }]
    for (const translations of [rows, [...rows].reverse()]) expect(resolveContent(input({ product: { ...product(), translations } })).value).toBe('Canonical')
  })
  it('refuses ambiguous regional-only translations instead of depending on row order', () => {
    const p = { ...product(), translations: [{ language: 'de-DE', name: 'A' }, { language: 'de-AT', name: 'B' }] }
    expect(() => resolveContent(input({ product: p }))).toThrow('Ambiguous')
  })
  it('batch returns every member × language × field with the same values as scalar resolution', () => {
    const p = product(), child = { ...product(), id: 'child', parentId: p.id }
    p.translations = [{ language: 'de', name: 'Titel' }]
    const members = [{ product: p }, { product: child, parent: p }], fields = ['title', 'description', 'bulletPoints', 'keywords'], addresses = ['de-DE', 'it', 'fr'].map(requested => ({ requested }))
    const batch = resolveContentBatch({ members, fields, addresses })
    expect(batch).toHaveLength(6)
    for (const row of batch) for (const field of fields) expect(row.fields[field]).toEqual(resolveContent({ ...members.find(m => m.product.id === row.productId)!, field, address: row.address }))
  })
})
