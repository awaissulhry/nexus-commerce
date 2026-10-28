import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import { LocalFileError, LOCAL_FILES_PATH, localFileStore } from './local'

// The local file store on a temporary folder: its "presigned URLs" are signed tokens checked like a presigned S3 PUT
// (type, size, SHA-256) and GET (expiry); it serves FAKE accounts only and exists only in local and test runs.

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
function store() {
  const root = mkdtempSync(join(tmpdir(), 'factory-local-files-'))
  folders.push(root)
  return localFileStore({ root, environment: 'test' })
}

const NOW = new Date('2026-10-28T10:00:00.000Z')
const LATER = new Date(NOW.getTime() + 301_000)
const KEY = 't/0199f0a0-0000-7000-8000-000000000001/c/0199f0a0-0000-7000-8000-000000000002/2026/3b1f0c3e-8d1a-4c2b-9f3e-2a1b0c9d8e7f'
const BODY = Buffer.from('%PDF-1.7 made-up test content')
const SHA = createHash('sha256').update(BODY).digest('hex')
const call = (mode: AdapterAccount['mode'] = 'FAKE'): GatewayCall => ({
  account: { id: 'a', tenantId: 't', companyId: null, provider: 'R2', mode, settings: null },
  attempt: 1,
  signal: new AbortController().signal,
  idempotencyKey: null,
  credentials: async () => null,
  answer: () => {},
})
const tokenOf = (url: string): string => url.slice(`${LOCAL_FILES_PATH}?token=`.length)
const upload = { key: KEY, contentType: 'application/pdf', sizeBytes: BODY.length, sha256: SHA, expiresInSeconds: 300, now: NOW }

