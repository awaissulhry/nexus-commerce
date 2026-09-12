import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { downloadAmazonSchema, schemaFingerprint } from './schema-document.js'

afterEach(() => vi.unstubAllGlobals())
const metadata = (body: string) => ({ link: { resource: 'https://schemas.example/schema.json', verb: 'GET' }, checksum: createHash('md5').update(body).digest('base64') })

it('verifies the original bytes before parsing, including whitespace and Unicode', async () => {
  const body = '{ "properties": { "title": { "title": "Taglià" } } }\n'
  const fetch = vi.fn().mockResolvedValue(new Response(body))
  vi.stubGlobal('fetch', fetch)
  expect(await downloadAmazonSchema(metadata(body))).toEqual(JSON.parse(body))
  expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
})

it('rejects checksum mismatches rather than accepting parseable corruption', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"properties":{"changed":{}}}')))
  await expect(downloadAmazonSchema(metadata('{"properties":{"original":{}}}'))).rejects.toThrow('checksum mismatch')
})

it.each(['[]', '{}', '{"properties":[]}','{"properties":{}}', 'not JSON'])('rejects unusable schema documents: %s', async body => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
  await expect(downloadAmazonSchema(metadata(body))).rejects.toThrow()
})

it('rejects missing integrity metadata before downloading', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  await expect(downloadAmazonSchema({ ...metadata('{}'), checksum: '' })).rejects.toThrow('incomplete')
  expect(fetch).not.toHaveBeenCalled()
})

it('rejects HTTP errors', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })))
  await expect(downloadAmazonSchema(metadata('{}'))).rejects.toThrow('HTTP 403')
})

it('fingerprints nested content and metadata independently of object key order', () => {
  const first = { properties: { size: { type: 'string', enum: ['S','M'] } }, __propertyGroups: { identity: ['size'] } }
  expect(schemaFingerprint(first)).toBe(schemaFingerprint({ __propertyGroups: { identity: ['size'] }, properties: { size: { enum: ['S','M'], type: 'string' } } }))
  expect(schemaFingerprint(first)).not.toBe(schemaFingerprint({ ...first, __propertyGroups: { other: ['size'] } }))
  expect(schemaFingerprint(['S','M'])).not.toBe(schemaFingerprint(['M','S']))
})
