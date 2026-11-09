import { describe, expect, it } from 'vitest'
import { composeLabel } from '@nexus/factory-domain/labels/model'
import { labelZpl } from '@nexus/factory-domain/labels/zpl'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { remnantLabel } from './remnant'
import { rollLabel } from './roll'
import { labelNumber } from './tag'

const TAG = tenantTag('0199f0a0-0000-7000-8000-000000000001')
const STOCK = { dpi: 203, widthMm: 100, heightMm: 50 }

describe('the roll and remnant tags (B-W2b-219)', () => {
  it('a number in the label\'s words: two places, the language\'s mark, the unit\'s symbol', () => {
    expect(labelNumber('25.4', 'M', 'it')).toBe('25,40 m')
    expect(labelNumber('145.5', 'CM', 'en')).toBe('145.50 cm')
    expect(labelNumber('5', 'FT2', 'en')).toBe('5.00 ft²')
  })

  it('lays a roll out as a ROLL label and ZPL: the RL code as Code 128, the length left, the width, the shade, the lot', () => {
    const code = formatScanId({ type: 'ROLL', tenantTag: TAG, ref: 4 })
    const input = rollLabel({ code, maker: 'Seed A', itemCode: 'LIN-01', itemName: 'Fodera', colour: 'BLK Nero', lengthLeft: '24.4000', uom: 'M', widthCm: '145.50', shade: '1', lotCode: 'SEED-LOT-LIN-01' }, 'it')
    const label = composeLabel(input, { tenantTag: TAG })
    expect(label.heading).toBe('Rotolo · Seed A')
    expect(label.fields).toEqual([
      { key: 'article', label: 'Articolo', value: 'LIN-01' },
      { key: 'colour', label: 'Colore', value: 'BLK Nero' },
      { key: 'length', label: 'Lunghezza', value: '24,40 m' },
      { key: 'width', label: 'Altezza', value: '145,50 cm' },
      { key: 'shade', label: 'Tonalità', value: '1' },
      { key: 'lot', label: 'Lotto', value: 'SEED-LOT-LIN-01' },
    ])
    const zpl = labelZpl(label, STOCK, 1)
    expect(zpl).toContain(code)
    expect(zpl.startsWith('^XA')).toBe(true)
  })

  it('lays a remnant out as a REMNANT label: the RM code, its area, its grade and the hide it is cut from', () => {
    const code = formatScanId({ type: 'REMNANT', tenantTag: TAG, ref: 9 })
    const label = composeLabel(remnantLabel({ code, maker: null, itemCode: 'LEA-110', itemName: 'Vacchetta', colour: null, area: '5', areaUom: 'FT2', grade: 'B', hideCode: 'HD-7K-0003RJ-M', lotCode: 'SEED-LOT-LEA-09' }, 'en'), { tenantTag: TAG })
    expect(label).toMatchObject({ kind: 'REMNANT', heading: 'Remnant', scanId: code })
    expect(label.fields.map((field) => [field.label, field.value])).toEqual([
      ['Article', 'LEA-110'],
      ['Area', '5.00 ft²'],
      ['Grade', 'B'],
      ['Hide', 'HD-7K-0003RJ-M'],
      ['Lot', 'SEED-LOT-LEA-09'],
    ])
  })
})
