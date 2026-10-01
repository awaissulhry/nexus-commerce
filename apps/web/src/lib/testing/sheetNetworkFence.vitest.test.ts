import { describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import type { BrowserContext, Route, WebSocketRoute } from '@playwright/test'
import { installSheetNetworkFence, startSheetDenyProxy } from '../../../smoke/sheet/networkFence'

async function fixture() {
  const context = {
    route: vi.fn<BrowserContext['route']>().mockResolvedValue({ dispose: async () => {}, [Symbol.asyncDispose]: async () => {} }),
    routeWebSocket: vi.fn<BrowserContext['routeWebSocket']>().mockResolvedValue(undefined),
  }
  const fence = await installSheetNetworkFence(context)
  expect(context.route).toHaveBeenCalledOnce()
  expect(context.routeWebSocket).toHaveBeenCalledOnce()
  expect(context.route.mock.calls[0][0]).toBe('**/*')
  expect(context.routeWebSocket.mock.calls[0][0]).toBe('**/*')
  return { fence, http: context.route.mock.calls[0][1], websocket: context.routeWebSocket.mock.calls[0][1] }
}

function request(url: string, method = 'GET') {
  const route = {
    request: () => ({ url: () => url, method: () => method }),
    abort: vi.fn().mockResolvedValue(undefined),
    fallback: vi.fn().mockResolvedValue(undefined),
    continue: vi.fn().mockResolvedValue(undefined),
  }
  return { route: route as unknown as Route, ...route }
}

describe('sheet browser fence — block before a network connector can run', () => {
  it.each([
    'https://outside.invalid/api/auth/login',
    'https://localhost.outside.invalid/api/auth/login',
    'https://127.outside.invalid/api/auth/login',
    'http://192.0.2.1/api/auth/login',
    'https://127.0.0.1@outside.invalid/api/auth/login',
  ])('aborts %s without falling through or continuing', async url => {
    const { fence, http } = await fixture()
    const r = request(url, 'POST')
    await http(r.route, r.route.request())
    expect(r.abort).toHaveBeenCalledWith('blockedbyclient')
    expect(r.fallback).not.toHaveBeenCalled()
    expect(r.continue).not.toHaveBeenCalled()
    expect(fence.blocked).toHaveLength(1)
  })

  it.each(['http://localhost:3085/login', 'http://127.0.0.1:4085/api/health', 'http://[::1]:3085/login'])
  ('keeps local request handlers reachable for %s', async url => {
    const { fence, http } = await fixture()
    const r = request(url)
    await http(r.route, r.route.request())
    expect(r.fallback).toHaveBeenCalledOnce()
    expect(r.abort).not.toHaveBeenCalled()
    expect(r.continue).not.toHaveBeenCalled()
    expect(fence.blocked).toEqual([])
  })

  it('keeps refusal evidence without URL credentials, query values or fragments', async () => {
    const { fence, http } = await fixture()
    const r = request('https://fixture-user:fixture-password@outside.invalid/api/login?token=fixture-secret#private', 'POST')
    await http(r.route, r.route.request())
    expect(fence.blocked).toEqual(['POST https://outside.invalid/api/login'])
  })

  it.each(['ws://outside.invalid/socket', 'wss://127.outside.invalid/socket'])
  ('closes %s without connecting to its server', async url => {
    const { fence, websocket } = await fixture()
    const ws = { url: () => url, close: vi.fn().mockResolvedValue(undefined), connectToServer: vi.fn() }
    await websocket(ws as unknown as WebSocketRoute)
    expect(ws.close).toHaveBeenCalledOnce()
    expect(ws.connectToServer).not.toHaveBeenCalled()
    expect(fence.blocked).toEqual([`WEBSOCKET ${url}`])
  })

  it('allows the local websocket server and records no false refusal', async () => {
    const { fence, websocket } = await fixture()
    const ws = { url: () => 'ws://localhost:3085/socket', close: vi.fn(), connectToServer: vi.fn() }
    await websocket(ws as unknown as WebSocketRoute)
    expect(ws.connectToServer).toHaveBeenCalledOnce()
    expect(ws.close).not.toHaveBeenCalled()
    expect(fence.blocked).toEqual([])
  })
})

describe('sheet deny proxy — the fallback never forwards HTTP or CONNECT', () => {
  it.each([
    { method: 'GET', path: 'http://outside.invalid/api/read?private=value', evidence: 'GET http://outside.invalid/api/read' },
    { method: 'POST', path: 'https://outside.invalid/api/login?token=fixture', evidence: 'POST https://outside.invalid/api/login' },
    { method: 'CONNECT', path: 'outside.invalid:443', evidence: 'CONNECT https://outside.invalid/' },
  ])('refuses $method without asking any remote host', async ({ method, path, evidence }) => {
    const fence = await startSheetDenyProxy()
    try {
      const proxy = new URL(fence.proxy.server)
      expect(proxy.hostname).toBe('127.0.0.1')
      // The client socket names ONLY the local proxy. The outside URL is request data.
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ hostname: proxy.hostname, port: proxy.port, method, path }, response => {
          response.resume()
          response.on('end', () => resolve(response.statusCode!))
        })
        req.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode!) })
        req.on('error', reject)
        req.end()
      })
      expect(status).toBe(403)
      expect(fence.blocked).toEqual([evidence])
    } finally { await fence.close() }
  })
})
