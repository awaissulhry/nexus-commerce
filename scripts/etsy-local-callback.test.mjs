import assert from 'node:assert/strict'
import { once } from 'node:events'
import { after, before, test } from 'node:test'
import { createEtsyLocalCallbackServer } from './etsy-local-callback.mjs'

const state = 'a'.repeat(43)
const server = createEtsyLocalCallbackServer()
let base
before(async () => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => new Promise(resolve => server.close(resolve)))

test('returns the browser to the fixed local API with the provider code and state intact', async () => {
  const response = await fetch(`${base}/api/cx/callback/etsy?state=${state}&code=code%2Bwith%2Fsymbols`, { redirect: 'manual', headers: { Host: 'untrusted.example' } })
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location'))
  assert.equal(location.origin, 'http://localhost:8091')
  assert.equal(location.pathname, '/api/cx/callback/etsy')
  assert.equal(location.searchParams.get('state'), state)
  assert.equal(location.searchParams.get('code'), 'code+with/symbols')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('set-cookie'), null)
})

test('returns provider cancellation to the normal local error handler', async () => {
  const response = await fetch(`${base}/api/cx/callback/etsy?state=${state}&error=access_denied&error_description=User%20declined`, { redirect: 'manual' })
  assert.equal(response.status, 302)
  assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), 'access_denied')
})

test('never exposes other local API routes or accepts ambiguous callbacks', async () => {
  for (const [path, status] of [
    ['/api/health', 404], ['/api/products', 404], ['/api/cx/callback/shopify', 404],
    ['/api/cx/callback/etsy', 404],
    [`/api/cx/callback/etsy?code=test`, 400],
    [`/api/cx/callback/etsy?state=${state}`, 400],
    [`/api/cx/callback/etsy?state=${state}&code=test&error=denied`, 400],
    [`/api/cx/callback/etsy?state=${state}&code=test&code=other`, 400],
    [`/api/cx/callback/etsy?state=${state}&code=test&redirect_uri=https://untrusted.example`, 400],
  ]) {
    const response = await fetch(`${base}${path}`, { redirect: 'manual' })
    assert.equal(response.status, status, path)
    assert.equal(response.headers.get('location'), null, path)
  }
  const post = await fetch(`${base}/api/cx/callback/etsy?state=${state}&code=test`, { method: 'POST', redirect: 'manual' })
  assert.equal(post.status, 405)
})

test('refuses non-loopback destinations and URL overrides', () => {
  for (const origin of ['https://untrusted.example', 'http://localhost.untrusted.example', 'http://user:pass@localhost:8091', 'http://localhost:8091/other', 'http://localhost:8091?redirect=other', 'file:///tmp']) {
    assert.throws(() => createEtsyLocalCallbackServer(origin), /loopback API origin/)
  }
})
