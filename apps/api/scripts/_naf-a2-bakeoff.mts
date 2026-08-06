/**
 * NAF.A2 — fleet-selftest bake-off harness (docs/2026-08-06-naf-a2-local-provider.md).
 *
 * Runs `fleet-selftest` N times sequentially through the real executor and
 * prints the full Phase A acceptance evidence chain plus the schema-
 * validation retry rate — datapoint #1 for the Phase J model bake-off.
 *
 *   npx tsx apps/api/scripts/_naf-a2-bakeoff.mts --runs=0    # wiring only, no model call
 *   npx tsx apps/api/scripts/_naf-a2-bakeoff.mts --runs=1
 *   npx tsx apps/api/scripts/_naf-a2-bakeoff.mts --runs=10
 *
 * Flags: --runs=N (default 10) · --allow-cloud · --skip-negative-control
 *
 * Deliberately does NOT boot the API. `npm run dev` starts every registered
 * cron against the production database — a second cron runner competing with
 * Railway, writing the very CronRun rows the cron-health observation reads.
 * This calls executeCharter() in-process instead: same executor, same
 * provider path, same rows, no crons.
 *
 * Runs are sequential by design. Concurrent runs would race the observation
 * upsert and destroy the cache-reuse evidence.
 *
 * Refuses to run on a cloud provider unless --allow-cloud: the point is to
 * measure a local model, and an accidental cloud run would both cost money
 * and silently answer a different question.
 */
import '../src/env.js'

const { default: prisma } = await import('../src/db.js')
const { executeCharter } = await import('../src/services/agent-fleet/agent-executor.js')
const { getProviderForFeature, resolveModelForFeature } = await import(
  '../src/services/ai/model-resolver.service.js'
)

const CHARTER = 'fleet-selftest'
const OBS_KEY = 'cron-health'

const argRuns = process.argv.find((a) => a.startsWith('--runs='))
const RUNS = argRuns ? Number(argRuns.split('=')[1]) : 10
const ALLOW_CLOUD = process.argv.includes('--allow-cloud')
const SKIP_NEG = process.argv.includes('--skip-negative-control')

