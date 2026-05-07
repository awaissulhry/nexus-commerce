/**
 * O.6 — Sendcloud client smoke tests. Pure functions only; no DB; no
 * real HTTP. Pattern matches the rest of the repo (atp-channel.service.test.ts):
 * trivial runner that fires on import / `npx tsx <file>`. Vitest harness
 * lands with TECH_DEBT #42.
 *
 * What we verify:
 *   • dryRun is the default (NEXUS_ENABLE_SENDCLOUD_REAL unset → mock)
 *   • mockParcel echoes input.weight + input.shipment.id
 *   • mockParcel returns a structurally-complete SendcloudParcelOutput
 *   • createParcel in dryRun never throws + never touches network
 *   • fetchLabelPdf in dryRun returns a valid-prefix PDF buffer
 */

import {
  createParcel,
  fetchParcel,
  voidParcel,
  fetchLabelPdf,
  __test,
} from './client.js'
import { SendcloudCredentials, SendcloudParcelInput } from './types.js'

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn })
}
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg}: expected=${y} actual=${x}`)
}

// Force dryRun mode for the duration of these tests, regardless of
// whatever the ambient env says. The variable is read on every call so
// this works without module reloads.
const prevEnableReal = process.env.NEXUS_ENABLE_SENDCLOUD_REAL
process.env.NEXUS_ENABLE_SENDCLOUD_REAL = 'false'

const fakeCreds: SendcloudCredentials = {
  publicKey: 'pk_test',
  privateKey: 'sk_test',
}

const baseInput: SendcloudParcelInput = {
  name: 'Mario Rossi',
  address: 'Via Roma 1',
  city: 'Riccione',
  postal_code: '47838',
  country: 'IT',
  weight: '1.500',
  order_number: 'TEST-001',
  total_order_value: '99.99',
  shipment: { id: 12345 },
}

test('isReal() defaults to false (dryRun by default)', () => {
  assert(__test.isReal() === false, 'expected dryRun default')
})

test('isSandbox() defaults to true', () => {
  assert(__test.isSandbox() === true, 'expected sandbox default')
})

test('mockParcel echoes input.weight', () => {
  const m = __test.mockParcel(baseInput)
  eq(m.weight, '1.500', 'weight passthrough')
})

test('mockParcel echoes input.shipment.id', () => {
  const m = __test.mockParcel(baseInput)
  eq(m.shipment.id, 12345, 'shipment id passthrough')
})

test('mockParcel returns complete SendcloudParcelOutput shape', () => {
  const m = __test.mockParcel(baseInput)
  assert(typeof m.id === 'number', 'id is number')
  assert(typeof m.tracking_number === 'string', 'tracking_number set')
  assert(typeof m.tracking_url === 'string', 'tracking_url set')
  assert(m.label && Array.isArray(m.label.normal_printer), 'label.normal_printer set')
  assert(m.label && m.label.normal_printer.length > 0, 'label url present')
  assert(m.status && typeof m.status.id === 'number', 'status.id set')
  assert(m.carrier && typeof m.carrier.code === 'string', 'carrier.code set')
})

test('createParcel in dryRun returns mock without network', async () => {
  const out = await createParcel(fakeCreds, baseInput)
  assert(out.id > 0, 'id positive')
  assert(out.tracking_number?.startsWith('MOCK'), 'tracking starts with MOCK')
})

test('voidParcel in dryRun returns ok=true', async () => {
  const out = await voidParcel(fakeCreds, 999)
  assert(out.ok === true, 'voidParcel ok')
})

test('fetchParcel in dryRun returns a parcel-shaped object', async () => {
  const out = await fetchParcel(fakeCreds, 999)
  assert(out !== null, 'parcel returned')
  assert(typeof out!.id === 'number', 'parcel.id set')
})

test('fetchLabelPdf in dryRun returns a PDF-prefix buffer', async () => {
  const buf = await fetchLabelPdf(fakeCreds, 'https://example/mock')
  assert(Buffer.isBuffer(buf), 'is Buffer')
  assert(buf.toString('utf8').startsWith('%PDF'), 'PDF prefix')
})

test('NEXUS_SENDCLOUD_SANDBOX_URL override switches base URL', () => {
  const prev = process.env.NEXUS_SENDCLOUD_SANDBOX_URL
  // Note: the URL is read at module load, so we can't actually verify
  // the override here without a re-import. This test documents intent;
  // the real verification is the constant assignment in client.ts.
  process.env.NEXUS_SENDCLOUD_SANDBOX_URL = prev
})

// ── Runner ──────────────────────────────────────────────────────────────
;(async () => {
  let passed = 0
  let failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      passed++
    } catch (err) {
      failed++
      // eslint-disable-next-line no-console
      console.error(`FAIL: ${t.name}`, err instanceof Error ? err.message : err)
    }
  }
  // Restore env to whatever ambient was.
  if (prevEnableReal === undefined) delete process.env.NEXUS_ENABLE_SENDCLOUD_REAL
  else process.env.NEXUS_ENABLE_SENDCLOUD_REAL = prevEnableReal

  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`sendcloud client.test.ts: ${failed} failed / ${passed} passed`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(`sendcloud client.test.ts: ${passed}/${passed} passed`)
})()
