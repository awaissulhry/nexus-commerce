/**
 * NAF.AC.1 — Charter Studio: revisions are immutable, activation moves a
 * pointer, and the CODE charter is always the floor and the fallback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentCharter: { findMany: vi.fn() },
    agentCharterRevision: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))

import prisma from '../../db.js'
import {
  activateRevision,
  createRevision,
  diffPrompts,
  getActiveRevisions,
  revertToCode,
} from './charter-revisions.service.js'
import { bustCharterCache, FLEET_CHARTERS, resolveCharter } from './charter-registry.js'

const db = vi.mocked(prisma, true)

const CHARTER = 'amazon-negative-miner'
const codeDef = () => FLEET_CHARTERS[CHARTER]!

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    key: CHARTER,
    version: codeDef().version,
    enabled: true,
    autonomyLevel: 'OBSERVE',
    scopeMarketplaces: [],
    scopePortfolioIds: [],
    scopeCampaignIds: [],
    maxFindingsPerRun: 20,
    maxToolCallsPerRun: 12,
    maxTokensPerRun: 20_000,
    dailyBudgetUSD: 0.1,
    maxProposedValueCents: null,
    toolNames: [],
    modelProviderOverride: null,
    modelNameOverride: null,
    pausedUntil: null,
    pausedReason: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  bustCharterCache()
  db.agentCharter.findMany.mockResolvedValue([dbRow()] as never)
  db.agentCharterRevision.findMany.mockResolvedValue([] as never)
  db.agentCharterRevision.findFirst.mockResolvedValue(null as never)
  db.agentCharterRevision.updateMany.mockResolvedValue({ count: 0 } as never)
})

describe('resolution law: code default ⊕ active revision', () => {
  it('no revision → the CODE prompt runs', async () => {
    const c = await resolveCharter(CHARTER)
    expect(c!.systemPrompt).toBe(codeDef().systemPrompt)
    expect(c!.activeRevisionId).toBeUndefined()
  })

  it('an active revision overrides the prompt and is attributed', async () => {
    db.agentCharterRevision.findMany.mockResolvedValue([
      {
        id: 'rev1',
        charterKey: CHARTER,
        revision: 3,
        systemPrompt: 'You are a REVISED negative miner.',
        policy: null,
        activatedAt: new Date(),
        supersededAt: null,
      },
    ] as never)
    const c = await resolveCharter(CHARTER)
    expect(c!.systemPrompt).toBe('You are a REVISED negative miner.')
    expect(c!.activeRevisionId).toBe('rev1')
    expect(c!.activeRevisionNumber).toBe(3)
  })

  it("a revision's policy may TIGHTEN a cap, never loosen it", async () => {
    db.agentCharterRevision.findMany.mockResolvedValue([
      {
        id: 'rev2',
        charterKey: CHARTER,
        revision: 1,
        systemPrompt: 'x',
        policy: { maxFindingsPerRun: 5, dailyBudgetUSD: 99, maxTokensPerRun: 1000 },
        activatedAt: new Date(),
        supersededAt: null,
      },
    ] as never)
    const c = await resolveCharter(CHARTER)
    expect(c!.maxFindingsPerRun).toBe(5) // tightened
    expect(c!.maxTokensPerRun).toBe(1000) // tightened
    expect(c!.dailyBudgetUSD).toBe(codeDef().dailyBudgetUSD) // 99 refused
  })

  it('an unreadable revision store does not break resolution — code runs', async () => {
    db.agentCharterRevision.findMany.mockRejectedValue(new Error('db down') as never)
    const c = await resolveCharter(CHARTER)
    // the whole policy read fails closed to OFF, and the prompt is code's
    expect(c!.systemPrompt).toBe(codeDef().systemPrompt)
    expect(c!.enabled).toBe(false)
    expect(c!.degraded).toBe(true)
  })

  it('AC.6 — a live pause resolves as not-enabled without moving the dial', async () => {
    db.agentCharter.findMany.mockResolvedValue([
      dbRow({ pausedUntil: new Date(Date.now() + 3600_000), pausedReason: 'holiday' }),
    ] as never)
    const c = await resolveCharter(CHARTER)
    expect(c!.enabled).toBe(false)
    expect(c!.autonomyLevel).toBe('OBSERVE') // the dial is untouched
    expect(c!.pausedReason).toBe('holiday')
  })

  it('an EXPIRED pause lets the worker run again by itself', async () => {
    db.agentCharter.findMany.mockResolvedValue([
      dbRow({ pausedUntil: new Date(Date.now() - 1000) }),
    ] as never)
    const c = await resolveCharter(CHARTER)
    expect(c!.enabled).toBe(true)
  })

  it('AC.5 — the DB may narrow the tool list, never widen it', async () => {
    db.agentCharter.findMany.mockResolvedValue([
      dbRow({ toolNames: ['create-negative-keyword', 'not-a-code-tool'] }),
    ] as never)
    const c = await resolveCharter(CHARTER)
    expect(c!.toolNames.every((t) => codeDef().toolNames.includes(t))).toBe(true)
  })
})

describe('createRevision', () => {
  it('demands a prompt and a note, and numbers monotonically', async () => {
    db.agentCharterRevision.findFirst.mockResolvedValue({ revision: 7 } as never)
    db.agentCharterRevision.create.mockResolvedValue({ id: 'r8', revision: 8 } as never)
    await createRevision({
      charterKey: CHARTER,
      systemPrompt: 'new prompt',
      note: 'tightened the waste rule',
      author: 'operator',
    })
    const data = (db.agentCharterRevision.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data
    expect(data.revision).toBe(8)
    expect(data.note).toBe('tightened the waste rule')

    await expect(
      createRevision({ charterKey: CHARTER, systemPrompt: 'x', note: '  ' }),
    ).rejects.toThrow(/note/i)
    await expect(
      createRevision({ charterKey: CHARTER, systemPrompt: '   ', note: 'why' }),
    ).rejects.toThrow(/prompt/i)
  })
})

describe('activateRevision / revertToCode', () => {
  it('activating supersedes the incumbent, then points at the new one', async () => {
    db.agentCharterRevision.findUnique.mockResolvedValue({
      id: 'rev9',
      charterKey: CHARTER,
    } as never)
    db.agentCharterRevision.update.mockResolvedValue({ id: 'rev9' } as never)
    await activateRevision(CHARTER, 'rev9')
    const supersede = db.agentCharterRevision.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }
    expect(supersede.where.charterKey).toBe(CHARTER)
    expect(supersede.data.supersededAt).toBeInstanceOf(Date)
    const activate = db.agentCharterRevision.update.mock.calls[0]![0] as {
      data: Record<string, unknown>
    }
    expect(activate.data.activatedAt).toBeInstanceOf(Date)
    expect(activate.data.supersededAt).toBeNull()
  })

  it("refuses to activate another charter's revision", async () => {
    db.agentCharterRevision.findUnique.mockResolvedValue({
      id: 'rev9',
      charterKey: 'someone-else',
    } as never)
    expect(await activateRevision(CHARTER, 'rev9')).toBeNull()
    expect(db.agentCharterRevision.update).not.toHaveBeenCalled()
  })

  it('revert-to-code supersedes everything and activates nothing', async () => {
    db.agentCharterRevision.updateMany.mockResolvedValue({ count: 1 } as never)
    const out = await revertToCode(CHARTER)
    expect(out.superseded).toBe(1)
    expect(db.agentCharterRevision.update).not.toHaveBeenCalled()
  })
})

describe('getActiveRevisions', () => {
  it('keeps only the newest active revision per charter', async () => {
    db.agentCharterRevision.findMany.mockResolvedValue([
      { id: 'new', charterKey: 'a', revision: 2, activatedAt: new Date(2), supersededAt: null },
      { id: 'old', charterKey: 'a', revision: 1, activatedAt: new Date(1), supersededAt: null },
    ] as never)
    const m = await getActiveRevisions()
    expect(m.get('a')!.id).toBe('new')
  })
})

describe('diffPrompts', () => {
  it('marks added, removed and unchanged lines', () => {
    const d = diffPrompts('one\ntwo\nthree', 'one\ntwo point five\nthree')
    expect(d.filter((l) => l.kind === 'removed').map((l) => l.text)).toEqual(['two'])
    expect(d.filter((l) => l.kind === 'added').map((l) => l.text)).toEqual(['two point five'])
    expect(d.filter((l) => l.kind === 'same')).toHaveLength(2)
  })

  it('identical prompts diff to nothing but sames', () => {
    expect(diffPrompts('a\nb', 'a\nb').every((l) => l.kind === 'same')).toBe(true)
  })
})