const n = (v: unknown): number => (v == null ? 0 : Number(v))
const pct = (a: number, b: number): string =>
  b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(1)}%`

interface RunRecord {
  i: number
  runId: string | null
  status: string
  ok: boolean
  provider: string | null
  model: string | null
  findingCount: number
  costUSD: number
  latencyMs: number | null
  attempts: number
  validations: number
  firstValidationOk: boolean | null
  validationErrors: string[]
  obsId: string | null
  obsCached: boolean | null
  obsVintage: string | null
  stepCostSum: number
  error: string | null
}

/* ── 0 — routing, before anything is spent ─────────────────────────────── */

const feature = 'agent-fleet-analyst'
const provider = await getProviderForFeature(feature)
if (!provider) {
  console.error(
    '✗ No provider resolves for agent-fleet-analyst. Kill switch on, or nothing configured.',
  )
  process.exit(1)
}
const model = await resolveModelForFeature(feature, provider)

console.log('═══ NAF.A2 bake-off ═══')
console.log(`feature   : ${feature}`)
console.log(`provider  : ${provider.name}`)
console.log(`model     : ${model}`)
console.log(`base URL  : ${process.env.NEXUS_LOCAL_AI_BASE_URL ?? '(none)'}`)
console.log(`allowlist : ${process.env.NEXUS_LOCAL_AI_FEATURES ?? '(unset)'}`)
console.log(`runs      : ${RUNS}`)

if (provider.name !== 'local' && !ALLOW_CLOUD) {
  console.error(
    `\n✗ Refusing to run: resolved provider is '${provider.name}', not 'local'.` +
      `\n  Set NEXUS_LOCAL_AI_BASE_URL + NEXUS_LOCAL_AI_FEATURES=${feature},` +
      `\n  or pass --allow-cloud if a cloud run is genuinely what you want.`,
  )
  process.exit(1)
}
if (RUNS <= 0) {
  console.log('\n--runs=0 — wiring verified, no model call made.')
  await prisma.$disconnect()
  process.exit(0)
}

/* ── 1 — baseline ──────────────────────────────────────────────────────── */

const baselineFindings = await prisma.agentFinding.count({
  where: { charterKey: CHARTER },
})
console.log(`\nAgentFinding rows for ${CHARTER} before: ${baselineFindings}`)

/* ── 2 — the runs ──────────────────────────────────────────────────────── */

const records: RunRecord[] = []
const findingCountAfter: number[] = []

for (let i = 1; i <= RUNS; i++) {
  process.stdout.write(`run ${i}/${RUNS} … `)
  const t0 = Date.now()
  const res = await executeCharter(CHARTER, {
    trigger: 'manual',
    mode: 'ask',
    ignoreEnabled: true,
  })
  const wall = Date.now() - t0

  const run = res.runId
    ? await prisma.agentRun.findUnique({ where: { id: res.runId } })
    : null
  const steps = res.runId
    ? await prisma.agentStep.findMany({
        where: { agentRunId: res.runId },
        orderBy: { seq: 'asc' },
      })
    : []

  const modelSteps = steps.filter((s) => s.type === 'model')
  const validationSteps = steps.filter((s) => s.type === 'validation')
  const obsStep = steps.find((s) => s.type === 'observation')
  const obsOut = (obsStep?.output ?? null) as
    | { id?: string; cached?: boolean; dataVintage?: string }
    | null

  records.push({
    i,
    runId: res.runId,
    status: run?.status ?? 'n/a',
    ok: run?.ok ?? false,
    provider: run?.provider ?? null,
    model: run?.model ?? null,
    findingCount: run?.findingCount ?? 0,
    costUSD: n(run?.costUSD),
    latencyMs: run?.latencyMs ?? wall,
    attempts: modelSteps.length,
    validations: validationSteps.length,
    firstValidationOk: validationSteps[0]?.ok ?? null,
    validationErrors: validationSteps
      .filter((s) => !s.ok)
      .map((s) => s.errorMessage ?? '(no message)'),
    obsId: obsOut?.id ?? null,
    obsCached: obsOut?.cached ?? null,
    obsVintage: obsOut?.dataVintage ?? null,
    stepCostSum: steps.reduce((a, s) => a + n(s.costUSD), 0),
    error: run?.errorMessage ?? res.error ?? null,
  })

  findingCountAfter.push(
    await prisma.agentFinding.count({ where: { charterKey: CHARTER } }),
  )
  console.log(
    `${run?.status ?? '?'} · attempts=${modelSteps.length} · findings=${run?.findingCount ?? 0} · ${wall}ms`,
  )
}

/* ── 3 — per-run table ─────────────────────────────────────────────────── */

console.log('\n═══ (a)(d) runs ═══')
console.table(
  records.map((r) => ({
    run: r.i,
    runId: r.runId?.slice(-8) ?? '—',
    status: r.status,
    ok: r.ok,
    provider: r.provider,
    model: r.model,
    findings: r.findingCount,
    cost: r.costUSD,
    stepCost: r.stepCostSum,
    attempts: r.attempts,
    ms: r.latencyMs,
  })),
)
const nonZeroCost = records.filter((r) => r.costUSD !== 0 || r.stepCostSum !== 0)
console.log(
  nonZeroCost.length === 0
    ? '✓ (d) every run and every step costed exactly 0'
    : `✗ (d) ${nonZeroCost.length} run(s) carried non-zero cost`,
)
const models = [...new Set(records.map((r) => r.model).filter(Boolean))]
console.log(`✓ (d) model id(s) recorded on runs/steps: ${models.join(', ') || '—'}`)

/* ── 4 — (b) observation reuse ─────────────────────────────────────────── */

console.log('\n═══ (b) shared-evidence cache ═══')
console.table(
  records.map((r) => ({
    run: r.i,
    observationId: r.obsId,
    cached: r.obsCached,
    dataVintage: r.obsVintage,
  })),
)
const ids = [...new Set(records.map((r) => r.obsId).filter(Boolean))]
const vintages = [...new Set(records.map((r) => r.obsVintage).filter(Boolean))]
const afterFirst = records.slice(1)
console.log(`distinct observation ids     : ${ids.length} → ${ids.join(', ')}`)
console.log(`distinct dataVintage values  : ${vintages.length}`)
console.log(
  afterFirst.length === 0
    ? '— (b) single run: there is no "later run" to test reuse against. Run ≥2.'
    : afterFirst.every((r) => r.obsCached === true)
      ? '✓ (b) every run after the first hit the cache (cached=true)'
      : '✗ (b) at least one later run recomputed',
)
console.log(
  ids.length === 1 && vintages.length === 1
    ? '✓ (b) one observation row, one vintage — reused, not recomputed'
    : '✗ (b) the evidence moved between runs',
)

/* ── 5 — (c) dedupe ────────────────────────────────────────────────────── */

console.log('\n═══ (c) AgentFinding_dedupe ═══')
const findings = await prisma.agentFinding.findMany({
  where: { charterKey: CHARTER },
  select: {
    id: true,
    entityType: true,
    entityId: true,
    dedupeKey: true,
    kind: true,
    severity: true,
    runId: true,
    createdAt: true,
  },
  orderBy: { createdAt: 'asc' },
})
console.log(`rows before: ${baselineFindings} · after each run: ${findingCountAfter.join(', ')}`)
console.table(
  findings.map((f) => ({
    entityId: f.entityId,
    dedupeKey: f.dedupeKey,
    kind: f.kind,
    severity: f.severity,
    lastRun: f.runId.slice(-8),
    created: f.createdAt.toISOString(),
  })),
)
// Two distinct results, never collapsed into one tick (operator ruling Q4).
//
// Row growth is NOT a constraint test — it is a KEY test. A growing table
// with zero duplicate tuples means the index worked perfectly and the model
// invented a new key. Conflating them mislabels a healthy constraint as
// broken, which an earlier version of this harness did.

// (c1) CONSTRAINT: no (entityType, entityId, dedupeKey) tuple may appear
// twice, and a repeat run emitting the SAME key must update, not insert.
const tuples = new Map<string, number>()
for (const f of findings) {
  const k = `${f.entityType}|${f.entityId}|${f.dedupeKey}`
  tuples.set(k, (tuples.get(k) ?? 0) + 1)
}
const violations = [...tuples.values()].filter((c) => c > 1).length
const noGrowthRuns = findingCountAfter.filter(
  (c, idx) => idx > 0 && c === findingCountAfter[idx - 1],
).length
console.log(
  violations === 0
    ? `✓ (c1) CONSTRAINT: ${findings.length} rows, ${tuples.size} distinct key tuples, 0 violations` +
        `\n       ${noGrowthRuns}/${Math.max(0, findingCountAfter.length - 1)} repeat runs inserted NOTHING (upsert updated in place)`
    : `✗ (c1) CONSTRAINT: ${violations} duplicated key tuple(s) — the unique index did not hold`,
)

// (c2) KEY STABILITY: does one entity accumulate more than one dedupeKey?
const byEntity = new Map<string, Set<string>>()
for (const f of findings) {
  if (!byEntity.has(f.entityId)) byEntity.set(f.entityId, new Set())
  byEntity.get(f.entityId)!.add(f.dedupeKey)
}
const drifted = [...byEntity.entries()].filter(([, s]) => s.size > 1)
console.log(
  drifted.length === 0
    ? `✓ (c2) KEY STABILITY: all ${byEntity.size} entities carry exactly one dedupeKey`
    : `✗ (c2) KEY STABILITY: ${drifted.length}/${byEntity.size} entities carry MORE THAN ONE dedupeKey —` +
        `\n       the same real issue is stored as multiple open findings. The constraint is fine;` +
        `\n       the charter does not pin a key format. Examples:`,
)
for (const [entity, keys] of drifted.slice(0, 3)) {
  console.log(`       ${entity}: ${[...keys].join(' | ')}`)
}
console.log(
  `  (c2) findings emitted per run = [${records.map((r) => r.findingCount).join(', ')}]` +
    ' — variance here is COVERAGE drift, a separate property from key drift.',
)

/* ── 6 — (e) retry rate ────────────────────────────────────────────────── */

console.log('\n═══ (e) schema-validation retry rate — Phase J datapoint #1 ═══')
const total = records.length
const firstPass = records.filter((r) => r.attempts === 1 && r.firstValidationOk).length
const retried = records.filter((r) => r.attempts >= 2).length
const retriedPassed = records.filter(
  (r) => r.attempts >= 2 && r.status === 'done' && r.ok,
).length
const twiceFailed = records.filter(
  (r) => r.validations >= 2 && r.validationErrors.length >= 2,
).length
const otherFailures = records.filter(
  (r) => r.status === 'failed' && r.validationErrors.length < 2,
).length
console.table([
  { metric: 'runs', value: total },
  { metric: 'first-attempt pass', value: `${firstPass} (${pct(firstPass, total)})` },
  { metric: 'retried', value: `${retried} (${pct(retried, total)})` },
  { metric: 'retried then passed', value: retriedPassed },
  { metric: 'failed twice (nothing persisted)', value: `${twiceFailed} (${pct(twiceFailed, total)})` },
  { metric: 'failed for a non-validation reason', value: otherFailures },
])
const allErrors = records.flatMap((r) => r.validationErrors)
if (allErrors.length) {
  console.log('\nvalidation errors, verbatim:')
  const tally = new Map<string, number>()
  for (const e of allErrors) {
    const head = e.slice(0, 160)
    tally.set(head, (tally.get(head) ?? 0) + 1)
  }
  for (const [msg, count] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ×${count}  ${msg}`)
  }
} else {
  console.log('\nno validation errors in this batch.')
}
const lat = records.map((r) => r.latencyMs ?? 0).sort((a, b) => a - b)
console.log(
  `\nlatency ms: min ${lat[0]} · median ${lat[Math.floor(lat.length / 2)]} · max ${lat[lat.length - 1]}`,
)

