/**
 * MCP full control P7 — the organizing changes of the catalog: set-product-tags, move-workflow-stage and save-view,
 * through the doors a person or Claude uses (runOrQueueTool, then scheduleApproval + commitScheduledApproval as the
 * Approvals page and the sweep run them), on PGlite with the production schema and the business policies.
 *
 *   refused     a wrongly made call, a person without the permission, a deleted or unknown row, nothing to change
 *   dry run     the preview names the rows and the from → to, and writes nothing
 *   limits      what Claude may do without a person (C5): small tag changes of existing tags, one stage forward,
 *               saving a view — never a deletion, a new tag or a jump, unless the business allows it
 *   round trip  approved → done → recorded (before → after) → undone through undo-change → the old state is back
 *   stale       a change made after the approval hands it back, and nothing is written; undo refused once the value
 *               moved since
 *   business    another business's product, stage or view is not found, and nothing is queued (profiles on)
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
import { getTool } from '../tool-registry.js'
import { commitScheduledApproval, scheduleApproval } from '../../agent-fleet/approval-inbox.service.js'

const A = LEGACY_WORKSPACE_ID
const B = 'p7_organize_catalog_bravo'
const TIMEOUT = 30_000
const profilesOn = process.env.NEXUS_WORKSPACES_ENABLED === '1'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)

const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = {
  approver: '', other: '', tagged: '', staged: '', unstaged: '', deleted: '', otherFlow: '',
  sale: '', summer: '', draft: '', review: '', live: '', otherStage: '', view: '', othersView: '',
  bravoProduct: '', bravoStage: '', bravoView: '',
}

const person = (permissions: Set<string>, extra: Partial<UserPrincipal> = {}): UserPrincipal => ({
  kind: 'user', userId: ids.approver, label: 'Olga Organize', permissions: { isOwner: false, permissions }, workspace: business(A), via: 'claude', ...extra,
})
const ALL = () => person(EVERYTHING)
const WITHOUT = (permission: string) => person(new Set([...EVERYTHING].filter((p) => p !== permission)))
const db = () => database.client

async function dryRun(tool: string, args: Record<string, unknown>, who = ALL(), workspaceId = A) {
  try {
    return { result: (await inside(() => callTool(who, tool, args), workspaceId)).visible, refused: null as ToolAccessError | null }
  } catch (error) {
    if (error instanceof ToolAccessError) return { result: null, refused: error }
    throw error
  }
}

async function ask(tool: string, args: Record<string, unknown>, workspaceId = A) {
  const run = await inside(() => db().agentRun.create({
    data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: ids.approver, via: 'claude' },
  }), workspaceId)
  return inside(() => runOrQueueTool(tool, args, ALL(), run.id, { forceAsk: true }), workspaceId)
}

async function approveAndRun(approvalId: string) {
  const parked = await inside(() => scheduleApproval({ id: approvalId, actor: person(EVERYTHING, { via: 'app' }) }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}

async function askAndRun(tool: string, args: Record<string, unknown>) {
  const queued = await ask(tool, args)
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  const ran = await approveAndRun(queued.approvalId!)
  expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
  return queued.approvalId!
}

const changeOf = (approvalId: string) => inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
const pendingCount = () => inside(() => db().agentApproval.count({ where: { status: 'pending' } }))

/** Undo a change through undo-change, approve it, run it. */
async function undo(approvalId: string) {
  const change = await changeOf(approvalId)
  const asked = await ask('undo-change', { changeId: change.id })
  expect(asked, asked.error).toMatchObject({ ok: true, mode: 'queued', undoes: change.id })
  const ran = await approveAndRun(asked.approvalId!)
  expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
}

const tagsOf = async (productId: string) =>
  (await inside(() => db().productTag.findMany({ where: { productId }, include: { tag: { select: { name: true } } } })))
    .map((row) => row.tag.name).sort((a, b) => a.localeCompare(b))
