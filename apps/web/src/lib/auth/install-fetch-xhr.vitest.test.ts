/**
 * 2026-10-19 — an upload sends the CSRF token and the business, like every fetch.
 *
 * The media library (files and ZIPs) and purchase-order attachments upload with XMLHttpRequest for byte progress.
 * `installAuthFetch` patched only `window.fetch` (and EventSource), so those requests left without `x-nexus-csrf` and
 * `x-nexus-workspace-id`, and the API's CSRF check refused every one: 403 "Refresh this page and try again"
 * (seen on production, Nexus assets › Upload, a ZIP of A+ images).
 *
 * This workspace's vitest has no DOM: XMLHttpRequest is a recording fake, and the real `xhrUpload` helper runs on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const API = 'http://127.0.0.1:8130'
const WEB = 'http://127.0.0.1:3130'

class FakeXhr {
  static sent: FakeXhr[] = []
  method = ''
  url = ''
  headers: Array<[string, string]> = []
  withCredentials = false
  upload: { onprogress: unknown } = { onprogress: null }
  status = 200
  responseText = '{"ok":true}'
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(name: string, value: string) { this.headers.push([name, value]) }
  send() { FakeXhr.sent.push(this); queueMicrotask(() => this.onload?.()) }
  abort() {}
}

async function install(path = '/marketing/content', workspaces = false) {
  vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', workspaces ? '1' : '')
  vi.stubGlobal('window', {
    fetch: vi.fn(async () => new Response('{}')),
    location: { href: `${WEB}${path}`, origin: WEB, pathname: path },
    XMLHttpRequest: FakeXhr,
  })
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  vi.stubGlobal('document', { cookie: workspaces ? 'nexus_csrf=cookie-token' : '' })
  const { setCsrfToken } = await import('./csrf-store')
  setCsrfToken('session-token')
  const { installAuthFetch } = await import('./install-fetch')
  installAuthFetch()
}

/** Sends one request with the patched XMLHttpRequest, as an upload dialog does. */
function sendXhr(method: string, url: string, own: Array<[string, string]> = []) {
  const xhr = new XMLHttpRequest()
  xhr.open(method, url)
  for (const [name, value] of own) xhr.setRequestHeader(name, value)
  xhr.send(null)
  return FakeXhr.sent.at(-1)!
}

const header = (xhr: FakeXhr, name: string) => xhr.headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v)

const PROTOTYPE = { ...Object.getOwnPropertyDescriptors(FakeXhr.prototype) }

beforeEach(() => {
  vi.resetModules()                                  // a fresh `installed` flag in install-fetch per test
  vi.stubEnv('NEXT_PUBLIC_API_URL', API)
  FakeXhr.sent = []
})
afterEach(() => {
  Object.defineProperties(FakeXhr.prototype, PROTOTYPE)   // undo the patch for the next test
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('XMLHttpRequest to the API carries what fetch carries', () => {
  it('🔴 the media library ZIP upload sends the CSRF token and the session (it was refused 403 without them)', async () => {
    await install()
    const { xhrUpload } = await import('@/app/marketing/content/_lib/xhr-upload')
    const res = await xhrUpload({ url: `${API}/api/assets/upload-zip`, body: 'zip-bytes' })
    expect(res.ok).toBe(true)
    const xhr = FakeXhr.sent[0]
    expect(xhr.method).toBe('POST')
    expect(header(xhr, 'x-nexus-csrf')).toEqual(['session-token'])
    expect(xhr.withCredentials).toBe(true)
  })

  it('🔴 with business profiles on, it names the business from the page path and reads the CSRF cookie', async () => {
    await install('/w/nexus_test_workspace/marketing/content', true)
    const xhr = sendXhr('post', `${WEB}/backend/api/assets/upload?source=nexus`)
    expect(header(xhr, 'x-nexus-workspace-id')).toEqual(['nexus_test_workspace'])
    expect(header(xhr, 'x-nexus-csrf')).toEqual(['cookie-token'])
  })

  it('a GET carries no CSRF token (as fetch)', async () => {
    await install()
    const xhr = sendXhr('GET', `${API}/api/assets/library`)
    expect(header(xhr, 'x-nexus-csrf')).toEqual([])
    expect(xhr.withCredentials).toBe(true)
  })

  it('a request to another site is left untouched', async () => {
    await install()
    const xhr = sendXhr('POST', 'https://api.cloudinary.com/v1_1/demo/image/upload')
    expect(xhr.headers).toEqual([])
    expect(xhr.withCredentials).toBe(false)
  })

  it('a header the caller set itself is not sent twice', async () => {
    await install()
    const xhr = sendXhr('POST', `${API}/api/fulfillment/purchase-orders/po1/attachments`, [['X-Nexus-Csrf', 'own']])
    expect(header(xhr, 'x-nexus-csrf')).toEqual(['own'])
  })

  it('the same request object opened again for another site loses the API rule', async () => {
    await install()
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API}/api/assets/upload`)
    xhr.open('POST', 'https://example.com/upload')
    xhr.send(null)
    expect(FakeXhr.sent[0].headers).toEqual([])
  })
})