/* ── 7 — negative control: prove the TTL, not just the sticky row ──────── */

if (!SKIP_NEG) {
  console.log('\n═══ negative control — forced expiry must recompute ═══')
  const before = await prisma.agentObservation.findFirst({
    where: { key: OBS_KEY },
    orderBy: { computedAt: 'desc' },
  })
  if (!before) {
    console.log('no cron-health row to expire — skipped.')
  } else {
    await prisma.agentObservation.update({
      where: { id: before.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    })
    const res = await executeCharter(CHARTER, {
      trigger: 'manual',
      mode: 'ask',
      ignoreEnabled: true,
    })
    const step = res.runId
      ? await prisma.agentStep.findFirst({
          where: { agentRunId: res.runId, type: 'observation' },
        })
      : null
    const out = (step?.output ?? null) as { id?: string; cached?: boolean } | null
    const after = await prisma.agentObservation.findUnique({ where: { id: before.id } })
    console.log(`row id before/after : ${before.id} / ${out?.id ?? '—'}`)
    console.log(`cached flag         : ${out?.cached}`)
    console.log(
      `computedAt          : ${before.computedAt.toISOString()} → ${after?.computedAt.toISOString()}`,
    )
    console.log(
      out?.cached === false && after && after.computedAt > before.computedAt
        ? '✓ expiry forced a recomputation — the TTL is real, and the row is reused IN PLACE\n' +
            '  (so row-id equality alone never proved reuse; cached+dataVintage do)'
        : '✗ expiry did not force a recomputation',
    )
  }
}

await prisma.$disconnect()
