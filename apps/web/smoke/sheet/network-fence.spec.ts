/** Safety controls use only a local server and a local proxy that never forwards. */
import { createServer } from 'node:http'
import { test, expect } from '@playwright/test'
import { test as guardedTest } from './fixture'
import { installSheetNetworkFence, startSheetDenyProxy } from './networkFence'

const payload = Buffer.from('Local sheet response · unchanged bytes')

async function localServer() {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '/')
    if (request.url?.startsWith('/redirect-')) {
      response.writeHead(302, { location: request.url === '/redirect-https' ? 'https://outside.invalid/redirected' : 'http://outside.invalid/redirected' })
      response.end()
    } else {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': payload.length })
      response.end(payload)
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected the local HTTP fixture port')
  return { url: `http://127.0.0.1:${address.port}`, requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => error ? reject(error) : resolve())
    }) }
}

test('@sheet network fence · installs before the first navigation and keeps local bytes unchanged', async ({ browser }) => {
  const proxy = await startSheetDenyProxy()
  const local = await localServer()
  const context = await browser.newContext({ proxy: proxy.proxy, serviceWorkers: 'block' })
  try {
    const guard = await installSheetNetworkFence(context)
    const page = await context.newPage()
    await expect(page.goto('http://outside.invalid/first-navigation')).rejects.toThrow()
    expect(guard.blocked).toEqual(['GET http://outside.invalid/first-navigation'])
    expect(proxy.blocked).toEqual([])

    // Chromium may still navigate its refused tab to chrome-error://. Use a fresh tab in the SAME guarded context.
    await page.close()
    const localPage = await context.newPage()
    const response = await localPage.goto(`${local.url}/content`)
    expect(response?.status()).toBe(200)
    expect(await response!.body()).toEqual(payload)
    expect(Number((await response!.allHeaders())['content-length'])).toBe(payload.length)
    expect(local.requests).toContain('/content')
    expect(proxy.blocked).toEqual([])
  } finally { await context.close(); await local.close(); await proxy.close() }
})

test('@sheet network fence · outside HTTP redirects and a page continue cannot bypass the deny proxy', async ({ browser }) => {
  const proxy = await startSheetDenyProxy()
  const local = await localServer()
  const context = await browser.newContext({ proxy: proxy.proxy, serviceWorkers: 'block' })
  try {
    const guard = await installSheetNetworkFence(context)
    const page = await context.newPage()
    const redirected = await page.goto(`${local.url}/redirect-http`)
    expect(redirected?.status()).toBe(403)
    expect(proxy.blocked).toEqual(['GET http://outside.invalid/redirected'])
    expect(guard.blocked).toEqual([])

    // Page-level continue skips the context routing chain. The browser proxy must still refuse.
    await page.route('**/bypass', route => route.continue())
    const bypassed = await page.goto('http://outside.invalid/bypass')
    expect(bypassed?.status()).toBe(403)
    expect(proxy.blocked).toContain('GET http://outside.invalid/bypass')
    expect(guard.blocked).toEqual([])
  } finally { await context.close(); await local.close(); await proxy.close() }
})

test('@sheet network fence · refuses an outside HTTPS redirect at CONNECT', async ({ browser }) => {
  const proxy = await startSheetDenyProxy()
  const local = await localServer()
  const context = await browser.newContext({ proxy: proxy.proxy, serviceWorkers: 'block' })
  try {
    await installSheetNetworkFence(context)
    const page = await context.newPage()
    await expect(page.goto(`${local.url}/redirect-https`)).rejects.toThrow()
    expect(proxy.blocked).toContain('CONNECT https://outside.invalid/')
  } finally { await context.close(); await local.close(); await proxy.close() }
})

test('@sheet network fence · blocks a new popup and a websocket before either remote server connects', async ({ browser }) => {
  const proxy = await startSheetDenyProxy()
  const local = await localServer()
  const context = await browser.newContext({ proxy: proxy.proxy, serviceWorkers: 'block' })
  try {
    const guard = await installSheetNetworkFence(context)
    const page = await context.newPage()
    await page.goto(`${local.url}/content`)
    const popup = context.waitForEvent('page')
    await page.evaluate(() => { window.open('http://outside.invalid/popup') })
    await popup
    await expect.poll(() => guard.blocked).toContain('GET http://outside.invalid/popup')
    const closed = await page.evaluate(() => new Promise<boolean>(resolve => {
      const socket = new WebSocket('wss://outside.invalid/socket')
      socket.onclose = () => resolve(true)
      socket.onerror = () => resolve(false)
    }))
    expect(closed).toBe(true)
    expect(guard.blocked).toContain('WEBSOCKET wss://outside.invalid/socket')
    expect(proxy.blocked).toEqual([])
  } finally { await context.close(); await local.close(); await proxy.close() }
})

guardedTest('@sheet network fence · the actual product fixture keeps loopback bytes and blocks service workers', async ({ page, sheetFence }) => {
  const local = await localServer()
  const warnings: string[] = []
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()) })
  try {
    for (const origin of [local.url, local.url.replace('127.0.0.1', 'localhost')]) {
      const response = await page.goto(`${origin}/content`)
      expect(response?.status()).toBe(200)
      expect(await response!.body()).toEqual(payload)
      expect(Number((await response!.allHeaders())['content-length'])).toBe(payload.length)
    }
    await page.evaluate(async () => { await navigator.serviceWorker.register('/worker.js') })
    expect(warnings).toContain('Service Worker registration blocked by Playwright')
    expect(local.requests).not.toContain('/worker.js')
    expect(sheetFence.blocked).toEqual([])
  } finally { await local.close() }
})
