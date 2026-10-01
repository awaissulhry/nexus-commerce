/** Real transactions, runtime-role RLS and forced competing first creates. Only provider reads are synthetic. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { informationRegistry, informationStoredValue } from '@nexus/shared/shopify-information'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { concurrentDatabase, concurrentDatabaseUrl, raceChannelListingInserts } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { shopifyCellToken } from './channel-sheet-projection.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
const provider = vi.hoisted(() => ({ rows: [] as any[], schema: null as any }))
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))
vi.mock('../pim/channel-specs/shopify.js', () => ({ readShopifyMappingSchema: async () => provider.schema }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => ({ graphql: async () => { throw Error('No external Shopify call is allowed') } }) }))
vi.mock('./information-gateway.js', () => ({ readInformation: async () => ({ currency: 'EUR', rows: provider.rows }) }))
const { saveShopifySheetCells } = await import('./channel-sheet.service.js')
const { getLinkedWorkspace } = await import('./linked-products.service.js')

const BUSINESS = 'nexus_legacy_workspace', OTHER = 'root-proof-other-business'
const actor = 'root-proof-actor', otherActor = 'root-proof-other-actor'
const inside = <T>(run: () => Promise<T>, workspaceId = BUSINESS) => withWorkspace({ workspaceId, actorUserId: actor, membershipId: null, roleKeys: [] }, run)
const column = 'metafield:PRODUCT:custom.note'
const baseSchema = (): ShopifyStoreSchema => ({ revision: 'root-proof-v1', currency: 'EUR', definitions: [{ id: 'note', ownerType: 'PRODUCT', namespace: 'custom', key: 'note', name: 'Note', type: 'single_line_text_field', validations: [], access: {} }], types: [], locales: [], metaobjects: [] }) as ShopifyStoreSchema
type Fixture = { familyId: string; accountId: string; anchorId: string; aliasKey: string }
const scope = (fixture: Fixture) => ({ accountId: fixture.accountId, listingId: fixture.anchorId, aliasKey: fixture.aliasKey, market: 'GLOBAL' })
async function fixture(count = 3, base?: Fixture, alias = ''): Promise<Fixture> {
  return inside(async () => {
    const accountId = base?.accountId ?? (await database.client.channelConnection.create({ data: { channelType: 'SHOPIFY', isActive: true, externalAccountId: randomUUID() } })).id
    const familyId = base?.familyId ?? (await database.client.product.create({ data: { sku: randomUUID(), name: 'Synthetic root-proof family', basePrice: 49, isParent: true } })).id
    let aliasKey = ''
    if (alias) aliasKey = (await database.client.productListingAlias.create({ data: { productId: familyId, channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: accountId, label: alias } })).id
    const children = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), sku: randomUUID(), name: `Synthetic coat ${index}`, parentId: familyId, basePrice: 49 }))
    await database.client.product.createMany({ data: children })
    const listings = children.map((child, index) => ({ id: randomUUID(), productId: child.id, channel: 'SHOPIFY' as const, channelMarket: 'SHOPIFY_GLOBAL' as const,
      region: 'GLOBAL', marketplace: 'GLOBAL', channelConnectionId: accountId, aliasKey, aliasId: aliasKey || null, externalListingId: String(index + 10) }))
    await database.client.channelListing.createMany({ data: listings })
    provider.rows = children.map((_, index) => { const id = `gid://shopify/Product/${index + 10}`; return { id, productId: id, kind: 'PRODUCT', title: `Synthetic coat ${index}`, handle: `synthetic-${index}`, image: null, media: [],
      fields: [{ ownerId: id, namespace: 'custom', key: 'note', type: 'single_line_text_field', value: 'Before', compareDigest: 'provider-baseline' }], values: {} } })
    return { familyId, accountId, aliasKey, anchorId: listings[0].id }
  })
}
async function cells(f: Fixture) {
  const workspace = await inside(() => getLinkedWorkspace(f.familyId, scope(f))), field = informationRegistry(provider.schema).find(field => field.id === column)!
  return provider.rows.map((row, index) => ({ colId: column, receiptKey: `row-${index}`, ownerId: row.id, fieldId: column, value: `Saved ${index}`, intent: 'pin' as const,
    baseline: informationStoredValue(row, field), token: shopifyCellToken(workspace, row.id, field, undefined, f.aliasKey) }))
}
type Change = Awaited<ReturnType<typeof cells>>[number]
const save = (f: Fixture, changes: Change[], operationId = 'column-action-a', user = actor) => inside(() => saveShopifySheetCells(f.familyId, scope(f), { cells: changes, operationId }, user))
const root = (f: Fixture) => inside(() => database.client.channelListing.findFirstOrThrow({ where: { productId: f.familyId, channelConnectionId: f.accountId, aliasKey: f.aliasKey } }))
const receipts = () => inside(() => database.client.commandReceipt.findMany({ where: { scope: 'shopify-sheet-root-v1' } }))
async function stored(f: Fixture) { return (await root(f)).platformAttributes as any }
const proofFor = async (f: Fixture) => { const listing = await root(f); return (await receipts()).find(row => (row.response as any)?.root?.id === listing.id)! }

describe.skipIf(!concurrentDatabaseUrl())('Shopify same-action root continuation on real PostgreSQL', () => {
  beforeAll(async () => {
    database = await concurrentDatabase()
    // The context names an actor, so the runtime role's row security requires an active membership (as in production).
    // The actor is a member of BOTH businesses: an empty read in the other one proves business isolation, not a missing member.
    for (const id of [actor, otherActor]) await database.pool.query('INSERT INTO "UserProfile" (id,email,"displayName","updatedAt") VALUES ($1,$2,$3,now())', [id, `${id}@example.invalid`, id])
    await database.pool.query('INSERT INTO "Workspace" (id,name,status,"isLegacy","createdByUserId","creationKey","updatedAt") VALUES ($1,$2,\'active\',false,$3,$4,now())', [OTHER, 'Other proof business', actor, OTHER])
    for (const [index, [workspaceId, userId]] of [[BUSINESS, actor], [BUSINESS, otherActor], [OTHER, actor]].entries()) {
      await database.pool.query('INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,\'active\',now())', [`root-proof-member-${index}`, workspaceId, userId])
    }
    await inside(() => database.client.marketplace.create({ data: { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Synthetic', region: 'GLOBAL', currency: 'EUR', language: 'en', languages: ['en'], isActive: true } }))
  }, 180_000)
  beforeEach(() => { provider.schema = baseSchema() })
  afterAll(async () => { await database?.close() }, 60_000)

  it('keeps 2001 absent-root cells valid across endpoint and outer-operation boundaries with exact readback', async () => {
    const f = await fixture(2001), original = await cells(f)
    expect(await inside(() => getLinkedWorkspace(f.familyId, scope(f))).then(w => w.destination.listingId)).toBeNull()
    for (let offset = 0; offset < original.length; offset += 1000) {
      const part = original.slice(offset, offset + 1000), result = await save(f, part)
      expect(result.ok, JSON.stringify(Object.entries(result.cells).filter(([, cell]) => !cell.ok).slice(0, 3))).toBe(true)
      const workspace = await inside(() => getLinkedWorkspace(f.familyId, scope(f))), field = informationRegistry(provider.schema).find(field => field.id === column)!
      for (const cell of part) expect(result.cells[cell.receiptKey].shopifyWrite?.token).toBe(shopifyCellToken(workspace, cell.ownerId, field, undefined, f.aliasKey))
    }
    const draft = (await stored(f))._nexusLinkedProducts
    expect(draft.sheetValues).toHaveLength(2001)
    expect(new Map(draft.sheetValues.map((value: any) => [value.ownerId, value.value]))).toEqual(new Map(original.map(cell => [cell.ownerId, cell.value])))
    const rootId = (await root(f)).id
    expect((await receipts()).filter(row => (row.response as any)?.root?.id === rootId)).toHaveLength(1)
    const proof = await proofFor(f)
    expect(proof.response).toMatchObject({ version: 1, root: { id: (await root(f)).id, createdAt: (await root(f)).createdAt.toISOString() } })
    expect(await inside(() => database.client.auditLog.count({ where: { entityId: rootId, action: 'shopify.draft.cells.saved' } }))).toBe(3)
  }, 120_000)

  it('does not transfer absence tokens to another action or actor, and retains independent cells after a lost answer', async () => {
    const f = await fixture(), original = await cells(f)
    await save(f, [original[0]]) // Committed response deliberately ignored by the next request.
    expect((await save(f, [original[1]], 'other-action')).cells[original[1].receiptKey].ok).toBe(false)
    expect((await save(f, [original[1]], 'column-action-a', otherActor)).cells[original[1].receiptKey].ok).toBe(false)
    expect((await save(f, [original[0]])).cells[original[0].receiptKey].ok).toBe(false)
    expect((await save(f, [original[1]])).cells[original[1].receiptKey].ok).toBe(true)
    expect((await stored(f))._nexusLinkedProducts.sheetValues).toHaveLength(2)
  })

  it('binds absent aliases, account, family and the real runtime workspace', async () => {
    const a = await fixture(), tokensA = await cells(a), b = await fixture(3, a, 'Second'), tokensB = await cells(b)
    expect(tokensA[0].token).not.toBe(tokensB[0].token)
    await save(a, [tokensA[0]])
    expect((await save(b, [tokensA[1]])).ok).toBe(false)
    const sibling = await fixture(3, { accountId: a.accountId } as Fixture), tokensSibling = await cells(sibling)
    expect(tokensSibling[0].token).not.toBe(tokensA[0].token)
    expect((await save(sibling, [tokensA[1]])).ok).toBe(false)
    const foreign = await fixture(), tokensForeign = await cells(foreign)
    expect(tokensForeign[0].token).not.toBe(tokensA[0].token)
    expect((await save(foreign, [tokensA[1]])).ok).toBe(false)
    expect(await inside(() => database.client.commandReceipt.findMany({ where: { scope: 'shopify-sheet-root-v1' } }), OTHER)).toEqual([])
    await expect(inside(() => saveShopifySheetCells(a.familyId, scope(a), { cells: [tokensA[1]], operationId: 'column-action-a' }, actor), OTHER)).rejects.toThrow(/unavailable/)
  })

  it.each(['id', 'createdAt'] as const)('refuses a replacement physical root with equal data and changed %s', async changed => {
    const f = await fixture(), original = await cells(f)
    await save(f, [original[0]])
    const before = await root(f), existingToken = (await cells(f))[1]
    if (changed === 'id') {
      await inside(() => database.client.channelListing.delete({ where: { id: before.id } }))
      await inside(() => database.client.channelListing.create({ data: { ...before, id: randomUUID(), platformAttributes: before.platformAttributes as any } }))
    } else await database.pool.query('UPDATE "ChannelListing" SET "createdAt"="createdAt"+interval \'1 second\' WHERE id=$1', [before.id])
    expect((await save(f, [original[1]])).ok).toBe(false)
    // Existing-root R1 tokens remain bound to R1's physical ID. The controlled same-ID
    // storage fixture above separately tests the creation proof's timestamp binding.
    if (changed === 'id') expect((await save(f, [existingToken])).ok).toBe(false)
    expect((await stored(f))._nexusLinkedProducts.sheetValues).toHaveLength(1)
  })

  it.each(['pending', 'pin', 'sharing', 'schema'] as const)('refuses a changed current %s without invalidating an independent cell', async changed => {
    const f = await fixture(), original = await cells(f)
    await save(f, [original[0]])
    const listing = await root(f), pa = structuredClone(listing.platformAttributes) as any, draft = pa._nexusLinkedProducts
    if (changed === 'pending') draft.edits.push({ ...provider.rows[1].fields[0], ownerLabel: provider.rows[1].title, nextValue: 'Foreign edit' })
    if (changed === 'pin') draft.sheetValues.push({ ownerId: original[1].ownerId, fieldId: column, type: 'single_line_text_field', locale: '', value: 'Foreign pin' })
    if (changed === 'sharing') draft.sharedFields = [{ namespace: 'custom', key: 'note', sourceProductId: original[0].ownerId, excludedProductIds: [original[2].ownerId], baseline: provider.rows.flatMap(row => row.fields) }]
    if (changed === 'schema') provider.schema.definitions[0].validations = [{ name: 'max', value: '100' }]
    else await inside(() => database.client.channelListing.update({ where: { id: listing.id }, data: { platformAttributes: pa } }))
    expect((await save(f, [original[1]])).ok).toBe(false)
    if (changed === 'pending' || changed === 'pin') expect((await save(f, [original[2]])).ok).toBe(true)
    else expect((await save(f, [original[2]])).ok).toBe(false)
  })

  it.each(['expired', 'deleted', 'malformed', 'public-scope'] as const)('fails closed for a %s proof', async changed => {
    const f = await fixture(), original = await cells(f)
    await save(f, [original[0]])
    const proof = await proofFor(f)
    if (changed === 'deleted') await inside(() => database.client.commandReceipt.delete({ where: { id: proof.id } }))
    else await inside(() => database.client.commandReceipt.update({ where: { id: proof.id }, data: changed === 'expired' ? { expiresAt: new Date(0) } : changed === 'malformed' ? { response: { version: 999 } } : { scope: 'products-bulk-save' } }))
    expect((await save(f, [original[1]])).ok).toBe(false)
    expect((await stored(f))._nexusLinkedProducts.sheetValues).toHaveLength(1)
  })

  it('creates neither root nor proof on total refusal; partial success retains only accepted cells', async () => {
    const f = await fixture(), original = await cells(f), count = (await receipts()).length
    const refused = { ...original[0], token: 'stale' }
    expect((await save(f, [refused])).ok).toBe(false)
    await expect(root(f)).rejects.toThrow()
    expect(await receipts()).toHaveLength(count)
    const partial = await save(f, [refused, original[1]])
    expect(partial.cells[refused.receiptKey].ok).toBe(false)
    expect(partial.cells[original[1].receiptKey].ok).toBe(true)
    expect((await stored(f))._nexusLinkedProducts.sheetValues).toEqual([expect.objectContaining({ ownerId: original[1].ownerId })])
    expect(await receipts()).toHaveLength(count + 1)
  })

  it.each(['root', 'proof'] as const)('rolls back root, proof and audit on a fault after %s insertion', async phase => {
    const f = await fixture(), original = await cells(f), count = (await receipts()).length
    const table = phase === 'root' ? 'CommandReceipt' : 'AuditLog'
    const condition = phase === 'root' ? 'NEW.scope = \'shopify-sheet-root-v1\'' : 'NEW.action = \'shopify.draft.cells.saved\''
    const verify = phase === 'proof' ? `IF NOT EXISTS (SELECT 1 FROM "CommandReceipt" WHERE scope='shopify-sheet-root-v1' AND response->'root'->>'id'=NEW."entityId") THEN RAISE EXCEPTION 'proof-was-not-inserted'; END IF;` : ''
    await database.pool.query(`CREATE FUNCTION pse_root_proof_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${verify} RAISE EXCEPTION 'fault-after-${phase}'; END; $$`)
    await database.pool.query(`CREATE TRIGGER pse_root_proof_fault BEFORE INSERT ON "${table}" FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION pse_root_proof_fault()`)
    try {
      await expect(save(f, [original[0]])).rejects.toThrow(`fault-after-${phase}`)
      await expect(root(f)).rejects.toThrow()
      expect(await receipts()).toHaveLength(count)
      expect(await inside(() => database.client.auditLog.count({ where: { metadata: { path: ['accountId'], equals: f.accountId } } }))).toBe(0)
    } finally {
      await database.pool.query(`DROP TRIGGER pse_root_proof_fault ON "${table}"`)
      await database.pool.query('DROP FUNCTION pse_root_proof_fault()')
    }
  })

  it('never retargets a retained proof after root deletion, including expired action reuse', async () => {
    const f = await fixture(), original = await cells(f)
    await save(f, [original[0]])
    const created = await root(f), proof = await proofFor(f)
    await inside(() => database.client.channelListing.delete({ where: { id: created.id } }))
    await inside(() => database.client.commandReceipt.update({ where: { id: proof.id }, data: { expiresAt: new Date(0) } }))
    await expect(save(f, [original[1]])).rejects.toThrow(/Another editor/)
    await expect(root(f)).rejects.toThrow()
    expect((await inside(() => database.client.commandReceipt.findUniqueOrThrow({ where: { id: proof.id } }))).response).toEqual(proof.response)
    // Removal of all old evidence permits a genuinely new absent-root creation. This
    // bounded proof makes no claim about generations after retention removes evidence.
    await inside(() => database.client.commandReceipt.delete({ where: { id: proof.id } }))
    expect((await save(f, [original[1]], 'fresh-action')).ok).toBe(true)
    expect((await root(f)).id).not.toBe(created.id)
  })

  it('forces competing first-create transactions; only the committed root has usable proof', async () => {
    const f = await fixture(), original = await cells(f), count = (await receipts()).length
    const outcomes = await raceChannelListingInserts(database, [() => save(f, [original[0]], 'race-a'), () => save(f, [original[1]], 'race-b')])
    expect(outcomes.filter(outcome => 'value' in outcome && outcome.value.ok)).toHaveLength(1)
    expect(outcomes.filter(outcome => 'error' in outcome)).toHaveLength(1)
    expect(await receipts()).toHaveLength(count + 1)
    const won = 'value' in outcomes[0] && outcomes[0].value.ok ? 'race-a' : 'race-b'
    expect((await save(f, [original[2]], won === 'race-a' ? 'race-b' : 'race-a')).ok).toBe(false)
    expect((await save(f, [original[2]], won)).ok).toBe(true)
  }, 60_000)
})
