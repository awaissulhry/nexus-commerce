/**
 * MCP full control I10 — set-product-sku, set-gtin, set-brand and set-listing-sku, through the doors a person and
 * Claude use: the gate queues each change (alwaysAsk), a person approves it, the sweep runs it, the change is recorded,
 * and undo-change asks for the old value through the same gate. Real product bulk writer, real PostgreSQL with the
 * production schema and policies (PGlite); nothing reaches a channel.
 *
 * d12 (decided): a live listing's channel SKU is recorded, never renamed — a live product's SKU is refused, and an extra
 * listing's recorded SKU is not changed while it is live. set-listing-sku needs ProductListingAlias.sku: refused with
 * its reason without the column, working once the column exists (added here as the eBay import's migration adds it).
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { runOrQueueTool } from '../approval-gate.service.js'
import { callTool, type UserPrincipal } from '../call-tool.js'
import { commitScheduledApproval, scheduleApproval } from '../../agent-fleet/approval-inbox.service.js'

const A = LEGACY_WORKSPACE_ID
const B = 'i10_identity_fix_bravo'
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids: Record<string, string> = {}
const ALL = (): UserPrincipal => ({ kind: 'user', userId: ids.approver, label: 'Ida Identity', permissions: { isOwner: false, permissions: EVERYTHING }, workspace: business(A), via: 'app' })
const CLAUDE = (): UserPrincipal => ({ ...ALL(), via: 'claude' })
const db = () => database.client
type Data = Record<string, any>

function withCheckDigit(base: string): string {
  let sum = 0
  for (let i = base.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(base[i]) * w
  return base + ((10 - (sum % 10)) % 10)
}
const G1 = withCheckDigit('400638133391')
const G2 = withCheckDigit('400638133392')
const G3 = withCheckDigit('400638133395')

async function ask(tool: string, args: Record<string, unknown>, who = ALL()) {
  const run = await inside(() => db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: ids.approver, via: who.via } }))
  return inside(() => runOrQueueTool(tool, args, who, run.id, { forceAsk: true })) as Promise<Data>
}
async function approveAndRun(approvalId: string) {
  const parked = await inside(() => scheduleApproval({ id: approvalId, actor: ALL() }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId)) as Promise<Data>
}
async function askAndRun(tool: string, args: Record<string, unknown>) {
  const queued = await ask(tool, args)
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  const ran = await approveAndRun(queued.approvalId)
  expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
  return queued.approvalId as string
}
/** Undo a change that ran: queued through the same gate, approved, run. */
async function undo(approvalId: string) {
  const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
  const asked = await ask('undo-change', { changeId: change.id })
  expect(asked, asked.error).toMatchObject({ ok: true, mode: 'queued' })
  return { asked, ran: await approveAndRun(asked.approvalId) }
}
const preview = async (tool: string, args: Record<string, unknown>, who = ALL()) => (await callTool(who, tool, args)).visible as Data
const product = (sku: string) => inside(() => db().product.findFirstOrThrow({ where: { sku } }))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  const role = await client.role.create({ data: { key: `I10_${randomUUID().slice(0, 8)}`, name: 'Identity tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const approver = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Ida Identity' } })
  ids.approver = approver.id
  await client.userRole.create({ data: { userId: approver.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: 'Bravo identity business', createdByUserId: approver.id, creationKey: randomUUID() } })
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: approver.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  await inside(async () => {
    for (const [channel, code] of [['EBAY', 'IT'], ['EBAY', 'DE'], ['AMAZON', 'DE']]) {
      await client.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: `I10_${channel}_${code}` } as never })
    }
    const make = async (sku: string, extra: Data = {}) => { ids[sku] = (await client.product.create({ data: { sku, name: `${sku} jacket`, basePrice: '10.00', ...extra } })).id }
    const list = (sku: string, channel: string, market: string, extra: Data = {}) => client.channelListing.create({
      data: { productId: ids[sku], channel, marketplace: market, region: market, channelMarket: `${channel}_${market}`, listingStatus: 'ACTIVE', isPublished: true, externalListingId: `${sku}-ITEM`, ...extra },
    })
    await make('FIX-OLD')
    await list('FIX-OLD', 'EBAY', 'IT', { listingStatus: 'DRAFT', externalListingId: null })
    await make('FIX-LIVE')
    await list('FIX-LIVE', 'EBAY', 'IT')
    await make('FIX-GTIN')
    await make('FIX-HOLDER', { ean: G2 })
    await make('FIX-AMZ', { gtin: G3 })
    await list('FIX-AMZ', 'AMAZON', 'DE')
    await make('FIX-B1', { brand: 'ACME MOTO' })
    await make('FIX-B2', { brand: 'acme-moto' })
    await make('FIX-B3', { brand: 'Acme Moto' })
    await make('FIX-ROOT')
    const live = await client.productListingAlias.create({ data: { productId: ids['FIX-ROOT'], channel: 'EBAY', marketplace: 'IT', label: 'second listing', position: 2 } })
    ids.liveAlias = live.id
    await list('FIX-ROOT', 'EBAY', 'IT', { aliasId: live.id, aliasKey: live.id, externalListingId: '110000000777' })
    const quiet = await client.productListingAlias.create({ data: { productId: ids['FIX-ROOT'], channel: 'EBAY', marketplace: 'DE', label: 'draft listing', position: 2 } })
    ids.quietAlias = quiet.id
    await list('FIX-ROOT', 'EBAY', 'DE', { aliasId: quiet.id, aliasKey: quiet.id, listingStatus: 'DRAFT', externalListingId: null })
  })
  await inside(async () => { ids.bravo = (await client.product.create({ data: { sku: 'FIX-OLD', name: 'Bravo jacket', basePrice: '10.00' } })).id }, B)
  // Integration (ids × eBay import by SKU): this schema already has ProductListingAlias.sku (20261001c). The tests below
  // start from the state before that migration and add the column themselves, so drop it once the seed is in.
  await database.db.query(`ALTER TABLE "ProductListingAlias" DROP COLUMN IF EXISTS "sku"`)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('I10 — set-product-sku', () => {
  it('previews the rename with the writer\'s verdict, runs only after a person approves, and undo puts the old SKU back', async () => {
    const out = await preview('set-product-sku', { productId: ids['FIX-OLD'], sku: 'FIX-NEW' })
    expect(out.ok, out.error).toBe(true)
    expect(out.preview).toMatchObject({ action: 'set-product-sku', changes: { SKU: { from: 'FIX-OLD', to: 'FIX-NEW' } }, effect: expect.stringContaining('1 draft listing will be published under the new SKU') })
    expect((await product('FIX-OLD')).id).toBe(ids['FIX-OLD'])
    const approvalId = await askAndRun('set-product-sku', { productId: ids['FIX-OLD'], sku: 'FIX-NEW' })
    expect((await inside(() => db().product.findUniqueOrThrow({ where: { id: ids['FIX-OLD'] } }))).sku).toBe('FIX-NEW')
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
    expect(change).toMatchObject({ toolName: 'set-product-sku', before: { productId: ids['FIX-OLD'], sku: 'FIX-OLD' }, after: { productId: ids['FIX-OLD'], sku: 'FIX-NEW' } })
    const { asked, ran } = await undo(approvalId)
    expect(asked.preview).toMatchObject({ changes: { SKU: { from: 'FIX-NEW', to: 'FIX-OLD' } } })
    expect(ran).toMatchObject({ ok: true, status: 'executed' })
    expect((await inside(() => db().product.findUniqueOrThrow({ where: { id: ids['FIX-OLD'] } }))).sku).toBe('FIX-OLD')
  }, TIMEOUT)

  it('refuses a live product (d12: a channel seller SKU is never renamed), a SKU in use, and the SKU it already has', async () => {
    expect(await preview('set-product-sku', { productId: ids['FIX-LIVE'], sku: 'FIX-LIVE-2' })).toMatchObject({ ok: false, error: expect.stringContaining("Can't change the SKU while this product is live on EBAY") })
    expect(await preview('set-product-sku', { productId: ids['FIX-OLD'], sku: 'FIX-LIVE' })).toMatchObject({ ok: false, error: expect.stringContaining('already used by another product') })
    expect(await preview('set-product-sku', { productId: ids['FIX-OLD'], sku: 'FIX-OLD' })).toMatchObject({ ok: false, error: expect.stringContaining('already has this SKU') })
  }, TIMEOUT)

  it('another business\'s product is not found, and Claude\'s request is only ever queued', async () => {
    expect(await preview('set-product-sku', { productId: ids.bravo, sku: 'FIX-ANY' })).toEqual({ ok: false, error: 'Product not found' })
    const queued = await inside(async () => runOrQueueTool('set-product-sku', { productId: ids['FIX-OLD'], sku: 'FIX-CLAUDE' }, CLAUDE(),
      (await db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'running', via: 'claude' } })).id)) as Data
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    expect((await inside(() => db().product.findUniqueOrThrow({ where: { id: ids['FIX-OLD'] } }))).sku).toBe('FIX-OLD')
  }, TIMEOUT)

  it('a SKU changed after the approval was asked for makes it stale: nothing runs', async () => {
    const queued = await ask('set-product-sku', { productId: ids['FIX-OLD'], sku: 'FIX-STALE' })
    await inside(() => db().product.update({ where: { id: ids['FIX-OLD'] }, data: { sku: 'FIX-MOVED' } }))
    const ran = await approveAndRun(queued.approvalId).catch((error) => ({ ok: false, error: String(error) }))
    expect(ran.ok).toBe(false)
    expect((await inside(() => db().product.findUniqueOrThrow({ where: { id: ids['FIX-OLD'] } }))).sku).toBe('FIX-MOVED')
    await inside(() => db().product.update({ where: { id: ids['FIX-OLD'] }, data: { sku: 'FIX-OLD' } }))
  }, TIMEOUT)
})

