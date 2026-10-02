/**
 * MCP full control P7 (W2) — set-alert-rule, acknowledge-alerts and organize-image-library, through the doors a person
 * or Claude uses (runOrQueueTool, then scheduleApproval + commitScheduledApproval as the Approvals page and the sweep
 * run them), on PGlite with the production schema and business policies.
 *
 *   dry run     the preview names the rows and the from → to, and writes nothing
 *   run         a person approves, the change is made and recorded (before → after)
 *   stale       a row changed after the approval: handed back, nothing written
 *   undo        undo-change asks for the inverse through the same gate; approved, the old state is back
 *   limits      what `auto` may run without a person (withinLimits)
 *   refusals    schema, permission, another person's notification, product photos, rows of another business
 *   never       a rule's notification targets (webhooks, e-mail addresses) are never shown and never set by Claude
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
// No Redis: nothing here enqueues.
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, adsSyncQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))

import { runOrQueueTool } from '../approval-gate.service.js'
import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'
import { commitScheduledApproval, scheduleApproval } from '../../agent-fleet/approval-inbox.service.js'

const A = LEGACY_WORKSPACE_ID
const B = 'p7_organize_platform_bravo'
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)

const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = {
  approver: '', other: '',
  rule: '', ruleQuiet: '', e1: '', e2: '', e3: '', n1: '', nOther: '',
  folderA: '', folderB: '', tagRed: '', tagBlue: '', a1: '', a2: '',
  bRule: '', bEvent: '', bNote: '', bAsset: '', bFolder: '', bTag: '',
}
const WEBHOOK = 'webhook:https://hooks.example.test/p7-secret-path'
const MAILBOX = 'email:p7-ops@example.test'

const person = (permissions: Set<string>, extra: Partial<UserPrincipal> = {}): UserPrincipal => ({
  kind: 'user', userId: ids.approver, label: 'Olga Organize', permissions: { isOwner: false, permissions }, workspace: business(A), via: 'claude', oauthGrantId: 'grant-p7', ...extra,
})
const ALL = () => person(EVERYTHING)
const WITHOUT = (permission: string) => person(new Set([...EVERYTHING].filter((p) => p !== permission)))
const db = () => database.client

async function ask(who: UserPrincipal, tool: string, args: Record<string, unknown>, workspaceId = A) {
  const run = await inside(() => db().agentRun.create({
    data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: ids.approver, via: who.via, oauthGrantId: who.oauthGrantId ?? null },
  }), workspaceId)
  return inside(() => runOrQueueTool(tool, args, who, run.id, { forceAsk: true }), workspaceId)
}
async function approveAndRun(approvalId: string) {
  const parked = await inside(() => scheduleApproval({ id: approvalId, actor: person(EVERYTHING, { via: 'app' }) }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}
async function askAndRun(tool: string, args: Record<string, unknown>) {
  const queued = await ask(ALL(), tool, args)
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  const ran = await approveAndRun(queued.approvalId!)
  expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
  return queued.approvalId!
}
async function undo(approvalId: string) {
  const asked = await ask(ALL(), 'undo-change', { approvalId })
  expect(asked, asked.error).toMatchObject({ ok: true, mode: 'queued' })
  return asked
}
async function dryRun(who: UserPrincipal, tool: string, args: Record<string, unknown>) {
  try {
    return { result: (await callTool(who, tool, args)).visible, refused: null as ToolAccessError | null }
  } catch (error) {
    if (error instanceof ToolAccessError) return { result: null, refused: error }
    throw error
  }
}
const changeOf = (approvalId: string) => inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
const pending = () => inside(() => db().agentApproval.count({ where: { status: 'pending' } }))
const ruleRow = (id: string) => inside(() => db().alertRule.findUniqueOrThrow({ where: { id } }))
const eventRow = (id: string) => inside(() => db().alertEvent.findUniqueOrThrow({ where: { id } }))
const noteRow = (id: string) => inside(() => db().notification.findUniqueOrThrow({ where: { id } }))
async function assetState(id: string) {
  const row = await inside(() => db().digitalAsset.findUniqueOrThrow({ where: { id }, include: { tags: true } }))
  return { label: row.label, folderId: row.folderId, tagIds: row.tags.map((t: { tagId: string }) => t.tagId).sort() }
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  const role = await client.role.create({
    data: { key: `P7_W2_${randomUUID().slice(0, 8)}`, name: 'Organizer', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const approver = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Olga Organize' } })
  ids.approver = approver.id
  ids.other = (await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Someone Else' } })).id
  await client.userRole.create({ data: { userId: approver.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: 'Bravo organize business', createdByUserId: approver.id, creationKey: randomUUID() } })
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: approver.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  await inside(async () => {
    ids.rule = (await client.alertRule.create({ data: { name: 'Queue deep', metric: 'queueDepth', operator: 'gt', threshold: 100, notificationChannels: ['log', WEBHOOK, MAILBOX], lastFired: true } })).id
    ids.ruleQuiet = (await client.alertRule.create({ data: { name: 'Error rate', metric: 'errorRate', operator: 'gt', threshold: 0.2, channel: 'EBAY', notificationChannels: ['log'] } })).id
    ids.e1 = (await client.alertEvent.create({ data: { ruleId: ids.rule, value: 250 } })).id
    ids.e2 = (await client.alertEvent.create({ data: { ruleId: ids.rule, value: 300 } })).id
    ids.e3 = (await client.alertEvent.create({ data: { ruleId: ids.ruleQuiet, value: 0.5, status: 'ACKNOWLEDGED', acknowledgedAt: new Date('2026-09-01T00:00:00Z'), acknowledgedBy: 'Earlier Person', notes: 'seen' } })).id
    ids.n1 = (await client.notification.create({ data: { userId: approver.id, type: 'alert', title: 'Queue deep fired' } })).id
    ids.nOther = (await client.notification.create({ data: { userId: ids.other, type: 'alert', title: 'Not yours' } })).id
    ids.folderA = (await client.assetFolder.create({ data: { name: 'Lookbook' } })).id
    ids.folderB = (await client.assetFolder.create({ data: { name: 'Packshots' } })).id
    ids.tagRed = (await client.tag.create({ data: { name: 'red' } })).id
    ids.tagBlue = (await client.tag.create({ data: { name: 'blue' } })).id
    const asset = (label: string, folderId: string | null) =>
      client.digitalAsset.create({ data: { label, type: 'image', mimeType: 'image/jpeg', sizeBytes: 100, storageId: `p7/${randomUUID()}`, url: `https://example.test/${randomUUID()}.jpg`, folderId } })
    ids.a1 = (await asset('Jacket front', ids.folderA)).id
    ids.a2 = (await asset('Jacket back', null)).id
    await client.assetTag.create({ data: { assetId: ids.a1, tagId: ids.tagRed } })
  })
  await inside(async () => {
    ids.bRule = (await client.alertRule.create({ data: { name: 'BRAVO rule', metric: 'queueDepth', operator: 'gt', threshold: 5, notificationChannels: ['log'] } })).id
    ids.bEvent = (await client.alertEvent.create({ data: { ruleId: ids.bRule, value: 9 } })).id
    ids.bNote = (await client.notification.create({ data: { userId: approver.id, type: 'alert', title: 'BRAVO note' } })).id
    ids.bFolder = (await client.assetFolder.create({ data: { name: 'BRAVO folder' } })).id
    ids.bTag = (await client.tag.create({ data: { name: 'bravo' } })).id
    ids.bAsset = (await client.digitalAsset.create({ data: { label: 'BRAVO photo', type: 'image', mimeType: 'image/jpeg', sizeBytes: 100, storageId: 'p7/bravo', url: 'https://example.test/bravo.jpg' } })).id
  }, B)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('P7 W2 — refusals before anything runs', () => {
  it('a wrongly made call, and a person without the permission', async () => {
    expect((await dryRun(ALL(), 'set-alert-rule', { name: 'x', metric: 'nope', operator: 'gt', threshold: 1 })).refused?.code).toBe('invalid_arguments')
    expect((await dryRun(ALL(), 'acknowledge-alerts', { alertEventIds: Array.from({ length: 51 }, (_, i) => `e${i}`), action: 'acknowledge' })).refused?.code).toBe('invalid_arguments')
    expect((await dryRun(ALL(), 'organize-image-library', { assetIds: [], folderId: null })).refused?.code).toBe('invalid_arguments')
    expect((await dryRun(WITHOUT(F.syncManage), 'set-alert-rule', { ruleId: ids.rule, threshold: 150 })).refused?.code).toBe('forbidden')
    expect((await dryRun(WITHOUT(F.syncManage), 'acknowledge-alerts', { alertEventIds: [ids.e1], action: 'acknowledge' })).refused?.code).toBe('forbidden')
    expect((await dryRun(WITHOUT(F.assetsManage), 'organize-image-library', { assetIds: [ids.a2], folderId: ids.folderA })).refused?.code).toBe('forbidden')
  })
})

describe('P7 W2 — set-alert-rule', { timeout: TIMEOUT }, () => {
  it('the dry run names the rule and the change, never its notification targets, and writes nothing', async () => {
    const before = await ruleRow(ids.rule)
    const { result } = await dryRun(ALL(), 'set-alert-rule', { ruleId: ids.rule, threshold: 150 })
    expect(result).toMatchObject({
      ok: true,
      preview: { action: 'set-alert-rule', mode: 'update', rule: 'Queue deep', changes: { threshold: { from: 100, to: 150 } }, thresholdChangePct: 50 },
    })
    expect((result!.preview as { notifies: string[] }).notifies).toEqual(['the Nexus log', '1 webhook', '1 e-mail address'])
    const text = JSON.stringify(result)
    expect(text).not.toContain('hooks.example.test')
    expect(text).not.toContain('p7-ops@')
    expect(await ruleRow(ids.rule)).toEqual(before)
  })

  it('refuses another metric for a rule, a change that changes nothing, a half new rule, and an unknown rule', async () => {
    expect((await dryRun(ALL(), 'set-alert-rule', { ruleId: ids.rule, metric: 'errorRate' })).result?.error).toMatch(/metric and operator/)
    expect((await dryRun(ALL(), 'set-alert-rule', { ruleId: ids.rule, threshold: 100, name: 'Queue deep' })).result?.error).toMatch(/Nothing would change/)
    expect((await dryRun(ALL(), 'set-alert-rule', { name: 'Half', metric: 'queueDepth' })).result?.error).toMatch(/needs a name, a metric, an operator and a threshold/)
    expect((await dryRun(ALL(), 'set-alert-rule', { ruleId: 'missing-rule', threshold: 3 })).result).toEqual({ ok: false, error: 'Alert rule not found' })
  })

  it('approved, the threshold changes and the change is recorded; undo puts it back through the same gate', async () => {
    const approvalId = await askAndRun('set-alert-rule', { ruleId: ids.rule, threshold: 150 })
    const changed = await ruleRow(ids.rule)
    expect(changed).toMatchObject({ threshold: 150, notificationChannels: ['log', WEBHOOK, MAILBOX], metric: 'queueDepth' })
    const change = await changeOf(approvalId)
    expect(change).toMatchObject({ toolName: 'set-alert-rule', reversibility: 'full', before: { ruleId: ids.rule, threshold: 100 }, after: { ruleId: ids.rule, threshold: 150 } })
    const asked = await undo(approvalId)
    expect(asked.preview).toMatchObject({ changes: { threshold: { from: 150, to: 100 } } })
    expect(await approveAndRun(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect((await ruleRow(ids.rule)).threshold).toBe(100)
  })

  it('handed back when the rule changed after the approval; nothing written', async () => {
    const queued = await ask(ALL(), 'set-alert-rule', { ruleId: ids.rule, threshold: 200 })
    await inside(() => db().alertRule.update({ where: { id: ids.rule }, data: { threshold: 180 } }))
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran.ok).toBe(false)
    expect(ran.error).toContain('the facts moved')
    expect((await ruleRow(ids.rule)).threshold).toBe(180)
    await inside(() => db().alertRule.update({ where: { id: ids.rule }, data: { threshold: 100 } }))
  })

  it('a new rule notifies the Nexus log only; its undo switches it off', async () => {
    const approvalId = await askAndRun('set-alert-rule', { name: 'eBay errors', metric: 'errorRate', operator: 'gte', threshold: 0.3, channel: 'ebay', windowMinutes: 30 })
    const change = await changeOf(approvalId)
    const ruleId = (change.after as { ruleId: string }).ruleId
    expect(await ruleRow(ruleId)).toMatchObject({ name: 'eBay errors', metric: 'errorRate', operator: 'gte', threshold: 0.3, channel: 'EBAY', windowMinutes: 30, enabled: true, notificationChannels: ['log'] })
    const asked = await undo(approvalId)
    expect(asked.preview).toMatchObject({ changes: { enabled: { from: true, to: false } } })
    expect(await approveAndRun(asked.approvalId!)).toMatchObject({ ok: true })
    expect((await ruleRow(ruleId)).enabled).toBe(false)
  })

  it('auto stays inside its limits: small threshold moves only, no new rules, nothing switched off', () => {
    const tool = getTool('set-alert-rule')!
    const limits = tool.limits!.parse({}) as Record<string, unknown>
    const update = (pct: number | null, changes: Record<string, unknown> = { threshold: { from: 100, to: 100 + (pct ?? 0) } }) =>
      ({ mode: 'update', rule: 'Queue deep', changes, thresholdChangePct: pct })
    expect(tool.withinLimits!(null, limits)).toBeTypeOf('string')
    expect(tool.withinLimits!(update(50), limits)).toBeNull()
    expect(tool.withinLimits!(update(-60), limits)).toMatch(/60 %/)
    expect(tool.withinLimits!(update(null), limits)).toMatch(/percent/)
    expect(tool.withinLimits!({ mode: 'create', rule: 'New', changes: {} }, limits)).toMatch(/new alert rule/)
    expect(tool.withinLimits!({ mode: 'create', rule: 'New', changes: {} }, { ...limits, allowNewRules: true })).toBeNull()
    expect(tool.withinLimits!(update(null, { enabled: { from: true, to: false } }), limits)).toMatch(/off/)
    expect(tool.withinLimits!(update(null, { name: { from: 'a', to: 'b' } }), limits)).toBeNull()
  })
})

describe('P7 W2 — acknowledge-alerts', { timeout: TIMEOUT }, () => {
  it('the dry run lists what changes and what is already done; writes nothing; refuses someone else’s notification', async () => {
    const { result } = await dryRun(ALL(), 'acknowledge-alerts', { alertEventIds: [ids.e1, ids.e3], notificationIds: [ids.n1], action: 'acknowledge' })
    expect(result).toMatchObject({
      ok: true,
      preview: {
        action: 'acknowledge-alerts', mode: 'acknowledge', count: 2,
        events: [{ alertEventId: ids.e1, rule: 'Queue deep', status: { from: 'TRIGGERED', to: 'ACKNOWLEDGED' } }],
        notifications: [{ notificationId: ids.n1, title: 'Queue deep fired', read: { from: false, to: true } }],
        unchanged: [expect.stringContaining('Error rate')],
      },
    })
    expect((await eventRow(ids.e1)).status).toBe('TRIGGERED')
    expect((await noteRow(ids.n1)).readAt).toBeNull()
    expect((await dryRun(ALL(), 'acknowledge-alerts', { notificationIds: [ids.nOther], action: 'acknowledge' })).result).toEqual({ ok: false, error: 'Notification not found' })
    expect((await dryRun(ALL(), 'acknowledge-alerts', { alertEventIds: [ids.e3], action: 'acknowledge' })).result?.error).toMatch(/Nothing to change/)
  })

  it('approved: acknowledged by the person, notification read; undo puts both back exactly', async () => {
    const approvalId = await askAndRun('acknowledge-alerts', { alertEventIds: [ids.e1], notificationIds: [ids.n1], action: 'acknowledge', note: 'looking into it' })
    expect(await eventRow(ids.e1)).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: 'Olga Organize (Claude)', notes: 'looking into it' })
    expect((await noteRow(ids.n1)).readAt).toBeInstanceOf(Date)
    const asked = await undo(approvalId)
    expect(await approveAndRun(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await eventRow(ids.e1)).toMatchObject({ status: 'TRIGGERED', acknowledgedAt: null, acknowledgedBy: null, notes: null })
    expect((await noteRow(ids.n1)).readAt).toBeNull()
  })

  it('resolve also stops the rule counting as fired; undo restores the earlier acknowledgement', async () => {
    const approvalId = await askAndRun('acknowledge-alerts', { alertEventIds: [ids.e3], action: 'resolve' })
    expect(await eventRow(ids.e3)).toMatchObject({ status: 'RESOLVED', acknowledgedBy: 'Earlier Person' })
    const asked = await undo(approvalId)
    expect(await approveAndRun(asked.approvalId!)).toMatchObject({ ok: true })
    expect(await eventRow(ids.e3)).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: 'Earlier Person', notes: 'seen', resolvedAt: null })
  })

  it('handed back when someone acknowledged it in the meantime', async () => {
    const queued = await ask(ALL(), 'acknowledge-alerts', { alertEventIds: [ids.e2], action: 'acknowledge' })
    await inside(() => db().alertEvent.update({ where: { id: ids.e2 }, data: { status: 'ACKNOWLEDGED', acknowledgedBy: 'Fast Person' } }))
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran.ok).toBe(false)
    expect((await eventRow(ids.e2)).acknowledgedBy).toBe('Fast Person')
    await inside(() => db().alertEvent.update({ where: { id: ids.e2 }, data: { status: 'TRIGGERED', acknowledgedBy: null } }))
  })

  it('auto: acknowledging a few, never resolving without a person, never too many', () => {
    const tool = getTool('acknowledge-alerts')!
    const limits = tool.limits!.parse({}) as Record<string, unknown>
    expect(tool.withinLimits!(null, limits)).toBeTypeOf('string')
    expect(tool.withinLimits!({ mode: 'acknowledge', count: 3 }, limits)).toBeNull()
    expect(tool.withinLimits!({ mode: 'acknowledge', count: 21 }, limits)).toMatch(/21/)
    expect(tool.withinLimits!({ mode: 'resolve', count: 1 }, limits)).toMatch(/resolv/)
    expect(tool.withinLimits!({ mode: 'restore', count: 2 }, limits)).toBeNull()
  })
})

describe('P7 W2 — organize-image-library', { timeout: TIMEOUT }, () => {
  it('the dry run shows each asset’s folder and tags before and after, and writes nothing', async () => {
    const before = [await assetState(ids.a1), await assetState(ids.a2)]
    const { result } = await dryRun(ALL(), 'organize-image-library', { assetIds: [`da_${ids.a1}`, ids.a2], folderId: ids.folderB, tagIds: [ids.tagBlue] })
    expect(result).toMatchObject({
      ok: true,
      preview: {
        action: 'organize-image-library',
        totals: { assets: 2, changing: 2 },
        assets: [
          { label: 'Jacket front', changes: { folder: { from: 'Lookbook', to: 'Packshots' }, tags: { from: ['red'], to: ['blue', 'red'] } } },
          { label: 'Jacket back', changes: { folder: { from: null, to: 'Packshots' }, tags: { from: [], to: ['blue'] } } },
        ],
      },
    })
    expect([await assetState(ids.a1), await assetState(ids.a2)]).toEqual(before)
  })

  it('refuses product photos, a label for several assets, unknown assets, folders and tags, and a change that changes nothing', async () => {
    expect((await dryRun(ALL(), 'organize-image-library', { assetIds: ['pi_photo-1'], folderId: ids.folderA })).result?.error).toMatch(/product photo/)
    expect((await dryRun(ALL(), 'organize-image-library', { assetIds: [ids.a1, ids.a2], label: 'Same' })).result?.error).toMatch(/one asset/)
    expect((await dryRun(ALL(), 'organize-image-library', { assetIds: ['missing-asset'], folderId: ids.folderA })).result).toEqual({ ok: false, error: 'Asset not found' })
    expect((await dryRun(ALL(), 'organize-image-library', { assetIds: [ids.a2], folderId: 'missing-folder' })).result).toEqual({ ok: false, error: 'Folder not found' })
    expect((await dryRun(ALL(), 'organize-image-library', { assetIds: [ids.a2], tagIds: ['missing-tag'] })).result).toEqual({ ok: false, error: 'Tag not found' })
    expect((await dryRun(ALL(), 'organize-image-library', { assetIds: [ids.a1], folderId: ids.folderA })).result?.error).toMatch(/Nothing would change/)
    expect((await dryRun(ALL(), 'organize-image-library', { assetIds: [ids.a1] })).result?.error).toMatch(/Say what to change/)
  })

  it('approved, both move and gain the tag; undo puts each back where it was, with its own tags', async () => {
    const approvalId = await askAndRun('organize-image-library', { assetIds: [ids.a1, ids.a2], folderId: ids.folderB, tagIds: [ids.tagBlue] })
    expect(await assetState(ids.a1)).toEqual({ label: 'Jacket front', folderId: ids.folderB, tagIds: [ids.tagBlue, ids.tagRed].sort() })
    expect(await assetState(ids.a2)).toEqual({ label: 'Jacket back', folderId: ids.folderB, tagIds: [ids.tagBlue] })
    const asked = await undo(approvalId)
    expect(await approveAndRun(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await assetState(ids.a1)).toEqual({ label: 'Jacket front', folderId: ids.folderA, tagIds: [ids.tagRed] })
    expect(await assetState(ids.a2)).toEqual({ label: 'Jacket back', folderId: null, tagIds: [] })
  })

  it('a label, a tag taken off, and back', async () => {
    const approvalId = await askAndRun('organize-image-library', { assetIds: [ids.a1], label: 'Jacket front, studio', tagIds: [ids.tagRed], tagAction: 'remove' })
    expect(await assetState(ids.a1)).toEqual({ label: 'Jacket front, studio', folderId: ids.folderA, tagIds: [] })
    const asked = await undo(approvalId)
    expect(await approveAndRun(asked.approvalId!)).toMatchObject({ ok: true })
    expect(await assetState(ids.a1)).toEqual({ label: 'Jacket front', folderId: ids.folderA, tagIds: [ids.tagRed] })
  })

  it('handed back when the asset moved after the approval', async () => {
    const queued = await ask(ALL(), 'organize-image-library', { assetIds: [ids.a2], folderId: ids.folderA })
    await inside(() => db().digitalAsset.update({ where: { id: ids.a2 }, data: { folderId: ids.folderB } }))
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran.ok).toBe(false)
    expect((await assetState(ids.a2)).folderId).toBe(ids.folderB)
    await inside(() => db().digitalAsset.update({ where: { id: ids.a2 }, data: { folderId: null } }))
  })

  it('auto: a handful of assets at once', () => {
    const tool = getTool('organize-image-library')!
    const limits = tool.limits!.parse({}) as Record<string, unknown>
    expect(tool.withinLimits!(null, limits)).toBeTypeOf('string')
    expect(tool.withinLimits!({ totals: { assets: 3, changing: 3 } }, limits)).toBeNull()
    expect(tool.withinLimits!({ totals: { assets: 30, changing: 26 } }, limits)).toMatch(/26/)
  })
})

describe('P7 W2 — another business’s rows are not found (business profiles on)', { timeout: TIMEOUT }, () => {
  it('rules, events, notifications, assets, folders and tags of B are not found from A; nothing is queued', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    try {
      const before = await pending()
      const calls: Array<[string, Record<string, unknown>]> = [
        ['set-alert-rule', { ruleId: ids.bRule, threshold: 7 }],
        ['acknowledge-alerts', { alertEventIds: [ids.bEvent], action: 'acknowledge' }],
        ['acknowledge-alerts', { notificationIds: [ids.bNote], action: 'acknowledge' }],
        ['organize-image-library', { assetIds: [ids.bAsset], folderId: ids.folderA }],
        ['organize-image-library', { assetIds: [ids.a2], folderId: ids.bFolder }],
        ['organize-image-library', { assetIds: [ids.a2], tagIds: [ids.bTag] }],
      ]
      for (const [tool, args] of calls) {
        const asked = await ask(ALL(), tool, args)
        expect({ tool, ok: asked.ok, error: asked.error }).toMatchObject({ tool, ok: false, error: expect.stringMatching(/not found/) })
        expect(JSON.stringify(asked)).not.toContain('BRAVO')
      }
      expect(await pending()).toBe(before)
      // Control: inside B, the same rows are found.
      const inB = await ask({ ...ALL(), workspace: business(B) }, 'acknowledge-alerts', { alertEventIds: [ids.bEvent], notificationIds: [ids.bNote], action: 'acknowledge' }, B)
      expect(inB, inB.error).toMatchObject({ ok: true, mode: 'queued' })
      expect(JSON.stringify(inB.preview)).toContain('BRAVO')
    } finally {
      vi.unstubAllEnvs()
      vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
      vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
    }
  })
})
