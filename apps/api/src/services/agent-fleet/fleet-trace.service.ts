/**
 * FX.1 — the run-trace endpoint's assembler: one run, told as a story.
 * Steps get plain-language labels server-side (one vocabulary for every
 * client); observation steps pull a bounded PREVIEW of the evidence the
 * agent actually read; the validated output and the findings written come
 * along. Depth-3 raw data stays available (step input/output ride along
 * untruncated except the evidence preview) — sentence → card → JSON.
 */
import prisma from '../../db.js'

const EVIDENCE_PREVIEW_CHARS = 4000

export interface TraceStep {
  seq: number
  type: string
  name: string
  label: string
  ok: boolean
  latencyMs: number | null
  costUSD: number
  inputTokens: number
  outputTokens: number
  errorMessage: string | null
  output: unknown
}

export interface RunTrace {
  shape: 'agent-step' | 'legacy-json'
  run: {
    id: string
    agentKey: string
    mode: string | null
    trigger: string
    status: string
    ok: boolean
    costUSD: number
    latencyMs: number | null
    haltedReason: string | null
    errorMessage: string | null
    createdAt: Date
    model: string | null
    findingCount: number
  }
  steps: TraceStep[]
  evidence: Array<{
    id: string
    key: string
    dataVintage: Date | null
    preview: string
    truncated: boolean
  }>
  output: unknown
  findings: Array<{
    id: string
    kind: string
    entityType: string
    entityId: string
    severity: string
    confidence: unknown
    rationale: string
  }>
}

/** Plain-language step labels — the single vocabulary for every client. */
export function stepLabel(type: string, name: string): string {
  switch (type) {
    case 'observation':
      return name === 'exemplars'
        ? 'Recalled your past decisions'
        : `Read the evidence: ${name.replace(/-/g, ' ')}`
    case 'model':
      return `Thought it through (${name})`
    case 'validation':
      return name.includes('retry')
        ? 'Checked its own work — retried once'
        : 'Checked its own work against the contract'
    case 'gate':
      return `Safety gate: ${name.replace(/-/g, ' ')}`
    case 'tool':
      return `Used a tool: ${name}`
    case 'critic':
      return `Adversarial review: ${name.replace(/-/g, ' ')}`
    default:
      return `${type}: ${name}`
  }
}

export async function getRunTrace(runId: string): Promise<RunTrace | null> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      agentKey: true,
      mode: true,
      trigger: true,
      status: true,
      ok: true,
      costUSD: true,
      latencyMs: true,
      haltedReason: true,
      errorMessage: true,
      createdAt: true,
      findingCount: true,
      output: true,
      steps: true,
    },
  })
  if (!run) return null

  const base = {
    id: run.id,
    agentKey: run.agentKey,
    mode: run.mode,
    trigger: run.trigger,
    status: run.status,
    ok: run.ok,
    costUSD: Number(run.costUSD ?? 0),
    latencyMs: run.latencyMs,
    haltedReason: run.haltedReason,
    errorMessage: run.errorMessage,
    createdAt: run.createdAt,
    findingCount: run.findingCount,
  }

  if (run.mode == null) {
    // ACP copilot runs keep their legacy Json steps — read, not reshaped.
    return {
      shape: 'legacy-json',
      run: { ...base, model: null },
      steps: [],
      evidence: [],
      output: (run.steps as unknown) ?? [],
      findings: [],
    }
  }

  const [stepRows, findings] = await Promise.all([
    prisma.agentStep.findMany({
      where: { agentRunId: run.id },
      orderBy: { seq: 'asc' },
    }),
    prisma.agentFinding.findMany({
      where: { runId: run.id },
      select: {
        id: true,
        kind: true,
        entityType: true,
        entityId: true,
        severity: true,
        confidence: true,
        rationale: true,
      },
      take: 50,
    }),
  ])

  const steps: TraceStep[] = stepRows.map((s) => ({
    seq: s.seq,
    type: s.type,
    name: s.name,
    label: stepLabel(s.type, s.name),
    ok: s.ok,
    latencyMs: s.latencyMs,
    costUSD: Number(s.costUSD ?? 0),
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    errorMessage: s.errorMessage,
    output: s.output,
  }))

  const model =
    stepRows.find((s) => s.type === 'model')?.name ?? null

  // Evidence: the observation rows the run actually read, previewed.
  const obsIds = stepRows
    .filter((s) => s.type === 'observation')
    .map((s) => (s.output as { id?: string } | null)?.id)
    .filter((v): v is string => typeof v === 'string')
  const evidence = obsIds.length
    ? (
        await prisma.agentObservation.findMany({
          where: { id: { in: obsIds } },
          select: { id: true, key: true, dataVintage: true, payload: true },
        })
      ).map((o) => {
        const full = JSON.stringify(o.payload)
        return {
          id: o.id,
          key: o.key,
          dataVintage: o.dataVintage,
          preview: full.slice(0, EVIDENCE_PREVIEW_CHARS),
          truncated: full.length > EVIDENCE_PREVIEW_CHARS,
        }
      })
    : []

  return {
    shape: 'agent-step',
    run: { ...base, model },
    steps,
    evidence,
    output: run.output,
    findings,
  }
}
