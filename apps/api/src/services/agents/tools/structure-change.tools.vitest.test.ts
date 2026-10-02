/**
 * MCP full control P8 — save-attribute, save-product-family and save-category: catalog structure changes Claude may ask
 * for, each approved by a person (at most "confirm", never auto), each with the number of products it touches, each
 * undoable. Proven through the doors a person or Claude uses (runOrQueueTool, scheduleApproval +
 * commitScheduledApproval, undo-change), on PGlite with the production schema and business policies.
 *
 *   dry run    names the rows, says from → to and the impact count, and writes nothing
 *   run        an approved change is written through the same service the settings pages use, and recorded
 *   stale      a fact the person approved (a from-value, an impact count) moved before it ran: handed back, nothing written
 *   undo       undo-change asks for the opposite change through the same gate; approved, the old state is back
 *   refusals   no pim.manage; delete of what is used; a child re-declaring an ancestor's attribute; a cycle; another
 *              business's rows are not found
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
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const B = 'p8_structure_bravo'
const TIMEOUT = 30_000
const profilesOn = () => process.env.NEXUS_WORKSPACES_ENABLED === '1'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = {
  approver: '', group: '', groupEmpty: '', size: '', fit: '', colour: '', red: '', lining: '',
  apparel: '', jackets: '', other: '', p1: '', p2: '', root: '', shoes: '', boots: '', bravoAttr: '', bravoFamily: '', bravoCategory: '',
}

const person = (permissions: Set<string>, extra: Partial<UserPrincipal> = {}): UserPrincipal => ({
  kind: 'user', userId: ids.approver, label: 'Petra Structure', permissions: { isOwner: false, permissions }, workspace: business(A), via: 'claude', ...extra,
})
const ALL = () => person(EVERYTHING)
const db = () => database.client
type Data = Record<string, any>

async function ask(tool: string, args: Record<string, unknown>, who = ALL(), workspaceId = A) {
  const run = await inside(() => db().agentRun.create({
    data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: ids.approver, via: who.via, oauthGrantId: null },
  }), workspaceId)
  return inside(() => runOrQueueTool(tool, args, { ...who, workspace: business(workspaceId) }, run.id, { forceAsk: true }), workspaceId)
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
  return { approvalId: queued.approvalId!, preview: queued.preview as Data }
}
const changeOf = (approvalId: string) => inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
async function undo(approvalId: string) {
  const change = await changeOf(approvalId)
  const asked = await ask('undo-change', { changeId: change.id })
  expect(asked, asked.error).toMatchObject({ ok: true, mode: 'queued' })
  const ran = await approveAndRun(asked.approvalId!)
  expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
  return asked.preview as Data
}
const counts = () => inside(async () => ({
  attributes: await db().customAttribute.count(), options: await db().attributeOption.count(), groups: await db().attributeGroup.count(),
  families: await db().productFamily.count(), familyAttributes: await db().familyAttribute.count(), categories: await db().category.count(),
}))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  const role = await client.role.create({
    data: { key: `P8_STRUCTURE_${randomUUID().slice(0, 8)}`, name: 'Structure tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const approver = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Petra Structure' } })
  ids.approver = approver.id
  await client.userRole.create({ data: { userId: approver.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: 'Bravo structure business', createdByUserId: approver.id, creationKey: randomUUID() } })
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: approver.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  await inside(async () => {
    ids.group = (await client.attributeGroup.create({ data: { code: 'p8_general', label: 'General' } })).id
    ids.groupEmpty = (await client.attributeGroup.create({ data: { code: 'p8_spare', label: 'Spare' } })).id
    ids.size = (await client.customAttribute.create({ data: { code: 'p8_size', label: 'Size', groupId: ids.group, type: 'text' } })).id
    ids.fit = (await client.customAttribute.create({ data: { code: 'p8_fit', label: 'Fit', groupId: ids.group, type: 'text' } })).id
    ids.lining = (await client.customAttribute.create({ data: { code: 'p8_lining', label: 'Lining', groupId: ids.group, type: 'text' } })).id
    ids.colour = (await client.customAttribute.create({ data: { code: 'p8_colour', label: 'Colour', groupId: ids.group, type: 'select' } })).id
    ids.red = (await client.attributeOption.create({ data: { attributeId: ids.colour, code: 'red', label: 'Red' } })).id
    ids.apparel = (await client.productFamily.create({ data: { code: 'p8_apparel', label: 'Apparel' } })).id
    ids.jackets = (await client.productFamily.create({ data: { code: 'p8_jackets', label: 'Jackets', parentFamilyId: ids.apparel } })).id
    ids.other = (await client.productFamily.create({ data: { code: 'p8_other', label: 'Other' } })).id
    await client.familyAttribute.create({ data: { familyId: ids.apparel, attributeId: ids.size, required: true } })
    // Two jackets: one has a fit, one does not. Both have a size (inherited from Apparel, required).
    ids.p1 = (await client.product.create({ data: { sku: 'TEST-SKU-P8-1', name: 'Jacket one', basePrice: '10.00', familyId: ids.jackets, categoryAttributes: { p8_size: 'M', p8_fit: 'regular', p8_colour: 'red' } } })).id
    ids.p2 = (await client.product.create({ data: { sku: 'TEST-SKU-P8-2', name: 'Jacket two', basePrice: '10.00', familyId: ids.jackets, categoryAttributes: { p8_size: 'L' } } })).id
    // Categories: Root › Shoes › Boots; one product in Boots.
    const create = async (slug: string, name: string, parentId: string | null, depth: number) => {
      const node = await client.category.create({ data: { slug, name: { en: { name } }, parentId, depth } })
      await client.$executeRaw`INSERT INTO "CategoryClosure" ("ancestorId", "descendantId", "depth")
        SELECT "ancestorId", ${node.id}, "depth" + 1 FROM "CategoryClosure" WHERE "descendantId" = ${parentId} UNION ALL SELECT ${node.id}, ${node.id}, 0`
      return node.id
    }
    ids.root = await create('p8-root', 'Root', null, 0)
    ids.shoes = await create('p8-shoes', 'Shoes', ids.root, 1)
    ids.boots = await create('p8-boots', 'Boots', ids.shoes, 2)
    await client.productCategory.create({ data: { productId: ids.p1, categoryId: ids.boots, isPrimary: true } })
  })
  await inside(async () => {
    const group = await client.attributeGroup.create({ data: { code: 'p8_bravo_group', label: 'BRAVO group' } })
    ids.bravoAttr = (await client.customAttribute.create({ data: { code: 'p8_bravo', label: 'BRAVO attribute', groupId: group.id, type: 'text' } })).id
    ids.bravoFamily = (await client.productFamily.create({ data: { code: 'p8_bravo_family', label: 'BRAVO family' } })).id
    const node = await client.category.create({ data: { slug: 'p8-bravo', name: { en: { name: 'BRAVO category' } } } })
    await client.$executeRaw`INSERT INTO "CategoryClosure" ("ancestorId", "descendantId", "depth") VALUES (${node.id}, ${node.id}, 0)`
    ids.bravoCategory = node.id
  }, B)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('P8 — the contract: approved by a person, at most confirm, undoable', () => {
  it('each tool needs pim.manage, is at most confirm, never auto, and fully reversible', async () => {
    for (const name of ['save-attribute', 'save-product-family', 'save-category']) {
      const tool = getTool(name)!
      expect(tool, name).toBeDefined()
      expect({ name, trust: tool.maxClaudeTrust, rev: tool.reversibility, requires: tool.requires, undo: !!tool.undo }).toEqual({
        name, trust: 'confirm', rev: 'full', requires: [F.pimManage], undo: true,
      })
      const refused = await inside(() => callTool(person(new Set([F.aiRun, F.productsView])), name, { kind: 'attribute' }).catch((e) => e))
      expect(refused).toBeInstanceOf(ToolAccessError)
      expect((refused as ToolAccessError).code).toBe('forbidden')
    }
  })
})

describe('P8 — save-attribute', { timeout: TIMEOUT }, () => {
  it('create a choice list with options: the dry run writes nothing; approved, it exists; undo deletes it', async () => {
    const before = await counts()
    const args = { kind: 'attribute', code: 'p8_closure', label: 'Closure', type: 'select', groupId: ids.group, options: [{ code: 'zip', label: 'Zip' }, { code: 'buttons', label: 'Buttons', synonyms: ['buttoned'] }] }
    const queued = await ask('save-attribute', args)
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(queued.preview).toMatchObject({ action: 'create-attribute', impact: { products: 0, families: 0 } })
    expect(await counts()).toEqual(before)
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    const created = await inside(() => db().customAttribute.findFirstOrThrow({ where: { code: 'p8_closure' }, include: { options: { orderBy: { code: 'asc' } } } }))
    expect(created).toMatchObject({ label: 'Closure', type: 'select', groupId: ids.group })
    expect(created.options.map((o: Data) => [o.code, o.synonyms])).toEqual([['buttons', ['buttoned']], ['zip', []]])
    const undone = await undo(queued.approvalId!)
    expect(undone).toMatchObject({ action: 'remove-attribute' })
    expect(await inside(() => db().customAttribute.findFirst({ where: { code: 'p8_closure' } }))).toBeNull()
  })

  it('update: the preview says from → to and how many products carry it; stale when the label moved; undo puts it back', async () => {
    const queued = await ask('save-attribute', { kind: 'attribute', attributeId: ids.fit, label: 'Cut', description: 'How it sits' })
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(queued.preview).toMatchObject({
      action: 'update-attribute',
      attribute: { code: 'p8_fit', label: 'Fit' },
      changes: { label: { from: 'Fit', to: 'Cut' }, description: { from: null, to: 'How it sits' } },
      impact: { products: 1, families: 0, translations: 0 },
    })
    // Someone renames it in Nexus before the change runs: handed back, nothing written.
    await inside(() => db().customAttribute.update({ where: { id: ids.fit }, data: { label: 'Fit (renamed)' } }))
    const stale = await approveAndRun(queued.approvalId!)
    expect(stale).toMatchObject({ ok: false })
    expect(stale.error).toContain('the facts moved')
    expect((await inside(() => db().customAttribute.findUniqueOrThrow({ where: { id: ids.fit } }))).label).toBe('Fit (renamed)')
    await inside(() => db().customAttribute.update({ where: { id: ids.fit }, data: { label: 'Fit' } }))

    const { approvalId } = await askAndRun('save-attribute', { kind: 'attribute', attributeId: ids.fit, label: 'Cut', description: 'How it sits' })
    expect(await inside(() => db().customAttribute.findUniqueOrThrow({ where: { id: ids.fit } }))).toMatchObject({ label: 'Cut', description: 'How it sits' })
    const back = await undo(approvalId)
    expect(back).toMatchObject({ changes: { label: { from: 'Cut', to: 'Fit' }, description: { from: 'How it sits', to: null } } })
    expect(await inside(() => db().customAttribute.findUniqueOrThrow({ where: { id: ids.fit } }))).toMatchObject({ label: 'Fit', description: null })
  })

  it('undo is refused when the attribute changed again since', async () => {
    const { approvalId } = await askAndRun('save-attribute', { kind: 'attribute', attributeId: ids.lining, label: 'Inner lining' })
    await inside(() => db().customAttribute.update({ where: { id: ids.lining }, data: { label: 'Liner' } }))
    const change = await changeOf(approvalId)
    const asked = await ask('undo-change', { changeId: change.id })
    expect(asked).toMatchObject({ ok: false, mode: 'error' })
    expect(asked.error).toContain('changed since')
    await inside(() => db().customAttribute.update({ where: { id: ids.lining }, data: { label: 'Lining' } }))
  })

  it('delete only what nothing uses; options: create, archive, and no delete while a product carries it', async () => {
    const used = await ask('save-attribute', { kind: 'attribute', attributeId: ids.fit, remove: true })
    expect(used).toMatchObject({ ok: false, mode: 'error' })
    expect(used.error).toMatch(/Fit.*1 product.*archive/i)
    const optionUsed = await ask('save-attribute', { kind: 'option', optionId: ids.red, remove: true })
    expect(optionUsed.error).toMatch(/Red.*1 product.*archive/i)
    const { approvalId } = await askAndRun('save-attribute', { kind: 'option', optionId: ids.red, archived: true })
    expect((await inside(() => db().attributeOption.findUniqueOrThrow({ where: { id: ids.red } }))).archivedAt).toBeInstanceOf(Date)
    await undo(approvalId)
    expect((await inside(() => db().attributeOption.findUniqueOrThrow({ where: { id: ids.red } }))).archivedAt).toBeNull()
    const created = await askAndRun('save-attribute', { kind: 'option', attributeId: ids.colour, code: 'blue', label: 'Blue', synonyms: ['navy'] })
    expect(created.preview).toMatchObject({ action: 'create-option', impact: { products: 0 } })
    expect(await inside(() => db().attributeOption.findFirstOrThrow({ where: { attributeId: ids.colour, code: 'blue' } }))).toMatchObject({ label: 'Blue', synonyms: ['navy'] })
    await undo(created.approvalId)
    expect(await inside(() => db().attributeOption.findFirst({ where: { attributeId: ids.colour, code: 'blue' } }))).toBeNull()
  })

  it('groups: rename and undo; a group with attributes is not deleted; an empty one is, and comes back by undo', async () => {
    const renamed = await askAndRun('save-attribute', { kind: 'group', groupId: ids.group, label: 'Basics' })
    expect(renamed.preview).toMatchObject({ changes: { label: { from: 'General', to: 'Basics' } }, impact: { attributes: 4 } })
    await undo(renamed.approvalId)
    expect((await inside(() => db().attributeGroup.findUniqueOrThrow({ where: { id: ids.group } }))).label).toBe('General')
    const inUse = await ask('save-attribute', { kind: 'group', groupId: ids.group, remove: true })
    expect(inUse.error).toMatch(/General.*4 attributes/)
    const removed = await askAndRun('save-attribute', { kind: 'group', groupId: ids.groupEmpty, remove: true })
    expect(await inside(() => db().attributeGroup.findUnique({ where: { id: ids.groupEmpty } }))).toBeNull()
    await undo(removed.approvalId)
    const back = await inside(() => db().attributeGroup.findFirstOrThrow({ where: { code: 'p8_spare' } }))
    expect(back).toMatchObject({ label: 'Spare' })
    ids.groupEmpty = back.id
  })

  it('refuses what does not fit, naming the attribute', async () => {
    const wrong = await ask('save-attribute', { kind: 'attribute', attributeId: ids.fit, optionId: ids.red })
    expect(wrong.error).toMatch(/Fit.*optionId/)
    const nothing = await ask('save-attribute', { kind: 'attribute', attributeId: ids.fit, label: 'Fit' })
    expect(nothing.error).toMatch(/Nothing to change/)
    const typeChange = await ask('save-attribute', { kind: 'attribute', attributeId: ids.fit, type: 'number' })
    expect(typeChange.error).toMatch(/type/)
  })

  it.skipIf(!profilesOn())('another business’s attribute, option or group is not found, and nothing is queued', async () => {
    const pending = await inside(() => db().agentApproval.count({ where: { status: 'pending' } }))
    for (const args of [{ kind: 'attribute', attributeId: ids.bravoAttr, label: 'x' }, { kind: 'option', attributeId: ids.bravoAttr, code: 'x', label: 'x' }]) {
      const out = await ask('save-attribute', args)
      expect(out).toMatchObject({ ok: false, mode: 'error' })
      expect(out.error).toMatch(/not found/i)
      expect(out.error).not.toContain('BRAVO')
    }
    expect(await inside(() => db().agentApproval.count({ where: { status: 'pending' } }))).toBe(pending)
    // Control: inside B it is found.
    expect(await ask('save-attribute', { kind: 'attribute', attributeId: ids.bravoAttr, label: 'Renamed' }, ALL(), B)).toMatchObject({ ok: true, mode: 'queued' })
  })
})

describe('P8 — save-product-family', { timeout: TIMEOUT }, () => {
  it('attach a required attribute: both products become incomplete; approved; undo detaches it', async () => {
    const queued = await ask('save-product-family', { familyId: ids.jackets, attributes: [{ attributeId: ids.lining, required: true }] })
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(queued.preview).toMatchObject({
      action: 'update-family',
      family: { code: 'p8_jackets', label: 'Jackets' },
      impact: { products: 2, families: 1, becomeIncomplete: 2, becomeComplete: 0 },
    })
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    expect(await inside(() => db().familyAttribute.count({ where: { familyId: ids.jackets, attributeId: ids.lining, required: true } }))).toBe(1)
    await undo(queued.approvalId!)
    expect(await inside(() => db().familyAttribute.count({ where: { familyId: ids.jackets, attributeId: ids.lining } }))).toBe(0)
  })

  it('stale when the impact moved: a product got the value after the person approved', async () => {
    const queued = await ask('save-product-family', { familyId: ids.jackets, attributes: [{ attributeId: ids.fit, required: true }] })
    expect(queued.preview).toMatchObject({ impact: { becomeIncomplete: 1 } })
    await inside(() => db().product.update({ where: { id: ids.p2 }, data: { categoryAttributes: { p8_size: 'L', p8_fit: 'slim' } } }))
    const stale = await approveAndRun(queued.approvalId!)
    expect(stale).toMatchObject({ ok: false })
    expect(stale.error).toContain('the facts moved')
    expect(await inside(() => db().familyAttribute.count({ where: { familyId: ids.jackets, attributeId: ids.fit } }))).toBe(0)
    await inside(() => db().product.update({ where: { id: ids.p2 }, data: { categoryAttributes: { p8_size: 'L' } } }))
  })

  it('refuses a child re-declaring an ancestor’s attribute, a cycle, and deleting a family with products', async () => {
    const inherited = await ask('save-product-family', { familyId: ids.jackets, attributes: [{ attributeId: ids.size, required: false }] })
    expect(inherited.error).toMatch(/Jackets.*inherited from Apparel/)
    const cycle = await ask('save-product-family', { familyId: ids.apparel, parentFamilyId: ids.jackets })
    expect(cycle.error).toMatch(/Apparel.*cycle/)
    const withProducts = await ask('save-product-family', { familyId: ids.jackets, remove: true })
    expect(withProducts.error).toMatch(/Jackets.*2 products/)
  })

  it('create, rename with a new parent, and undo both', async () => {
    const created = await askAndRun('save-product-family', { code: 'p8_gloves', label: 'Gloves', parentFamilyId: ids.apparel, attributes: [{ attributeId: ids.fit, required: true }] })
    expect(created.preview).toMatchObject({ action: 'create-family', impact: { products: 0 } })
    const gloves = await inside(() => db().productFamily.findFirstOrThrow({ where: { code: 'p8_gloves' }, include: { familyAttributes: true } }))
    expect(gloves).toMatchObject({ label: 'Gloves', parentFamilyId: ids.apparel })
    expect(gloves.familyAttributes).toHaveLength(1)
    await undo(created.approvalId)
    expect(await inside(() => db().productFamily.findFirst({ where: { code: 'p8_gloves' } }))).toBeNull()

    const moved = await askAndRun('save-product-family', { familyId: ids.other, label: 'Others', parentFamilyId: ids.apparel })
    expect(moved.preview).toMatchObject({ changes: { label: { from: 'Other', to: 'Others' }, parent: { from: null, to: 'Apparel' } } })
    await undo(moved.approvalId)
    expect(await inside(() => db().productFamily.findUniqueOrThrow({ where: { id: ids.other } }))).toMatchObject({ label: 'Other', parentFamilyId: null })
  })

  it.skipIf(!profilesOn())('another business’s family is not found', async () => {
    const out = await ask('save-product-family', { familyId: ids.bravoFamily, label: 'x' })
    expect(out.error).toMatch(/not found/i)
    expect(out.error).not.toContain('BRAVO')
  })
})

describe('P8 — save-category', { timeout: TIMEOUT }, () => {
  it('move a category: the preview counts the products under it; approved; undo moves it back', async () => {
    const queued = await ask('save-category', { categoryId: ids.shoes, parentCategoryId: null })
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(queued.preview).toMatchObject({ action: 'move', category: { name: 'Shoes' }, changes: { parent: { from: 'Root', to: null } }, impact: { products: 1, childCategories: 1 } })
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    expect((await inside(() => db().category.findUniqueOrThrow({ where: { id: ids.shoes } }))).parentId).toBeNull()
    await undo(queued.approvalId!)
    expect((await inside(() => db().category.findUniqueOrThrow({ where: { id: ids.shoes } }))).parentId).toBe(ids.root)
  })

  it('create and rename, each undone; a category with products is not deleted', async () => {
    const created = await askAndRun('save-category', { name: 'Gloves', slug: 'p8-gloves', parentCategoryId: ids.root })
    expect(created.preview).toMatchObject({ action: 'create', impact: { products: 0 } })
    expect(await inside(() => db().category.count({ where: { slug: 'p8-gloves' } }))).toBe(1)
    await undo(created.approvalId)
    expect(await inside(() => db().category.count({ where: { slug: 'p8-gloves' } }))).toBe(0)

    const renamed = await askAndRun('save-category', { categoryId: ids.boots, name: 'Riding boots' })
    expect(renamed.preview).toMatchObject({ action: 'rename', changes: { name: { from: 'Boots', to: 'Riding boots' } }, impact: { products: 1 } })
    await undo(renamed.approvalId)
    const boots = await inside(() => db().category.findUniqueOrThrow({ where: { id: ids.boots } }))
    expect((boots.name as Data).en.name).toBe('Boots')

    const withProducts = await ask('save-category', { categoryId: ids.boots, remove: true })
    expect(withProducts.error).toMatch(/Boots/)
  })

  it('stale when the products under it changed after the person approved', async () => {
    const queued = await ask('save-category', { categoryId: ids.boots, name: 'Tall boots' })
    await inside(() => db().productCategory.create({ data: { productId: ids.p2, categoryId: ids.boots } }))
    const stale = await approveAndRun(queued.approvalId!)
    expect(stale).toMatchObject({ ok: false })
    expect(stale.error).toContain('the facts moved')
    await inside(() => db().productCategory.delete({ where: { productId_categoryId: { productId: ids.p2, categoryId: ids.boots } } }))
  })

  it.skipIf(!profilesOn())('another business’s category is not found', async () => {
    const out = await ask('save-category', { categoryId: ids.bravoCategory, name: 'x' })
    expect(out.error).toMatch(/not found/i)
    expect(out.error).not.toContain('BRAVO')
  })
})
