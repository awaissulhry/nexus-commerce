import { describe, expect, it } from 'vitest'
import { fieldHistorySelection } from './fieldHistorySelection'

const scope = { kind: 'master' as const, marketplace: 'IT', locale: 'it', label: 'Shared · IT' }

describe('drawer field-history coordinate', () => {
  it('uses the widened column language with the cell’s canonical write field', () => {
    expect(fieldHistorySelection('title@de', 'title', scope)).toEqual({
      fieldKey: 'title',
      scope: { ...scope, locale: 'de' },
    })
  })

  it('strips the language suffix when an empty cell has no write field', () => {
    expect(fieldHistorySelection('bulletPoints@nl', undefined, scope)).toEqual({
      fieldKey: 'bulletPoints',
      scope: { ...scope, locale: 'nl' },
    })
  })

  it('keeps the selected scope locale for an ordinary column', () => {
    expect(fieldHistorySelection('sku', 'sku', scope)).toEqual({ fieldKey: 'sku', scope })
  })
})
