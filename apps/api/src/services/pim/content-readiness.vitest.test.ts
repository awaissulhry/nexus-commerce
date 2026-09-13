import { describe, expect, it } from 'vitest'
import { buildCoordinateValidators, evaluateRow } from './readiness.service.js'
import { resolveContentAttributes, contentWireValue } from './content-read.js'
import { isOperatorContentPin, resolveContent, translationMissing } from './content-resolver.js'

describe('LX.5 language facts at reader boundaries', () => {
  const product = { id: 'p', name: 'Giacca', bulletPoints: [], translations: [] }
  const coordinate = { channel: 'AMAZON', marketplace: 'DE', label: 'Amazon · DE', languages: ['de'] } as any
  const columns = [{ key: 'title', label: 'Title', shape: 'text', requiredBy: ['Amazon · DE'], scope: 'global' }] as any
  it('blocks a required German title despite non-empty Italian fallback', () => {
    const fields = resolveContentAttributes({ product, requested: 'de' })
    const validators = buildCoordinateValidators(columns, coordinate, { isParent: false, productType: 'COAT' })
    const issues = evaluateRow({ title: fields.title.value }, validators, { requested: 'de', fields })
    expect(fields.title.value).toBe('Giacca')
    expect(issues).toContainEqual(expect.objectContaining({ field: 'title', severity: 'error' }))
    const translated = resolveContentAttributes({ product: { ...product, translations: [{ language: 'de-DE', name: 'Jacke' }] }, requested: 'de' })
    expect(evaluateRow({ title: translated.title.value }, validators, { requested: 'de', fields: translated }).filter(i => i.field === 'title')).toEqual([])
  })
  it('uses actual language for missing translation, separately from required emptiness', () => {
    expect(translationMissing({ language: 'it' }, 'de')).toBe(true)
    expect(translationMissing({ language: 'de' }, 'de-DE')).toBe(false)
    const clear = resolveContent({ product: { id: 'p', categoryAttributes: { material: null } }, field: 'material', localizableKeys: ['material'], address: { requested: 'it' } })
    expect(clear.value).toBeNull()
    expect(translationMissing(clear, 'it')).toBe(false)
  })
  it('keeps following legacy text as drift and refuses to classify it as an operator pin', () => {
    const address = { requested: 'de', coordinate: { channel: 'AMAZON', market: 'DE' } }
    const listing = { id: 'l', productId: 'p', coordinate: address.coordinate, languages: ['de'], title: 'Snapshot', followMasterTitle: true }
    const drift = resolveContent({ product, listing, field: 'title', address })
    expect(drift).toMatchObject({ value: 'Snapshot', follows: true, drift: true, provenance: { member: 'inherited' } })
    expect(isOperatorContentPin(drift)).toBe(false)
    expect(isOperatorContentPin(resolveContent({ product, listing: { ...listing, followMasterTitle: false }, field: 'title', address }))).toBe(true)
  })
  it('preserves [] on list wires while keeping an explicit child clear', () => {
    const parent = { id: 'p', categoryAttributes: { material: ['Parent'] } }
    const fields = resolveContentAttributes({ product: { id: 'c', parentId: 'p', categoryAttributes: { material: null } }, parent, requested: 'it', localizableKeys: ['material'] })
    expect(fields.material.value).toBeNull()
    expect(contentWireValue(fields.material.value, 'list')).toEqual([])
    expect(contentWireValue(null, 'text')).toBeNull()
    expect(contentWireValue(['Own'], 'list')).toEqual(['Own'])
  })
})
