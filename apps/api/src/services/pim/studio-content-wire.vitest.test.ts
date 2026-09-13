import { describe, expect, it } from 'vitest'
import { resolveContent } from './content-resolver.js'
import { contentAttribute, contentWireValue } from './content-read.js'
import { studioContentFacts } from './studio-content-wire.js'
import type { ResolvedCell } from './mapping/resolve-batch.service.js'
const product = { id: 'gale', name: 'Source title', translations: [{ language: 'de', name: 'German title', source: 'manual' as const, reviewedAt: '2026-09-12T00:00:00.000Z' }] }
const coordinate = { channel: 'AMAZON', market: 'BE' }
describe('canonical Studio content wire', () => {
  it('retains source fallback language, tier and source name for a nonempty value', () => {
    const resolved = resolveContent({ product, field: 'name', address: { requested: 'fr' } })
    const facts = studioContentFacts(contentAttribute(resolved, product.id).content, undefined, undefined, 'fr')
    expect(facts).toMatchObject({ tier: 'source', language: 'it', requested: 'fr', provenance: { member: 'inherited', from: 'Italian · source' } })
    expect(facts).not.toHaveProperty('translationState')
    expect(facts).not.toHaveProperty('effectiveLocale')
  })
  it('preserves review evidence across the attribute adapter and language-tier read', () => {
    const resolved = resolveContent({ product, field: 'name', address: { requested: 'de' } })
    const facts = studioContentFacts(contentAttribute(resolved, product.id).content, undefined, undefined, 'de')
    expect(facts).toMatchObject({ tier: 'language', language: 'de', requested: 'de', provenance: { from: 'German · shared' }, translation: { source: 'manual', reviewedAt: '2026-09-12T00:00:00.000Z', outdated: false } })
  })
  it.each([true, false])('names a listing tier and retains the following intent %s without exposing its database id', follows => {
    const resolved = resolveContent({ product, listing: { id: 'private-listing-id', productId: product.id, coordinate, languages: ['nl','fr'], title: 'Legacy Dutch snapshot', followMasterTitle: follows }, field: 'name', address: { requested: 'nl', coordinate } })
    const facts = studioContentFacts(resolved, undefined, undefined, 'nl', 'Amazon · BE')
    expect(facts.provenance).toEqual({ member: follows ? 'inherited' : 'pinned', from: `Dutch · Amazon · BE · ${follows ? 'following snapshot' : 'pin'}` })
  })
  it('uses the mapped winner’s source language and review facts, then lets formula refusal outrank its mark', () => {
    const source = resolveContent({ product, field: 'name', address: { requested: 'fr' } })
    const mapped = { status: 'mapped', content: { ...source, tier: 'computed', provenance: { member: 'mapped', from: 'Italian · source' } }, effectiveLocale: 'it' } as ResolvedCell
    expect(studioContentFacts(undefined, mapped, undefined, 'fr')).toMatchObject({ tier: 'computed', language: 'it', requested: 'fr', provenance: { member: 'mapped' } })
    expect(studioContentFacts(undefined, mapped, { expr: '$name', lastError: 'Name is too long.' }, 'fr').provenance).toEqual({ member: 'refused', from: 'Name is too long.' })
  })
  it('keeps an explicit list clear on the wire', () => {
    expect(contentWireValue([], 'list')).toEqual([])
    expect(contentWireValue(null, 'list')).toEqual([])
  })
})
