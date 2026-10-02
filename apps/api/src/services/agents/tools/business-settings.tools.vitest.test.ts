/**
 * MCP full control P10 — set-business-settings, through the gate a person and Claude use (runOrQueueTool, then
 * scheduleApproval + commitScheduledApproval as the Approvals page and the sweep run them), on PGlite with the
 * production schema and business policies.
 *
 *   refused    without settings.workspace.edit; a wrongly made call; a bad fiscal value (the settings page's own
 *              checks); nothing to change; a P.IVA left with neither an SDI code nor a PEC address
 *   preview    from → to of every field that changes, and the legal identity as documents will show it; the dry
 *              run writes nothing
 *   run        brand fields through the settings page's own save (and its settings audit row), the business name
 *              and primary market as Settings › Business saves them; the change is recorded
 *   stale      a value that moved after the approval hands it back, and nothing is written
 *   undo       a new request of the same tool with the old values, through the same gate; refused once a value
 *              moved since
 *   business   another business's settings are never read or written (profiles on); profiles off works too
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

const A = LEGACY_WORKSPACE_ID
const B = 'p10_settings_bravo'
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { approver: '' }

const person = (permissions: Set<string>, workspaceId = A): UserPrincipal => ({
  kind: 'user', userId: ids.approver, label: 'Sara Settings', permissions: { isOwner: false, permissions }, workspace: business(workspaceId), via: 'claude', oauthGrantId: 'grant-p10',
})
const ALL = (workspaceId = A) => person(EVERYTHING, workspaceId)
const db = () => database.client

async function ask(tool: string, args: Record<string, unknown>, workspaceId = A) {
  const run = await inside(() => db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: ids.approver, via: 'claude', oauthGrantId: 'grant-p10' } }), workspaceId)
  return inside(() => runOrQueueTool(tool, args, ALL(workspaceId), run.id, { forceAsk: true }), workspaceId)
}
async function approveAndRun(approvalId: string, workspaceId = A) {
  const parked = await inside(() => scheduleApproval({ id: approvalId, actor: ALL(workspaceId) }), workspaceId)
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }), workspaceId)
  return inside(() => commitScheduledApproval(approvalId), workspaceId)
}
async function preview(args: Record<string, unknown>, who = ALL()) {
  try {
    return (await callTool(who, 'set-business-settings', args)).visible
  } catch (error) {
    if (error instanceof ToolAccessError) return { ok: false, refused: error.code }
    throw error
  }
}
const brand = (workspaceId = A) => inside(() => db().brandSettings.findFirstOrThrow(), workspaceId)
const account = (workspaceId = A) => inside(() => db().accountSettings.findFirstOrThrow(), workspaceId)
const settingsAudits = (workspaceId = A) => inside(() => db().auditLog.count({ where: { entityType: 'Settings' } }), workspaceId)
const changeOf = (approvalId: string) => inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  const role = await client.role.create({ data: { key: `P10_${randomUUID().slice(0, 8)}`, name: 'Settings tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const approver = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Sara Settings' } })
  ids.approver = approver.id
  await client.userRole.create({ data: { userId: approver.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: 'Bravo settings business', createdByUserId: approver.id, creationKey: randomUUID() } })
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: approver.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  for (const [workspaceId, mark] of [[A, 'Alpha'], [B, 'BRAVO']] as const) {
    await inside(async () => {
      await client.accountSettings.deleteMany({})
      await client.brandSettings.deleteMany({})
      await client.accountSettings.create({ data: { businessName: `${mark} Trading`, country: 'IT', currency: 'EUR', timezone: 'Europe/Rome', primaryMarketplace: 'IT' } })
      await client.brandSettings.create({ data: { companyName: `${mark} Srl`, addressLines: ['Via Roma 1', '00100 Roma'], piva: '00000000000', sdiCode: 'ABC1234', vatScheme: 'ORDINARIO', websiteUrl: `https://${mark.toLowerCase()}.example.test` } })
    }, workspaceId)
  }
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('P10 — set-business-settings refuses what it should', { timeout: TIMEOUT }, () => {
  it('needs settings.workspace.edit, and a well-made call', async () => {
    expect(await preview({ websiteUrl: 'https://new.example.test' }, person(new Set([F.aiRun, F.settingsView])))).toMatchObject({ refused: 'forbidden' })
    expect(await preview({ vatScheme: 'MAYBE' })).toMatchObject({ refused: 'invalid_arguments' })
    expect(await preview({ displayName: 'X' })).toMatchObject({ refused: 'invalid_arguments' })
    expect(await preview({ addressLines: Array.from({ length: 7 }, () => 'line') })).toMatchObject({ refused: 'invalid_arguments' })
  })

  it('refuses a bad fiscal value with the settings page’s own words, nothing to change, and a P.IVA without routing', async () => {
    expect(await preview({ piva: '12345678901' })).toEqual({ ok: false, error: 'Not changed: piva — P.IVA checksum failed — last digit does not match the others.' })
    expect(await preview({ primaryMarketplace: 'ZZ' })).toEqual({ ok: false, error: 'Not changed: Primary marketplace must be a valid country code.' })
    expect(await preview({ companyName: 'Alpha Srl', primaryMarketplace: 'it' })).toEqual({ ok: false, error: 'Nothing to change: every value given is already the business’s.' })
    expect(await preview({})).toEqual({ ok: false, error: 'Nothing to change: name at least one setting and its new value.' })
    // The settings page checks the OLD SDI code when a save clears it; this tool checks what would be stored.
    const routing = await preview({ sdiCode: null })
    expect(routing).toMatchObject({ ok: false })
    expect((routing as { error: string }).error).toContain('routing —')
  })
})

describe('P10 — preview, run, record', { timeout: TIMEOUT }, () => {
  it('previews from → to and the legal identity, and writes nothing', async () => {
    const before = { brand: await brand(), account: await account(), audits: await settingsAudits() }
    const result = await preview({ companyName: '  Alpha Holding Srl ', pecEmail: 'alpha@pec.example.test', displayName: 'Alpha Group', websiteUrl: null })
    expect(result).toMatchObject({
      ok: true,
      preview: {
        action: 'set-business-settings',
        changes: {
          companyName: { from: 'Alpha Srl', to: 'Alpha Holding Srl' },
          pecEmail: { from: null, to: 'alpha@pec.example.test' },
          websiteUrl: { from: 'https://alpha.example.test', to: null },
          businessName: { from: 'Alpha Trading', to: 'Alpha Group' },
        },
        legal: { companyName: 'Alpha Holding Srl', addressLines: ['Via Roma 1', '00100 Roma'], piva: '00000000000', sdiCode: 'ABC1234', pecEmail: 'alpha@pec.example.test', vatScheme: 'ORDINARIO' },
      },
    })
    expect(JSON.stringify(result)).not.toContain('BRAVO')
    expect({ brand: await brand(), account: await account(), audits: await settingsAudits() }).toEqual(before)
  })

  it('a person approves it: saved as the settings pages save, audited, recorded; undo puts it back through the same gate', async () => {
    const audits = await settingsAudits()
    const queued = await ask('set-business-settings', { companyName: 'Alpha Holding Srl', sdiCode: 'xyz9876', displayName: 'Alpha Group', primaryMarketplace: 'de' })
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(await approveAndRun(queued.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await brand()).toMatchObject({ companyName: 'Alpha Holding Srl', sdiCode: 'XYZ9876' })
    expect(await account()).toMatchObject({ businessName: 'Alpha Group', primaryMarketplace: 'DE' })
    // One settings audit row per settings page: company and account.
    expect(await settingsAudits()).toBe(audits + 2)
    const change = await changeOf(queued.approvalId!)
    expect(change).toMatchObject({
      toolName: 'set-business-settings',
      reversibility: 'full',
      before: { companyName: 'Alpha Srl', sdiCode: 'ABC1234', businessName: 'Alpha Trading', primaryMarketplace: 'IT' },
      after: { companyName: 'Alpha Holding Srl', sdiCode: 'XYZ9876', businessName: 'Alpha Group', primaryMarketplace: 'DE' },
      undoTool: 'set-business-settings',
    })

    const undo = await ask('undo-change', { changeId: change.id })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued', undoes: change.id })
    expect(undo.preview).toMatchObject({ changes: { companyName: { from: 'Alpha Holding Srl', to: 'Alpha Srl' }, primaryMarketplace: { from: 'DE', to: 'IT' } } })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await brand()).toMatchObject({ companyName: 'Alpha Srl', sdiCode: 'ABC1234' })
    expect(await account()).toMatchObject({ businessName: 'Alpha Trading', primaryMarketplace: 'IT' })
    expect((await changeOf(queued.approvalId!)).undoneAt).toBeInstanceOf(Date)
  })

  it('stale: a value that moved after the approval hands it back, and nothing is written', async () => {
    const queued = await ask('set-business-settings', { websiteUrl: 'https://alpha-new.example.test' })
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    await inside(() => db().brandSettings.updateMany({ data: { websiteUrl: 'https://someone-else.example.test' } }))
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran).toMatchObject({ ok: false })
    expect(ran.error).toContain('the facts moved')
    expect((await brand()).websiteUrl).toBe('https://someone-else.example.test')
    await inside(() => db().brandSettings.updateMany({ data: { websiteUrl: 'https://alpha.example.test' } }))
  })

  it('undo is refused once a value moved since', async () => {
    const queued = await ask('set-business-settings', { contactPhone: '+39 000 111' })
    expect(await approveAndRun(queued.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    await inside(() => db().brandSettings.updateMany({ data: { contactPhone: '+39 999' } }))
    const undo = await ask('undo-change', { approvalId: queued.approvalId })
    expect(undo).toMatchObject({ ok: false })
    expect(undo.error).toContain('changed since')
    await inside(() => db().brandSettings.updateMany({ data: { contactPhone: null } }))
  })
})

describe('P10 — one business at a time', { timeout: TIMEOUT }, () => {
  it('each business reads and saves its own settings only', async () => {
    const inB = await preview({ websiteUrl: 'https://bravo-new.example.test' }, ALL(B))
    expect(inB).toMatchObject({ ok: true, preview: { changes: { websiteUrl: { from: 'https://bravo.example.test' } }, legal: { companyName: 'BRAVO Srl' } } })
    const inA = await preview({ websiteUrl: 'https://bravo-new.example.test' }, ALL(A))
    expect(JSON.stringify(inA)).not.toContain('BRAVO')
    const bravoBefore = await brand(B)
    const queued = await ask('set-business-settings', { companyName: 'Alpha Renamed Srl' })
    expect(await approveAndRun(queued.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await brand(B)).toEqual(bravoBefore)
    await inside(() => db().brandSettings.updateMany({ data: { companyName: 'Alpha Srl' } }))
  })
})
