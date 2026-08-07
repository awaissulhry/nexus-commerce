/**
 * NAF.WF.5 — the test-run lane: walk a DRAFT definition in preview mode.
 * Real evidence, real model, nothing written — the AC preview contract,
 * serialized over a definition's steps (concurrency 1, deliberately: cost
 * stays legible and the fleet ceiling is never burst by a test).
 *
 * Hand-offs are NOT simulated (study WF.5 truth #1): law L7 makes steps
 * communicate through persisted artifacts, and preview persists nothing —
 * each step reads the board as it is today. The UI says so.
 *
 * The walk is async; status is assembled from the run rows (preview runs
 * persist output + findingCount), with a small in-process registry carrying
 * only the step ORDER and the walking flag. If the process restarts
 * mid-test, the rows still tell the truth and `walking` honestly reads
 * false.
 */

import { randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { executeCharter } from './agent-executor.js'
import { topoLevels } from './fleet-graph.js'
import {
  assembleTestStatus,
  defToGraph,
  type TestStepStatus,
  type WorkflowDefinitionV1,
} from './workflow-defs.js'

interface TestEntry {
  workflowKey: string
  steps: string[]
  startedAt: number
  walking: boolean
}

const TESTS = new Map<string, TestEntry>()
const ENTRY_TTL_MS = 30 * 60 * 1000

function sweepEntries(): void {
  const cutoff = Date.now() - ENTRY_TTL_MS
  for (const [id, e] of TESTS) {
    if (e.startedAt < cutoff) TESTS.delete(id)
  }
}

/** Mean of each step's recent run costs; $0.05 when a worker has no history. */
export async function estimateTestCost(steps: string[]): Promise<number> {
  let total = 0
  for (const key of steps) {
    const recent = await prisma.agentRun.findMany({
      where: { agentKey: key, costUSD: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { costUSD: true },
    })
    total += recent.length
      ? recent.reduce((s, r) => s + Number(r.costUSD), 0) / recent.length
      : 0.05
  }
  return total
}

export function walkOrder(def: WorkflowDefinitionV1): string[] {
  return topoLevels(defToGraph(def)).flat()
}

/** One test per workflow at a time — a second start while walking is a 409. */
export function activeTestFor(workflowKey: string): string | null {
  sweepEntries()
  for (const [id, e] of TESTS) {
    if (e.workflowKey === workflowKey && e.walking) return id
  }
  return null
}

export async function startWorkflowTest(
  workflowKey: string,
  def: WorkflowDefinitionV1,
): Promise<{ testId: string; steps: string[]; estimatedCostUSD: number }> {
  const steps = walkOrder(def)
  const testId = `test_${randomUUID()}`
  const estimatedCostUSD = await estimateTestCost(steps)
  const entry: TestEntry = { workflowKey, steps, startedAt: Date.now(), walking: true }
  TESTS.set(testId, entry)

  void (async () => {
    try {
      for (const stepKey of steps) {
        // Serial on purpose. A step failure never stops the rest — a test
        // exists to show the whole picture, and the executor's own gates
        // (kill switch, halt, budgets) still bind each preview.
        await executeCharter(stepKey, {
          trigger: 'manual',
          mode: 'ask',
          preview: true,
          orchestrationId: testId,
          workflowKey,
        }).catch(() => null)
      }
    } finally {
      entry.walking = false
    }
  })()

  return { testId, steps, estimatedCostUSD }
}

export interface WorkflowTestStatus {
  testId: string
  walking: boolean
  steps: TestStepStatus[]
  totals: { costUSD: number; findings: number }
}

export async function getWorkflowTestStatus(testId: string): Promise<WorkflowTestStatus | null> {
  sweepEntries()
  const entry = TESTS.get(testId)
  const rows = await prisma.agentRun.findMany({
    where: { orchestrationId: testId },
    orderBy: { createdAt: 'asc' },
    select: {
      agentKey: true,
      status: true,
      ok: true,
      findingCount: true,
      costUSD: true,
      errorMessage: true,
      haltedReason: true,
    },
  })
  if (!entry && rows.length === 0) return null
  const steps = entry?.steps ?? rows.map((r) => r.agentKey)
  const assembled = assembleTestStatus(steps, rows)
  return {
    testId,
    walking: entry?.walking ?? false,
    steps: assembled,
    totals: {
      costUSD: assembled.reduce((s, r) => s + r.costUSD, 0),
      findings: assembled.reduce((s, r) => s + r.findingCount, 0),
    },
  }
}
