import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GarmentZoneMap } from './GarmentZoneMap'
import { GARMENT_ZONE_MAP_LABELS } from './GarmentZoneMapLabels'
import { centreOf, figureOf, offSketch, primaryShapes, RIDER_GARMENT_SHAPES, stepZone, zoneLabel, zoneMarkViews } from './garmentZoneMapModel'

/** B-W2b-207 — GarmentZoneMap (moved from the factory's quality area). Made-up words; the factory's ids. */
const IDS = ['FRONT', 'BACK', 'COLLAR', 'SHOULDER', 'SHOULDER_L', 'SHOULDER_R', 'SLEEVE_L', 'SLEEVE_R', 'ELBOW_L', 'ELBOW_R', 'CUFF', 'CHEST', 'BACK_PROTECTOR', 'WAIST', 'HIP_L', 'HIP_R', 'SEAT', 'KNEE_L', 'KNEE_R', 'LEG_L', 'LEG_R', 'ZIP', 'POCKET', 'LINING', 'LABEL']
const ZONES = IDS.map((id) => ({ id, label: id.charAt(0) + id.slice(1).toLowerCase().replace('_', ' ') }))

describe('the rider sketch', () => {
  it('every zone has exactly one pressable place: a shape that is not a copy, or a chip', () => {
    for (const id of IDS) {
      const primaries = RIDER_GARMENT_SHAPES.filter((shape) => shape.zone === id && !shape.copy)
      expect(primaries.length + (offSketch(IDS).includes(id) ? 1 : 0), id).toBe(1)
    }
    expect(primaryShapes(IDS).length + offSketch(IDS).length).toBe(IDS.length)
    expect(offSketch(IDS)).toEqual(['LINING'])
    expect([figureOf('SLEEVE_L'), figureOf('ELBOW_R'), figureOf('KNEE_L'), figureOf('LINING'), figureOf(null)]).toEqual(['front', 'back', 'trousers', null, null])
    expect(centreOf('10,10 30,10 30,20 10,20')).toEqual({ x: 20, y: 15 })
  })

  it('the arrows walk every zone in the zones’ order, round the end', () => {
    expect(stepZone(IDS, null, 1)).toBe('FRONT')
    expect(stepZone(IDS, 'FRONT', -1)).toBe('LABEL')
    expect(stepZone(IDS, 'LABEL', 1)).toBe('FRONT')
    expect(stepZone(IDS, 'COLLAR', 1)).toBe('SHOULDER')
    expect(stepZone([], 'FRONT', 1)).toBeNull()
    expect([zoneLabel(ZONES, 'ELBOW_L'), zoneLabel(ZONES, 'X'), zoneLabel(ZONES, null)]).toEqual(['Elbow l', 'X', ''])
  })

  it('marks: one per zone, four steps against the biggest, biggest first; text wins; 0 is no mark', () => {
    const views = zoneMarkViews(
      [
        { zone: 'CHEST', value: 8 },
        { zone: 'CUFF', value: 2 },
        { zone: 'CUFF', value: 3 },
        { zone: 'ZIP', value: 0 },
        { zone: 'LINING', text: 'Abrasion' },
      ],
      ZONES,
    )
    expect(views.map((view) => [view.zone, view.level, view.words])).toEqual([
      ['CHEST', 4, '8'],
      ['CUFF', 2, '3'],
      ['LINING', 2, 'Abrasion'],
    ])
    expect(zoneMarkViews(null, ZONES)).toEqual([])
  })
})

describe('GarmentZoneMap', () => {
  it('editable: every zone a button with its words, the picked one pressed, ONE Tab stop, the list and Clear', () => {
    const html = render(h(GarmentZoneMap, { zones: ZONES, label: 'Where', value: 'CHEST', onChange: () => undefined }))
    expect((html.match(/role="button"/g) ?? []).length).toBe(primaryShapes(IDS).length)
    expect(html).toContain('aria-label="Chest"')
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1)
    expect((html.match(/tabindex="0"/gi) ?? []).length).toBe(1)
    expect(html).toContain('nds-zone-pin')
    expect(html).toContain('Zone: Chest')
    expect((html.match(/<option/g) ?? []).length).toBe(IDS.length + 1)
    expect(html).toContain(GARMENT_ZONE_MAP_LABELS.hint.slice(0, 40))
    expect(html).toContain('Jacket, back')
  })

  it('read-only (or held with a reason): the pin and the words, nothing pressable, no list', () => {
    const html = render(h(GarmentZoneMap, { zones: ZONES, label: 'Where', value: 'LINING', readOnly: true }))
    expect(html).not.toContain('role="button"')
    expect(html).not.toContain('<select')
    expect(html).toContain('Zone: Lining')
    const held = render(h(GarmentZoneMap, { zones: ZONES, label: 'Where', value: null, onChange: () => undefined, heldReason: 'Signed: it no longer changes.' }))
    expect(held).not.toContain('role="button"')
    expect(held).toContain('Signed: it no longer changes.')
    expect(held).toContain('No zone picked')
  })

  it('marks: drawn stronger with their number, said in the shape’s name, and listed in a table', () => {
    const html = render(h(GarmentZoneMap, { zones: ZONES, label: 'Defects', value: null, onChange: () => undefined, marks: [{ zone: 'CHEST', value: 4 }, { zone: 'CUFF', value: 1 }], labels: { marks: 'Defects by zone', marksValue: 'Defects' } }))
    expect(html).toContain('data-level="4"')
    expect(html).toContain('aria-label="Chest: 4"')
    expect(html).toContain('<caption class="nds-zone-sub">Defects by zone</caption>')
    expect(html).toMatch(/<th scope="row">Chest<\/th><td>4<\/td>/)
    expect(html).toContain('nds-zone-mark-words')
    // A text mark is shaded and said in the table, not written on the sketch.
    const risk = render(h(GarmentZoneMap, { zones: ZONES, label: 'Risk', value: null, readOnly: true, marks: [{ zone: 'SEAT', text: 'Abrasion' }] }))
    expect(risk).toContain('<td>Abrasion</td>')
    expect(risk).not.toContain('nds-zone-mark-words')
  })

  it('without marks there is no table; the words come from labels', () => {
    const html = render(h(GarmentZoneMap, { zones: ZONES, label: 'Dove', value: 'CUFF', readOnly: true, labels: { picked: (zone: string) => `Zona: ${zone}`, figures: { front: 'Giacca, davanti', back: 'Giacca, dietro', trousers: 'Pantaloni, davanti' } } }))
    expect(html).not.toContain('<table')
    expect(html).toContain('Zona: Cuff')
    expect(html).toContain('Giacca, dietro')
  })
})
