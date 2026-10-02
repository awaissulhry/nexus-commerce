/**
 * MCP full control P8 — save-channel-mapping and save-listing-template, through the doors a person or Claude uses
 * (runOrQueueTool; scheduleApproval + commitScheduledApproval as the Approvals page and the sweep run them), on PGlite
 * with the production schema and business policies. The mapping review, its activation, the revisions and the
 * value-map and size-scale stores are the real ones; nothing reaches a marketplace from here.
 *
 *   preview     the mapping review computed in memory — listings and values that change, examples — and NO row
 *               written by the dry run (no review row, no mapping, no revision)
 *   refusals    another business's market, theme or preset is not found; nothing to change; one kind per request;
 *               a market over the 2,000-listing review bound
 *   run         approved → the stored review counts the same → activated; the revision holds the old rules
 *   stale       the mapping moved after the approval: handed back, nothing activated
 *   undo        restores the revision; refused once the mapping moved since; value maps and size conversions come
 *               back entry by entry; a theme and a preset come back as they were
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

import { runOrQueueTool } from '../approval-gate.service.js'
import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { commitScheduledApproval, scheduleApproval } from '../../agent-fleet/approval-inbox.service.js'
import { getMappingForMarketplace, persistMapping } from '../../pim/schema-mapping.service.js'

const A = LEGACY_WORKSPACE_ID
const B = 'p8_mapping_bravo'
const T = 60_000
const profilesOn = () => process.env.NEXUS_WORKSPACES_ENABLED === '1'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T,>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { approver: '', theme: '', defaultTheme: '', builtInPreset: '', preset: '', bTheme: '', bPreset: '' }

const person = (permissions: Set<string>, workspaceId = A): UserPrincipal => ({
  kind: 'user', userId: ids.approver, label: 'Mia Mapping', permissions: { isOwner: false, permissions }, workspace: business(workspaceId), via: 'claude', oauthGrantId: 'grant-p8',
})
const ALL = (workspaceId = A) => person(EVERYTHING, workspaceId)
const db = () => database.client

async function ask(tool: string, args: Record<string, unknown>, who = ALL()) {
  const workspaceId = who.workspace!.workspaceId
  const run = await inside(() => db().agentRun.create({
    data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: ids.approver, via: 'claude', oauthGrantId: 'grant-p8' },
  }), workspaceId)
  return inside(() => runOrQueueTool(tool, args, who, run.id, { forceAsk: true }), workspaceId)
}
async function approveAndRun(approvalId: string) {
  const parked = await inside(() => scheduleApproval({ id: approvalId, actor: ALL() }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}
async function askAndRun(tool: string, args: Record<string, unknown>) {
  const queued = await ask(tool, args)
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  const ran = await approveAndRun(queued.approvalId!)
  expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
  return queued
}
async function dryRun(tool: string, args: Record<string, unknown>, who = ALL()) {
  try {
    return (await callTool(who, tool, args)).visible
  } catch (error) {
    if (error instanceof ToolAccessError) return { ok: false, refused: error.code, error: error.message }
    throw error
  }
}
const changeOf = (approvalId: string) => inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
const titleRule = async () => (await inside(() => getMappingForMarketplace('EBAY', 'IT'))).fields.title
const counts = () => inside(async () => ({
  reviews: await db().bulkOperation.count(),
  revisions: await db().mappingRevision.count(),
  maps: await db().fieldValueMap.count(),
  scales: await db().sizeScaleMap.count(),
  approvals: await db().agentApproval.count(),
}))
/** Someone else edits the mapping in Nexus (the page's own write). */
async function editMappingElsewhere(source: string) {
  await inside(async () => {
    const current = await getMappingForMarketplace('EBAY', 'IT')
    await persistMapping('EBAY', 'IT', current, { ...current, fields: { ...current.fields, brand: { source } } })
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  const role = await client.role.create({ data: { key: `P8_MAP_${randomUUID().slice(0, 8)}`, name: 'Mapping tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const approver = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Mia Mapping' } })
  ids.approver = approver.id
  await client.userRole.create({ data: { userId: approver.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: 'Bravo mapping business', createdByUserId: approver.id, creationKey: randomUUID() } })
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: approver.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  await inside(async () => {
    await client.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'EBAY_IT',
      schemaMapping: { version: 1, fields: { title: { source: 'name', notes: 'Alpha title rule' } } } } as never })
    await client.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'eBay Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'], marketplaceId: 'EBAY_DE' } as never })
    // No title of their own: the title follows the mapping rule (a listing's own title is pinned and no rule changes it).
    for (const n of [1, 2]) {
      const product = await client.product.create({ data: { sku: `TEST-SKU-P8-${n}`, name: `P8 jacket ${n}`, basePrice: '10.00', categoryAttributes: { color: 'Rosso' } } })
      await client.channelListing.create({ data: { productId: product.id, channelMarket: 'EBAY_IT', channel: 'EBAY', region: 'IT', marketplace: 'IT', price: '10.00', quantity: 1, listingStatus: 'ACTIVE',
        platformAttributes: n === 1 ? { descriptionThemeId: 'set-below' } : {} } })
    }
    ids.theme = (await client.ebayDescriptionTheme.create({ data: { name: 'P8 classic', html: '<div class="p8">{{body}}</div>', notes: 'old notes' } })).id
    ids.defaultTheme = (await client.ebayDescriptionTheme.create({ data: { name: 'P8 default', html: '<div>{{body}}</div>', isDefault: true } })).id
    await client.channelListing.updateMany({ where: { platformAttributes: { path: ['descriptionThemeId'], equals: 'set-below' } }, data: { platformAttributes: { descriptionThemeId: ids.theme } } })
    ids.preset = (await client.wizardTemplate.create({ data: { name: 'P8 jackets preset', channels: [], defaults: {}, usageCount: 4, description: 'Jackets for eBay' } })).id
    ids.builtInPreset = (await client.wizardTemplate.create({ data: { name: 'P8 built-in', channels: [], defaults: {}, builtIn: true } })).id
  })
  await inside(async () => {
    await client.marketplace.create({ data: { channel: 'EBAY', code: 'FR', name: 'eBay France', currency: 'EUR', region: 'EU', language: 'fr', languages: ['fr'], marketplaceId: 'EBAY_FR',
      schemaMapping: { version: 1, fields: { title: { source: 'name', notes: 'BRAVO title rule' } } } } as never })
    ids.bTheme = (await client.ebayDescriptionTheme.create({ data: { name: 'BRAVO theme', html: '<div>{{body}}</div>' } })).id
    ids.bPreset = (await client.wizardTemplate.create({ data: { name: 'BRAVO preset', channels: [], defaults: {} } })).id
  }, B)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

