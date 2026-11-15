import { describe, expect, it } from 'vitest'
import { MIRRORS } from './domain-mirrors'
import * as enums from './generated/prisma/enums'

/** B-W2b-F60: the schema's enums and the factory-domain lists they mirror, value for value (no database; the typecheck holds them too). */
describe('the enums that mirror a factory-domain list', () => {
  it.each(MIRRORS.map((entry) => [`${entry.schemaEnum} = ${entry.domainList}`, entry] as const))('%s', (_name, entry) => {
    expect([...entry.domain].sort()).toEqual([...entry.schema].sort())
    expect(new Set(entry.domain).size, 'each value once').toBe(entry.domain.length)
  })

  it('name enums of the schema, each with every one of its values', () => {
    for (const entry of MIRRORS) expect(Object.values((enums as Record<string, Record<string, string>>)[entry.schemaEnum] ?? {}), entry.schemaEnum).toEqual(entry.schema)
  })

  it('include the document template kinds, all eight documents the code prints', () => {
    const kinds = MIRRORS.filter((entry) => entry.schemaEnum === 'DocumentTemplateKind')
    expect(kinds.map((entry) => entry.domainList)).toEqual(['documents/model DOCUMENT_TYPES', 'templates/documents DOCUMENT_TEMPLATE_KINDS'])
    expect([...kinds[0]!.schema].sort()).toEqual(['COMMERCIAL_INVOICE', 'DDT', 'INVOICE_COPY', 'ORDER_CONFIRMATION', 'PACKING_LIST', 'PROFORMA', 'PURCHASE_ORDER', 'QUOTE'])
  })
})
