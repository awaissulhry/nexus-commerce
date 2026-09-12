import { describe, expect, it } from 'vitest'
import { applyNormalizedReferenceChanges } from './normalizedReferenceChanges'

const submitted = [{ colId: 'descriptionThemeId', field: 'attr_descriptionThemeId', value: 'Modern' }]
const normalization = { id: 'p', field: 'attr_descriptionThemeId', value: 'theme-id' }
describe('server-normalized reference values', () => {
  it('replaces the submitted display name with the saved ID and retains cell metadata', () => {
    const row = { id: 'p', values: { descriptionThemeId: { value: 'Modern', pinned: true } } }
    applyNormalizedReferenceChanges({ normalizedChanges: [normalization] }, row, submitted)
    expect(row.values.descriptionThemeId).toEqual({ value: 'theme-id', pinned: true })
  })
  it('does not overwrite a newer edit while the save request is in flight', () => {
    const row = { id: 'p', values: { descriptionThemeId: { value: 'Newer choice' } } }
    applyNormalizedReferenceChanges({ normalizedChanges: [normalization] }, row, submitted)
    expect(row.values.descriptionThemeId.value).toBe('Newer choice')
  })
  it('ignores failed, foreign, malformed and unsubmitted fields', () => {
    for (const body of [
      { normalizedChanges: [normalization], errors: [{ id: 'p', field: 'attr_descriptionThemeId' }] },
      { normalizedChanges: [{ ...normalization, id: 'another' }] },
      { normalizedChanges: [{ ...normalization, value: {} }] },
      { normalizedChanges: [{ ...normalization, field: 'manufacturer' }] },
      { normalizedChanges: {} },
    ]) {
      const row = { id: 'p', values: { descriptionThemeId: { value: 'Modern' } } }
      applyNormalizedReferenceChanges(body, row, submitted)
      expect(row.values.descriptionThemeId.value).toBe('Modern')
    }
  })
  it('accepts null when the server resolves Default theme', () => {
    const row = { id: 'p', values: { descriptionThemeId: { value: 'Default theme' } } }
    applyNormalizedReferenceChanges({ normalizedChanges: [{ ...normalization, value: null }] }, row, [{ ...submitted[0], value: 'Default theme' }])
    expect(row.values.descriptionThemeId.value).toBeNull()
  })
})
