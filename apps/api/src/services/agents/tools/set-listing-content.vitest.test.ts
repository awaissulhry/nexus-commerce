/**
 * MCP full control T7 (docs/mcp-full-control/sections/03-content.md §3, §6 step 7) — `set-listing-content` changes what
 * ONE listing shows, through the doors a person and Claude use, on PostgreSQL with the production schema (PGlite). The
 * product sheet's read, the product writer and the content door are real.
 *
 *   pin        Amazon DE keeps its own German description; eBay DE goes on following the shared text, and the shared
 *              text does not move; 0 channel updates queued (d7)
 *   follow     a pinned title goes back to the shared text (the follow marker)
 *   attribute  the listing's own channel values (eBay's subtitle, an Amazon attribute) are set on the listing, never on
 *              the product; one Amazon marks read-only on an existing listing is refused with its reason; a listing
 *              setting (price), a shared attribute of the product and an unknown key are refused
 *   refused    no listing on the coordinate yet ("create the listing first"); a language the market does not carry;
 *              no English meaning
 *   undo       a new set-listing-content that puts the listing's own text back (or follows again)
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
// The sheet read picks each row's face image; this fixture has none.
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
  const out = await ask('set-listing-content', args)
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
  return (await inside(() => callTool(who, 'set-listing-content', args))).visible as { ok: boolean; error?: string; preview?: Data }
}
const productOf = (id: string) => inside(() => db().product.findUniqueOrThrow({ where: { id }, include: { translations: true } }))
const german = async (id: string) => (await productOf(id)).translations.find((row) => row.language === 'de')
const queueRows = (ids: string[]) => inside(() => db().outboundSyncQueue.count({ where: { productId: { in: ids } } }))


const translationOf = (listingId: string) => inside(() => db().channelListingTranslation.findFirst({ where: { channelListingId: listingId, language: 'de' } }))
const listingOf = (id: string) => inside(() => db().channelListing.findUniqueOrThrow({ where: { id } }))

/** A jacket family listed on Amazon DE (the parent keeps its own German title, a pin) and eBay DE (follows). */
async function seed(sku: string) {
  return inside(async () => {
    const parent = await db().product.create({ data: {
      sku, name: `${sku} giacca`, basePrice: '100.00', isParent: true, productType: 'TEST_JACKET', brand: 'Test Brand',
      familyId: (await db().productFamily.findFirstOrThrow({ where: { code: 'test-t7-jackets' } })).id, categoryAttributes: { lining: 'Cotone' },
      description: 'Giacca da moto in pelle.', bulletPoints: ['Pelle'], status: 'ACTIVE',
    } })
    const child = await db().product.create({ data: { sku: `${sku}-S`, name: `${sku} giacca S`, basePrice: '100.00', parentId: parent.id, productType: 'TEST_JACKET', status: 'ACTIVE' } })
    const listing = (productId: string, channel: string, market: string, account: string) => db().channelListing.create({ data: {
      productId, channel, marketplace: market, region: 'EU', channelMarket: `${channel}_${market}`, channelConnectionId: account, aliasKey: '',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `FIXTURE-${channel}-${market}-${productId}`, syncPaused: false,
      lastSyncStatus: 'SUCCESS', lastSyncedAt: new Date('2026-09-30T10:00:00Z'),
    } as never })
    const amazonDe = await listing(parent.id, 'AMAZON', 'DE', accounts.amazon)
    const ebayDe = await listing(parent.id, 'EBAY', 'DE', accounts.ebay)
    await listing(child.id, 'AMAZON', 'DE', accounts.amazon)
    await db().channelListingTranslation.create({ data: { channelListingId: amazonDe.id, language: 'de', name: 'Amazon-Titel', source: 'manual', reviewedAt: new Date() } })
    return { parent, child, amazonDe, ebayDe }
  })
}