describe('I10 — set-gtin', () => {
  it('sets a valid code (spaces dropped), records it, and undo clears it again', async () => {
    const out = await preview('set-gtin', { productId: ids['FIX-GTIN'], code: `${G1.slice(0, 6)} ${G1.slice(6)}` })
    expect(out.preview).toMatchObject({ action: 'set-gtin', field: 'gtin', changes: { GTIN: { from: null, to: G1 } } })
    const approvalId = await askAndRun('set-gtin', { productId: ids['FIX-GTIN'], code: G1 })
    expect((await product('FIX-GTIN')).gtin).toBe(G1)
    const { ran } = await undo(approvalId)
    expect(ran).toMatchObject({ ok: true, status: 'executed' })
    expect((await product('FIX-GTIN')).gtin).toBeNull()
  }, TIMEOUT)

  it('refuses a wrong check digit and a code another product carries; names a live Amazon listing', async () => {
    const bad = G1.slice(0, -1) + ((Number(G1.at(-1)) + 1) % 10)
    expect(await preview('set-gtin', { productId: ids['FIX-GTIN'], code: bad })).toMatchObject({ ok: false, error: expect.stringContaining('not a valid barcode (check digit mismatch)') })
    expect(await preview('set-gtin', { productId: ids['FIX-GTIN'], field: 'UPC', code: `0${G2}` })).toMatchObject({ ok: false, error: expect.stringContaining('FIX-HOLDER already carries this barcode') })
    const live = await preview('set-gtin', { productId: ids['FIX-AMZ'], code: G1 })
    expect(live.preview).toMatchObject({ changes: { GTIN: { from: G3, to: G1 } }, liveOn: ['Amazon DE'], risk: expect.stringContaining('Amazon may match the listing to another catalogue item') })
  }, TIMEOUT)
})