const RULES = { channel: 'EBAY', market: 'IT', rules: [{ fieldKey: 'title', rule: { source: 'sku', notes: 'SKU as the title' } }] }

describe('P8 — save-channel-mapping refuses what it should', { timeout: T }, () => {
  it('a person without pim.manage is refused; a wrongly made call is refused by its schema', async () => {
    expect(await dryRun('save-channel-mapping', RULES, person(new Set([F.aiRun, F.productsView])))).toMatchObject({ refused: 'forbidden' })
    expect(await dryRun('save-channel-mapping', { ...RULES, channel: 'NOPE' })).toMatchObject({ refused: 'invalid_arguments' })
    const tooMany = Array.from({ length: 251 }, (_, i) => ({ attribute: 'color', fromValue: `v${i}`, toValue: 'x' }))
    expect(await dryRun('save-channel-mapping', { channel: 'EBAY', market: 'IT', kind: 'value-map', valueMap: tooMany })).toMatchObject({ refused: 'invalid_arguments' })
  })

  it('a market the business does not have is not found; nothing to change, or two kinds at once, is said', async () => {
    expect(await dryRun('save-channel-mapping', { ...RULES, market: 'ES' })).toEqual({ ok: false, error: 'Market not found' })
    expect(await dryRun('save-channel-mapping', { channel: 'EBAY', market: 'IT', rules: [{ fieldKey: 'title', rule: { source: 'name', notes: 'Alpha title rule' } }] }))
      .toEqual({ ok: false, error: 'Not changed: these rules are already the mapping.' })
    expect((await dryRun('save-channel-mapping', { ...RULES, valueMap: [{ attribute: 'color', fromValue: 'Rosso', toValue: 'Red' }] }) as { error: string }).error)
      .toMatch(/one kind of change per request/)
    expect(await dryRun('save-channel-mapping', { channel: 'EBAY', market: 'IT', restoreRevisionId: 'no-such-revision' })).toEqual({ ok: false, error: 'Mapping revision not found' })
  })

  it.runIf(profilesOn())('another business’s market, revision, theme and preset are not found, and nothing is queued', async () => {
    const before = await counts()
    for (const [tool, args, error] of [
      ['save-channel-mapping', { ...RULES, market: 'FR' }, 'Market not found'],
      ['save-listing-template', { themeId: ids.bTheme, name: 'x' }, 'Description theme not found'],
      ['save-listing-template', { presetId: ids.bPreset, name: 'x' }, 'Listing preset not found'],
    ] as const) {
      const queued = await ask(tool, args)
      expect(queued).toMatchObject({ ok: false })
      expect(queued.error).toContain(error)
    }
    expect(await counts()).toEqual(before)
    // Control: inside B the same market is found and reviewed.
    const own = await dryRun('save-channel-mapping', { ...RULES, market: 'FR' }, ALL(B)) as { ok: boolean; preview: { changes: Array<{ from: { notes: string } }> } }
    expect(own.ok).toBe(true)
    expect(own.preview.changes[0].from.notes).toBe('BRAVO title rule')
  })

  it('a market with more listings than Claude reviews in one request is refused with the reason, before scanning', async () => {
    await inside(async () => {
      await db().product.createMany({ data: Array.from({ length: 2001 }, (_, i) => ({ sku: `TEST-SKU-P8-BULK-${i}`, name: `Bulk ${i}`, basePrice: '1.00' })) })
      const products = await db().product.findMany({ where: { sku: { startsWith: 'TEST-SKU-P8-BULK-' } }, select: { id: true } })
      await db().channelListing.createMany({ data: products.map((p) => ({ productId: p.id, channelMarket: 'EBAY_DE', channel: 'EBAY', region: 'DE', marketplace: 'DE', title: 'x', price: '1.00', quantity: 1 })) })
    })
    const before = await counts()
    const refused = await dryRun('save-channel-mapping', { ...RULES, market: 'DE' }) as { ok: boolean; error: string }
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/covers 2001 listings .*more than Claude reviews in one conversation \(2000 listings.*mapping review/)
    expect(await counts()).toEqual(before)
    await inside(async () => {
      await db().channelListing.deleteMany({ where: { marketplace: 'DE' } })
      await db().product.updateMany({ where: { sku: { startsWith: 'TEST-SKU-P8-BULK-' } }, data: { deletedAt: new Date() } })
    })
  })
})

