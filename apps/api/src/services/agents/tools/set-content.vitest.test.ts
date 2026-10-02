/**
 * MCP full control T5 (docs/mcp-full-control/sections/03-content.md §3, §6 step 5; the Owner's d7, d8) — `set-content`
 * changes one product's shared text in one language, through the doors a person and Claude use (runOrQueueTool,
 * scheduleApproval + commitScheduledApproval, checkStaleness), on PostgreSQL with the production schema (PGlite). The
 * product writer, the content door and the cascade are real.
 *
 *   source    the primary language (it) writes the product's own text: version moved, audit row as the approver with
 *             the reason mcp:set-content, the following listings' follow markers moved, 0 channel updates queued (d7)
 *   language  any other language writes the shared translation row: reviewed (d8), source manual, sourceModel
 *             "claude-mcp"; the product's own text untouched
 *   preview   from → to with the English meaning (required unless English), reach (listings that follow vs those with
 *             their own pin), the glossary's avoid words, the writer's verdict; refused when nothing changes
 *   stale     text moved after the preview → stale, and the run writes nothing
 *   reset     drops a language's own text: it shows the source again
 *   attribute a translatable attribute per language; one kept once for every language is refused
 *   undo      a new set-content that puts the old text back (or drops what was not there)
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
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
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
  const out = await ask('set-content', args)
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
  return (await inside(() => callTool(who, 'set-content', args))).visible as { ok: boolean; error?: string; preview?: Data }
}
const productOf = (id: string) => inside(() => db().product.findUniqueOrThrow({ where: { id }, include: { translations: true } }))
const german = async (id: string) => (await productOf(id)).translations.find((row) => row.language === 'de')
const queueRows = (ids: string[]) => inside(() => db().outboundSyncQueue.count({ where: { productId: { in: ids } } }))

/** A jacket family: the parent on Amazon IT (follows), Amazon DE (its own German title, a pin) and eBay DE (follows); a variation on Amazon DE (follows). */
async function seed(sku: string) {
  return inside(async () => {
    const family = await db().productFamily.findFirstOrThrow({ where: { code: 'test-content-jackets' } })
    const parent = await db().product.create({ data: {
      sku, name: `${sku} giacca`, basePrice: '100.00', isParent: true, familyId: family.id, brand: 'Test Brand',
      description: 'Giacca da moto in pelle.', bulletPoints: ['Pelle'], keywords: ['giacca'], status: 'ACTIVE',
    } })
    const child = await db().product.create({ data: { sku: `${sku}-S`, name: `${sku} giacca S`, basePrice: '100.00', parentId: parent.id, familyId: family.id, status: 'ACTIVE' } })
    const listing = (productId: string, channel: string, market: string, account: string) => db().channelListing.create({ data: {
      productId, channel, marketplace: market, region: 'EU', channelMarket: `${channel}_${market}`, channelConnectionId: account, aliasKey: '',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `FIXTURE-${channel}-${market}-${productId}`, syncPaused: false,
      followMasterTitle: true, lastSyncStatus: 'SUCCESS', lastSyncedAt: new Date('2026-09-30T10:00:00Z'),
    } as never })
    const amazonIt = await listing(parent.id, 'AMAZON', 'IT', accounts.amazon)
    const amazonDe = await listing(parent.id, 'AMAZON', 'DE', accounts.amazon)
    await listing(parent.id, 'EBAY', 'DE', accounts.ebay)
    await listing(child.id, 'AMAZON', 'DE', accounts.amazon)
    await db().channelListingTranslation.create({ data: { channelListingId: amazonDe.id, language: 'de', name: 'Amazon-Titel', source: 'manual', reviewedAt: new Date() } })
    return { parent, child, amazonIt }
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const role = await db().role.create({ data: { key: `T5_EDITOR_${randomUUID().slice(0, 8)}`, name: 'Editor', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const user = await db().userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Content approver' } })
  approverId = user.id
  await db().userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await db().workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  await db().workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  await inside(async () => {
    for (const [channel, code, language] of [['AMAZON', 'IT', 'it'], ['AMAZON', 'DE', 'de'], ['EBAY', 'DE', 'de']] as const) {
      await db().marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language, languages: [language], marketplaceId: `TEST_${channel}_${code}` } as never })
    }
    accounts.amazon = (await db().channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 't5-amazon', isActive: true, isPrimary: true, externalAccountId: 'SELLER-TEST-T5' } as never })).id
    accounts.ebay = (await db().channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 't5-ebay', isActive: true, isPrimary: true, externalAccountId: 'EBAY-TEST-T5' } as never })).id
    // The family's attributes: a translatable care note, and a fit kept once for every language.
    const group = await db().attributeGroup.create({ data: { code: 't5', label: 'Specifications' } })
    const care = await db().customAttribute.create({ data: { code: 'care_note', label: 'Care note', groupId: group.id, type: 'text', localizable: true } })
    const washing = await db().customAttribute.create({ data: { code: 'washing', label: 'Washing', groupId: group.id, type: 'text', localizable: true } })
    const fit = await db().customAttribute.create({ data: { code: 'fit', label: 'Fit', groupId: group.id, type: 'text' } })
    const family = await db().productFamily.create({ data: { code: 'test-content-jackets', label: 'Jackets' } })
    for (const attributeId of [care.id, washing.id, fit.id]) await db().familyAttribute.create({ data: { familyId: family.id, attributeId, channels: [] } })
    // The glossary: in German, Jacke — not Blouson.
    await db().terminologyPreference.create({ data: { brand: null, marketplace: 'DE', language: 'de', preferred: 'Jacke', avoid: ['Blouson'], context: 'Say Jacke.' } })
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('T5 — set-content, the primary language: the source text', { timeout: 30_000 }, () => {
  it('approved: version moved, audit row as the approver (mcp:set-content), follow marker cascaded; 0 channel updates', async () => {
    const { parent, child, amazonIt } = await seed('TEST-SKU-T5-SOURCE')
    const { approvalId, preview: p } = await queued({ product: parent.sku, language: 'it', title: 'Giacca da moto nuova', englishMeaning: { title: 'New motorcycle jacket' } })
    expect(p).toMatchObject({
      action: 'set-content', productId: parent.id, language: 'it', layer: 'source',
      changes: { title: { from: 'TEST-SKU-T5-SOURCE giacca', to: 'Giacca da moto nuova', englishMeaning: 'New motorcycle jacket' } },
      reach: { title: { follow: ['Amazon · IT · TEST-SKU-T5-SOURCE'], ownPin: [] } },
      basis: expect.any(String),
    })
    expect(await inside(() => checkStaleness(approvalId))).toEqual({ stale: false, why: null })

    const ran = await approveAndRun(approvalId)
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    const after = await productOf(parent.id)
    expect(after).toMatchObject({ name: 'Giacca da moto nuova', description: 'Giacca da moto in pelle.', version: parent.version + 1 })
    const audit = await inside(() => db().auditLog.findFirst({ where: { entityType: 'Product', entityId: parent.id }, orderBy: { createdAt: 'desc' } }))
    expect(audit).toMatchObject({ userId: approverId, metadata: expect.objectContaining({ layer: 'master', reason: 'mcp:set-content' }) })
    // d7 — Nexus only: the following listing takes the follow marker, nothing is queued, it does not read "Pending".
    expect(await queueRows([parent.id, child.id])).toBe(0)
    expect(await inside(() => db().channelListingTranslation.findFirst({ where: { channelListingId: amazonIt.id, language: 'it' } }))).toMatchObject({ follows: ['title'] })
    expect(await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: amazonIt.id } }))).toMatchObject({ lastSyncStatus: 'SUCCESS' })
    // The change record: what the source stored before and after.
    expect(await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))).toMatchObject({
      toolName: 'set-content', reversibility: 'full', outbound: false,
      before: { productId: parent.id, language: 'it', tier: 'source', fields: { title: { value: 'TEST-SKU-T5-SOURCE giacca' } } },
      after: { productId: parent.id, language: 'it', tier: 'source', fields: { title: { value: 'Giacca da moto nuova' } } },
    })
  })
})