describe('I10 — set-brand', () => {
  it('one spelling for several products (by id or SKU), each recorded, and undo gives each its own back', async () => {
    const args = { brands: [{ product: ids['FIX-B1'], brand: 'Acme Moto' }, { product: 'FIX-B2', brand: 'Acme Moto' }, { product: ids['FIX-B3'], brand: 'Acme Moto' }] }
    const out = await preview('set-brand', args)
    expect(out.preview).toMatchObject({ totals: { changing: 2, alreadySet: 1 }, changes: { 'FIX-B1 brand': { from: 'ACME MOTO', to: 'Acme Moto' }, 'FIX-B2 brand': { from: 'acme-moto', to: 'Acme Moto' } } })
    const approvalId = await askAndRun('set-brand', args)
    expect([(await product('FIX-B1')).brand, (await product('FIX-B2')).brand]).toEqual(['Acme Moto', 'Acme Moto'])
    const { asked, ran } = await undo(approvalId)
    expect(asked.preview).toMatchObject({ totals: { changing: 2 } })
    expect(ran).toMatchObject({ ok: true, status: 'executed' })
    expect([(await product('FIX-B1')).brand, (await product('FIX-B2')).brand, (await product('FIX-B3')).brand]).toEqual(['ACME MOTO', 'acme-moto', 'Acme Moto'])
  }, TIMEOUT)

  it('refuses a product named twice, one not found here, and nothing to change', async () => {
    expect(await preview('set-brand', { brands: [{ product: ids['FIX-B1'], brand: 'X' }, { product: 'FIX-B1', brand: 'Y' }] })).toMatchObject({ ok: false, error: expect.stringContaining('named twice') })
    expect(await preview('set-brand', { brands: [{ product: ids.bravo, brand: 'X' }] })).toMatchObject({ ok: false, error: expect.stringContaining('Product not found') })
    expect(await preview('set-brand', { brands: [{ product: ids['FIX-B3'], brand: 'Acme Moto' }] })).toMatchObject({ ok: false, error: expect.stringContaining('already has this brand') })
  }, TIMEOUT)
})

