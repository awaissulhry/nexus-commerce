/**
 * Shared stock step 6 (AE.4) — the field-state rule, with no database, and the capture trigger's column
 * lists kept equal to field-groups.ts (contract docs/2026-09-19-shared-stock-build.md §6.1).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PRODUCT_COLUMNS } from './field-groups.js'
import {
  ABSENT, FOLLOW_AGAIN, decide, fieldKey, fingerprint, imageFilePrint, imageMetaPrint, planMedia, readState, rowPrints, rowValue,
  type ImageFacts, type Pair,
} from './sync-fields.js'

const rulesPath = fileURLToPath(new URL('../../../../../packages/database/workspaces/assortment-sync.sql', import.meta.url))

describe('AE.4 — the field-state rule', () => {
  const s = (value: unknown) => fingerprint({ action: 'SET', value })
  const pair = (source: unknown, target: unknown): Pair => [s(source), s(target)]

  it('applies a source change, keeps a follower edit, and does nothing when neither changed', () => {
    expect(decide({ source: s('new'), target: s('old'), applied: pair('old', 'old'), overridden: false })).toBe('apply')
    expect(decide({ source: s('new'), target: s('mine'), applied: pair('old', 'old'), overridden: false })).toBe('override')
    expect(decide({ source: s('old'), target: s('mine'), applied: pair('old', 'old'), overridden: false })).toBe('override')
    expect(decide({ source: s('old'), target: s('old'), applied: pair('old', 'old'), overridden: false })).toBe('same')
  })

  it('compares each side with its OWN fingerprint: a value the follower stores in its own form is not an edit', () => {
    // The follower stored "1.50" for the source's "1.5": the pair remembers both.
    const applied: Pair = [s('1.5'), s('1.50')]
    expect(decide({ source: s('1.5'), target: s('1.50'), applied, overridden: false })).toBe('same')
    expect(decide({ source: s('2'), target: s('1.50'), applied, overridden: false })).toBe('apply')
  })

  it('an override stays until "Follow again", whatever the values', () => {
    expect(decide({ source: s('new'), target: s('old'), applied: pair('old', 'old'), overridden: true })).toBe('override')
    expect(decide({ source: s('same'), target: s('same'), applied: pair('same', 'same'), overridden: true })).toBe('override')
  })

  it('"Follow again" applies the source over whatever the follower holds', () => {
    expect(decide({ source: s('new'), target: s('mine'), applied: ['', FOLLOW_AGAIN], overridden: false })).toBe('apply')
  })

  it('with no fingerprint: equal values are recorded, a blank is filled, a differing value is never overwritten', () => {
    expect(decide({ source: s('x'), target: s('x'), applied: undefined, overridden: false })).toBe('record')
    expect(decide({ source: s('x'), target: ABSENT, applied: undefined, overridden: false })).toBe('apply')
    expect(decide({ source: s('x'), target: fingerprint({ action: 'CLEAR' }), applied: undefined, overridden: false })).toBe('apply')
    expect(decide({ source: s('x'), target: s('y'), applied: undefined, overridden: false })).toBe('override')
  })

  it('rows: categories compare by path, an inherited language row by its ownership alone, keys carry the language', () => {
    const row = { row: 1, entity: 'Products' as const, sku: 'A', channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '' }
    const paths = new Map([['cat-a', 'apparel/jackets'], ['cat-b', 'apparel/coats']])
    const pathOf = (id: string) => paths.get(id) ?? null
    expect(rowValue({ ...row, field: 'categoryIds', action: 'SET', value: ['cat-b', 'cat-a'] }, pathOf)).toEqual({ action: 'SET', value: ['apparel/coats', 'apparel/jackets'] })
    expect(rowValue({ ...row, field: 'name', locale: 'de', action: 'INHERIT', value: 'Parent text' }, pathOf)).toEqual({ action: 'INHERIT' })
    expect(fieldKey({ field: 'name', locale: 'de' })).toBe('name@de')
    expect(fieldKey({ field: 'name', locale: '' })).toBe('name')
    // The same categories under other ids (another business) print the same.
    const other = new Map([['x1', 'apparel/jackets'], ['x2', 'apparel/coats']])
    const a = rowPrints([{ ...row, field: 'categoryIds', action: 'SET', value: ['cat-a', 'cat-b'] }], pathOf)
    const b = rowPrints([{ ...row, field: 'categoryIds', action: 'SET', value: ['x2', 'x1'] }], (id) => other.get(id) ?? null)
    expect(a.get('categoryIds')).toBe(b.get('categoryIds'))
    // Listing rows are not product fields.
    expect(rowPrints([{ ...row, entity: 'Overrides', field: 'title', action: 'SET', value: 'x' }], pathOf).size).toBe(0)
  })

  it('images: a new image is added, a removed one removed, a new address is copied again, new text updates the copy', () => {
    const image = (id: string, url: string, alt: string | null = null): ImageFacts => ({ id, url, alt, type: 'ALT', isPrimary: false, sortOrder: 0 })
    const entry = (i: ImageFacts, target: string) => ({ source: i.id, target, file: imageFilePrint(i), meta: imageMetaPrint(i) })
    const kept = image('s1', 'https://a/1.png'), gone = image('s2', 'https://a/2.png'), moved = image('s3', 'https://a/3.png'), retold = image('s4', 'https://a/4.png')
    const map = [entry(kept, 't1'), entry(gone, 't2'), entry(moved, 't3'), entry(retold, 't4')]
    const plan = planMedia([kept, { ...moved, url: 'https://a/3-v2.png' }, { ...retold, alt: 'New words' }, image('s5', 'https://a/5.png')], map)
    expect(plan.add.map((i) => i.id).sort()).toEqual(['s3', 's5'])
    expect(plan.remove.map((e) => e.target).sort()).toEqual(['t2', 't3'])
    expect(plan.update.map((u) => [u.source.id, u.entry.target])).toEqual([['s4', 't4']])
    // Order alone is not followed.
    expect(planMedia([{ ...kept, sortOrder: 9 }], [entry(kept, 't1')])).toEqual({ add: [], remove: [], update: [] })
  })

  it('a stored state is read back, and anything else starts empty', () => {
    expect(readState(null)).toEqual({ v: 1, fields: {} })
    expect(readState({ v: 2, fields: {} })).toEqual({ v: 1, fields: {} })
    expect(readState({ v: 1, fields: { name: ['a', 'b'] }, media: { target: 't', map: [] } })).toEqual({ v: 1, fields: { name: ['a', 'b'] }, media: { target: 't', map: [] } })
  })
})

describe('AE.4 — the capture trigger follows exactly the columns field-groups.ts shares', () => {
  const rules = readFileSync(rulesPath, 'utf8')
  const block = rules.slice(rules.indexOf('-- followed-columns:begin'), rules.indexOf('-- followed-columns:end'))

  const groupsInFunction = () => {
    const groups = new Map<string, Set<string>>()
    for (const match of block.matchAll(/IF \(?((?:OLD\.[\w"]+(?:,\s*)?\s*)+)\)?\s*IS DISTINCT FROM[\s\S]*?array_append\(groups, '(\w+)'\)/g)) {
      const columns = [...match[1].matchAll(/OLD\.("?)(\w+)\1/g)].map((m) => m[2])
      groups.set(match[2], new Set(columns))
    }
    return groups
  }

  it('each group in the trigger function lists exactly the columns of that group', () => {
    const found = groupsInFunction()
    expect(found.size, 'the parser found no groups — the rules file changed shape').toBeGreaterThan(5)
    const expected = new Map<string, Set<string>>()
    for (const [column, disposition] of Object.entries(PRODUCT_COLUMNS)) {
      if (!('group' in disposition)) continue
      expected.set(disposition.group, new Set([...(expected.get(disposition.group) ?? []), column]))
    }
    expected.set('lifecycle', new Set(['deletedAt']))
    const asSorted = (m: Map<string, Set<string>>) => Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort()]).sort())
    expect(asSorted(found)).toEqual(asSorted(expected))
  })

  it("the update trigger's WHEN lists the same columns, so a save of any other column never calls it", () => {
    const when = block.slice(block.indexOf('CREATE TRIGGER nexus_assortment_capture_product_update'))
    const old = [...when.slice(0, when.indexOf('IS DISTINCT FROM')).matchAll(/OLD\.("?)(\w+)\1/g)].map((m) => m[2]).sort()
    const shared = Object.entries(PRODUCT_COLUMNS).filter(([, d]) => 'group' in d).map(([column]) => column)
    expect(old).toEqual([...shared, 'deletedAt'].sort())
  })
})