describe('P8 — save-channel-mapping: the review, the run and the undo', { timeout: T }, () => {
  it('the dry run gives the review’s numbers and examples and writes nothing', async () => {
    const before = await counts()
    const result = await dryRun('save-channel-mapping', RULES) as { ok: boolean; preview: Record<string, any> }
    expect(result.ok).toBe(true)
    expect(result.preview).toMatchObject({
      action: 'save-channel-mapping', kind: 'rules', channel: 'EBAY', market: 'IT',
      changes: [{ field: 'title', category: null, from: { source: 'name', notes: 'Alpha title rule' }, to: { source: 'sku', notes: 'SKU as the title' } }],
      impact: { listingsInMarket: 2, listingsChanged: 2, valuesChanged: expect.any(Number), overridesKept: 0 },
      basis: { token: expect.any(String), inputToken: expect.any(String) },
    })
    expect(result.preview.impact.valuesChanged).toBeGreaterThanOrEqual(2)
    expect(result.preview.examples).toEqual(expect.arrayContaining([expect.objectContaining({ sku: 'TEST-SKU-P8-1', field: 'title', from: 'P8 jacket 1', to: 'TEST-SKU-P8-1' })]))
    expect(await counts()).toEqual(before)
    expect((await titleRule())?.source).toBe('name')
  })

  it('approved: the stored review counts the same, it is activated, the revision keeps the old rules; undo restores them', async () => {
    const queued = await askAndRun('save-channel-mapping', RULES)
    expect((await titleRule())?.source).toBe('sku')
    const change = await changeOf(queued.approvalId!)
    expect(change).toMatchObject({ toolName: 'save-channel-mapping', reversibility: 'full', before: { channel: 'EBAY', market: 'IT', kind: 'rules', fields: ['title'] } })
    const restoreRevisionId = (change.before as { restoreRevisionId: string }).restoreRevisionId
    const revision = await inside(() => db().mappingRevision.findUniqueOrThrow({ where: { id: restoreRevisionId } }))
    expect((revision.snapshot as unknown as { fields: { title: { source: string } } }).fields.title.source).toBe('name')

    const undo = await ask('undo-change', { changeId: change.id })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued', undoes: change.id })
    expect(undo.preview).toMatchObject({ kind: 'restore', changes: [{ field: 'title', from: { source: 'sku' }, to: { source: 'name' } }] })
    expect((await titleRule())?.source).toBe('sku') // nothing yet: a person approves the undo
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await titleRule()).toEqual({ source: 'name', notes: 'Alpha title rule' })
    expect((await changeOf(queued.approvalId!)).undoneAt).toBeInstanceOf(Date)
  })

  it('stale: the mapping moved after the approval — handed back, nothing activated', async () => {
    const queued = await ask('save-channel-mapping', RULES)
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    await editMappingElsewhere('brand')
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran).toMatchObject({ ok: false })
    expect(ran.error).toMatch(/moved|stale|changed/i)
    expect((await titleRule())?.source).toBe('name')
  })

  it('undo is refused once the mapping moved since the change; nothing is queued', async () => {
    const queued = await askAndRun('save-channel-mapping', { channel: 'EBAY', market: 'IT', rules: [{ fieldKey: 'title', rule: { source: 'sku' } }] })
    const change = await changeOf(queued.approvalId!)
    await editMappingElsewhere('manufacturer')
    const before = await counts()
    const undo = await ask('undo-change', { changeId: change.id })
    expect(undo).toMatchObject({ ok: false })
    expect(undo.error).toContain('changed since')
    expect(await counts()).toEqual(before)
  })

  it('value translations: preview, run, undo removes the one it added and puts back the one it replaced', async () => {
    await inside(() => db().fieldValueMap.create({ data: { channel: 'EBAY', marketplace: 'IT', attribute: 'color', fromValue: 'Blu', toValue: 'Navy' } }))
    const args = { channel: 'EBAY', market: 'IT', kind: 'value-map', valueMap: [{ attribute: 'color', fromValue: 'Rosso', toValue: 'Red' }, { attribute: 'color', fromValue: 'Blu', toValue: 'Blue' }] }
    const result = await dryRun('save-channel-mapping', args) as { ok: boolean; preview: Record<string, any> }
    expect(result.preview).toMatchObject({
      kind: 'value-map',
      changes: [{ attribute: 'color', fromValue: 'Rosso', from: null, to: 'Red' }, { attribute: 'color', fromValue: 'Blu', from: 'Navy', to: 'Blue' }],
      impact: { listingsWithTheseValues: 2 },
    })
    const queued = await askAndRun('save-channel-mapping', args)
    const maps = () => inside(() => db().fieldValueMap.findMany({ where: { attribute: 'color' }, orderBy: { fromValue: 'asc' }, select: { fromValue: true, toValue: true } }))
    expect(await maps()).toEqual([{ fromValue: 'Blu', toValue: 'Blue' }, { fromValue: 'Rosso', toValue: 'Red' }])
    const undo = await ask('undo-change', { approvalId: queued.approvalId })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await maps()).toEqual([{ fromValue: 'Blu', toValue: 'Navy' }])
  })

  it('size conversions: run and undo', async () => {
    const args = { channel: 'EBAY', market: 'IT', kind: 'size-scale', sizeScale: [{ scale: 'jackets', fromSystem: 'eu', toSystem: 'uk', fromValue: '52', toValue: 'L' }] }
    const result = await dryRun('save-channel-mapping', args) as { ok: boolean; preview: Record<string, any> }
    expect(result.preview).toMatchObject({ kind: 'size-scale', changes: [{ scale: 'JACKETS', fromSystem: 'EU', toSystem: 'UK', fromValue: '52', from: null, to: 'L' }] })
    const queued = await askAndRun('save-channel-mapping', args)
    expect(await inside(() => db().sizeScaleMap.count())).toBe(1)
    const undo = await ask('undo-change', { approvalId: queued.approvalId })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await inside(() => db().sizeScaleMap.count())).toBe(0)
  })
})

