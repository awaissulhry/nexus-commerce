/**
 * NAF.E — E2: exemplars. Every operator decision on a fleet approval
 * becomes a labelled precedent (the reject reason is the highest-value
 * datapoint, spec Part 10); the last five per charter feed back into the
 * director/critic prompts. Retrieval is recency-first v1 — embedding
 * retrieval stays deferred (A-D6).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentApproval: { findUnique: vi.fn() },
    agentRun: { findUnique: vi.fn() },
    agentExemplar: { findMany: vi.fn(), create: vi.fn() },
  },
}))

import prisma from '../../db.js'
import {
  mintExemplarFromDecision,
  renderExemplarBlock,
  retrieveExemplars,
} from './exemplar.service.js'

const db = vi.mocked(prisma, true)

beforeEach(() => {
  vi.clearAllMocks()
  db.agentApproval.findUnique.mockResolvedValue({
    id: 'ap1',
    toolName: 'create-negative-keyword',
    args: { keywordText: 'giacca pelle' },
    preview: { effect: 'negates giacca pelle' },
    agentRunId: 'run_dir',
  } as never)
  db.agentRun.findUnique.mockResolvedValue({ agentKey: 'amazon-ads-director' } as never)
  db.agentExemplar.create.mockResolvedValue({ id: 'ex1' } as never)
  db.agentExemplar.findMany.mockResolvedValue([] as never)
})

describe('mintExemplarFromDecision', () => {
  it('an approval mints an accepted exemplar under the queueing charter', async () => {
    const id = await mintExemplarFromDecision('ap1', 'approve')
    expect(id).toBe('ex1')
    const data = (db.agentExemplar.create.mock.calls[0]![0] as { data: Record<string, unknown> })
      .data
    expect(data.charterKey).toBe('amazon-ads-director')
    expect(data.label).toBe('accepted')
    expect(data.proposal).toEqual({ keywordText: 'giacca pelle' })
    expect((data.situation as Record<string, unknown>).toolName).toBe('create-negative-keyword')
  })

  it('a rejection stores the mandatory reason as the operator note', async () => {
    await mintExemplarFromDecision('ap1', 'reject', 'wrong campaign — that term converts in DE')
    const data = (db.agentExemplar.create.mock.calls[0]![0] as { data: Record<string, unknown> })
      .data
    expect(data.label).toBe('rejected')
    expect(data.operatorNote).toBe('wrong campaign — that term converts in DE')
  })

  it('an unknown approval mints nothing and returns null', async () => {
    db.agentApproval.findUnique.mockResolvedValue(null as never)
    const id = await mintExemplarFromDecision('ghost', 'approve')
    expect(id).toBeNull()
    expect(db.agentExemplar.create).not.toHaveBeenCalled()
  })
})

describe('retrieveExemplars', () => {
  it('takes the five most recent active exemplars for the charter', async () => {
    await retrieveExemplars('amazon-ads-director')
    const args = db.agentExemplar.findMany.mock.calls[0]![0]! as Record<string, unknown>
    expect(args.where).toEqual({ charterKey: 'amazon-ads-director', active: true })
    expect(args.take).toBe(5)
    expect(args.orderBy).toEqual({ createdAt: 'desc' })
  })
})

describe('renderExemplarBlock', () => {
  it('empty in, empty out — no fake precedent section', () => {
    expect(renderExemplarBlock([])).toBe('')
  })

  it('renders label, tool, and the operator note', () => {
    const block = renderExemplarBlock([
      {
        label: 'rejected',
        situation: { toolName: 'create-negative-keyword' },
        proposal: { keywordText: 'giacca pelle' },
        operatorNote: 'that term converts in DE',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      },
    ] as never)
    expect(block).toContain('## Operator precedent')
    expect(block).toContain('REJECTED')
    expect(block).toContain('create-negative-keyword')
    expect(block).toContain('that term converts in DE')
  })
})
