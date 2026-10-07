/**
 * Step 4 Send to FBA — the fake Amazon is honoured ONLY off production on a loopback `*test*` database (plan §6).
 *
 *  - the guard: flag off, NODE_ENV production, a Neon-like (production) URL, a remote host, a local database that is not a
 *    *test* one, no URL → refused; a loopback *test* database → allowed;
 *  - the client: NEXUS_FBA_INBOUND_FAKE=1 on a Neon-like URL REFUSES the call — it never falls back to Amazon (the
 *    gateway stub sees nothing); on a loopback test database the fake answers and nothing reaches the gateway either.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))
const gateway = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('../gateway/amazon-sdk.js', () => ({
  amazonSellerFetch: vi.fn(async (input: unknown) => {
    gateway.calls.push(input)
    throw new Error('the gateway must not be reached in this test')
  }),
}))

import { fakeAmazonGuard, sharedFakeAmazon } from './fake-amazon.js'
import * as client from '../../clients/amazon-fba-inbound-v2.client.js'

const NEON = 'postgresql://neondb_owner:secret@ep-purple-river-a1b2c3d4-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require'
const LOCAL_TEST = 'postgresql://postgres:postgres@127.0.0.1:55790/nexus_matrix_inventory_test'
const saved = { ...process.env }

afterEach(() => {
  for (const key of ['NEXUS_FBA_INBOUND_FAKE', 'NODE_ENV', 'DATABASE_URL', 'NEXUS_ENABLE_FBA_INBOUND_SEND']) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  client.setInboundTransportForTests(null)
  gateway.calls = []
})

describe('fakeAmazonGuard', () => {
  it('allows a loopback *test* database off production', () => {
    expect(fakeAmazonGuard({ NEXUS_FBA_INBOUND_FAKE: '1', NODE_ENV: 'development', DATABASE_URL: LOCAL_TEST })).toMatchObject({ allowed: true })
    expect(fakeAmazonGuard({ NEXUS_FBA_INBOUND_FAKE: '1', DATABASE_URL: 'postgresql://postgres@localhost:5432/nexus_test' })).toMatchObject({ allowed: true })
  })
  it('refuses a Neon-like (production) URL, naming it', () => {
    const verdict = fakeAmazonGuard({ NEXUS_FBA_INBOUND_FAKE: '1', NODE_ENV: 'development', DATABASE_URL: NEON })
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toMatch(/Neon PRODUCTION/)
  })
  it('refuses production, a remote host, a local non-test database, no URL, and the flag off', () => {
    expect(fakeAmazonGuard({ NEXUS_FBA_INBOUND_FAKE: '1', NODE_ENV: 'production', DATABASE_URL: LOCAL_TEST })).toMatchObject({ allowed: false, reason: 'NODE_ENV is production' })
    expect(fakeAmazonGuard({ NEXUS_FBA_INBOUND_FAKE: '1', DATABASE_URL: 'postgresql://u:p@db.internal.example:5432/nexus_test' }).allowed).toBe(false)
    expect(fakeAmazonGuard({ NEXUS_FBA_INBOUND_FAKE: '1', DATABASE_URL: 'postgresql://postgres@127.0.0.1:55439/nexus_development' })).toMatchObject({ allowed: false })
    expect(fakeAmazonGuard({ NEXUS_FBA_INBOUND_FAKE: '1' }).allowed).toBe(false)
    expect(fakeAmazonGuard({ NEXUS_FBA_INBOUND_FAKE: '0', DATABASE_URL: LOCAL_TEST }).allowed).toBe(false)
    expect(fakeAmazonGuard({ NEXUS_FBA_INBOUND_FAKE: 'true', DATABASE_URL: LOCAL_TEST }).allowed).toBe(false)
  })
})

describe('the client and the flag', () => {
  it('a Neon-like URL with the flag: every call is refused, nothing reaches the gateway', async () => {
    process.env.NEXUS_FBA_INBOUND_FAKE = '1'
    process.env.NODE_ENV = 'development'
    process.env.DATABASE_URL = NEON
    process.env.NEXUS_ENABLE_FBA_INBOUND_SEND = '1'
    await expect(client.listInboundPlans('conn-1')).rejects.toBeInstanceOf(client.FakeAmazonRefused)
    await expect(client.generatePlacementOptions('conn-1', 'wf-x')).rejects.toThrow(/refused here, nothing was sent/)
    expect(gateway.calls).toEqual([])
    expect(await client.inboundFakeActive()).toBe(false)
  })
  it('production with the flag is refused too', async () => {
    process.env.NEXUS_FBA_INBOUND_FAKE = '1'
    process.env.NODE_ENV = 'production'
    process.env.DATABASE_URL = LOCAL_TEST
    await expect(client.inboundTransport()).rejects.toBeInstanceOf(client.FakeAmazonRefused)
    expect(gateway.calls).toEqual([])
  })
  it('a loopback test database with the flag: the fake answers (one per process), the gateway sees nothing', async () => {
    process.env.NEXUS_FBA_INBOUND_FAKE = '1'
    process.env.NODE_ENV = 'development'
    process.env.DATABASE_URL = LOCAL_TEST
    process.env.NEXUS_ENABLE_FBA_INBOUND_SEND = '1'
    expect((await client.inboundTransport()).kind).toBe('fake')
    expect(await client.inboundFakeActive()).toBe(true)
    const before = sharedFakeAmazon().requests.length
    const plans = await client.listInboundPlans('conn-1', { status: 'ACTIVE' })
    expect(plans.inboundPlans).toEqual([])
    expect(sharedFakeAmazon().requests.length).toBe(before + 1)
    expect(gateway.calls).toEqual([])
  })
  it('labels (v0 getLabels, behind the drawer\'s "Labels"): a fake PDF link where the fake is allowed, refused elsewhere', async () => {
    const { getInboundShipmentLabels } = await import('../fba-inbound.service.js')
    const ask = () => getInboundShipmentLabels({ shipmentId: 'FBA15FAKE0001', pageType: 'PackageLabel_A4_4', labelType: 'UNIQUE', packageLabelsToPrint: ['FBA15FAKE0001U000001', 'FBA15FAKE0001U000002'] })
    process.env.NEXUS_FBA_INBOUND_FAKE = '1'
    process.env.NODE_ENV = 'development'
    process.env.DATABASE_URL = LOCAL_TEST
    // No Amazon credentials here: the fake answers before the "SP-API not configured" check.
    const before = sharedFakeAmazon().calls('getLabels').length
    const labels = await ask()
    expect(labels.downloadUrl).toMatch(/^https:\/\/fake-amazon\.invalid\/fba\/inbound\/labels\/FBA15FAKE0001\.pdf\?boxes=/)
    const [request] = sharedFakeAmazon().calls('getLabels').slice(before)
    expect(request).toMatchObject({ method: 'GET', query: { PageType: 'PackageLabel_A4_4', LabelType: 'UNIQUE', PackageLabelsToPrint: 'FBA15FAKE0001U000001,FBA15FAKE0001U000002' } })
    // A Neon-like URL with the flag: refused, never sent to Amazon.
    process.env.DATABASE_URL = NEON
    await expect(ask()).rejects.toBeInstanceOf(client.FakeAmazonRefused)
    // Flag off: the call is the old one (it needs Amazon credentials, which this test has none of).
    delete process.env.NEXUS_FBA_INBOUND_FAKE
    process.env.DATABASE_URL = LOCAL_TEST
    await expect(ask()).rejects.toThrow(/SP-API not configured/)
    expect(gateway.calls).toEqual([])
  })

  it('without the flag the gateway is the transport', async () => {
    delete process.env.NEXUS_FBA_INBOUND_FAKE
    expect(await client.inboundTransport()).toBe(client.gatewayInboundTransport)
  })
})