describe('I10 — set-listing-sku', () => {
  it('without the listing-SKU column: refused with the reason, naming the extra listing; an unknown one is not found', async () => {
    expect(await preview('set-listing-sku', { extraListingId: ids.quietAlias, sku: 'FIX-ROOT-DE' })).toMatchObject({
      ok: false, error: expect.stringContaining('"draft listing" of FIX-ROOT (EBAY DE): not available until the listing-SKU column exists'),
    })
    expect(await preview('set-listing-sku', { extraListingId: 'no-such-alias', sku: 'X' })).toEqual({ ok: false, error: 'Extra listing not found' })
  }, TIMEOUT)

  it('with the column: records a live listing\'s SKU, will not rename it while live (d12), and undo clears the record', async () => {
    await database.db.query(`ALTER TABLE "ProductListingAlias" ADD COLUMN "sku" TEXT`)
    const out = await preview('set-listing-sku', { extraListingId: ids.liveAlias, sku: 'FIX-ROOT-IT2' })
    expect(out.preview).toMatchObject({ changes: { 'listing SKU': { from: null, to: 'FIX-ROOT-IT2' } }, effect: expect.stringContaining('It is live') })
    const approvalId = await askAndRun('set-listing-sku', { extraListingId: ids.liveAlias, sku: 'FIX-ROOT-IT2' })
    const stored = async (id: string) => (await database.db.query<{ sku: string | null }>(`SELECT sku FROM "ProductListingAlias" WHERE id = $1`, [id])).rows[0].sku
    expect(await stored(ids.liveAlias)).toBe('FIX-ROOT-IT2')
    expect(await preview('set-listing-sku', { extraListingId: ids.liveAlias, sku: 'FIX-ROOT-IT3' })).toMatchObject({ ok: false, error: expect.stringContaining('is live with the SKU FIX-ROOT-IT2') })
    const { ran } = await undo(approvalId)
    expect(ran).toMatchObject({ ok: true, status: 'executed' })
    expect(await stored(ids.liveAlias)).toBeNull()
  }, TIMEOUT)

  it('with the column: refuses a SKU a product or another extra listing uses', async () => {
    expect(await preview('set-listing-sku', { extraListingId: ids.quietAlias, sku: 'fix-live' })).toMatchObject({ ok: false, error: expect.stringContaining('already the SKU of a product (FIX-LIVE)') })
    await askAndRun('set-listing-sku', { extraListingId: ids.quietAlias, sku: 'FIX-ROOT-DE' })
    expect(await preview('set-listing-sku', { extraListingId: ids.liveAlias, sku: 'FIX-ROOT-DE' })).toMatchObject({ ok: false, error: expect.stringContaining('another extra listing') })
  }, TIMEOUT)
})