describe('T5 — set-content, another language: the shared translation', { timeout: 30_000 }, () => {
  it('reviewed, source manual, sourceModel claude-mcp; reach: who follows the German text and who keeps a pin', async () => {
    const { parent, child } = await seed('TEST-SKU-T5-DE')
    const { approvalId, preview: p } = await queued({
      product: parent.id, language: 'de', title: 'Motorradjacke aus Leder', description: 'Eine Lederjacke.',
      englishMeaning: { title: 'Leather motorcycle jacket', description: 'A leather jacket.' },
    })
    expect(p.layer).toBe('language')
    // No German text yet: the fields show the Italian source, and say so.
    expect(p.changes.title).toEqual({ from: 'TEST-SKU-T5-DE giacca', fromLanguage: 'it', to: 'Motorradjacke aus Leder', englishMeaning: 'Leather motorcycle jacket' })
    expect(p.reach.title).toEqual({ follow: ['Amazon · DE · TEST-SKU-T5-DE-S', 'eBay · DE · TEST-SKU-T5-DE'], ownPin: ['Amazon · DE · TEST-SKU-T5-DE'] })
    // Italian listings do not show German text.
    expect(JSON.stringify(p.reach)).not.toContain('IT ·')

    expect(await approveAndRun(approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await german(parent.id)).toMatchObject({ name: 'Motorradjacke aus Leder', description: 'Eine Lederjacke.', source: 'manual', sourceModel: 'claude-mcp', version: 1 })
    expect((await german(parent.id))!.reviewedAt).toBeInstanceOf(Date)
    expect(await productOf(parent.id)).toMatchObject({ name: 'TEST-SKU-T5-DE giacca', description: 'Giacca da moto in pelle.' })
    expect(await queueRows([parent.id, child.id])).toBe(0)
    const audit = await inside(() => db().auditLog.findFirst({ where: { entityType: 'Product', entityId: parent.id, metadata: { path: ['layer'], equals: 'language' } }, orderBy: { createdAt: 'desc' } }))
    expect(audit).toMatchObject({ userId: approverId, metadata: expect.objectContaining({ reason: 'mcp:set-content', language: 'de' }) })
  })

  it('the English meaning is required unless the text is English; one for a field not set is refused', async () => {
    const { parent } = await seed('TEST-SKU-T5-MEANING')
    expect(await preview({ product: parent.id, language: 'de', title: 'Jacke' })).toMatchObject({ ok: false, error: expect.stringMatching(/^englishMeaning is required for title/) })
    expect(await preview({ product: parent.id, language: 'de', title: 'Jacke', englishMeaning: { title: 'Jacket', description: 'x' } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/englishMeaning names description/) })
    expect(await preview({ product: parent.id, language: 'en', title: 'Motorcycle jacket' })).toMatchObject({ ok: true, preview: { changes: { title: { to: 'Motorcycle jacket' } } } })
    // The primary language too: the person reads English.
    expect(await preview({ product: parent.id, language: 'it', title: 'Giacca' })).toMatchObject({ ok: false, error: expect.stringMatching(/englishMeaning is required/) })
  })

  it('refused when nothing changes; the glossary\'s avoid words are flagged', async () => {
    const { parent } = await seed('TEST-SKU-T5-SAME')
    expect(await preview({ product: parent.id, language: 'it', title: 'TEST-SKU-T5-SAME giacca', englishMeaning: { title: 'jacket' } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^Nothing to change: title already says that in it/) })
    const out = await preview({ product: parent.id, language: 'de', title: 'Blouson aus Leder', englishMeaning: { title: 'Leather blouson' } })
    expect(out.preview?.glossaryHits).toEqual([{ field: 'title', avoid: 'Blouson', use: 'Jacke', context: 'Say Jacke.' }])
  })

  it('stale when the text moved after the preview: the approval is stale and the run writes nothing', async () => {
    const { parent } = await seed('TEST-SKU-T5-STALE')
    const { approvalId } = await queued({ product: parent.id, language: 'it', description: 'Nuova descrizione.', englishMeaning: { description: 'New description.' } })
    // Someone edits the description in the sheet meanwhile.
    await inside(() => db().product.update({ where: { id: parent.id }, data: { description: 'Edited in the sheet.' } }))
    expect((await inside(() => checkStaleness(approvalId))).stale).toBe(true)
    const ran = await approveAndRun(approvalId)
    expect(ran.status).not.toBe('executed')
    expect((await productOf(parent.id)).description).toBe('Edited in the sheet.')
    expect(MATERIAL_PREVIEW_FIELDS['set-content']).toEqual(['changes', 'reach', 'basis'])
  })
})

describe('T5 — reset, attributes, undo, permissions', { timeout: 30_000 }, () => {
  it('reset drops the language\'s own text: it shows the source again', async () => {
    const { parent } = await seed('TEST-SKU-T5-RESET')
    await inside(() => db().productTranslation.create({ data: { productId: parent.id, language: 'de', name: 'Jacke', description: 'Alte Beschreibung.', source: 'manual', reviewedAt: new Date() } }))
    const { approvalId, preview: p } = await queued({ product: parent.id, language: 'de', reset: ['description'] })
    expect(p.changes.description).toEqual({ from: 'Alte Beschreibung.', to: null, reset: true, thenShows: 'Giacca da moto in pelle.', thenShowsLanguage: 'it' })
    expect(await approveAndRun(approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await german(parent.id)).toMatchObject({ name: 'Jacke', description: null })
    // Nothing to reset any more.
    expect(await preview({ product: parent.id, language: 'de', reset: ['description'] })).toMatchObject({ ok: false, error: expect.stringMatching(/^Nothing to change/) })
    expect(await preview({ product: parent.id, language: 'it', reset: ['description'] })).toMatchObject({ ok: false, error: expect.stringMatching(/^reset drops/) })
  })

  it('a translatable attribute per language; an attribute kept once for every language is refused', async () => {
    const { parent } = await seed('TEST-SKU-T5-ATTR')
    // Two attributes, named in the order jsonb does NOT keep (it stores shorter keys first): the stored approval must
    // still re-check as the same plan.
    const { approvalId, preview: p } = await queued({ product: parent.id, language: 'de', attributes: { care_note: 'Nur Handwäsche.', washing: '30 Grad' }, englishMeaning: { care_note: 'Hand wash only.', washing: '30 degrees' } })
    expect(p.changes.care_note).toMatchObject({ to: 'Nur Handwäsche.', englishMeaning: 'Hand wash only.' })
    expect(await inside(() => checkStaleness(approvalId))).toEqual({ stale: false, why: null })
    expect(await approveAndRun(approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await german(parent.id))!.attributes).toMatchObject({ care_note: 'Nur Handwäsche.', washing: '30 Grad' })
    expect(await preview({ product: parent.id, language: 'de', attributes: { fit: 'Schmal' }, englishMeaning: { fit: 'Slim' } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^fit is not translatable text/) })
  })

  it('undo asks for a new set-content that puts the old text back, and drops what was not there', async () => {
    const { parent } = await seed('TEST-SKU-T5-UNDO')
    const first = await queued({ product: parent.id, language: 'de', title: 'Neue Jacke', englishMeaning: { title: 'New jacket' } })
    expect(await approveAndRun(first.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await german(parent.id))!.name).toBe('Neue Jacke')
    const undo = await ask('undo-change', { approvalId: first.approvalId })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    const request = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: undo.approvalId! } }))
    expect(request).toMatchObject({ toolName: 'set-content', args: { product: parent.id, language: 'de', reset: ['title'] } })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    // There was no German row before the change: the undo puts back "no row", never an empty one.
    expect(await german(parent.id)).toBeUndefined()
  })

  // Found in the local end-to-end run (2026-10-02): undoing a set-content in en, on a product with no en row, left an
  // empty en row behind.
  it('undo of a change that created the language row removes it; a row that keeps other text stays', async () => {
    const { parent } = await seed('TEST-SKU-T5-UNDO-EN')
    const english = async () => (await productOf(parent.id)).translations.find((row) => row.language === 'en')
    expect(await english()).toBeUndefined()
    const first = await queued({ product: parent.id, language: 'en', keywords: ['test keyword'] })
    expect(await approveAndRun(first.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await english())!.keywords).toEqual(['test keyword'])
    const undo = await ask('undo-change', { approvalId: first.approvalId })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await english()).toBeUndefined()
    // The product's own text is untouched, and the removal is audited as Claude's change.
    expect(await productOf(parent.id)).toMatchObject({ keywords: ['giacca'], name: 'TEST-SKU-T5-UNDO-EN giacca' })
    const audits = await inside(() => db().auditLog.findMany({ where: { entityId: parent.id, entityType: 'Product' }, orderBy: { createdAt: 'asc' } }))
    expect(audits.at(-1)).toMatchObject({ userId: approverId, after: { removed: true }, metadata: { language: 'en', intent: 'remove', reason: 'mcp:set-content' } })

    // A row that holds other text keeps it: only the field the change set goes.
    await inside(() => db().productTranslation.create({ data: { productId: parent.id, language: 'en', name: 'Test jacket', source: 'manual', reviewedAt: new Date() } }))
    const second = await queued({ product: parent.id, language: 'en', keywords: ['another keyword'] })
    expect(await approveAndRun(second.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const again = await ask('undo-change', { approvalId: second.approvalId })
    expect(await approveAndRun(again.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await english()).toMatchObject({ name: 'Test jacket', keywords: [] })
  })

  it('undo restores an empty source field as no value (null), not as an empty text', async () => {
    const empty = await inside(() => db().product.create({ data: { sku: 'TEST-SKU-T5-EMPTY', name: 'Giacca vuota', basePrice: '10.00', description: null } }))
    const first = await queued({ product: empty.id, language: 'it', description: 'Ora una descrizione.', englishMeaning: { description: 'Now a description.' } })
    expect(await approveAndRun(first.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await productOf(empty.id)).description).toBe('Ora una descrizione.')
    const undo = await ask('undo-change', { approvalId: first.approvalId })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect((await productOf(empty.id)).description).toBeNull()
  })

  it('needs products.translations.edit; a deleted product is not found', async () => {
    const { parent } = await seed('TEST-SKU-T5-PERM')
    const noTranslations = person(new Set([...EVERYTHING].filter((p) => p !== F.productsTranslationsEdit)))
    await expect(inside(() => callTool(noTranslations, 'set-content', { product: parent.id, language: 'de', title: 'Jacke', englishMeaning: { title: 'Jacket' } })))
      .rejects.toBeInstanceOf(ToolAccessError)
    await inside(() => db().product.update({ where: { id: parent.id }, data: { deletedAt: new Date() } }))
    expect(await preview({ product: parent.sku, language: 'de', title: 'Jacke', englishMeaning: { title: 'Jacket' } })).toEqual({ ok: false, error: 'Product not found' })
  })
})
