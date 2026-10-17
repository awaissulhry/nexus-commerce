/**
 * MCP full control T8 (docs/mcp-full-control/sections/03-content.md §3, §6 step 8) — `bulk-content-change` changes the
 * shared text of up to 25 products in one language with one approval, through the doors a person and Claude use, on
 * PostgreSQL with the production schema (PGlite). The product writer and the content door are real.
 *
 *   run        every product's text written, reviewed, sourceModel claude-mcp; 0 channel updates queued (d7)
 *   preview    totals, the first 20 changes by SKU with their English meaning, how many listings show the texts
 *   all-or-none one product that cannot change refuses them all, in the preview and when it runs
 *   basis      a text moved on product 21 (past the 20 lines shown) makes the approval stale
 *   size       more than 512 KB of arguments is refused
 *   undo       one new bulk request that puts every product's text back
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// As db.ts wraps it: inside a transaction, `prisma.x` is that transaction's client.
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
// The product sheet (product-content reads it) takes the face-image select from here too.
vi.mock('../../product-read-cache.service.js', () => ({
  productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() },
  FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: { url: true }, pickFaceImage: () => null,
}))
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { runOrQueueTool } from '../approval-gate.service.js'
import { checkStaleness, commitScheduledApproval, MATERIAL_PREVIEW_FIELDS, scheduleApproval } from '../../agent-fleet/approval-inbox.service.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
let approverId = ''
const person = (permissions: Set<string>): UserPrincipal => ({
  kind: 'user', userId: approverId, label: 'Content approver', permissions: { isOwner: false, permissions }, workspace: business, via: 'claude',
})
const ALL = () => person(EVERYTHING)

type Data = Record<string, any>
const db = () => database.client
const accounts = { amazon: '', ebay: '' }

async function ask(tool: string, args: Record<string, unknown>, who = ALL()) {
  const run = await inside(() => db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: approverId, via: 'claude' } }))
  return inside(() => runOrQueueTool(tool, args, who, run.id, { forceAsk: true })) as Promise<{ ok: boolean; mode?: string; approvalId?: string; preview?: Data; error?: string }>
}
async function queued(args: Record<string, unknown>) {
  const out = await ask('bulk-content-change', args)
  expect(out, out.error).toMatchObject({ ok: true, mode: 'queued' })
  return out as { approvalId: string; preview: Data }
}
async function approveAndRun(approvalId: string) {
  const parked = await inside(() => scheduleApproval({ id: approvalId, actor: { ...ALL(), via: 'app' } }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}
async function preview(args: Record<string, unknown>, who = ALL()) {
  return (await inside(() => callTool(who, 'bulk-content-change', args))).visible as { ok: boolean; error?: string; preview?: Data }
}
const productOf = (id: string) => inside(() => db().product.findUniqueOrThrow({ where: { id }, include: { translations: true } }))
const german = async (id: string) => (await productOf(id)).translations.find((row) => row.language === 'de')
const queueRows = (ids: string[]) => inside(() => db().outboundSyncQueue.count({ where: { productId: { in: ids } } }))


async function products(prefix: string, n: number) {
  return inside(async () => {
    const out = []
    for (let i = 1; i <= n; i++) {
      out.push(await db().product.create({ data: { sku: `${prefix}-${String(i).padStart(2, '0')}`, name: `${prefix} giacca ${i}`, basePrice: '10.00', description: 'Descrizione.' } }))
    }
    return out
  })
}
const item = (sku: string, title: string) => ({ product: sku, title, englishMeaning: { title: `${title} (in English)` } })

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const role = await db().role.create({ data: { key: `T8_EDITOR_${randomUUID().slice(0, 8)}`, name: 'Editor', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const user = await db().userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Content approver' } })
  approverId = user.id
  await db().userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await db().workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  await db().workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  await inside(async () => {
    for (const [channel, code, language] of [['AMAZON', 'IT', 'it'], ['EBAY', 'DE', 'de'], ['EBAY', 'IT', 'it']] as const) {
      await db().marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language, languages: [language], marketplaceId: `TEST_${channel}_${code}` } as never })
    }
    accounts.ebay = (await db().channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 't8-ebay', isActive: true, isPrimary: true, externalAccountId: 'EBAY-TEST-T8' } as never })).id
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('T8 — bulk-content-change', { timeout: 60_000 }, () => {
  it('two products in German: one approval, both written reviewed with sourceModel claude-mcp; 0 channel updates', async () => {
    const [one, two] = await products('TEST-SKU-T8-RUN', 2)
    // The first is listed on eBay DE and follows the shared German text.
    await inside(() => db().channelListing.create({ data: { productId: one.id, channel: 'EBAY', marketplace: 'DE', region: 'EU', channelMarket: 'EBAY_DE', channelConnectionId: accounts.ebay, aliasKey: '', listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'FIXTURE-T8-1', syncPaused: false } as never }))
    const { approvalId, preview: p } = await queued({ language: 'de', items: [item(one.sku, 'Jacke eins'), { ...item(two.id, 'Jacke zwei'), description: 'Zwei.', englishMeaning: { title: 'Jacket two', description: 'Two.' } }] })
    expect(p).toMatchObject({
      action: 'bulk-content-change', language: 'de', layer: 'language', totals: { products: 2, changes: 3 },
      changes: [
        { sku: one.sku, field: 'title', from: `${one.sku.replace(/-01$/, '')} giacca 1`, fromLanguage: 'it', to: 'Jacke eins', englishMeaning: 'Jacke eins (in English)' },
        { sku: two.sku, field: 'title', to: 'Jacke zwei', englishMeaning: 'Jacket two' },
        { sku: two.sku, field: 'description', from: 'Descrizione.', to: 'Zwei.', englishMeaning: 'Two.' },
      ],
      reach: { listingsFollowing: 1, listingsWithOwnText: 0 },
      basis: expect.any(String),
    })
    expect(await inside(() => checkStaleness(approvalId))).toEqual({ stale: false, why: null })
    expect(await approveAndRun(approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await german(one.id)).toMatchObject({ name: 'Jacke eins', source: 'manual', sourceModel: 'claude-mcp' })
    expect(await german(two.id)).toMatchObject({ name: 'Jacke zwei', description: 'Zwei.', source: 'manual', sourceModel: 'claude-mcp' })
    expect(await queueRows([one.id, two.id])).toBe(0)
  })

  /*
   * 2026-10-17 (a jacket family, 31 eBay IT listings): a change of the shared Italian title turned every eBay IT title the
   * listings kept as their own into the new 150-character shared title. A listing linked from eBay keeps the channel's
   * title as a legacy snapshot under the default follow flag; the shared write's cascade wrote "follows title" on it.
   */
  it("a change of the shared title never drops an eBay listing's own title; only the following listing shows the new one", async () => {
    const [snapshot, pinned, plain] = await products('TEST-SKU-T8-KEEP', 3)
    const ebayIt = (productId: string, extra: Data = {}) => inside(() => db().channelListing.create({ data: {
      productId, channel: 'EBAY', marketplace: 'IT', region: 'EU', channelMarket: 'EBAY_IT', channelConnectionId: accounts.ebay, aliasKey: '',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `FIXTURE-T8-KEEP-${productId}`, syncPaused: false, ...extra,
    } as never }))
    // The eBay title as a listing linked from eBay keeps it (followMasterTitle stays at its default), and an operator's pin.
    const linked = await ebayIt(snapshot.id, { title: 'Giacca Moto Uomo Impermeabile Protezioni CE Livello 2', followMasterTitle: true })
    const own = await ebayIt(pinned.id)
    await inside(() => db().channelListingTranslation.create({ data: { channelListingId: own.id, language: 'it', name: 'Giacca Moto Uomo CE Livello 2 con Cappuccio', source: 'manual', reviewedAt: new Date(), version: 1 } }))
    const following = await ebayIt(plain.id)
    const shows = async (sku: string) => {
      const read = (await inside(() => callTool(ALL(), 'product-content', { product: sku, coordinate: { channel: 'EBAY', market: 'IT' }, language: 'it', fields: ['title'] }))).visible as { ok: boolean; error?: string; data?: Data }
      expect(read.ok, read.error).toBe(true)
      return read.data!.rows[0].cells.title as { value: unknown; layer: string; followsShared?: boolean }
    }
    expect(await shows(snapshot.sku)).toMatchObject({ value: 'Giacca Moto Uomo Impermeabile Protezioni CE Livello 2', layer: 'pin', followsShared: false })

    const { approvalId, preview: p } = await queued({ language: 'it', items: [item(snapshot.sku, 'Nuovo titolo uno'), item(pinned.sku, 'Nuovo titolo due'), item(plain.sku, 'Nuovo titolo tre')] })
    expect(p.reach).toEqual({ listingsFollowing: 1, listingsWithOwnText: 2 })
    expect(await approveAndRun(approvalId)).toMatchObject({ ok: true, status: 'executed' })

    expect(await shows(snapshot.sku)).toMatchObject({ value: 'Giacca Moto Uomo Impermeabile Protezioni CE Livello 2', layer: 'pin' })
    expect(await shows(pinned.sku)).toMatchObject({ value: 'Giacca Moto Uomo CE Livello 2 con Cappuccio', layer: 'pin' })
    expect(await shows(plain.sku)).toMatchObject({ value: 'Nuovo titolo tre', followsShared: true })
    // Nothing written on the listings that keep their own text: no follow marker, the same versions.
    const rows = await inside(() => db().channelListingTranslation.findMany({ where: { channelListingId: { in: [linked.id, own.id, following.id] } } }))
    expect(rows.find((row) => row.channelListingId === linked.id)).toBeUndefined()
    expect(rows.find((row) => row.channelListingId === own.id)).toMatchObject({ name: 'Giacca Moto Uomo CE Livello 2 con Cappuccio', follows: [], version: 1 })
    expect(rows.find((row) => row.channelListingId === following.id)).toMatchObject({ follows: ['title'] })
    expect((await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: linked.id } }))).version).toBe(linked.version)
  })

  it("refused: a new title over eBay's 80 characters that an eBay listing following the shared title would show", async () => {
    const [follows, keeps] = await products('TEST-SKU-T8-EBAY80', 2)
    for (const [product, extra] of [[follows, {}], [keeps, { title: 'Titolo eBay proprio', followMasterTitle: false }]] as const) {
      await inside(() => db().channelListing.create({ data: {
        productId: product.id, channel: 'EBAY', marketplace: 'IT', region: 'EU', channelMarket: 'EBAY_IT', channelConnectionId: accounts.ebay, aliasKey: '',
        listingStatus: 'ACTIVE', isPublished: true, externalListingId: `FIXTURE-T8-EBAY80-${product.id}`, syncPaused: false, ...extra,
      } as never }))
    }
    const long = `Giacca Moto – Giubbotto Moto Traspirante e Idrorepellente con Protezioni CE Livello 2 | Tutte le Stagioni`
    expect(long.length).toBeGreaterThan(80)
    expect(await preview({ language: 'it', items: [item(follows.sku, long), item(keeps.sku, long)] })).toMatchObject({
      ok: false, error: expect.stringMatching(new RegExp(`^${follows.sku}: the new title is ${long.length} characters; eBay allows 80, and 1 eBay listing follows the shared title and would show it \\(eBay · IT · ${follows.sku}\\)`)),
    })
    expect((await inside(() => callTool(ALL(), 'set-content', { product: follows.sku, language: 'it', title: long, englishMeaning: { title: 'Long' } }))).visible)
      .toMatchObject({ ok: false, error: expect.stringMatching(/the new title is \d+ characters; eBay allows 80/) })
    // The listing that keeps its own eBay title does not show the shared one: nothing to refuse.
    const kept = await preview({ language: 'it', items: [item(keeps.sku, long)] })
    expect(kept, kept.error).toMatchObject({ ok: true, preview: { reach: { listingsFollowing: 0, listingsWithOwnText: 1 } } })
  })

  it('one product that cannot change refuses them all — in the preview, and when it runs', async () => {
    const [one, two] = await products('TEST-SKU-T8-ALL', 2)
    expect(await preview({ language: 'de', items: [item(one.sku, 'Jacke'), item('TEST-SKU-NOWHERE', 'Jacke')] }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^1 of 2 products cannot change, so none does: TEST-SKU-NOWHERE: Product not found/) })
    expect(await preview({ language: 'de', items: [item(one.sku, 'Jacke'), item(one.id, 'Jacke')] }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/named more than once/) })
    // Queued for both; the second is deleted before it runs: nothing is written, not even the first.
    const { approvalId } = await queued({ language: 'de', items: [item(one.sku, 'Jacke A'), item(two.sku, 'Jacke B')] })
    await inside(() => db().product.update({ where: { id: two.id }, data: { deletedAt: new Date() } }))
    expect((await approveAndRun(approvalId)).status).not.toBe('executed')
    expect(await german(one.id)).toBeUndefined()
  })

  it('a text moved on product 21 — past the 20 lines the preview shows — makes the approval stale', async () => {
    const many = await products('TEST-SKU-T8-BASIS', 21)
    const { approvalId, preview: p } = await queued({ language: 'it', items: many.map((m, i) => item(m.sku, `Giacca nuova ${i + 1}`)) })
    expect(p.changes).toHaveLength(20)
    expect(p).toMatchObject({ totals: { products: 21, changes: 21 }, moreChanges: 1 })
    expect(MATERIAL_PREVIEW_FIELDS['bulk-content-change']).toEqual(['changes', 'totals', 'reach', 'basis'])
    await inside(() => db().product.update({ where: { id: many[20].id }, data: { name: 'Edited in the sheet' } }))
    const verdict = await inside(() => checkStaleness(approvalId))
    expect(verdict.stale).toBe(true)
    expect(verdict.why).toMatch(/basis/)
  })

  it('more than 512 KB of arguments is refused', async () => {
    const long = 'x'.repeat(20_000)
    const items = Array.from({ length: 25 }, (_, i) => ({ product: `TEST-SKU-T8-BIG-${i}`, description: long, englishMeaning: { description: long } }))
    expect(await preview({ language: 'de', items })).toMatchObject({ ok: false, error: expect.stringMatching(/at most 512 KB/) })
  })

  it('undo restores an empty source field as no value (null), not as an empty text', async () => {
    const empty = await inside(() => db().product.create({ data: { sku: 'TEST-SKU-T8-EMPTY', name: 'Giacca vuota', basePrice: '10.00', description: null } }))
    const first = await queued({ language: 'it', items: [{ product: empty.sku, description: 'Ora una descrizione.', englishMeaning: { description: 'Now a description.' } }] })
    expect(await approveAndRun(first.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const undo = await ask('undo-change', { approvalId: first.approvalId })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect((await productOf(empty.id)).description).toBeNull()
  })

  it('undo: one new bulk request puts every product\'s text back', async () => {
    const [one, two] = await products('TEST-SKU-T8-UNDO', 2)
    const first = await queued({ language: 'it', items: [item(one.sku, 'Nuovo uno'), item(two.sku, 'Nuovo due')] })
    expect(await approveAndRun(first.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const undo = await ask('undo-change', { approvalId: first.approvalId })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    const request = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: undo.approvalId! } }))
    expect(request).toMatchObject({ toolName: 'bulk-content-change', args: { language: 'it', items: [
      { product: one.id, title: 'TEST-SKU-T8-UNDO giacca 1' }, { product: two.id, title: 'TEST-SKU-T8-UNDO giacca 2' },
    ] } })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect((await productOf(one.id)).name).toBe('TEST-SKU-T8-UNDO giacca 1')
    expect((await productOf(two.id)).name).toBe('TEST-SKU-T8-UNDO giacca 2')
  })

  it('undo of a change that created German rows removes them; a row that keeps other text stays', async () => {
    const [one, two] = await products('TEST-SKU-T8-UNDO-DE', 2)
    await inside(() => db().productTranslation.create({ data: { productId: two.id, language: 'de', description: 'Bleibt.', source: 'manual', reviewedAt: new Date() } }))
    const first = await queued({ language: 'de', items: [item(one.sku, 'Jacke eins'), item(two.sku, 'Jacke zwei')] })
    expect(await approveAndRun(first.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await german(one.id))!.name).toBe('Jacke eins')
    const undo = await ask('undo-change', { approvalId: first.approvalId })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await german(one.id)).toBeUndefined()
    expect(await german(two.id)).toMatchObject({ name: null, description: 'Bleibt.' })
  })
})
