import type { Ajv2019 } from 'ajv/dist/2019.js'

/** Amazon PTD v1 validation vocabulary. Register with Ajv so constraints inside
 * conditional branches and references apply to the serialized envelopes too. */
export function addAmazonVocabulary(ajv: Ajv2019): void {
  for (const [keyword, minimum] of [['minUtf8ByteLength', true], ['maxUtf8ByteLength', false]] as const) {
    ajv.addKeyword({ keyword, type: 'string', schemaType: 'number', errors: false,
      validate: (limit: number, value: string) => minimum
        ? Buffer.byteLength(value, 'utf8') >= limit : Buffer.byteLength(value, 'utf8') <= limit })
  }
  // Canonical JSON equality must ignore object member order. Missing selector
  // properties stay distinct from an explicit null; requiredness is schema-owned.
  const stable = (value: unknown): string => value === undefined ? 'undefined'
    : Array.isArray(value) ? `[${value.map(stable).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`
      : JSON.stringify(value)
  const uniqueCount = (value: unknown[], selectors?: string[]) => new Set(value.map(item =>
    stable(selectors?.length && item !== null && typeof item === 'object'
      ? selectors.map(key => (item as Record<string, unknown>)[key]) : item))).size
  for (const [keyword, minimum] of [['minUniqueItems', true], ['maxUniqueItems', false]] as const) {
    ajv.addKeyword({ keyword, type: 'array', schemaType: 'number', errors: false,
      validate: (limit: number, value: unknown[], schema: { selectors?: string[] }) => minimum
        ? uniqueCount(value, schema.selectors) >= limit : uniqueCount(value, schema.selectors) <= limit })
  }
  // selectors changes the identity used by uniqueItems; it does not itself
  // require every item to be unique (max/minUniqueItems may permit duplicates).
  ajv.removeKeyword('uniqueItems')
  ajv.addKeyword({ keyword: 'uniqueItems', type: 'array', schemaType: 'boolean', errors: false,
    validate: (enabled: boolean, value: unknown[], schema: { selectors?: string[] }) =>
      !enabled || uniqueCount(value, schema.selectors) === value.length })
}
