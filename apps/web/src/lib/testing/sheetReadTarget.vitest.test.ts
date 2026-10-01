import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { request, type APIRequestContext, type Page } from '@playwright/test'
import { readSheet, type Scope } from '../../../smoke/sheet/grid'

const body = { columns: [], rows: [], scope: { kind: 'channel', channel: 'EBAY', marketplace: 'IT', connectionId: 'fixture-account', locale: 'it' } }

it('sets the explicit no-redirect option on the named route and workspace header', async () => {
  const scope: Scope = { name: 'EBAY', family: 'fixture-family', page: '/w/fixture/sheet',
    api: '/backend/api/products/fixture-family/studio/sheet?scope=channel', locale: 'it' }
  const get = vi.fn().mockResolvedValue({ status: () => 200, json: async () => body })
  const page = { request: { get } } as unknown as Page
  expect(await readSheet(page, scope, 'fixture-workspace')).toEqual(body)
  expect(get).toHaveBeenCalledExactlyOnceWith(`${scope.api}&cells=compact`, {
    headers: { 'x-nexus-workspace-id': 'fixture-workspace' }, maxRedirects: 0,
  })
})

async function localRead(work: (page: Page, seen: Array<{ path: string; workspace: string | string[] | undefined }>) => Promise<void>) {
  const seen: Array<{ path: string; workspace: string | string[] | undefined }> = []
  const server = createServer((incoming, outgoing) => {
    const path = incoming.url ?? '/'
    seen.push({ path, workspace: incoming.headers['x-nexus-workspace-id'] })
    if (path.startsWith('/redirect?')) {
      outgoing.writeHead(302, { location: '/target' })
      outgoing.end()
    } else {
      outgoing.writeHead(200, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify(body))
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback server address')
  let context: APIRequestContext | undefined
  try {
    context = await request.newContext({ baseURL: `http://127.0.0.1:${address.port}` })
    await work({ request: context } as Page, seen)
  } finally {
    try { await context?.dispose() }
    finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
}

it('refuses a real local 302 before the redirected target receives any request', async () => {
  await localRead(async (page, seen) => {
    const scope: Scope = { name: 'EBAY', family: 'fixture-family', page: '/sheet', api: '/redirect?scope=channel', locale: 'it' }
    const result = await readSheet(page, scope, 'fixture-workspace').then(value => ({ value, error: null }), error => ({ value: null, error }))
    expect.soft(seen.filter(hit => hit.path === '/target')).toHaveLength(0)
    expect(seen[0]).toEqual({ path: '/redirect?scope=channel&cells=compact', workspace: 'fixture-workspace' })
    expect(result.error).toBeTruthy()
    expect(String(result.error)).toContain('302')
    expect(result.value).toBeNull()
  })
})

it('reads a real local 200 with the intended workspace header and exact sheet body', async () => {
  await localRead(async (page, seen) => {
    const scope: Scope = { name: 'EBAY', family: 'fixture-family', page: '/sheet', api: '/success?scope=channel', locale: 'it' }
    expect(await readSheet(page, scope, 'fixture-workspace')).toEqual(body)
    expect(seen).toEqual([{ path: '/success?scope=channel&cells=compact', workspace: 'fixture-workspace' }])
  })
})
