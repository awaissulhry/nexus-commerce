/**
 * NAF.AC.3 — evidence before promotion.
 *
 * A draft revision is scored against the charter that is RUNNING, on the
 * SAME evidence, before it may go live. Both sides are preview runs, so
 * neither writes to the blackboard.
 *
 * What we score, and why these four:
 *  - `validRate`    — did it honour its output contract? (a broken contract
 *                     writes nothing at all, so this dominates)
 *  - `agreement`    — of the entities it flagged, how many did the
 *                     deterministic engines flag too? This is the same
 *                     shadow-grade measure the fleet is already judged on.
 *  - `findings`     — volume, so "it stopped finding anything" is visible
 *  - `costPerCase`  — the price of the change
 *
 * The verdict is deliberately conservative: `worse` if the candidate is
 * worse on ANY hard measure (contract or agreement), `better` only if it
 * wins one and loses none, otherwise `inconclusive`. Cost never makes a
 * revision "better" on its own — cheaper nonsense is still nonsense.
 */
import type { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { executeCharter } from './agent-executor.js'
import { resolveCharter } from './charter-registry.js'

export interface EvalScores {
  cases: number
  validRate: number
  agreement: number | null
  findings: number
  costUSD: number
  costPerCase: number
}

export interface EvalResult {
  id?: string
  charterKey: string
  revisionId: string | null
  baseline: EvalScores
  candidate: EvalScores
  verdict: 'better' | 'worse' | 'inconclusive'
  measures: Array<{ measure: string; baseline: number | null; candidate: number | null; better: boolean | null }>
  costUSD: number
}

const DEFAULT_CASES = 2

/** Entities the deterministic engines flagged recently — the yardstick. */
async function engineFlaggedEntities(charterKey: string): Promise<Set<string>> {
  const graded = await prisma.agentShadowGrade.findMany({
    where: { agrees: true },
    orderBy: { gradedAt: 'desc' },
    take: 200,
    select: { findingId: true },
  })
  if (graded.length === 0) return new Set()
  const findings = await prisma.agentFinding.findMany({
    where: { id: { in: graded.map((g) => g.findingId) }, charterKey },
    select: { entityId: true },
  })
  return new Set(findings.map((f) => f.entityId))
}

function scoreRun(
  runs: Array<{ ok: boolean; findings: unknown[]; costUSD: number }>,
  yardstick: Set<string>,
): EvalScores {
  const cases = runs.length
  const valid = runs.filter((r) => r.ok).length
  const allFindings = runs.flatMap((r) => r.findings as Array<{ entityId?: string }>)
  const withEntity = allFindings.filter((f) => typeof f.entityId === 'string')
  const hits = withEntity.filter((f) => yardstick.has(f.entityId!)).length
  const costUSD = runs.reduce((s, r) => s + r.costUSD, 0)
  return {
    cases,
    validRate: cases ? valid / cases : 0,
    // Unknown, not zero, when there is nothing to compare against.
    agreement: yardstick.size === 0 || withEntity.length === 0 ? null : hits / withEntity.length,
    findings: allFindings.length,
    costUSD,
    costPerCase: cases ? costUSD / cases : 0,
  }
}

async function runCases(
  charterKey: string,
  promptOverride: string | undefined,
  cases: number,
): Promise<Array<{ ok: boolean; findings: unknown[]; costUSD: number }>> {
  const out: Array<{ ok: boolean; findings: unknown[]; costUSD: number }> = []
  for (let i = 0; i < cases; i++) {
    const r = await executeCharter(charterKey, {
      trigger: 'manual',
      mode: 'ask',
      preview: true,
      promptOverride,
    })
    out.push({
      ok: r.ok,
      findings: (r.previewFindings ?? []) as unknown[],
      costUSD: r.costUSD ?? 0,
    })
  }
  return out
}

export async function evaluateRevision(input: {
  charterKey: string
  candidatePrompt: string
  revisionId?: string | null
  cases?: number
}): Promise<EvalResult> {
  const cases = Math.min(Math.max(input.cases ?? DEFAULT_CASES, 1), 5)
  const charter = await resolveCharter(input.charterKey)
  if (!charter) throw new Error(`unknown charter: ${input.charterKey}`)

  const yardstick = await engineFlaggedEntities(input.charterKey)

  // Same evidence for both sides: the observation cache TTL means the two
  // passes read the identical snapshot, which is what makes this a fair test.
  const baselineRuns = await runCases(input.charterKey, undefined, cases)
  const candidateRuns = await runCases(input.charterKey, input.candidatePrompt, cases)

  const baseline = scoreRun(baselineRuns, yardstick)
  const candidate = scoreRun(candidateRuns, yardstick)

  const measures: EvalResult['measures'] = [
    {
      measure: 'kept its output contract',
      baseline: baseline.validRate,
      candidate: candidate.validRate,
      better:
        candidate.validRate === baseline.validRate ? null : candidate.validRate > baseline.validRate,
    },
    {
      measure: 'agrees with the engines',
      baseline: baseline.agreement,
      candidate: candidate.agreement,
      better:
        baseline.agreement == null || candidate.agreement == null
          ? null
          : candidate.agreement === baseline.agreement
            ? null
            : candidate.agreement > baseline.agreement,
    },
    {
      measure: 'findings per run',
      baseline: baseline.findings / Math.max(baseline.cases, 1),
      candidate: candidate.findings / Math.max(candidate.cases, 1),
      better: null, // volume alone is neither good nor bad
    },
    {
      measure: 'cost per run',
      baseline: baseline.costPerCase,
      candidate: candidate.costPerCase,
      better: null, // cheaper nonsense is still nonsense
    },
  ]

  const hard = measures.filter((m) =>
    ['kept its output contract', 'agrees with the engines'].includes(m.measure),
  )
  const anyWorse = hard.some((m) => m.better === false)
  const anyBetter = hard.some((m) => m.better === true)
  const verdict: EvalResult['verdict'] = anyWorse
    ? 'worse'
    : anyBetter
      ? 'better'
      : 'inconclusive'

  const costUSD = baseline.costUSD + candidate.costUSD
  const saved = await prisma.agentEvalRun.create({
    data: {
      charterKey: input.charterKey,
      revisionId: input.revisionId ?? null,
      baseline: baseline as unknown as Prisma.InputJsonValue,
      candidate: candidate as unknown as Prisma.InputJsonValue,
      verdict,
      measures: measures as unknown as Prisma.InputJsonValue,
      cases,
      costUSD,
    },
  })

  return {
    id: saved.id,
    charterKey: input.charterKey,
    revisionId: input.revisionId ?? null,
    baseline,
    candidate,
    verdict,
    measures,
    costUSD,
  }
}

/** The newest eval for a revision — what the activation gate consults. */
export async function latestEvalFor(revisionId: string): Promise<{
  verdict: string
  createdAt: Date
} | null> {
  const row = await prisma.agentEvalRun.findFirst({
    where: { revisionId },
    orderBy: { createdAt: 'desc' },
    select: { verdict: true, createdAt: true },
  })
  return row ?? null
}
