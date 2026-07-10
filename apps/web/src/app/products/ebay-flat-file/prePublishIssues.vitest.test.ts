import { describe, it, expect } from 'vitest'
import {
  scanAspectConflicts,
  describeConflict,
  buildPrePublishIssues,
} from './prePublishIssues.pure'

describe('scanAspectConflicts', () => {
  it('flags a variant carrying two synonym keys with differing values', () => {
    const conflicts = scanAspectConflicts([
      { sku: 'GALE-RED-M', aspect_Color: 'Red', aspect_Colore: 'Rosso' },
    ])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].sku).toBe('GALE-RED-M')
    expect(conflicts[0].entries.map((e) => e.name).sort()).toEqual(['Color', 'Colore'])
  })

  it('does NOT flag same-value synonym duplicates (harmless)', () => {
    expect(scanAspectConflicts([
      { sku: 'A', aspect_Color: 'Red', aspect_Colore: 'Red' },
    ])).toHaveLength(0)
  })

  it('does NOT flag a single aspect per dimension', () => {
    expect(scanAspectConflicts([
      { sku: 'A', aspect_Colore: 'Rosso', aspect_Taglia: 'M' },
    ])).toHaveLength(0)
  })

  it('treats custom axes (no synonym group) as distinct dimensions', () => {
    expect(scanAspectConflicts([
      { sku: 'A', aspect_Tipo_di_prodotto: 'Giacca', aspect_Colore: 'Rosso' },
    ])).toHaveLength(0)
  })

  it('ignores blank / whitespace-only values', () => {
    expect(scanAspectConflicts([
      { sku: 'A', aspect_Color: 'Red', aspect_Colore: '   ' },
    ])).toHaveLength(0)
  })

  it('trims before comparing so " Rosso " equals "Rosso"', () => {
    expect(scanAspectConflicts([
      { sku: 'A', aspect_Color: 'Rosso', aspect_Colore: ' Rosso ' },
    ])).toHaveLength(0)
  })

  it('scans across the size dimension too', () => {
    const conflicts = scanAspectConflicts([
      { sku: 'A', aspect_Size: 'M', aspect_Taglia: 'L' },
    ])
    expect(conflicts).toHaveLength(1)
  })

  it('handles multiple rows independently', () => {
    const conflicts = scanAspectConflicts([
      { sku: 'A', aspect_Color: 'Red', aspect_Colore: 'Rosso' },
      { sku: 'B', aspect_Colore: 'Nero' },
      { sku: 'C', aspect_Size: 'S', aspect_Taglia: 'XL' },
    ])
    expect(conflicts.map((c) => c.sku)).toEqual(['A', 'C'])
  })
})

describe('describeConflict', () => {
  it('names the SKU, both axes and their values, plus the fix hint', () => {
    const msg = describeConflict({
      sku: 'GALE-RED-M',
      entries: [{ name: 'Color', value: 'Red' }, { name: 'Colore', value: 'Rosso' }],
    })
    expect(msg).toContain('GALE-RED-M')
    expect(msg).toContain('Color (Red)')
    expect(msg).toContain('Colore (Rosso)')
    expect(msg).toContain('remove the duplicate')
  })
})

describe('buildPrePublishIssues', () => {
  it('returns empty when there are no issues (no modal)', () => {
    expect(buildPrePublishIssues({ conflicts: [], axisWarnings: [], suppressed: [] })).toEqual([])
  })

  it('orders conflicts, then axis warnings, then suppressed notes', () => {
    const issues = buildPrePublishIssues({
      conflicts: [{ sku: 'A', entries: [{ name: 'Color', value: 'Red' }, { name: 'Colore', value: 'Rosso' }] }],
      axisWarnings: ['Taglia has only one value'],
      suppressed: ['Team Name'],
    })
    expect(issues.map((i) => i.kind)).toEqual(['conflict', 'axis-warning', 'suppressed'])
    expect(issues[2].fix).toBeUndefined() // suppressed = read-only, no action
    expect(issues[2].message).toContain('no action needed')
  })

  it('dedupes repeated server warnings and suppressed strings', () => {
    const issues = buildPrePublishIssues({
      conflicts: [],
      axisWarnings: ['same warning', 'same warning'],
      suppressed: ['Team Name', 'Team Name'],
    })
    expect(issues).toHaveLength(2)
  })
})