describe('P8 — save-listing-template', { timeout: T }, () => {
  it('needs listings.publish; edits only', async () => {
    expect(await dryRun('save-listing-template', { themeId: ids.theme, name: 'x' }, person(new Set([F.aiRun, F.pimManage])))).toMatchObject({ refused: 'forbidden' })
    expect((await dryRun('save-listing-template', { kind: 'description-theme', name: 'New theme' }) as { error: string }).error).toMatch(/New themes are created in Nexus/)
    expect((await dryRun('save-listing-template', { presetId: ids.builtInPreset, name: 'Mine' }) as { error: string }).error).toMatch(/built-in presets are read-only/)
    expect((await dryRun('save-listing-template', { themeId: ids.defaultTheme, active: false }) as { error: string }).error).toMatch(/default theme/)
  })

  it('a theme: the listings it wraps, the change, the run and the undo', async () => {
    const before = await counts()
    const result = await dryRun('save-listing-template', { themeId: ids.theme, html: '<section>{{body}}</section>', notes: null }) as { ok: boolean; preview: Record<string, any> }
    expect(result.preview).toMatchObject({
      kind: 'description-theme', theme: 'P8 classic',
      changes: { notes: { from: 'old notes', to: null }, htmlLength: expect.any(Object), htmlHash: expect.any(Object) },
      newHtmlStart: '<section>{{body}}</section>',
      impact: { assignedListings: 1, listingsUsingTheDefault: 0 },
      basis: { version: 1 },
    })
    expect(await counts()).toEqual(before)
    const queued = await askAndRun('save-listing-template', { themeId: ids.theme, html: '<section>{{body}}</section>', notes: null })
    const theme = () => inside(() => db().ebayDescriptionTheme.findUniqueOrThrow({ where: { id: ids.theme } }))
    expect(await theme()).toMatchObject({ html: '<section>{{body}}</section>', notes: null, version: 2 })
    const undo = await ask('undo-change', { approvalId: queued.approvalId })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await theme()).toMatchObject({ html: '<div class="p8">{{body}}</div>', notes: 'old notes', version: 3 })
  })

  it('a theme edited after the approval is handed back; a preset: run and undo', async () => {
    const queued = await ask('save-listing-template', { themeId: ids.theme, name: 'P8 renamed' })
    await inside(() => db().ebayDescriptionTheme.update({ where: { id: ids.theme }, data: { notes: 'someone else', version: { increment: 1 } } }))
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran).toMatchObject({ ok: false })
    expect((await inside(() => db().ebayDescriptionTheme.findUniqueOrThrow({ where: { id: ids.theme } }))).name).toBe('P8 classic')

    const preview = await dryRun('save-listing-template', { presetId: ids.preset, description: '', categoryHint: 'OUTERWEAR' }) as { preview: Record<string, any> }
    expect(preview.preview).toMatchObject({ kind: 'preset', changes: { description: { from: 'Jackets for eBay', to: null }, categoryHint: { from: null, to: 'OUTERWEAR' } }, impact: { timesApplied: 4, listingsFollowingIt: 0 } })
    const done = await askAndRun('save-listing-template', { presetId: ids.preset, description: '', categoryHint: 'OUTERWEAR' })
    const preset = () => inside(() => db().wizardTemplate.findUniqueOrThrow({ where: { id: ids.preset } }))
    expect(await preset()).toMatchObject({ description: null, categoryHint: 'OUTERWEAR' })
    const undo = await ask('undo-change', { approvalId: done.approvalId })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await preset()).toMatchObject({ description: 'Jackets for eBay', categoryHint: null })
  })
})
