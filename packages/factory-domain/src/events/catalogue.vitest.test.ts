import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ROLE_TEMPLATES } from '../auth/roles/templates'
import { createCatalogue, EVENT_CATALOGUE, EVENT_DEFINITIONS, EventPayloadError, UndeclaredEventError } from './catalogue'
import { defineEvent } from './define'

const v1 = defineEvent({ type: 'lot.released', context: 'quality', description: 'A lot was released.', payload: z.strictObject({ lotId: z.string() }) })
const v2 = defineEvent({
  type: 'lot.released',
  version: 2,
  context: 'quality',
  description: 'A lot was released, with who signed.',
  payload: z.strictObject({ lotId: z.string(), signedBy: z.string() }),
})
const other = defineEvent({ type: 'ddt.issued', context: 'shipping', description: 'A DDT was issued.', payload: z.strictObject({ ddtId: z.string() }) })

describe('createCatalogue', () => {
  const catalogue = createCatalogue([v2, other, v1])

  it('finds each version of each type, sorted', () => {
    expect(catalogue.definitions.map((definition) => `${definition.type}@${definition.version}`)).toEqual(['ddt.issued@1', 'lot.released@1', 'lot.released@2'])
    expect(catalogue.types()).toEqual(['ddt.issued', 'lot.released'])
    expect(catalogue.get('lot.released', 2)).toBe(v2)
    expect(catalogue.find('lot.released', 3)).toBeUndefined()
  })

  it('refuses an undeclared type or version', () => {
    expect(() => catalogue.get('lot.scrapped', 1)).toThrow(UndeclaredEventError)
    expect(() => catalogue.get('lot.released', 3)).toThrow(/"lot.released" version 3 is not declared/)
    expect(() => catalogue.parse('lot.scrapped', 1, {})).toThrow(UndeclaredEventError)
  })

  it('parses a payload strictly: a missing or unknown key is refused', () => {
    expect(catalogue.parse('lot.released', 1, { lotId: 'L1' })).toEqual({ lotId: 'L1' })
    expect(() => catalogue.parse('lot.released', 1, { lotId: 'L1', extra: true })).toThrow(EventPayloadError)
    expect(() => catalogue.parse('lot.released', 2, { lotId: 'L1' })).toThrow(/signedBy/)
  })

  it('refuses a type and version declared twice, or one type in two modules', () => {
    expect(() => createCatalogue([v1, v1])).toThrow(/declared twice/)
    const elsewhere = defineEvent({ type: 'lot.released', version: 3, context: 'inventory', description: 'x', payload: z.strictObject({}) })
    expect(() => createCatalogue([v1, elsewhere])).toThrow(/declared by two modules/)
  })
})

describe('EVENT_CATALOGUE', () => {
  const src = fileURLToPath(new URL('..', import.meta.url))

  it('is built from EVENT_DEFINITIONS', () => {
    expect(EVENT_CATALOGUE.definitions).toHaveLength(EVENT_DEFINITIONS.length)
  })

  it('assembles every module events file (src/<module>/events.ts)', () => {
    const catalogueSource = readFileSync(join(src, 'events', 'catalogue.ts'), 'utf8')
    const modules = readdirSync(src, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(src, entry.name, 'events.ts')))
      .map((entry) => entry.name)
    for (const module of modules) expect(catalogueSource, `src/${module}/events.ts`).toContain(`from '../${module}/events'`)
  })

  // B-W2a-F5: a live rule's floor permission is one a floor role really holds, so the floor events reach a tablet.
  it('names, on every rule that reaches the floor, a permission a floor role template holds', () => {
    const heldOnTheFloor = new Set(ROLE_TEMPLATES.filter((template) => template.audience === 'floor').flatMap((template) => template.permissions))
    const floorRules = EVENT_CATALOGUE.definitions.filter((definition) => definition.live?.floor)
    expect(floorRules.length).toBeGreaterThan(0)
    for (const definition of floorRules) expect(heldOnTheFloor.has(definition.live!.floor!), `${definition.type}: ${definition.live!.floor}`).toBe(true)
  })

  it('sends My work and the station screens what they listen to (floor.work; the machine card plant.report)', () => {
    const floorOf = (type: string) => EVENT_CATALOGUE.find(type, 1)?.live?.floor
    for (const type of ['planning.schedule_published', 'production.scan_recorded', 'quality.hold_placed', 'quality.hold_released', 'workorder.status_changed']) {
      expect(floorOf(type), type).toBe('floor.work')
    }
    expect(floorOf('machine.status_changed')).toBe('plant.report')
    expect(floorOf('quality.inspection_decided')).toBe('quality.inspections.view')
  })
})
