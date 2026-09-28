import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => '' }))
import { downloadArchive, requestArchivePreview } from './archiveApi'

const query = { accountId: 'acc', market: 'DE', kind: 'slots' as const }
const preview = { market: 'DE', kind: 'slots', language: 'de', apiLanguage: 'it', apiMarket: 'IT', digest: 'a'.repeat(64), filename: 'amazon-DE-photos-aaaaaaaaaa.zip',
  issues: [], warnings: [], skipped: [], files: [] }
const zipBytes = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])
const answer = (body: BodyInit | null, status = 200, type = 'application/json') => vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': type } }))
afterEach(() => vi.unstubAllGlobals())

describe('Amazon ZIP transport (P4d)', () => {
  it('asks for one product, account, market and kind, and refuses an answer for another choice', async () => {
    const fetch = answer(JSON.stringify(preview)); vi.stubGlobal('fetch', fetch)
    expect(await requestArchivePreview('p 1', query)).toEqual(preview)
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe('/api/products/p%201/media/amazon-archive?accountId=acc&market=DE&kind=slots')
    vi.stubGlobal('fetch', answer(JSON.stringify({ ...preview, market: 'IT' })))
    await expect(requestArchivePreview('p', query)).rejects.toThrow('The list of files belongs to another choice. Check again.')
  })
  it('speaks of the list of files, never of a gallery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(requestArchivePreview('p', query)).rejects.toThrow('The list of files could not be loaded: the server did not answer. Check again.')
    vi.stubGlobal('fetch', answer('<html>', 200, 'text/html'))
    await expect(requestArchivePreview('p', query)).rejects.toThrow('The list of files could not be read. Check again.')
  })
  it('downloads only a real ZIP, and passes the server\'s own sentence on', async () => {
    vi.stubGlobal('fetch', answer(zipBytes, 200, 'application/zip'))
    expect((await downloadArchive('p', { ...query, digest: 'a'.repeat(64) })).size).toBe(6)
    vi.stubGlobal('fetch', answer('<html>Login</html>', 200, 'application/zip'))
    await expect(downloadArchive('p', { ...query, digest: 'a'.repeat(64) })).rejects.toThrow('The server did not send a readable ZIP. No ZIP was saved; try again.')
    vi.stubGlobal('fetch', answer(JSON.stringify({ error: 'The photos changed since the preview. Check the list again, then download.' }), 409))
    await expect(downloadArchive('p', { ...query, digest: 'a'.repeat(64) })).rejects.toMatchObject({ status: 409, message: 'The photos changed since the preview. Check the list again, then download.' })
  })
  it('a proxy that gives up (Vercel answers 504 after 120 s) is a sentence, not a status code', async () => {
    vi.stubGlobal('fetch', answer('<html>An error occurred</html>', 504, 'text/html'))
    await expect(downloadArchive('p', { ...query, digest: 'a'.repeat(64) })).rejects.toThrow('The server took too long to answer, so the connection was closed. No ZIP was saved; try again.')
  })
})
