/** Read-only, pure examples: no database or provider writes. Run from the repository root:
 * node --import tsx docs/audits/2026-09-11-pim-management/reproduce-resolver-gaps.mts
 */
import { resolveAttributes } from '../../../apps/api/src/services/pim/attribute-resolver.js'
import { resolveChannelField } from '../../../apps/api/src/services/pim/resolve-channel-field.js'
import { amazonSpecFromDefinition } from '../../../apps/api/src/services/pim/channel-specs/amazon.js'
import { evaluateSchemaRequirements, registerCatalogueSchema } from '../../../apps/api/src/services/pim/mapping/schema-requirements.js'

const product = { id: 'audit-example', parentId: null, categoryAttributes: {}, variantAttributes: {},
  localizedContent: { en: { title: 'Waterproof jacket' } } }
const resolvedAttrs = resolveAttributes({ product: product as any, locale: 'de' })
const translation = resolveChannelField({ fieldKey: 'title', rule: { source: 'title' }, resolvedAttrs, product, locale: 'de' })

const attribute = (extra: object = {}) => ({ type: 'array', items: { type: 'object', properties: { value: { type: 'string', ...extra } }, required: ['value'] } })
const definition = { type: 'object', properties: { mode: attribute(), description: attribute() }, allOf: [{
  if: { required: ['mode'], properties: { mode: { contains: { properties: { value: { const: 'restricted' } }, required: ['value'] } } } },
  then: { properties: { description: attribute({ maxUtf8ByteLength: 3 }) } },
}] }
const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'AUDIT', schemaDefinition: definition })
const catalogue = {}
registerCatalogueSchema(catalogue, spec)
const validation = evaluateSchemaRequirements(catalogue, { mode: 'restricted', description: 'abcdef' })
console.log(JSON.stringify({
  localeFallback: { requestedLocale: 'de', availableLocale: 'en', value: translation.value, source: translation.source, needsTranslation: translation.needsTranslation },
  conditionalAmazonByteLimit: { limit: 3, actualBytes: 6, result: validation, fieldMaxBytes: spec.fields.find(f => f.key === 'description')?.maxBytes ?? null },
}, null, 2))
