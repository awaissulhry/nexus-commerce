import { createHash } from 'node:crypto'

/** Amazon defines this checksum as Base64 MD5 over the downloaded document. */
export async function downloadAmazonSchema(schema: {
  link: { resource: string; verb: string }
  checksum: string
}): Promise<Record<string, unknown>> {
  if (!schema?.link?.resource || schema.link.verb !== 'GET' || !schema.checksum) {
    throw new Error('Amazon schema metadata is incomplete')
  }
  const response = await fetch(schema.link.resource, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Failed to download Amazon schema: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('md5').update(bytes).digest('base64') !== schema.checksum) {
    throw new Error('Amazon schema checksum mismatch; cached requirements were preserved')
  }
  const definition: unknown = JSON.parse(bytes.toString('utf8'))
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('Amazon schema must be an object')
  }
  const properties = (definition as Record<string, unknown>).properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties) || !Object.keys(properties).length) {
    throw new Error('Amazon schema contains no attribute definitions')
  }
  return definition as Record<string, unknown>
}

/** Object key order is immaterial; array order and every actual value are preserved. */
export function schemaFingerprint(definition: unknown): string {
  const canonical = (value: any): any => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
      : value
  return createHash('sha256').update(JSON.stringify(canonical(definition))).digest('hex')
}
