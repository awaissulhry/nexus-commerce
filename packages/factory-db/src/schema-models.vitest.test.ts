import { describe, expect, it } from 'vitest'
import { Prisma } from './generated/prisma/client'
import { parseSchema, SchemaReadError } from './schema-models'
import { loadSchema } from './tools'

describe('the schema reader', () => {
  it('reads the same models and columns as the client Prisma generates', () => {
    const models = loadSchema()
    const namespace = Prisma as unknown as Record<string, Record<string, string>>
    expect(models.map((model) => model.name).sort()).toEqual(Object.values(Prisma.ModelName).sort())
    for (const model of models) {
      expect(model.columns, model.name).toEqual(Object.values(namespace[`${model.name}ScalarFieldEnum`] ?? {}))
      expect(model.table).toBe(model.name)
    }
  })

  it('reads relations, native types, defaults and unique keys', () => {
    const station = loadSchema().find((model) => model.name === 'Station')!
    expect(station.file).toBe('_core.prisma')
    expect(station.fields.filter((field) => field.relation).map((field) => field.name)).toEqual(['site', 'line', 'workCentre'])
    expect(station.fields.find((field) => field.name === 'lineId')).toMatchObject({ type: 'String', nativeType: 'Uuid', optional: true })
    expect(station.fields.find((field) => field.name === 'workCentreId')).toMatchObject({ type: 'String', nativeType: 'Uuid', optional: false })
    expect(station.fields.find((field) => field.name === 'tenantId')?.defaultValue).toMatch(/^dbgenerated\(".*factory\.tenant_id.*"\)$/)
    expect(station.uniques).toEqual([['id'], ['tenantId', 'siteId', 'code']])
  })

  it('honours @map and @@map, and ignores comments but not strings that look like them', () => {
    const [model] = parseSchema([
      {
        file: 'x.prisma',
        text: [
          'model Thing { // a comment {',
          '  id   String @id @map("thing_id") /// doc { }',
          '  url  String @default("https://example.test/{a}") // "quoted"',
          '  kind Kind?',
          '  tags String[]',
          '  @@unique([url(sort: Desc), kind])',
          '  @@map("things")',
          '}',
          'enum Kind { A B }',
        ].join('\n'),
      },
    ])
    expect(model).toMatchObject({ name: 'Thing', table: 'things', columns: ['thing_id', 'url', 'kind', 'tags'] })
    expect(model?.uniques).toEqual([['thing_id'], ['url', 'kind']])
    expect(model?.fields.find((field) => field.name === 'url')?.defaultValue).toBe('"https://example.test/{a}"')
    expect(model?.fields.find((field) => field.name === 'tags')?.list).toBe(true)
  })

  it.each([
    ['a composite type', 'type Address { city String }'],
    ['a view', 'view Totals { id String @unique }'],
    ['@@schema', 'model A { id String @id\n @@schema("other") }'],
    ['@ignore', 'model A { id String @id\n x String @ignore }'],
    ['@@ignore', 'model A { id String @id\n @@ignore }'],
    ['a model defined twice', 'model A { id String @id }\nmodel A { id String @id }'],
    ['an unreadable field line', 'model A { id String @id\n = broken }'],
  ])('refuses %s instead of skipping it', (_label, text) => {
    expect(() => parseSchema([{ file: 'x.prisma', text }])).toThrow(SchemaReadError)
  })
})
