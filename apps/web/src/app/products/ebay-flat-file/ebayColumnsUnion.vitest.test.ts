/**
 * EFX P4 — union manifest + ghost column helpers (ebay-columns.ts).
 */
import { describe, it, expect } from 'vitest'
import {
  mergeCategoryGroups,
  buildGhostAspectColumns,
  computeAspectKeySignature,
  buildCategoryColumns,
  aspectRoutesToPanel,
  GHOST_COLUMN_DESC,
  type CategoryAspect,
  type EbayColumnGroup,
} from './ebay-columns'

function aspect(partial: Partial<CategoryAspect> & { id: string; label: string }): CategoryAspect {
  return {
    kind: 'text',
    required: false,
    recommended: false,
    width: 130,
    ...partial,
  } as CategoryAspect
}

function group(aspects: CategoryAspect[]): EbayColumnGroup {
  return buildCategoryColumns(aspects)
}

describe('mergeCategoryGroups', () => {
  it('unions columns across categories and records applicableCategories', () => {
    const a = group([aspect({ id: 'aspect_Marca', label: 'Marca (Brand)' })])
    const b = group([
      aspect({ id: 'aspect_Marca', label: 'Marca (Brand)' }),
      aspect({ id: 'aspect_Materiale', label: 'Materiale (Material)' }),
    ])
    const merged = mergeCategoryGroups([
      { categoryId: '111', group: a },
      { categoryId: '222', group: b },
    ])
    expect(merged.id).toBe('item-specifics')
    expect(merged.columns).toHaveLength(2)
    const marca = merged.columns.find((c) => c.id === 'aspect_Marca')!
    expect(marca.applicableCategories).toEqual(['111', '222'])
    const materiale = merged.columns.find((c) => c.id === 'aspect_Materiale')!
    expect(materiale.applicableCategories).toEqual(['222'])
  })

  it('folds dual-cased ids by lowercase, keeping the mixed-case variant', () => {
    const a = group([aspect({ id: 'aspect_colore', label: 'colore' })])
    const b = group([aspect({ id: 'aspect_Colore', label: 'Colore (Color)' })])
    const merged = mergeCategoryGroups([
      { categoryId: 'A', group: a },
      { categoryId: 'B', group: b },
    ])
    expect(merged.columns).toHaveLength(1)
    expect(merged.columns[0].id).toBe('aspect_Colore')
    expect(merged.columns[0].applicableCategories).toEqual(['A', 'B'])
  })

  it('required = ANY category requires; requiredForCategories names them; label gains *', () => {
    const a = group([aspect({ id: 'aspect_Taglia', label: 'Taglia (Size)', required: false })])
    const b = group([aspect({ id: 'aspect_Taglia', label: 'Taglia (Size)', required: true })])
    const merged = mergeCategoryGroups([
      { categoryId: 'A', group: a },
      { categoryId: 'B', group: b },
    ])
    const col = merged.columns[0]
    expect(col.required).toBe(true)
    expect(col.requiredForCategories).toEqual(['B'])
    expect(col.applicableCategories).toEqual(['A', 'B'])
    expect(col.label.endsWith(' *')).toBe(true)
  })

  it('unions options as a set and widens enumMode to open when any category is open', () => {
    const a = group([aspect({ id: 'aspect_Stagione', label: 'Stagione', kind: 'enum', options: ['Estate', 'Inverno'], enumMode: 'strict' })])
    const b = group([aspect({ id: 'aspect_Stagione', label: 'Stagione', kind: 'enum', options: ['Inverno', 'Autunno'], enumMode: 'open' })])
    const merged = mergeCategoryGroups([
      { categoryId: 'A', group: a },
      { categoryId: 'B', group: b },
    ])
    const col = merged.columns[0]
    expect(col.options).toEqual(['Estate', 'Inverno', 'Autunno'])
    expect(col.enumMode).toBe('open')
  })

  it('keeps strict when every category is strict', () => {
    const a = group([aspect({ id: 'aspect_X', label: 'X', kind: 'enum', options: ['1'], enumMode: 'strict' })])
    const b = group([aspect({ id: 'aspect_X', label: 'X', kind: 'enum', options: ['2'], enumMode: 'strict' })])
    const merged = mergeCategoryGroups([
      { categoryId: 'A', group: a },
      { categoryId: 'B', group: b },
    ])
    expect(merged.columns[0].enumMode).toBe('strict')
  })

  it('widens conflicting kinds to enum (open) when either side is an enum', () => {
    const a = group([aspect({ id: 'aspect_Numero', label: 'Numero', kind: 'number' })])
    const b = group([aspect({ id: 'aspect_Numero', label: 'Numero', kind: 'enum', options: ['1', '2'], enumMode: 'strict' })])
    const merged = mergeCategoryGroups([
      { categoryId: 'A', group: a },
      { categoryId: 'B', group: b },
    ])
    expect(merged.columns[0].kind).toBe('enum')
    expect(merged.columns[0].enumMode).toBe('open')
  })

  it('a single category passes through with its own tags', () => {
    const merged = mergeCategoryGroups([
      { categoryId: '177104', group: group([aspect({ id: 'aspect_Marca', label: 'Marca', required: true })]) },
    ])
    expect(merged.columns).toHaveLength(1)
    expect(merged.columns[0].applicableCategories).toEqual(['177104'])
    expect(merged.columns[0].requiredForCategories).toEqual(['177104'])
  })
})