const AMAZON_DE = { channel: 'AMAZON', market: 'DE' }
const EBAY_DE = { channel: 'EBAY', market: 'DE' }

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const role = await db().role.create({ data: { key: `T7_EDITOR_${randomUUID().slice(0, 8)}`, name: 'Editor', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const user = await db().userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Content approver' } })
  approverId = user.id
  await db().userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await db().workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  await db().workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  await inside(async () => {
    for (const [channel, code, language] of [['AMAZON', 'IT', 'it'], ['AMAZON', 'DE', 'de'], ['EBAY', 'DE', 'de'], ['EBAY', 'IT', 'it']] as const) {
      await db().marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language, languages: [language], marketplaceId: `TEST_${channel}_${code}` } as never })
    }
    // Amazon's cached rules for the jacket on DE: text, bullets, and a fit read-only on a listing Amazon already has.
    const attribute = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'array', maxItems: 1, items: { type: 'object', properties }, ...extra })
    await db().categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'DE', productType: 'TEST_JACKET', schemaVersion: 't7-fixture', expiresAt: new Date('2099-01-01'), schemaDefinition: {
      type: 'object', required: ['item_name'], properties: {
        item_name: attribute({ value: { type: 'string', maxLength: 150 } }),
        product_description: attribute({ value: { type: 'string', maxLength: 2000 } }),
        bullet_point: attribute({ value: { type: 'string', maxLength: 500 } }, { maxItems: 5 }),
        fit_type: attribute({ value: { type: 'string', editable: false } }),
        color: attribute({ value: { type: 'string' } }),
        number_of_pockets: attribute({ value: { type: 'integer' } }),
        special_feature: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' } } } },
      },
    } } })
    // The family's own attribute, kept once for every channel.
    const group = await db().attributeGroup.create({ data: { code: 't7', label: 'Specifications' } })
    const lining = await db().customAttribute.create({ data: { code: 'lining', label: 'Lining', groupId: group.id, type: 'text' } })
    const family = await db().productFamily.create({ data: { code: 'test-t7-jackets', label: 'Jackets' } })
    await db().familyAttribute.create({ data: { familyId: family.id, attributeId: lining.id, channels: [] } })
    accounts.amazon = (await db().channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 't7-amazon', isActive: true, isPrimary: true, externalAccountId: 'SELLER-TEST-T7' } as never })).id
    accounts.ebay = (await db().channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 't7-ebay', isActive: true, isPrimary: true, externalAccountId: 'EBAY-TEST-T7' } as never })).id
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('T7 — set-listing-content', { timeout: 30_000 }, () => {
  it('an Amazon DE pin: only that listing keeps its own text; eBay DE follows the shared text; 0 channel updates', async () => {
    const { parent, child, amazonDe, ebayDe } = await seed('TEST-SKU-T7-PIN')
    const { approvalId, preview: p } = await queued({
      product: parent.sku, coordinate: AMAZON_DE, language: 'de', pin: { description: 'Nur auf Amazon: Lederjacke.' },
      englishMeaning: { description: 'Only on Amazon: leather jacket.' },
    })
    expect(p).toMatchObject({
      action: 'set-listing-content', listing: 'Amazon · DE · TEST-SKU-T7-PIN', language: 'de',
      changes: { description: { kind: 'pin', from: 'Giacca da moto in pelle.', to: 'Nur auf Amazon: Lederjacke.', englishMeaning: 'Only on Amazon: leather jacket.' } },
      reach: { listing: 'Amazon · DE · TEST-SKU-T7-PIN', status: 'ACTIVE', otherListingsChange: false },
    })
    expect(await inside(() => checkStaleness(approvalId))).toEqual({ stale: false, why: null })
    expect(await approveAndRun(approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await translationOf(amazonDe.id)).toMatchObject({ name: 'Amazon-Titel', description: 'Nur auf Amazon: Lederjacke.', source: 'manual' })
    expect(await translationOf(ebayDe.id)).toBeNull()
    expect(await inside(() => db().productTranslation.count({ where: { productId: parent.id } }))).toBe(0)
    expect((await productOf(parent.id)).description).toBe('Giacca da moto in pelle.')
    expect(await queueRows([parent.id, child.id])).toBe(0)
    const audit = await inside(() => db().auditLog.findFirst({ where: { entityType: 'ChannelListing', entityId: amazonDe.id }, orderBy: { createdAt: 'desc' } }))
    expect(audit).toMatchObject({ userId: approverId, metadata: expect.objectContaining({ layer: 'pin', reason: 'mcp:set-listing-content' }) })
  })

  it('follow: the pinned title goes back to the shared text', async () => {
    const { parent, amazonDe } = await seed('TEST-SKU-T7-FOLLOW')
    const { approvalId, preview: p } = await queued({ product: parent.id, coordinate: AMAZON_DE, language: 'de', follow: ['title'] })
    // No German shared title: it shows the Italian source once it follows.
    expect(p.changes.title).toEqual({ kind: 'follow', from: 'Amazon-Titel', to: 'TEST-SKU-T7-FOLLOW giacca' })
    expect(await approveAndRun(approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await translationOf(amazonDe.id)).toMatchObject({ name: null, follows: ['title'] })
    // Nothing to return any more.
    expect(await preview({ product: parent.id, coordinate: AMAZON_DE, language: 'de', follow: ['title'] }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^Nothing to change/) })
  })

  it("the listing's own channel attribute; read-only, a listing setting and unknown keys are refused with their reason", async () => {
    const { parent, ebayDe } = await seed('TEST-SKU-T7-ATTR')
    const { approvalId, preview: p } = await queued({ product: parent.id, coordinate: EBAY_DE, language: 'de', attributes: { subtitle: 'Neu: Leder' }, englishMeaning: { subtitle: 'New: leather' } })
    expect(p.changes.subtitle).toMatchObject({ kind: 'attribute', to: 'Neu: Leder', englishMeaning: 'New: leather' })
    expect(await approveAndRun(approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await listingOf(ebayDe.id)).platformAttributes).toMatchObject({ subtitle: 'Neu: Leder' })
    expect(await queueRows([parent.id])).toBe(0)

    expect(await preview({ product: parent.id, coordinate: AMAZON_DE, language: 'de', attributes: { fit_type: 'Schmal' }, englishMeaning: { fit_type: 'Slim' } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/fit_type: The channel marks this field read-only on an existing listing/) })
    expect(await preview({ product: parent.id, coordinate: EBAY_DE, language: 'de', attributes: { price: '10' }, englishMeaning: { price: '10' } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/price: a listing setting/) })
    // An Amazon attribute this listing keeps (stored on the listing, not on the product).
    const amazon = await queued({ product: parent.id, coordinate: AMAZON_DE, language: 'de', attributes: { color: 'Schwarz' }, englishMeaning: { color: 'Black' } })
    expect(amazon.preview.changes.color).toMatchObject({ kind: 'attribute', from: null, to: 'Schwarz' })
    expect(await approveAndRun(amazon.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const amazonListing = await inside(() => db().channelListing.findFirstOrThrow({ where: { productId: parent.id, channel: 'AMAZON', marketplace: 'DE' } }))
    expect(amazonListing.overrideData).toMatchObject({ color: 'Schwarz' })
    expect((await productOf(parent.id)).categoryAttributes ?? {}).not.toHaveProperty('color')
    // An attribute of the product's family, shared by every channel: changed here, it would change everywhere.
    expect(await preview({ product: parent.id, coordinate: AMAZON_DE, language: 'de', attributes: { lining: 'Mesh' }, englishMeaning: { lining: 'Mesh' } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/lining: a shared attribute of the product, kept once for every channel — change it with bulk-attribute-change/) })
    expect(await preview({ product: parent.id, coordinate: EBAY_DE, language: 'de', attributes: { no_such_key: 'x' }, englishMeaning: { no_such_key: 'x' } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/no_such_key: eBay · DE listings have no such attribute/) })
  })

  it('refused: no listing on the coordinate yet, a language the market does not carry, no English meaning', async () => {
    const { parent } = await seed('TEST-SKU-T7-REFUSE')
    expect(await preview({ product: parent.id, coordinate: { channel: 'EBAY', market: 'IT' }, language: 'it', pin: { title: 'Giacca' }, englishMeaning: { title: 'Jacket' } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/has no eBay · IT listing yet: create the listing first/) })
    expect(await preview({ product: parent.id, coordinate: AMAZON_DE, language: 'it', pin: { title: 'Giacca' }, englishMeaning: { title: 'Jacket' } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^it is not a language of Amazon · DE: it carries de/) })
    expect(await preview({ product: parent.id, coordinate: AMAZON_DE, language: 'de', pin: { description: 'Text' } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^englishMeaning is required for description/) })
    expect(MATERIAL_PREVIEW_FIELDS['set-listing-content']).toEqual(['changes', 'reach', 'basis'])
  })

  it('a listing with no channel account, in a business that has an eBay account, is refused with the fix named', async () => {
    // The same family twice: one eBay DE listing on the business's eBay account (control), one legacy listing with none.
    const { parent: linked } = await seed('TEST-SKU-T7-LINKED')
    const legacy = await inside(async () => {
      const p = await db().product.create({ data: { sku: 'TEST-SKU-T7-LEGACY', name: 'Giacca legacy', basePrice: '10.00', status: 'ACTIVE' } })
      await db().channelListing.create({ data: { productId: p.id, channel: 'EBAY', marketplace: 'DE', region: 'EU', channelMarket: 'EBAY_DE', channelConnectionId: null, aliasKey: '',
        listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'FIXTURE-T7-LEGACY', syncPaused: false } as never })
      return p
    })
    const pin = { coordinate: EBAY_DE, language: 'de', pin: { description: 'Eigene Beschreibung.' }, englishMeaning: { description: 'Own description.' } }
    expect(await preview({ product: linked.id, ...pin })).toMatchObject({ ok: true, preview: { listing: 'eBay · DE · TEST-SKU-T7-LINKED' } })
    expect(await preview({ product: legacy.id, ...pin })).toEqual({
      ok: false,
      error: 'Not possible on eBay · DE · TEST-SKU-T7-LEGACY: this listing has no channel account — link it to the eBay account first, then ask again. Nothing was queued.',
    })
  })

  it('stale when the listing\'s own text moved after the preview', async () => {
    const { parent, amazonDe } = await seed('TEST-SKU-T7-STALE')
    const { approvalId } = await queued({ product: parent.id, coordinate: AMAZON_DE, language: 'de', pin: { title: 'Neuer Amazon-Titel' }, englishMeaning: { title: 'New Amazon title' } })
    await inside(() => db().channelListingTranslation.updateMany({ where: { channelListingId: amazonDe.id, language: 'de' }, data: { name: 'Edited in the sheet', version: { increment: 1 } } }))
    expect((await inside(() => checkStaleness(approvalId))).stale).toBe(true)
    expect((await approveAndRun(approvalId)).status).not.toBe('executed')
    expect((await translationOf(amazonDe.id))!.name).toBe('Edited in the sheet')
  })

  it('undo restores an attribute with its original JSON type: a number stays a number, a list stays a list', async () => {
    const { parent, amazonDe } = await seed('TEST-SKU-T7-TYPES')
    await inside(() => db().channelListing.update({ where: { id: amazonDe.id }, data: { overrideData: { number_of_pockets: 4, special_feature: ['Impermeabile', 'Ventilata'] } } }))
    const first = await queued({ product: parent.id, coordinate: AMAZON_DE, language: 'de', attributes: { number_of_pockets: 6, special_feature: ['Leicht'] }, englishMeaning: { special_feature: 'Light' } })
    const ran = await approveAndRun(first.approvalId)
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    expect((await listingOf(amazonDe.id)).overrideData).not.toMatchObject({ number_of_pockets: 4 })
    const undo = await ask('undo-change', { approvalId: first.approvalId })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    const undone = await approveAndRun(undo.approvalId!)
    expect(undone, undone.error).toMatchObject({ ok: true, status: 'executed' })
    const back = (await listingOf(amazonDe.id)).overrideData as Record<string, unknown>
    expect(back.number_of_pockets).toBe(4)
    expect(back.special_feature).toEqual(['Impermeabile', 'Ventilata'])
  })

  it('undo puts the listing back: a pin it did not have before is returned to the shared text', async () => {
    const { parent, amazonDe } = await seed('TEST-SKU-T7-UNDO')
    const first = await queued({ product: parent.id, coordinate: AMAZON_DE, language: 'de', pin: { description: 'Eigene Beschreibung.' }, englishMeaning: { description: 'Own description.' } })
    expect(await approveAndRun(first.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const undo = await ask('undo-change', { approvalId: first.approvalId })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    const request = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: undo.approvalId! } }))
    expect(request).toMatchObject({ toolName: 'set-listing-content', args: { product: parent.id, language: 'de', follow: ['description'], coordinate: { channel: 'AMAZON', market: 'DE', accountId: accounts.amazon } } })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await translationOf(amazonDe.id)).toMatchObject({ name: 'Amazon-Titel', description: null, follows: ['description'] })
  })
})
