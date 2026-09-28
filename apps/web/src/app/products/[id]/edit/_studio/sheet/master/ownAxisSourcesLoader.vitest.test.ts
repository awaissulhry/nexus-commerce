/**
 * Sheet pop-up P3 A3 — how the sheet reads every answer of `POST …/studio/own-axis-attribute` (QUALITY-PLAN §4.10), and that
 * an older server without `newAttribute` offers no "New attribute" (never a dead control). Made-up data only.
 */
import { describe, expect, it } from 'vitest'
import { CHANNEL_AXES_COPY } from '@/design-system/grid'
import { ownAxisAttributeAnswer } from './ownAxisSourcesLoader'

const SOURCE = { field: 'stile', label: 'Stile', filled: 0, of: 4, values: [] }

describe('the create route\'s answers, as the pop-up reads them', () => {
  it('created, placed and present carry the new "Values from" entry', () => {
    expect(ownAxisAttributeAnswer(201, { outcome: 'created', source: SOURCE })).toEqual({ outcome: 'created', source: SOURCE })
    expect(ownAxisAttributeAnswer(200, { outcome: 'placed', source: SOURCE })).toEqual({ outcome: 'placed', source: SOURCE })
    expect(ownAxisAttributeAnswer(200, { outcome: 'present', source: SOURCE })).toEqual({ outcome: 'present', source: SOURCE })
  })

  it('the 409 is an offer to use the existing attribute; a 400 is the server\'s sentence; a 403 the permission sentence', () => {
    expect(ownAxisAttributeAnswer(409, { error: 'own_axis_attribute_exists', message: '“Fit” already exists. Use it in this family?', offer: { code: 'fit', label: 'Fit' } }))
      .toEqual({ outcome: 'offer', message: '“Fit” already exists. Use it in this family?', label: 'Fit' })
    expect(ownAxisAttributeAnswer(400, { error: 'own_axis_attribute_refused', message: 'Use letters or digits in the name.' }))
      .toEqual({ outcome: 'refused', message: 'Use letters or digits in the name.' })
    expect(ownAxisAttributeAnswer(403, { error: 'forbidden', message: 'This operation requires pim.manage.' }))
      .toEqual({ outcome: 'refused', message: CHANNEL_AXES_COPY.noPermission })
  })

  it('🔴 anything else throws with the server\'s words — a 2xx without a source is not a success', () => {
    expect(() => ownAxisAttributeAnswer(500, { message: 'database down' })).toThrow('database down')
    expect(() => ownAxisAttributeAnswer(201, { outcome: 'created' })).toThrow('the attribute call failed (201)')
    expect(() => ownAxisAttributeAnswer(400, {})).toThrow('the attribute call failed (400)')
  })
})
