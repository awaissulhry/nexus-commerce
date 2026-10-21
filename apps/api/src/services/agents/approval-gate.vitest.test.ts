/**
 * MCP.1 — the approval gate names its principal.
 *
 * Before MCP.1 the copilot's approve route needed only `ai.run`, so a person
 * who may not change prices could approve a price change, and it recorded the
 * decider as nobody. These lock down the fix: a person approves only what
 * they could have done, the decision carries their name, and the stored
 * preview stays whole while the caller gets a filtered one.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentTool } from './tool-types.js'

const handler = vi.fn()
const execute = vi.fn()

const TOOLS: Record<string, AgentTool> = {
  'change-price': {
    name: 'change-price',
    title: 'Test tool',
    category: 'pricing',
    description: 'test tool',
    riskTier: 'high',
    readOnly: false,
    alwaysAsk: true,
    requires: ['products.price.edit'],
    input: z.object({}).loose(),
    handler,
    execute,
  },
  // Item 7 — a change with a secret argument (as create-meta-boost's adCode); the schema refuses anything but the code.
  'boost-code': {
    name: 'boost-code',
    title: 'Test boost',
    category: 'advertising',
    description: 'test tool',
    riskTier: 'high',
    readOnly: false,
    alwaysAsk: true,
    requires: ['products.price.edit'],
    secretArgs: ['adCode'],
    input: z.object({ adCode: z.string().regex(/^[A-Z0-9_]+$/), name: z.string().optional() }),
    handler,
    execute,
  },
  // C6 — the plan control tool, as submit-change-plan: its dry run hands the plan to the gate.
  'submit-change-plan': {
    name: 'submit-change-plan',
    title: 'Submit a change plan',
    category: 'approvals',
    description: 'test tool',
    riskTier: 'high',
    readOnly: false,
    control: true,
    requires: [],
    input: z.object({}).loose(),
    handler: async (args) => ({ ok: true, preview: {}, plan: { title: String(args.title), steps: args.steps as Array<{ tool: string; args: Record<string, unknown> }> } }),
  },
}

vi.mock('./tool-registry.js', () => ({
  getTool: (name: string) => TOOLS[name],
  listTools: () => Object.values(TOOLS),
}))
vi.mock('./tool-policy.service.js', () => ({
  resolveToolPolicy: vi.fn(async (name: string) =>
    TOOLS[name]
      ? { name, riskTier: 'high', enabled: true, requiresApproval: true, readOnly: false }
      : null,
  ),
}))
vi.mock('../../db.js', () => {
  const db: Record<string, unknown> = {
    agentApproval: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    agentRun: { create: vi.fn() },
    agentPlanStep: { createMany: vi.fn() },
    agentChange: { create: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(async () => []) },
    // C8 — the change record and its events are written in one transaction.
    eventOutbox: { create: vi.fn(), createMany: vi.fn() },
  }
  db.$transaction = vi.fn(async (work: (tx: unknown) => unknown) => work(db))
  return { default: db }
})

import prisma from '../../db.js'
import { __test as cryptoTest } from '../../lib/crypto.js'
import { decideApproval, listApprovals, requestApproval, runOrQueueTool } from './approval-gate.service.js'
import { planHashOf } from './change-plan.service.js'
import { systemPrincipal, type UserPrincipal } from './call-tool.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { resolveToolPolicy } from './tool-policy.service.js'
import { __toolRateTest } from './tool-rate.js'

const db = vi.mocked(prisma, true)

// A real request carries the business the workspace hook verified; production runs with profiles on.
const BUSINESS = { workspaceId: 'ws_alpha_0001', actorUserId: 'u1', membershipId: 'm1', roleKeys: [] }

function person(permissions: string[]): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u1',
    label: 'Awais',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    workspace: BUSINESS,
    via: 'app',
  }
}

const PRICE_PERSON = person(['ai.run', 'products.price.edit'])
const VIEWER = person(['ai.run', 'products.view'])

beforeEach(() => {
  vi.clearAllMocks()
  __toolRateTest.reset()
  handler.mockResolvedValue({ ok: true, preview: { price: { from: 10, to: 12 }, costPrice: 7 } })
  execute.mockResolvedValue({ ok: true, data: { changed: true, costPrice: 7 } })
  db.agentApproval.findUnique.mockResolvedValue({
    id: 'a1',
    status: 'pending',
    toolName: 'change-price',
    args: { price: 12 },
  } as never)
  db.agentApproval.updateMany.mockResolvedValue({ count: 1 } as never)
  db.agentApproval.update.mockResolvedValue({} as never)
  db.agentApproval.create.mockResolvedValue({ id: 'a1' } as never)
})

describe('MCP.1 — who may approve', () => {
  it('refuses a person who could not make the change, before claiming the row', async () => {
    const out = await decideApproval('a1', 'approve', VIEWER)
    expect(out).toMatchObject({ ok: false, code: 'forbidden' })
    expect(out.error).toContain('products.price.edit')
    expect(db.agentApproval.updateMany).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('lets a person with the permission approve, under their own name and id', async () => {
    const out = await decideApproval('a1', 'approve', PRICE_PERSON)
    expect(out).toMatchObject({ ok: true, status: 'executed' })
    expect(db.agentApproval.updateMany.mock.calls[0]![0]!.data).toMatchObject({
      status: 'executing',
      decidedBy: 'Awais',
    })
    expect(execute).toHaveBeenCalledWith({ price: 12 }, expect.objectContaining({ userId: 'u1' }))
  })

  it('hands the approver a result without money they may not see', async () => {
    const out = await decideApproval('a1', 'approve', PRICE_PERSON)
    expect(out.result).toEqual({ changed: true })
  })

  it('anyone who may use the assistant can say no', async () => {
    const out = await decideApproval('a1', 'reject', VIEWER, 'not now')
    expect(out).toMatchObject({ ok: true, status: 'rejected' })
    expect(db.agentApproval.update.mock.calls[0]![0]!.data).toMatchObject({ decidedBy: 'Awais' })
  })

  it('the sweep runs a decision already taken, under the decider’s name', async () => {
    const out = await decideApproval('a1', 'approve', systemPrincipal('Awais'))
    expect(out.ok).toBe(true)
    expect(execute).toHaveBeenCalledWith({ price: 12 }, expect.objectContaining({ userId: 'Awais' }))
  })
})

describe('MCP.4 — a request records its front door', () => {
  it('an in-app request is recorded as via the app', async () => {
    db.agentRun.create.mockResolvedValue({ id: 'run9' } as never)
    await requestApproval('change-price', { price: 12 }, PRICE_PERSON)
    expect(db.agentRun.create.mock.calls[0]![0]!.data).toMatchObject({
      userId: 'u1',
      via: 'app',
      oauthGrantId: null,
    })
  })

  it('a Claude request is recorded with its connection', async () => {
    db.agentRun.create.mockResolvedValue({ id: 'run9' } as never)
    await requestApproval('change-price', { price: 12 }, { ...PRICE_PERSON, via: 'claude', oauthGrantId: 'grant1' })
    expect(db.agentRun.create.mock.calls[0]![0]!.data).toMatchObject({ via: 'claude', oauthGrantId: 'grant1' })
  })
})

describe('MCP.1 — queueing', () => {
  it('stores the whole preview and returns the filtered one', async () => {
    const out = await runOrQueueTool('change-price', { price: 12 }, PRICE_PERSON, 'run1')
    expect(out).toEqual({
      ok: true,
      mode: 'queued',
      approvalId: 'a1',
      preview: { price: { from: 10, to: 12 } },
    })
    expect(db.agentApproval.create.mock.calls[0]![0]!.data).toMatchObject({
      preview: { price: { from: 10, to: 12 }, costPrice: 7 },
    })
  })

  it('MCP.2 — the operator’s hourly limit refuses the request over it, and queues nothing', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue({
      name: 'change-price',
      riskTier: 'high',
      enabled: true,
      requiresApproval: true,
      readOnly: false,
      rateLimitPerHour: 1,
    } as never)
    expect((await runOrQueueTool('change-price', { price: 12 }, PRICE_PERSON, 'run1')).mode).toBe('queued')
    const over = await runOrQueueTool('change-price', { price: 13 }, PRICE_PERSON, 'run1')
    expect(over).toMatchObject({ ok: false, mode: 'error' })
    expect(over.error).toContain('limited to 1 call per hour')
    expect(db.agentApproval.create).toHaveBeenCalledTimes(1)
  })

  it('MCP.3 — stores the arguments as asked, while the tool sees the parsed ones', async () => {
    await runOrQueueTool('change-price', { price: 12, note: 'kept on the request' }, PRICE_PERSON, 'run1')
    expect(db.agentApproval.create.mock.calls[0]![0]!.data).toMatchObject({
      args: { price: 12, note: 'kept on the request' },
    })
  })

  it('a person without the permission cannot even queue it', async () => {
    const out = await runOrQueueTool('change-price', { price: 12 }, VIEWER, 'run1')
    expect(out).toMatchObject({ ok: false, mode: 'error' })
    expect(handler).not.toHaveBeenCalled()
    expect(db.agentApproval.create).not.toHaveBeenCalled()
  })
})

describe('C1 — execute knows the approval it carries out', () => {
  it('passes the approval id, the stored preview and the door of the request', async () => {
    db.agentApproval.findUnique.mockResolvedValue({
      id: 'a1', status: 'pending', toolName: 'change-price', args: { price: 12 },
      preview: { price: { from: 10, to: 12 }, costPrice: 7 },
      agentRun: { via: 'claude', mode: null },
    } as never)
    await decideApproval('a1', 'approve', PRICE_PERSON)
    expect(execute.mock.calls[0]![1]).toMatchObject({
      userId: 'u1',
      approvalId: 'a1',
      approvedPreview: { price: { from: 10, to: 12 }, costPrice: 7 },
      via: 'claude',
    })
  })

  it('AA-W2-1 — and who decided it: a person in Nexus, the person who asked with their code in Claude, or the rule', async () => {
    // NA — under "Claude's changes need no approval": the person who asked, in Claude — a person's approval.
    const cases: Array<[string | null, string, boolean]> = [
      [null, 'nexus', true], ['nexus', 'nexus', true], ['nexus-step-up', 'nexus', true], ['claude-confirm', 'claude', true], ['auto', 'auto', false],
      ['no-approval', 'claude', true],
    ]
    for (const [decisionVia, decidedVia, byPerson] of cases) {
      execute.mockClear()
      db.agentApproval.findUnique.mockResolvedValue({
        id: 'a1', status: 'pending', toolName: 'change-price', args: { price: 12 }, preview: null, decisionVia, agentRun: { via: 'claude', mode: null },
      } as never)
      await decideApproval('a1', 'approve', PRICE_PERSON)
      const ctx = execute.mock.calls[0]![1]
      expect(ctx.decidedVia, String(decisionVia)).toBe(decidedVia)
      expect(ctx.approvedByPerson === true, String(decisionVia)).toBe(byPerson)
    }
  })

  it('a fleet request runs as the fleet; one from in-process code as the system', async () => {
    db.agentApproval.findUnique.mockResolvedValue({
      id: 'a1', status: 'pending', toolName: 'change-price', args: { price: 12 }, preview: null, agentRun: { via: null, mode: 'council' },
    } as never)
    await decideApproval('a1', 'approve', PRICE_PERSON)
    expect(execute.mock.calls[0]![1]).toMatchObject({ via: 'fleet' })
    db.agentApproval.findUnique.mockResolvedValue({
      id: 'a1', status: 'pending', toolName: 'change-price', args: { price: 12 }, preview: null, agentRun: { via: null, mode: null },
    } as never)
    await decideApproval('a1', 'approve', PRICE_PERSON)
    expect(execute.mock.calls[1]![1]).toMatchObject({ via: 'system' })
  })
})

describe('C2 — an executed approval keeps what it changed', () => {
  it('records before → after, the door, the connection and who ran it, after the approval is marked executed', async () => {
    db.agentApproval.findUnique.mockResolvedValue({
      id: 'a1', status: 'pending', toolName: 'change-price', args: { price: 12 }, preview: null, decisionVia: 'auto',
      agentRun: { via: 'claude', mode: null, oauthGrantId: 'grant-1' },
    } as never)
    execute.mockResolvedValue({ ok: true, data: { changed: true }, change: { before: { price: 10 }, after: { price: 12 } } })
    db.agentChange.create.mockResolvedValue({ id: 'c1' } as never)
    db.agentChange.findMany.mockResolvedValue([{ id: 'c0' }] as never)
    db.agentChange.updateMany.mockResolvedValue({ count: 1 } as never)
    // Bound to the business, as the Approvals routes and the sweep are: the events carry it.
    const out = await withWorkspace(BUSINESS, () => decideApproval('a1', 'approve', PRICE_PERSON))
    expect(out).toMatchObject({ ok: true, status: 'executed' })
    expect(db.agentChange.create.mock.calls[0]![0]!.data).toMatchObject({
      approvalId: 'a1', toolName: 'change-price', via: 'claude', oauthGrantId: 'grant-1', executedByUserId: 'u1',
      reversibility: 'none', before: { price: 10 }, after: { price: 12 }, outbound: false,
    })
    // The status first: recording comes after the change ran, so it can never make it run twice.
    expect(db.agentApproval.update.mock.invocationCallOrder[0]).toBeLessThan(db.agentChange.create.mock.invocationCallOrder[0])
    // This approval may have been an undo: the change it put back is marked undone.
    expect(db.agentChange.findMany.mock.calls[0]![0]).toMatchObject({ where: { undoneByApprovalId: 'a1', undoneAt: null } })
    expect(db.agentChange.updateMany.mock.calls[0]![0]).toMatchObject({ where: { id: { in: ['c0'] }, undoneAt: null } })
    // C8 — with its events, in the same transaction: ids and names only.
    const events = (db.eventOutbox.create.mock.calls as Array<[{ data: { type: string; payload: unknown } }]>).map(([arg]) => [arg.data.type, arg.data.payload])
    expect(events).toEqual([
      ['agent.change.executed', { changeId: 'c1', approvalId: 'a1', tool: 'change-price', via: 'claude', decisionVia: 'auto' }],
      ['agent.change.undone', { changeId: 'c0', undoneByApprovalId: 'a1' }],
    ])
  })

  it('a failure to record is logged, and the executed change stays executed', async () => {
    db.agentChange.create.mockRejectedValue(new Error('database away'))
    const out = await decideApproval('a1', 'approve', PRICE_PERSON)
    expect(out).toMatchObject({ ok: true, status: 'executed' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(db.agentApproval.update.mock.calls.map((c) => (c[0] as { data: { status: string } }).data.status)).toEqual(['executed'])
  })

  it('a failed run records nothing', async () => {
    execute.mockResolvedValue({ ok: false, error: 'refused' })
    await decideApproval('a1', 'approve', PRICE_PERSON)
    expect(db.agentChange.create).not.toHaveBeenCalled()
  })
})

describe('Item 7 — a secret argument is stored encrypted, and opened only for the tool', () => {
  beforeAll(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}) // the once-per-process "no KMS, env key" notice
  })
  beforeEach(() => {
    // A made-up key for this run only (never a real one); KMS stays unset.
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
    vi.stubEnv('NEXUS_KMS_KEY_ID', undefined)
    cryptoTest.resetKeyCache()
  })
  afterAll(() => {
    vi.unstubAllEnvs()
    cryptoTest.resetKeyCache()
  })
  const noKey = () => {
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', undefined)
    cryptoTest.resetKeyCache()
  }
  const storedArgs = () => (db.agentApproval.create.mock.calls[0]![0]!.data as unknown as { args: Record<string, unknown> }).args

  it('a call with no secret argument is stored as it came, and needs no key', async () => {
    noKey()
    expect(await runOrQueueTool('change-price', { price: 12 }, PRICE_PERSON, 'run1')).toMatchObject({ mode: 'queued' })
    expect(storedArgs()).toEqual({ price: 12 })
  })

  it('without a key a request with a secret is refused and nothing is stored (one change, a plan); the words name no value', async () => {
    noKey()
    const one = await runOrQueueTool('boost-code', { adCode: 'CODE_123' }, PRICE_PERSON, 'run1').catch((error: Error) => error)
    const plan = await runOrQueueTool('submit-change-plan', { title: 'Boosts', steps: [{ tool: 'boost-code', args: { adCode: 'CODE_123' } }] }, PRICE_PERSON, 'run1').catch((error: Error) => error)
    for (const error of [one, plan]) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('boost-code: Nexus could not encrypt its secret argument adCode (no encryption key is set up), so the request was not stored.')
    }
    expect(db.agentApproval.create).not.toHaveBeenCalled()
    expect(db.agentPlanStep.createMany).not.toHaveBeenCalled()
  })

  it('the approval keeps it sealed; the dry run read it in plain text', async () => {
    const out = await runOrQueueTool('boost-code', { adCode: 'CODE_123', name: 'x' }, PRICE_PERSON, 'run1')
    expect(out.mode).toBe('queued')
    expect(storedArgs()).toEqual({ adCode: { __enc: expect.stringMatching(/^v1:/) }, name: 'x' })
    expect(JSON.stringify(db.agentApproval.create.mock.calls[0]![0])).not.toContain('CODE_123')
    expect(handler).toHaveBeenCalledWith({ adCode: 'CODE_123', name: 'x' }, expect.anything())
  })

  it('the approved run opens it right before execute (the no-approval switch and the sweep commit through here too)', async () => {
    await runOrQueueTool('boost-code', { adCode: 'CODE_123' }, PRICE_PERSON, 'run1')
    db.agentApproval.findUnique.mockResolvedValue({ id: 'a1', status: 'pending', toolName: 'boost-code', args: storedArgs() } as never)
    const out = await decideApproval('a1', 'approve', systemPrincipal('Awais'))
    expect(out).toMatchObject({ ok: true, status: 'executed' })
    expect(execute).toHaveBeenCalledWith({ adCode: 'CODE_123' }, expect.anything())
  })

  it('a request stored before item 7 (plain text) still runs', async () => {
    db.agentApproval.findUnique.mockResolvedValue({ id: 'a1', status: 'pending', toolName: 'boost-code', args: { adCode: 'CODE_OLD' } } as never)
    expect((await decideApproval('a1', 'approve', PRICE_PERSON)).ok).toBe(true)
    expect(execute).toHaveBeenCalledWith({ adCode: 'CODE_OLD' }, expect.anything())
  })

  it('a stored code that cannot be opened runs nothing, and stays for a person', async () => {
    db.agentApproval.findUnique.mockResolvedValue({ id: 'a1', status: 'pending', toolName: 'boost-code', args: { adCode: { __enc: 'v1:AAAA.BBBB.CCCC' } } } as never)
    const out = await decideApproval('a1', 'approve', PRICE_PERSON)
    expect(out).toMatchObject({ ok: false })
    expect(out.error).toMatch(/could not be decrypted/)
    expect(execute).not.toHaveBeenCalled()
    expect(db.agentApproval.update.mock.calls.at(-1)![0]!.data).toMatchObject({ status: 'pending' })
  })

  it('the old Approvals list (GET /agent/approvals) shows a secret argument as the mask, sealed or plain', async () => {
    db.agentApproval.findMany.mockResolvedValue([
      { id: 'a1', toolName: 'boost-code', args: { adCode: { __enc: 'v1:AAAA.BBBB.CCCC' }, name: 'x' } },
      { id: 'a2', toolName: 'boost-code', args: { adCode: 'CODE_OLD' } },
      { id: 'a3', toolName: 'change-price', args: { price: 12 } },
    ] as never)
    const rows = await listApprovals()
    expect(rows.map((row) => row.args)).toEqual([{ adCode: '[redacted]', name: 'x' }, { adCode: '[redacted]' }, { price: 12 }])
  })

  it('the request button\'s run record keeps the mask', async () => {
    db.agentRun.create.mockResolvedValue({ id: 'run9' } as never)
    await requestApproval('boost-code', { adCode: 'CODE_123' }, PRICE_PERSON)
    expect(db.agentRun.create.mock.calls[0]![0]!.data.input).toEqual({ tool: 'boost-code', args: { adCode: '[redacted]' } })
  })

  it('a change plan stores each step sealed, and its hash is of what is stored (what confirm-change recomputes)', async () => {
    const out = await runOrQueueTool('submit-change-plan', { title: 'Boosts', steps: [{ tool: 'boost-code', args: { adCode: 'CODE_123' } }] }, PRICE_PERSON, 'run1')
    expect(out.mode).toBe('queued')
    const rows = db.agentPlanStep.createMany.mock.calls[0]![0]!.data as unknown as Array<{ args: Record<string, unknown> }>
    expect(rows[0]!.args).toEqual({ adCode: { __enc: expect.stringMatching(/^v1:/) } })
    expect(JSON.stringify(db.agentPlanStep.createMany.mock.calls[0]![0])).not.toContain('CODE_123')
    expect(out.plan!.planHash).toBe(planHashOf({ title: 'Boosts', steps: [{ tool: 'boost-code', args: rows[0]!.args }] }))
    expect(out.plan!.planHash).not.toBe(planHashOf({ title: 'Boosts', steps: [{ tool: 'boost-code', args: { adCode: 'CODE_123' } }] }))
  })
})