describe('the local file store', () => {
  it('is refused outside local and test runs', () => {
    for (const environment of ['staging', 'production'] as const) {
      expect(() => localFileStore({ root: tmpdir(), environment })).toThrow(/local and test runs only/)
    }
  })

  it('round-trips an upload: presign, put, head, download, remove', async () => {
    const files = store()
    const put = await files.presignUpload(call(), upload)
    expect(put).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/pdf' }, expiresAt: new Date(NOW.getTime() + 300_000) })
    expect(put.url.startsWith(`${LOCAL_FILES_PATH}?token=`)).toBe(true)
    expect(await files.head(call(), KEY)).toBeNull()
    await files.acceptUpload(tokenOf(put.url), { body: BODY, contentType: 'application/pdf' }, NOW)
    expect(await files.head(call(), KEY)).toEqual({ sizeBytes: BODY.length, contentType: 'application/pdf', sha256: SHA })

    const get = await files.presignDownload(call(), { key: KEY, contentType: 'application/pdf', disposition: 'attachment; filename="a.pdf"', expiresInSeconds: 60, now: NOW })
    expect(get).toMatchObject({ method: 'GET', headers: {} })
    expect(await files.openDownload(tokenOf(get.url), NOW)).toEqual({ body: BODY, contentType: 'application/pdf', disposition: 'attachment; filename="a.pdf"' })
    // A download token is not an upload token, and the other way round.
    await expect(files.acceptUpload(tokenOf(get.url), { body: BODY, contentType: 'application/pdf' }, NOW)).rejects.toMatchObject({ status: 403 })
    await expect(files.openDownload(tokenOf(put.url), NOW)).rejects.toMatchObject({ status: 403 })

    await files.remove(call(), KEY)
    expect(await files.head(call(), KEY)).toBeNull()
    await files.remove(call(), KEY)
    await expect(files.openDownload(tokenOf(get.url), NOW)).rejects.toMatchObject({ status: 404 })
  })

  it('reads an object\'s bytes for server-side work, up to a limit; no object is null', async () => {
    const files = store()
    expect(await files.read(call(), KEY, 1_000)).toBeNull()
    await files.acceptUpload(tokenOf((await files.presignUpload(call(), upload)).url), { body: BODY, contentType: 'application/pdf' }, NOW)
    expect(await files.read(call(), KEY, BODY.length)).toEqual(BODY)
    await expect(files.read(call(), KEY, BODY.length - 1)).rejects.toMatchObject({ name: 'TooLargeObjectError' })
    await expect(files.read(call('LIVE'), KEY, 1_000)).rejects.toBeInstanceOf(ProviderError)
  })

  it('refuses a body whose type, size or SHA-256 is not the one announced, and stores nothing', async () => {
    const files = store()
    const token = tokenOf((await files.presignUpload(call(), upload)).url)
    const refused = [
      { body: BODY, contentType: 'image/png' },
      { body: BODY, contentType: undefined },
      { body: Buffer.concat([BODY, Buffer.from('!')]), contentType: 'application/pdf' },
      { body: Buffer.from(BODY.toString().replace('test', 'TEST')), contentType: 'application/pdf' },
    ]
    for (const body of refused) await expect(files.acceptUpload(token, body, NOW)).rejects.toMatchObject({ name: 'LocalFileError', status: 400 })
    expect(await files.head(call(), KEY)).toBeNull()
  })

  it('refuses an expired, altered or foreign token', async () => {
    const files = store()
    const token = tokenOf((await files.presignUpload(call(), upload)).url)
    await expect(files.acceptUpload(token, { body: BODY, contentType: 'application/pdf' }, LATER)).rejects.toThrow(/expired/)
    const [payload, signature] = token.split('.') as [string, string]
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>
    const altered = `${Buffer.from(JSON.stringify({ ...grant, n: 1 })).toString('base64url')}.${signature}`
    for (const bad of [altered, `${payload}.`, payload, `${token}.x`, 'not-a-token-at-all']) {
      await expect(files.acceptUpload(bad, { body: BODY, contentType: 'application/pdf' }, NOW), bad).rejects.toBeInstanceOf(LocalFileError)
    }
    // Another process's store (another key) does not accept this one's tokens.
    await expect(store().acceptUpload(token, { body: BODY, contentType: 'application/pdf' }, NOW)).rejects.toMatchObject({ status: 403 })
  })

  it('reads the stored bytes in head, so an object changed in the store does not pass as the announced one', async () => {
    const files = store()
    await files.acceptUpload(tokenOf((await files.presignUpload(call(), upload)).url), { body: BODY, contentType: 'application/pdf' }, NOW)
    writeFileSync(join(files.root, KEY), 'something else')
    expect(await files.head(call(), KEY)).toMatchObject({ sizeBytes: 14, sha256: createHash('sha256').update('something else').digest('hex') })
  })

  it('puts bytes the API made (a generated document) when they match their SHA-256, and only for FAKE accounts', async () => {
    const local = store()
    await expect(local.put(call(), { key: KEY, contentType: 'application/pdf', body: BODY, sha256: 'ab'.repeat(32) })).rejects.toThrow(ProviderError)
    expect(await local.head(call(), KEY)).toBeNull()
    await local.put(call(), { key: KEY, contentType: 'Application/PDF', body: BODY, sha256: SHA })
    expect(await local.head(call(), KEY)).toEqual({ sizeBytes: BODY.length, contentType: 'application/pdf', sha256: SHA })
    await expect(local.put(call('LIVE'), { key: KEY, contentType: 'application/pdf', body: BODY, sha256: SHA })).rejects.toThrow(ProviderError)
  })

  it('takes only storage keys under its folder, and only FAKE accounts', async () => {
    const files = store()
    for (const key of ['../escape', `${KEY}/../../../../x`, '/etc/passwd', 'legal/../t']) {
      await expect(files.presignUpload(call(), { ...upload, key }), key).rejects.toMatchObject({ status: 403 })
      await expect(files.head(call(), key), key).rejects.toMatchObject({ status: 403 })
    }
    await expect(files.presignUpload(call('LIVE'), upload)).rejects.toBeInstanceOf(ProviderError)
    await expect(files.head(call('SANDBOX'), KEY)).rejects.toBeInstanceOf(ProviderError)
    expect(existsSync(join(files.root, 'escape'))).toBe(false)
  })
})
