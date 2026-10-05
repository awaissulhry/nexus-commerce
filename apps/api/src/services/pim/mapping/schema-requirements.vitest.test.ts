import { describe, it, expect } from 'vitest'
import { amazonSpecFromDefinition } from '../channel-specs/amazon.js'
import { attributeDeleteValue, attributesFromCells, evaluateSchemaRequirements, registerCatalogueSchema, validateSchemaAttributes } from './schema-requirements.js'

it('uses actual selectors for deletes, deduplicates repeated instances, and refuses unknown selector values', () => {
  const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: {
    content: { type: 'array', selectors: ['marketplace_id', 'language_tag', 'value'], items: { properties: {
      marketplace_id: { const: 'IT' }, language_tag: { enum: ['it_IT', 'en_GB'] }, value: { type: 'string' },
    } } },
  } } })
  const actual = { marketplace_id: 'IT', language_tag: 'en_GB', value: 'Exact existing value', ignored: true }
  expect(attributeDeleteValue(spec, 'content', [actual, actual])).toEqual([{ marketplace_id: 'IT', language_tag: 'en_GB', value: 'Exact existing value' }])
  expect(() => attributeDeleteValue(spec, 'content', [{ marketplace_id: 'IT', language_tag: 'de_DE', value: 'Wrong language' }])).toThrow(/language_tag/)
  expect(() => attributeDeleteValue(spec, 'content', [{ marketplace_id: 'IT', value: 'Missing language' }])).toThrow(/language_tag/)
})