describe('computeAspectKeySignature', () => {
  it('is stable across row order and only reflects keys with non-empty values', () => {
    const r1 = { aspect_Colore: 'Nero', aspect_Taglia: '', title: 'x' }
    const r2 = { aspect_Marca: 'Xavia', aspect_Vuoto: null }
    expect(computeAspectKeySignature([r1, r2])).toBe(computeAspectKeySignature([r2, r1]))
    const keys = JSON.parse(computeAspectKeySignature([r1, r2])) as string[]
    expect(keys).toContain('aspect_Colore')
    expect(keys).toContain('aspect_Marca')
    expect(keys).not.toContain('aspect_Taglia') // empty value
    expect(keys).not.toContain('aspect_Vuoto')  // null value
    expect(keys).not.toContain('title')
  })

  it('folds dual-cased keys by lowercase, preferring the mixed-case representative', () => {
    const keys = JSON.parse(computeAspectKeySignature([
      { aspect_colore: 'Nero' },
      { aspect_Colore: 'Rosso' },
    ])) as string[]
    expect(keys).toEqual(['aspect_Colore'])
  })
})

describe('buildGhostAspectColumns', () => {
  it('excludes keys covered by the union (case-insensitively) and folds dual-cased ghosts', () => {
    const ghosts = buildGhostAspectColumns(
      ['aspect_colore', 'aspect_Team_Name', 'aspect_team_name', 'aspect_Legacy_Field'],
      ['aspect_Colore'],
    )
    expect(ghosts.map((g) => g.id).sort()).toEqual(['aspect_Legacy_Field', 'aspect_Team_Name'])
  })

  it('flags ghost columns with the ⚠ label suffix, tooltip description, editable text kind', () => {
    const [g] = buildGhostAspectColumns(['aspect_Team_Name'], [])
    expect(g.label).toBe('Team Name ⚠')
    expect(g.description).toBe(GHOST_COLUMN_DESC)
    expect(g.kind).toBe('text')
    expect(g.required).toBe(false)
    expect(g.readOnly).toBeUndefined()
    expect(g.ghost).toBe(true)
  })

  it('returns nothing when every key is in the union', () => {
    expect(buildGhostAspectColumns(['aspect_Marca'], ['aspect_marca'])).toEqual([])
  })
})

describe('aspectRoutesToPanel (UFX P5)', () => {
  it('routes real schema aspect columns to the Item Specifics panel', () => {
    expect(aspectRoutesToPanel({ id: 'aspect_Colore' })).toBe(true)
    expect(aspectRoutesToPanel({ id: 'aspect_Marca', ghost: undefined })).toBe(true)
    const merged = mergeCategoryGroups([
      { categoryId: '111', group: group([aspect({ id: 'aspect_Marca', label: 'Marca' })]) },
    ])
    expect(aspectRoutesToPanel(merged.columns[0])).toBe(true)
  })

  it('lets ghost aspect columns fall through to the inline editor', () => {
    const [g] = buildGhostAspectColumns(['aspect_Team_Name'], [])
    expect(aspectRoutesToPanel(g)).toBe(false)
    expect(aspectRoutesToPanel({ id: 'aspect_Legacy', ghost: true })).toBe(false)
  })

  it('never routes non-aspect columns', () => {
    expect(aspectRoutesToPanel({ id: 'title' })).toBe(false)
    expect(aspectRoutesToPanel({ id: 'category_id', ghost: true })).toBe(false)
  })
})
