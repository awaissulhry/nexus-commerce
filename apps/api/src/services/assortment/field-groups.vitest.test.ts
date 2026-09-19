/**
 * AE.3 — every Product column has a field-group decision, derived from schema.prisma so that a column
 * added later fails here instead of being copied, or dropped, without anyone deciding.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FIELD_GROUPS } from './share-rules.js'
import { PRODUCT_COLUMNS, classifyRow } from './field-groups.js'

const schemaPath = fileURLToPath(new URL('../../../../../packages/database/prisma/schema.prisma', import.meta.url))

/** Scalar and enum fields of `model Product` — everything that is not a relation. */
function productColumns(): string[] {
  const schema = readFileSync(schemaPath, 'utf8')
  const start = schema.indexOf('\nmodel Product {')
  const end = schema.indexOf('\n}\n', start)
  expect(start, 'model Product not found in schema.prisma').toBeGreaterThan(-1)
  const models = new Set([...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]))
  const columns: string[] = []
  for (const line of schema.slice(start, end).split('\n').slice(2)) {
    const match = /^\s+(\w+)\s+(\w+)(\[\])?\??/.exec(line)
    if (!match || line.trim().startsWith('//') || line.trim().startsWith('@@')) continue
    if (models.has(match[2])) continue // a relation field
    columns.push(match[1])
  }
  return columns
}

describe('AE.3 field groups', () => {
  it('every scalar column of Product has exactly one decision, and the map names no column that does not exist', () => {
    const columns = productColumns()
    expect(columns.length, 'parser found too few columns — the schema read is broken').toBeGreaterThan(80)
    expect(columns).toContain('sku')
    expect(columns).toContain('declarationOfConformityUrl')
    const missing = columns.filter((c) => !(c in PRODUCT_COLUMNS))
    const stale = Object.keys(PRODUCT_COLUMNS).filter((c) => !columns.includes(c))
    expect(missing, 'Product columns with no field-group decision').toEqual([])
    expect(stale, 'decisions for columns that no longer exist').toEqual([])
  })

  it('every group a column names is a real field group; every never has a reason', () => {
    for (const [column, disposition] of Object.entries(PRODUCT_COLUMNS)) {
      if ('group' in disposition) expect(FIELD_GROUPS, column).toContain(disposition.group)
      else expect(disposition.never.length, column).toBeGreaterThan(10)
    }
  })

  it('channel identities, stock and cost are never copied', () => {
    for (const column of ['amazonAsin', 'ebayItemId', 'fnsku', 'totalStock', 'costPrice', 'fulfillmentMethod', 'workflowStageId']) {
      expect('never' in PRODUCT_COLUMNS[column], column).toBe(true)
    }
  })

  it('rows classify by metadata, then language, then storage, then column; an unknown key is never copied', () => {
    expect(classifyRow({ field: 'parentSku' }, undefined, 'it')).toEqual({ group: 'structure' })
    expect(classifyRow({ field: 'categoryIds' }, undefined, 'it')).toEqual({ group: 'attributes' })
    expect(classifyRow({ field: 'name', locale: 'de' }, 'column', 'it')).toEqual({ group: 'translations' })
    expect(classifyRow({ field: 'name', locale: 'it' }, 'column', 'it')).toEqual({ group: 'content' })
    expect(classifyRow({ field: 'armor_level' }, 'categoryAttributes', 'it')).toEqual({ group: 'attributes' })
    expect(classifyRow({ field: 'item_name' }, 'listing', 'it')).toMatchObject({ never: expect.stringMatching(/listing/) })
    expect(classifyRow({ field: 'gtin' }, 'column', 'it')).toEqual({ group: 'identity' })
    expect(classifyRow({ field: 'mystery' }, undefined, 'it')).toMatchObject({ never: 'this field is not shared yet' })
  })
})