const attribute = (extra: object = {}) => ({ type: 'array', items: { type: 'object', properties: { value: { type: 'string', ...extra } }, required: ['value'] } })
const schema = {
  type: 'object', properties: { parentage_level: attribute({ enum: ['parent', 'child'] }),
    battery: attribute({ enum: ['yes', 'no'] }), battery_type: attribute(), parent_sku: attribute(),
    identifier: attribute(), exemption: attribute({ enum: ['yes'] }) },
  allOf: [
    { if: { required: ['battery'], properties: { battery: { contains: { properties: { value: { const: 'yes' } }, required: ['value'] } } } }, then: { required: ['battery_type'] } },
    { if: { required: ['parentage_level'], properties: { parentage_level: { contains: { properties: { value: { const: 'child' } } } } } }, then: { required: ['parent_sku'] } },
  ],
}
function check(definition: object, values: Record<string, unknown>) {
  const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'TEST', schemaDefinition: definition })
  const catalogue = {}
  registerCatalogueSchema(catalogue, spec)
  return evaluateSchemaRequirements(catalogue, values)
}
describe('product-aware channel requirements', () => {
  it('keeps a supplied ASIN even when value is also an Amazon uniqueness selector', () => {
    const definition = { properties: { merchant_suggested_asin: { ...attribute({ minLength: 10 }), selectors: ['marketplace_id', 'value'], minItems: 1 } }, required: ['merchant_suggested_asin'] }
    const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: definition })
    expect(attributesFromCells(spec, { merchant_suggested_asin: 'B0H7W8PH1F' })).toEqual({ merchant_suggested_asin: [{ value: 'B0H7W8PH1F' }] })
    expect(check(definition, { merchant_suggested_asin: 'B0H7W8PH1F' }).issues).toEqual([])
    expect(check(definition, {}).issues).toHaveLength(1)
  })
  it('omits empty optional lists but still refuses a missing required list', () => {
    const definition = { properties: { seasons: { ...attribute(), minItems: 1 }, bullet_point: { ...attribute(), minItems: 1 } }, required: ['bullet_point'] }
    expect(check(definition, { seasons: [], bullet_point: ['Warm jacket'] }).issues).toEqual([])
    expect(check(definition, { seasons: [''], bullet_point: [] }).issues.map(issue => issue.fieldKey)).toEqual(['bullet_point'])
  })
  it('enforces conditional Amazon UTF-8 limits on serialized values', () => {
    const definition = { properties: { mode: attribute(), description: attribute() }, allOf: [{
      if: { required: ['mode'], properties: { mode: { contains: { properties: { value: { const: 'restricted' } } } } } },
      then: { properties: { description: attribute({ minUtf8ByteLength: 2, maxUtf8ByteLength: 3 }) } },
    }] }
    expect(check(definition, { mode: 'open', description: 'abcdef' }).issues).toEqual([])
    expect(check(definition, { mode: 'restricted', description: 'é' }).issues).toEqual([])
    for (const description of ['a', 'éé', '😀']) {
      expect(check(definition, { mode: 'restricted', description }).issues).toContainEqual(expect.objectContaining({ fieldKey: 'description', required: false, schemaPath: expect.stringContaining('Utf8ByteLength') }))
    }
  })
  it('uses selector identity for uniqueness and unique item limits inside conditions', () => {
    const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'TEST', schemaDefinition: {
      properties: { entries: { type: 'array', selectors: ['language_tag', 'marketplace_id'], minUniqueItems: 2, maxUniqueItems: 2, uniqueItems: true,
        items: { type: 'object', properties: { value: { type: 'string' }, language_tag: { type: 'string' }, marketplace_id: { type: 'string' } } } } },
    } })
    const one = { value: 'one', language_tag: 'it_IT', marketplace_id: 'it' }
    expect(validateSchemaAttributes(spec, { entries: [one, { ...one, language_tag: 'de_DE' }] })).toEqual([])
    expect(validateSchemaAttributes(spec, { entries: [one, { ...one, value: 'different text' }] })).toEqual(expect.arrayContaining([expect.stringContaining('minUniqueItems'), expect.stringContaining('uniqueItems')]))
    expect(validateSchemaAttributes(spec, { entries: [one, { ...one, language_tag: 'de_DE' }, { ...one, language_tag: 'en_GB' }] })).toContainEqual(expect.stringContaining('maxUniqueItems'))
  })
  it('evaluates the actual predicate and explains the matching schema branch', () => {
    expect(check(schema, { battery: 'no' }).issues).toEqual([])
    expect(check(schema, {}).issues).toEqual([])
    expect(check(schema, { battery: 'yes' }).issues).toEqual([expect.objectContaining({ fieldKey: 'battery_type', required: true, schemaPath: '#/allOf/0/then/required' })])
    expect(check(schema, { battery: 'yes', battery_type: 'Lithium' }).issues).toEqual([])
    expect(check(schema, { battery: 'yes', battery_type: 'Lithium' }).requiredFields).toContain('battery_type')
    expect(check(schema, { battery: 'yes' }).requiredFields).toContain('battery_type')
    expect(check(schema, { battery: 'no', battery_type: 'Lithium' }).requiredFields).not.toContain('battery_type')
  })
  it('keeps optional envelopes optional and evaluates referenced conditions with the same schema engine', () => {
    const definition = { ...schema, $defs: { active: { required: ['battery'], properties: { battery: { contains: { properties: { value: { const: 'yes' } } } } } } },
      allOf: [{ if: { $ref: '#/$defs/active' }, then: { required: ['battery_type'] }, else: { required: ['identifier'] } }] }
    expect(check(definition, { battery: 'yes', battery_type: 'Lithium', parent_sku: 'optional' }).requiredFields).toEqual(['battery_type'])
    expect(check(definition, { battery: 'no' }).requiredFields).toEqual(['identifier'])
  })
  it('distinguishes parent and child listing requirements', () => {
    expect(check(schema, { parentage_level: 'parent' }).issues).toEqual([])
    expect(check(schema, { parentage_level: 'child' }).issues.map(i => i.fieldKey)).toEqual(['parent_sku'])
  })
  it('enforces enums narrowed by the matching condition', () => {
    const conditional = { ...schema, allOf: [{ if: { required: ['battery'], properties: { battery: { contains: { properties: { value: { const: 'yes' } } } } } },
      then: { properties: { battery_type: attribute({ enum: ['Lithium'] }) } } }] }
    expect(check(conditional, { battery: 'no', battery_type: 'Other' }).issues).toEqual([])
    expect(check(conditional, { battery: 'yes', battery_type: 'Other' }).issues).toContainEqual(expect.objectContaining({ fieldKey: 'battery_type', required: false, message: expect.stringContaining('Lithium') }))
  })
  it('E3 — an enum miss is the one off-list sentence: the value, Amazon, and the allowed values', () => {
    const conditional = { ...schema, allOf: [{ if: { required: ['battery'], properties: { battery: { contains: { properties: { value: { const: 'yes' } } } } } },
      then: { properties: { battery_type: attribute({ enum: ['Lithium', 'Alkaline'] }) } } }] }
    const issue = check(conditional, { battery: 'yes', battery_type: 'Other' }).issues.find(i => i.fieldKey === 'battery_type')!
    expect(issue.message).toMatch(/: "Other" is not on Amazon's list\. Amazon may refuse it\. Allowed: Lithium, Alkaline\.$/)
    expect(issue.message).not.toContain('must be equal to one of the allowed values')
  })
  it('retains schema-owned selectors on measure envelopes', () => {
    const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'TEST', schemaDefinition: { properties: {
      weight: { type: 'array', items: { type: 'object', properties: { value: { type: 'number' }, unit: { enum: ['kg'] }, marketplace_id: { const: 'market-it' }, language_tag: { enum: ['it_IT', 'en_GB'], default: 'it_IT' } } } },
    } } })
    expect(attributesFromCells(spec, { weight: { value: 2, unit: 'kg' } })).toEqual({ weight: [{ value: 2, unit: 'kg', marketplace_id: 'market-it', language_tag: 'it_IT' }] })
  })
  it('omits empty sibling arrays and supplies only schema-defined selectors', () => {
    const definition = { properties: {
      color: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, standardized: { type: 'array', items: { type: 'string' } } } } },
      size: { type: 'array', selectors: ['size_system'], items: { type: 'object', required: ['value', 'size_system'], properties: { value: { type: 'string' }, size_system: { enum: ['IT'] } } } },
    } }
    const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'TEST', schemaDefinition: definition })
    expect(attributesFromCells(spec, { color: 'Nero', size: 'XL' })).toEqual({ color: [{ value: 'Nero' }], size: [{ value: 'XL', size_system: 'IT' }] })
  })
  it('does not label every optional leaf required when the envelope itself is required', () => {
    const definition = { type: 'object', required: ['stock'], properties: { stock: { type: 'array', selectors: ['mode'], items: { type: 'object', required: ['mode'], properties: { mode: { enum: ['FBA', 'FBM'] }, quantity: { type: 'integer' }, restock: { type: 'string' } } } } } }
    const result = check(definition, {})
    // 2026-09-27 — `mode` is a selector with a CHOICE, so it is a column now, and it is the one leaf the envelope
    // requires. The optional leaves still are not labelled required.
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ fieldKey: 'stock__mode', required: true })
    expect(result.requiredFields).toEqual(['stock__mode'])
  })
  it('writes a chosen selector from its cell and a one-value selector from the schema', () => {
    const definition = { properties: {
      stock: { type: 'array', selectors: ['marketplace_id', 'mode'], items: { type: 'object', required: ['mode'], properties: { marketplace_id: { type: 'string' }, mode: { enum: ['FBA', 'FBM'] }, quantity: { type: 'integer' } } } },
      price: { type: 'array', selectors: ['marketplace_id', 'currency'], items: { type: 'object', properties: { marketplace_id: { type: 'string' }, currency: { enum: ['EUR'] }, amount: { type: 'number' } } } },
    } }
    const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'TEST', schemaDefinition: definition })
    // One ordinary leaf keeps the attribute's own key (`stock` → quantity); the chosen selector is `stock__mode`.
    expect(spec.fields.map(f => f.key).sort()).toEqual(['price', 'stock', 'stock__mode'])
    expect(attributesFromCells(spec, { stock__mode: 'FBM', stock: 4, price: 10 })).toEqual({
      stock: [{ mode: 'FBM', quantity: 4 }], price: [{ currency: 'EUR', amount: 10 }],
    })
  })
  it('evaluates date alternatives with format validation enabled', () => {
    const definition = { properties: { restock: attribute({ oneOf: [{ format: 'date' }, { format: 'date-time' }] }) } }
    expect(check(definition, { restock: '2026-09-07' })).toEqual({ issues: [], requiredFields: [] })
    expect(check(definition, { restock: 'next week' }).issues.length).toBeGreaterThan(0)
  })
  it('does not turn alternative identifier paths into unconditional requirements', () => {
    const alternatives = { ...schema, anyOf: [{ required: ['identifier'] }, { required: ['exemption'] }] }
    expect(check(alternatives, { exemption: 'yes' }).issues).toEqual([])
    expect(check(alternatives, {}).issues.every(i => !i.required && i.message.includes('allowed alternative'))).toBe(true)
  })
  it('preserves list members, native value types and measure envelopes', () => {
    const definition = { properties: { bullets: attribute(), flag: attribute({ type: 'boolean' }), count: attribute({ type: 'number' }),
      weight: { type: 'array', items: { type: 'object', properties: { value: { type: 'number' }, unit: { enum: ['kg'] } } } } } }
    const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'TEST', schemaDefinition: definition })
    expect(attributesFromCells(spec, { bullets: ['First', 'Second'], flag: false, count: 0, weight: { value: 1, unit: 'kg' } })).toEqual({
      bullets: [{ value: 'First' }, { value: 'Second' }], flag: [{ value: false }], count: [{ value: 0 }], weight: [{ value: 1, unit: 'kg' }],
    })
  })
  it('reports invalid schema references as unavailable rather than passing', () => {
    expect(check({ properties: { title: { $ref: '#/$defs/missing' } } }, {}).unavailable).toContain('reference')
  })
})
