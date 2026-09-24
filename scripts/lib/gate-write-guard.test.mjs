// node --test scripts/lib/gate-write-guard.test.mjs — the open-gesture gate's write guard (A-43, R-45).
// These arms run BEFORE the gate is ever pointed at a server: a guard that lets a write through is a
// gate that can damage the database it measures.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isApiWrite, apiKeyOf, expectedApiKey, isFormulaRead, isPreferenceWrite, hostKey } from './gate-write-guard.mjs'

const PAGE = 'http://localhost:3000'

test('🔴 the fill-down regression through the page proxy is a WRITE (aborted and counted)', () => {
  assert.equal(isApiWrite('PATCH', `${PAGE}/backend/api/products/bulk`), true)
  assert.equal(isApiWrite('POST', `${PAGE}/backend/api/products/p1/studio/sheet/cells`), true)
  assert.equal(isApiWrite('DELETE', `${PAGE}/backend/api/products/p1`), true)
})

test('a direct write to the API host is still a WRITE (the old shape)', () => {
  assert.equal(isApiWrite('PATCH', 'http://127.0.0.1:8091/api/products/bulk'), true)
})

test('a write to a FOREIGN backend is a WRITE too — never let through', () => {
  assert.equal(isApiWrite('PATCH', 'https://nexusapi-production-b7bb.up.railway.app/api/products/bulk'), true)
})

test('reads, formula reads, dev tooling and page paths are not writes', () => {
  assert.equal(isApiWrite('GET', `${PAGE}/backend/api/products/p1/studio/sheet`), false)
  assert.equal(isApiWrite('HEAD', `${PAGE}/backend/api/health`), false)
  assert.equal(isApiWrite('OPTIONS', 'http://127.0.0.1:8091/api/products/bulk'), false)
  assert.equal(isApiWrite('POST', `${PAGE}/backend/api/pim/formulas/batch`), false)
  assert.equal(isApiWrite('POST', 'http://127.0.0.1:8091/api/pim/formulas/preview'), false)
  assert.equal(isApiWrite('POST', `${PAGE}/__nextjs_original-stack-frames`), false)
  assert.equal(isApiWrite('POST', `${PAGE}/w/ws/products/p1/edit/studio`), false) // a server action posts to the page path
  assert.equal(isApiWrite('POST', `${PAGE}/apiary/x`), false) // "/api" must be a whole segment
})

test('the preference save is recognised on both paths (the reveal window lives in the gate)', () => {
  assert.equal(isPreferenceWrite(`${PAGE}/backend/api/saved-views`), true)
  assert.equal(isPreferenceWrite('http://127.0.0.1:8091/api/saved-views/abc'), true)
  assert.equal(isPreferenceWrite(`${PAGE}/backend/api/saved-viewsX`), false)
  assert.equal(isFormulaRead(`${PAGE}/backend/api/pim/formulas/batch`), true)
})

test('the wire control names the backend a request reached', () => {
  assert.equal(apiKeyOf(`${PAGE}/backend/api/products/p1/studio/sheet`), 'loopback:3000/backend')
  assert.equal(apiKeyOf('http://127.0.0.1:8091/api/products'), 'loopback:8091')
  assert.equal(apiKeyOf(`${PAGE}/w/ws/products/p1/edit/studio`), null)
  assert.equal(expectedApiKey(`${PAGE}/backend`), 'loopback:3000/backend')
  assert.equal(expectedApiKey(`${PAGE}/backend/`), 'loopback:3000/backend')
  assert.equal(expectedApiKey('http://127.0.0.1:8091'), 'loopback:8091')
  assert.equal(hostKey('https://example.com/x'), 'example.com:443')
})
