import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import type { GatewayCall } from '../../platform/gateway/gateway'
import { LocalFileError, LOCAL_FILES_PATH, localFileStore } from './local'

// B-W2b-160 (COL-052): uploads in parts on the local store (FAKE accounts): each part through the same signed
// `/local-files?token=…` PUT, checked like a presigned UploadPart (size and SHA-256), listed from the folder, joined in order.

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
function store() {
  const root = mkdtempSync(join(tmpdir(), 'factory-local-multipart-'))
  folders.push(root)
  return localFileStore({ root, environment: 'test' })
}
const NOW = new Date('2026-11-05T10:00:00.000Z')
const KEY = 't/0199f0a0-0000-7000-8000-000000000001/c/0199f0a0-0000-7000-8000-000000000002/2026/3b1f0c3e-8d1a-4c2b-9f3e-2a1b0c9d8e7f'
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')
const call = (mode: AdapterAccount['mode'] = 'FAKE'): GatewayCall => ({
  account: { id: 'a', tenantId: 't', companyId: null, provider: 'R2', mode, settings: null },
  attempt: 1,
  signal: new AbortController().signal,
  idempotencyKey: null,
  credentials: async () => null,
  answer: () => {},
})
const tokenOf = (url: string): string => url.slice(`${LOCAL_FILES_PATH}?token=`.length)

describe('the local store in parts (COL-052)', () => {
  it('takes parts in any order, says which it holds, joins them in number order and reads the object back', async () => {
    const local = store()
    const uploadId = await local.startMultipart(call(), { key: KEY, contentType: 'application/pdf' })
    const one = Buffer.from('%PDF made-up first part ')
    const two = Buffer.from('and the last part')
    for (const [partNumber, body] of [[2, two], [1, one]] as const) {
      const part = await local.presignPart(call(), { key: KEY, uploadId, partNumber, sizeBytes: body.length, sha256: sha(body), expiresInSeconds: 900, now: NOW })
      expect(part.headers).toEqual({ 'content-type': 'application/octet-stream' })
      await local.acceptUpload(tokenOf(part.url), { body, contentType: 'application/octet-stream' }, NOW)
    }
    const parts = await local.listParts(call(), KEY, uploadId)
    expect(parts?.map((part) => [part.partNumber, part.sizeBytes, part.sha256])).toEqual([
      [1, one.length, sha(one)],
      [2, two.length, sha(two)],
    ])
    await local.completeMultipart(call(), KEY, uploadId, parts!)
    const joined = Buffer.concat([one, two])
    expect(await local.digest(call(), KEY)).toEqual({ sizeBytes: joined.length, contentType: 'application/pdf', sha256: sha(joined) })
    expect(await local.listParts(call(), KEY, uploadId)).toBeNull()
    expect(existsSync(join(local.root, '.multipart', uploadId))).toBe(false)
  })

  it('refuses a part with other bytes or another size, a part of an upload given up, and a FAKE-only call from LIVE', async () => {
    const local = store()
    const uploadId = await local.startMultipart(call(), { key: KEY, contentType: 'application/pdf' })
    const body = Buffer.from('made-up part')
    const part = await local.presignPart(call(), { key: KEY, uploadId, partNumber: 1, sizeBytes: body.length, sha256: sha(body), expiresInSeconds: 900, now: NOW })
    await expect(local.acceptUpload(tokenOf(part.url), { body: Buffer.from('made-up PART'), contentType: 'application/octet-stream' }, NOW)).rejects.toThrow(LocalFileError)
    await expect(local.acceptUpload(tokenOf(part.url), { body: Buffer.from('made-up part!'), contentType: 'application/octet-stream' }, NOW)).rejects.toThrow('size')
    await local.abortMultipart(call(), KEY, uploadId)
    await expect(local.acceptUpload(tokenOf(part.url), { body, contentType: 'application/octet-stream' }, NOW)).rejects.toThrow('no longer open')
    await expect(local.startMultipart(call('LIVE'), { key: KEY, contentType: 'application/pdf' })).rejects.toThrow('FAKE accounts only')
    await expect(local.listParts(call(), KEY, '../../etc')).rejects.toThrow(LocalFileError)
  })
})