const stageOf = async (productId: string) => (await inside(() => db().product.findUniqueOrThrow({ where: { id: productId } }))).workflowStageId
const counts = () => inside(async () => ({
  productTags: await db().productTag.count(),
  tags: await db().tag.count(),
  transitions: await db().workflowTransition.count(),
  views: await db().savedView.count(),
  alerts: await db().savedViewAlert.count(),
}))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  const role = await client.role.create({
    data: { key: `P7_ORG_${randomUUID().slice(0, 8)}`, name: 'Organizer', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const approver = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Olga Organize' } })
  ids.approver = approver.id
  ids.other = (await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Otto Other' } })).id
  await client.userRole.create({ data: { userId: approver.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: 'Bravo organize business', createdByUserId: approver.id, creationKey: randomUUID() } })
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: approver.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }

  await inside(async () => {
    ids.tagged = (await client.product.create({ data: { sku: 'TEST-SKU-T1', name: 'Tagged jacket', basePrice: '10.00' } })).id
    ids.sale = (await client.tag.create({ data: { name: 'Sale' } })).id
    ids.summer = (await client.tag.create({ data: { name: 'Summer' } })).id
    await client.productTag.create({ data: { productId: ids.tagged, tagId: ids.sale } })

    const flow = await client.productWorkflow.create({ data: { code: 'launch', label: 'Launch' } })
    ids.draft = (await client.workflowStage.create({ data: { workflowId: flow.id, code: 'draft', label: 'Draft', sortOrder: 0, isInitial: true } })).id
    ids.review = (await client.workflowStage.create({ data: { workflowId: flow.id, code: 'review', label: 'Review', sortOrder: 1 } })).id
    ids.live = (await client.workflowStage.create({ data: { workflowId: flow.id, code: 'live', label: 'Live', sortOrder: 2, isTerminal: true, isPublishable: true } })).id
    const other = await client.productWorkflow.create({ data: { code: 'other', label: 'Other flow' } })
    ids.otherStage = (await client.workflowStage.create({ data: { workflowId: other.id, code: 'start', label: 'Start', sortOrder: 0, isInitial: true } })).id
    ids.staged = (await client.product.create({ data: { sku: 'TEST-SKU-T2', name: 'Staged jacket', basePrice: '10.00', workflowStageId: ids.draft } })).id
    ids.otherFlow = (await client.product.create({ data: { sku: 'TEST-SKU-T5', name: 'Other flow jacket', basePrice: '10.00', workflowStageId: ids.otherStage } })).id
    ids.unstaged = (await client.product.create({ data: { sku: 'TEST-SKU-T3', name: 'Loose jacket', basePrice: '10.00' } })).id
    ids.deleted = (await client.product.create({ data: { sku: 'TEST-SKU-T4', name: 'Gone jacket', basePrice: '10.00', deletedAt: new Date(), workflowStageId: ids.draft } })).id

    const view = await client.savedView.create({ data: { userId: approver.id, surface: 'products', name: 'My jackets', filters: { search: 'TEST-SKU' } } })
    ids.view = view.id
    await client.savedViewAlert.create({ data: { savedViewId: view.id, userId: approver.id, name: 'My jackets', comparison: 'GT', threshold: 10, cooldownMinutes: 60 } })
    ids.othersView = (await client.savedView.create({ data: { userId: ids.other, surface: 'products', name: 'Otto view', filters: {} } })).id
  })
  await inside(async () => {
    const flow = await client.productWorkflow.create({ data: { code: 'launch', label: 'Bravo launch' } })
    const draft = await client.workflowStage.create({ data: { workflowId: flow.id, code: 'draft', label: 'Bravo draft', sortOrder: 0, isInitial: true } })
    ids.bravoStage = (await client.workflowStage.create({ data: { workflowId: flow.id, code: 'review', label: 'Bravo review', sortOrder: 1 } })).id
    ids.bravoProduct = (await client.product.create({ data: { sku: 'TEST-SKU-T1', name: 'BRAVO jacket', basePrice: '10.00', workflowStageId: draft.id } })).id
    ids.bravoView = (await client.savedView.create({ data: { userId: approver.id, surface: 'products', name: 'BRAVO view', filters: {} } })).id
  }, B)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('P7 — refusals before anything runs', { timeout: TIMEOUT }, () => {
  it('a wrongly made call is refused by the schema', async () => {
    expect((await dryRun('set-product-tags', { productId: ids.tagged, tags: Array.from({ length: 51 }, (_, i) => `t${i}`) })).refused?.code).toBe('invalid_arguments')
    expect((await dryRun('move-workflow-stage', { productId: ids.staged })).refused?.code).toBe('invalid_arguments')
    expect((await dryRun('save-view', { name: 'x', alert: { comparison: 'ABOUT', threshold: 1 } })).refused?.code).toBe('invalid_arguments')
  })

  it('a person without the permission is refused', async () => {
    expect((await dryRun('set-product-tags', { productId: ids.tagged, tags: ['Sale'] }, WITHOUT(F.productsEdit))).refused?.code).toBe('forbidden')
    expect((await dryRun('move-workflow-stage', { productId: ids.staged, stageId: ids.review }, WITHOUT(F.pimManage))).refused?.code).toBe('forbidden')
    expect((await dryRun('save-view', { name: 'New' }, WITHOUT(F.settingsNotificationsEdit))).refused?.code).toBe('forbidden')
  })

  it('a deleted or unknown row is not found; nothing to change is said', async () => {
    expect((await dryRun('set-product-tags', { productId: ids.deleted, tags: ['Sale'] })).result).toEqual({ ok: false, error: 'Product not found' })
    expect((await dryRun('move-workflow-stage', { productId: ids.deleted, stageId: ids.review })).result).toEqual({ ok: false, error: 'Product not found' })
    expect((await dryRun('move-workflow-stage', { productId: ids.staged, stageId: 'nope' })).result).toEqual({ ok: false, error: 'Workflow stage not found' })
    expect((await dryRun('save-view', { savedViewId: ids.othersView, name: 'Mine now' })).result).toEqual({ ok: false, error: 'Saved view not found' })
    expect((await dryRun('set-product-tags', { productId: ids.tagged, tags: ['sale'] })).result?.error).toMatch(/^Nothing to change: TEST-SKU-T1 already carries/)
    expect((await dryRun('move-workflow-stage', { productId: ids.staged, stageId: ids.draft })).result?.error).toMatch(/^Nothing to change: TEST-SKU-T2 is already at Draft/)
    expect((await dryRun('save-view', { savedViewId: ids.view })).result?.error).toBe('Nothing to change: your view "My jackets" already has these settings.')
  })

  it('a product on no workflow, or on another workflow, is refused in words', async () => {
    expect((await dryRun('move-workflow-stage', { productId: ids.unstaged, stageId: ids.review })).result?.error).toMatch(/TEST-SKU-T3 is on no workflow yet/)
    expect((await dryRun('move-workflow-stage', { productId: ids.otherFlow, stageId: ids.review })).result?.error).toMatch(/TEST-SKU-T5 is on the Other flow workflow/)
  })
})

describe('P7 — set-product-tags', { timeout: TIMEOUT }, () => {
  it('previews the whole set from → to, writing nothing; the limits keep new tags and big changes for a person', async () => {
    const before = await counts()
    const { result } = await dryRun('set-product-tags', { productId: ids.tagged, tags: ['summer', 'Outlet', 'SUMMER'] })
    expect(result).toMatchObject({
      ok: true,
      preview: {
        action: 'set-product-tags', sku: 'TEST-SKU-T1',
        changes: { tags: { from: ['Sale'], to: ['Outlet', 'Summer'] } },
        added: ['Outlet', 'Summer'], removed: ['Sale'], newTags: ['Outlet'],
      },
    })
    expect(await counts()).toEqual(before)
    const tool = getTool('set-product-tags')!
    const defaults = tool.limits!.parse({})
    expect(tool.withinLimits!(result!.preview, defaults)).toMatch(/new tag/)
    expect(tool.withinLimits!(result!.preview, { ...defaults, allowNewTags: true })).toBeNull()
    expect(tool.withinLimits!({ ...(result!.preview as object), added: ['a', 'b', 'c'], removed: ['d', 'e', 'f'], newTags: [] }, defaults)).toMatch(/6 tag changes/)
    expect(typeof tool.withinLimits!(null, defaults)).toBe('string')
  })

  it('approved: the product carries exactly the new set (the new tag created); undone: the old set is back', async () => {
    const approvalId = await askAndRun('set-product-tags', { productId: ids.tagged, tags: ['Summer', 'Outlet'] })
    expect(await tagsOf(ids.tagged)).toEqual(['Outlet', 'Summer'])
    expect(await changeOf(approvalId)).toMatchObject({
      toolName: 'set-product-tags', reversibility: 'full',
      before: { productId: ids.tagged, sku: 'TEST-SKU-T1', tags: ['Sale'] },
      after: { productId: ids.tagged, tags: ['Outlet', 'Summer'] },
      undoTool: 'set-product-tags', undoArgs: { productId: ids.tagged, tags: ['Sale'] },
    })
    await undo(approvalId)
    expect(await tagsOf(ids.tagged)).toEqual(['Sale'])
  })

  it('stale: tags changed after the approval hand it back, and nothing is written; undo refused once they moved', async () => {
    const queued = await ask('set-product-tags', { productId: ids.tagged, tags: ['Sale', 'Summer'] })
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    await inside(() => db().productTag.create({ data: { productId: ids.tagged, tagId: ids.summer } }))
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran.ok).toBe(false)
    expect(ran.error).toMatch(/Nothing to change|the facts moved/)
    expect(await tagsOf(ids.tagged)).toEqual(['Sale', 'Summer'])

    const approvalId = await askAndRun('set-product-tags', { productId: ids.tagged, tags: ['Sale'] })
    await inside(() => db().productTag.create({ data: { productId: ids.tagged, tagId: ids.summer } }))
    const change = await changeOf(approvalId)
    const before = await pendingCount()
    const refused = await ask('undo-change', { changeId: change.id })
    expect(refused).toMatchObject({ ok: false })
    expect(refused.error).toContain('changed since')
    expect(await pendingCount()).toBe(before)
    await inside(() => db().productTag.delete({ where: { productId_tagId: { productId: ids.tagged, tagId: ids.summer } } }))
  })
})

describe('P7 — move-workflow-stage', { timeout: TIMEOUT }, () => {
  it('previews the stage from → to and the steps, writing nothing; the limits allow one step forward', async () => {
    const before = await counts()
    const { result } = await dryRun('move-workflow-stage', { productId: ids.staged, stageId: ids.review, comment: 'Photos done' })
    expect(result).toMatchObject({
      ok: true,
      preview: {
        action: 'move-workflow-stage', sku: 'TEST-SKU-T2', workflow: 'Launch',
        changes: { stage: { from: { id: ids.draft, label: 'Draft' }, to: { id: ids.review, label: 'Review' } } },
        steps: 1, terminal: false, comment: 'Photos done',
      },
    })
    expect(await counts()).toEqual(before)
    const tool = getTool('move-workflow-stage')!
    const defaults = tool.limits!.parse({})
    expect(tool.withinLimits!(result!.preview, defaults)).toBeNull()
    const jump = (await dryRun('move-workflow-stage', { productId: ids.staged, stageId: ids.live })).result!.preview
    expect(jump).toMatchObject({ steps: 2, terminal: true })
    expect(tool.withinLimits!(jump, defaults)).toMatch(/2 stages/)
    expect(tool.withinLimits!(jump, { ...defaults, maxSteps: 2 })).toMatch(/last stage/)
    expect(tool.withinLimits!({ ...(result!.preview as object), steps: -1 }, defaults)).toMatch(/back/)
    expect(typeof tool.withinLimits!(null, defaults)).toBe('string')
  })

  it('approved: the product moves and a transition is written; undone: it is back where it was', async () => {
    const approvalId = await askAndRun('move-workflow-stage', { productId: ids.staged, stageId: ids.review })
    expect(await stageOf(ids.staged)).toBe(ids.review)
    expect(await inside(() => db().workflowTransition.count({ where: { productId: ids.staged, toStageId: ids.review } }))).toBe(1)
    expect(await changeOf(approvalId)).toMatchObject({
      before: { productId: ids.staged, sku: 'TEST-SKU-T2', stageId: ids.draft, stage: 'Draft' },
      after: { productId: ids.staged, stageId: ids.review },
      undoTool: 'move-workflow-stage',
    })
    await undo(approvalId)
    expect(await stageOf(ids.staged)).toBe(ids.draft)
  })

  it('stale: a move by someone else after the approval hands it back', async () => {
    const queued = await ask('move-workflow-stage', { productId: ids.staged, stageId: ids.review })
    await inside(() => db().product.update({ where: { id: ids.staged }, data: { workflowStageId: ids.live } }))
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran.ok).toBe(false)
    expect(ran.error).toContain('the facts moved')
    expect(await stageOf(ids.staged)).toBe(ids.live)
    await inside(() => db().product.update({ where: { id: ids.staged }, data: { workflowStageId: ids.draft } }))
  })
})

describe('P7 — save-view', { timeout: TIMEOUT }, () => {
  it('a new view: previewed without a write, saved as the asking person’s, undone by removing it', async () => {
    const before = await counts()
    const { result } = await dryRun('save-view', { name: 'Low stock', filters: { stockLevel: 'low', brands: ['Acme'] }, alert: { comparison: 'GT', threshold: 3 } })
    expect(result).toMatchObject({
      ok: true,
      preview: {
        action: 'save-view', mode: 'create',
        changes: { view: { from: null, to: { name: 'Low stock', filters: { stockLevel: 'low', brands: ['Acme'] }, alert: { comparison: 'GT', threshold: 3, cooldownMinutes: 60, active: true } } } },
      },
    })
    expect(await counts()).toEqual(before)
    const tool = getTool('save-view')!
    expect(tool.withinLimits!(result!.preview, tool.limits!.parse({}))).toBeNull()

    const approvalId = await askAndRun('save-view', { name: 'Low stock', filters: { stockLevel: 'low', brands: ['Acme'] }, alert: { comparison: 'GT', threshold: 3 } })
    const created = await inside(() => db().savedView.findFirstOrThrow({ where: { name: 'Low stock' }, include: { alerts: true } }))
    expect(created).toMatchObject({ userId: ids.approver, surface: 'products', filters: { stockLevel: 'low', brands: ['Acme'] } })
    expect(created.alerts).toHaveLength(1)
    expect(created.alerts[0]).toMatchObject({ userId: ids.approver, comparison: 'GT', isActive: true })
    expect((await changeOf(approvalId)).undoArgs).toEqual({ savedViewId: created.id, remove: true })
    await undo(approvalId)
    expect(await inside(() => db().savedView.count({ where: { name: 'Low stock' } }))).toBe(0)
  })

  it('an update: rename and switch the alert off; undone: the name and the alert are back', async () => {
    const approvalId = await askAndRun('save-view', { savedViewId: ids.view, name: 'All test jackets', alert: null })
    const view = await inside(() => db().savedView.findUniqueOrThrow({ where: { id: ids.view }, include: { alerts: true } }))
    expect(view.name).toBe('All test jackets')
    expect(view.alerts[0].isActive).toBe(false)
    expect(await changeOf(approvalId)).toMatchObject({
      before: { savedViewId: ids.view, view: { name: 'My jackets', alert: { comparison: 'GT', threshold: 10, active: true } } },
      after: { savedViewId: ids.view, view: { name: 'All test jackets', alert: { active: false } } },
    })
    await undo(approvalId)
    const back = await inside(() => db().savedView.findUniqueOrThrow({ where: { id: ids.view }, include: { alerts: true } }))
    expect(back.name).toBe('My jackets')
    expect(back.alerts.map((alert) => alert.isActive)).toEqual([true])
  })

  it('removing a view is never inside the limits; approved, it goes, and undo brings it back', async () => {
    const preview = (await dryRun('save-view', { savedViewId: ids.view, remove: true })).result!.preview
    expect(preview).toMatchObject({ mode: 'remove', changes: { view: { to: null } } })
    const tool = getTool('save-view')!
    expect(tool.withinLimits!(preview, tool.limits!.parse({}))).toMatch(/deletes/)
    const approvalId = await askAndRun('save-view', { savedViewId: ids.view, remove: true })
    expect(await inside(() => db().savedView.count({ where: { id: ids.view } }))).toBe(0)
    await undo(approvalId)
    const back = await inside(() => db().savedView.findFirstOrThrow({ where: { name: 'My jackets' }, include: { alerts: true } }))
    expect(back).toMatchObject({ userId: ids.approver, filters: { search: 'TEST-SKU' } })
    expect(back.alerts).toHaveLength(1)
    ids.view = back.id
  })
})

describe.runIf(profilesOn)('P7 — another business', { timeout: TIMEOUT }, () => {
  it("B's product, stage and view are not found from A, and nothing is queued; inside B they are found", async () => {
    const before = await pendingCount()
    for (const [tool, args] of [
      ['set-product-tags', { productId: ids.bravoProduct, tags: ['Sale'] }],
      ['move-workflow-stage', { productId: ids.bravoProduct, stageId: ids.bravoStage }],
      ['move-workflow-stage', { productId: ids.staged, stageId: ids.bravoStage }],
      ['save-view', { savedViewId: ids.bravoView, name: 'Taken' }],
    ] as const) {
      const asked = await ask(tool, args)
      expect({ tool, ok: asked.ok, error: asked.error }).toMatchObject({ tool, ok: false, error: expect.stringMatching(/not found/i) })
      expect(JSON.stringify(asked)).not.toContain('BRAVO')
    }
    expect(await pendingCount()).toBe(before)
    // Control: the same calls inside B reach B's rows.
    expect((await dryRun('move-workflow-stage', { productId: ids.bravoProduct, stageId: ids.bravoStage }, person(EVERYTHING, { workspace: business(B) }), B)).result)
      .toMatchObject({ ok: true, preview: { sku: 'TEST-SKU-T1', changes: { stage: { to: { label: 'Bravo review' } } } } })
    expect((await dryRun('save-view', { savedViewId: ids.bravoView, name: 'Taken' }, person(EVERYTHING, { workspace: business(B) }), B)).result)
      .toMatchObject({ ok: true, preview: { changes: { view: { from: { name: 'BRAVO view' } } } } })
  })
})
