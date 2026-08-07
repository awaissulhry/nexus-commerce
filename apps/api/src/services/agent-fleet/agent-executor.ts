/**
 * NAF.A — run one agent (docs/AGENT_FLEET.md Part 12 § A).
 *
 * Pipeline: resolve charter → gates (kill switch, fleet halt, day budgets)
 * → create AgentRun FIRST → gather observations → one JSON generation via
 * AI-2 routing → strip fences → Zod-validate against the charter's
 * registered schema (retry ONCE with the error appended, then fail — never
 * coerce, never partially accept) → persist findings via dedupe-aware
 * upsert → success/failure run update per the house contract.
 *
 * Every stage lands on AgentStep (L6). Every model call goes through
 * getProviderForFeature → resolveModelForFeature → provider.generate →
 * logUsage (L9 — no direct SDK use). A reply citing evidence ids it was
 * never shown fails validation: the evidence floor is real ids, not
 * plausible-looking ones.
 */
import { Prisma } from '@nexus/database'
import {
  OUTPUT_SCHEMAS,
  type AnalystOutputT,
  type CriticOutputT,
  type DirectorOutputT,
  type OutputSchemaKey,
} from '@nexus/shared/agent-fleet'
import { foldPlanBlast } from './plan-blast.js'
import prisma from '../../db.js'
import {
  getProviderForFeature,
  resolveModelForFeature,
} from '../ai/model-resolver.service.js'
import { getProvider, isAiKillSwitchOn } from '../ai/providers/index.js'
import { logUsage } from '../ai/usage-logger.service.js'
import { checkCharterDayBudget, checkFleetDayBudget, checkRunBudget } from './budget-guard.js'
import { resolveCharter } from './charter-registry.js'
import type { EffectiveCharter } from './charter-types.js'
import { getFleetState } from './fleet-state.service.js'
import { renderExemplarBlock, retrieveExemplars } from './exemplar.service.js'
import { getObservation, type ObservationResult } from './observation-builder.js'
import { singleMarketplace } from './observations/scope-filter.js'
import { pickRevisionForRun } from './charter-revisions.service.js'
import { recordStep } from './tracing.js'

export interface ExecuteOptions {
  trigger: 'manual' | 'schedule'
  mode: 'tick' | 'sweep' | 'council' | 'summit' | 'incident' | 'ask' | 'custom'
  orchestrationId?: string
  userId?: string | null
  /** Manual run-now only — mirrors the existing autonomous agents' Run-now,
   *  which deliberately ignores `enabled`. */
  ignoreEnabled?: boolean
  /** AC.2 — gather real evidence, call the model, validate the output, and
   *  write NOTHING to the blackboard. The run row still exists (cost is
   *  real and must be counted) and is marked mode='preview'. */
  preview?: boolean
  /** AC.2 — try a draft charter without activating it. */
  promptOverride?: string
  /** AC.8 — attribute this run to the revision that produced it. */
  charterRevisionId?: string | null
  /** WF.4a — the stored workflow (and its revision, when one is active)
   *  that this run serves. Null/absent = a code-path or manual run. */
  workflowKey?: string
  workflowRevisionId?: string
}

export interface ExecuteResult {
  runId: string | null
  ok: boolean
  findingCount?: number
  costUSD?: number
  haltedReason?: string
  skipped?: 'disabled'
  error?: string
  /** NAF.C — the AgentPlan a director created / a critic annotated. */
  planId?: string | null
  /** AC.2 — in preview, the findings the run WOULD have written. */
  previewFindings?: unknown[]
  /** AC.2 — the validation failure, verbatim, when the draft broke contract. */
  validationError?: string
  inputTokens?: number
  outputTokens?: number
}

/** Prompt-side description of each output contract. Keyed exhaustively so
 *  adding a schema without a hint is a compile error, not a runtime gap. */
const CONTRACT_HINTS: Record<OutputSchemaKey, string> = {
  'analyst-output': [
    'Reply with ONLY a JSON object — no prose, no markdown fences — of shape:',
    '{ "findings": [ ... ], "scanned": <int entities examined>, "notes": <optional string, HARD LIMIT 600 characters — exceeding it fails validation> }',
    'Each finding: {',
    '  "entityType": one of CAMPAIGN|AD_GROUP|AD_TARGET|SEARCH_TERM|PRODUCT|ASIN|PORTFOLIO|ACCOUNT|COMPONENT|ROUTE,',
    '  "entityId": string, "entityName": optional string,',
    '  "kind": string (≥3 chars), "severity": info|low|medium|high|critical,',
    '  "confidence": number 0..1,',
    '  "observation": object with the structured numbers you saw,',
    '  "evidenceRefs": [the observation id(s) EXACTLY as shown in the Evidence headers above — at least one],',
    '  "dataVintage": the "data as of" timestamp copied EXACTLY as printed in the Evidence header (Z-suffixed ISO like 2026-08-06T00:00:00.000Z — never reformat it, never use an offset form),',
    '  "rationale": string 20..1200 chars,',
    '  "dedupeKey": stable string for this exact issue on this entity (≥3 chars),',
    '  "expiresInHours": integer 1..720',
    '}',
    'An empty findings array is valid when the evidence shows nothing actionable.',
  ].join('\n'),
  'director-output': [
    'Reply with ONLY a JSON object — no prose, no fences — of shape:',
    '{ "headline": string ≤140, "narrative": string 50..3000,',
    '  "items": [ up to 60 of {',
    '    "findingId": the AgentFinding id from the evidence,',
    '    "rank": int ≥1 (1 = do first),',
    '    "tool": one of "create-negative-keyword" | "graduate-keyword" | "set-target-bid",',
    '    "args": the tool args EXACTLY as specified in the evidence tool contracts,',
    '    "expectedEffect": { "metric", "direction", "magnitudePct" 0..500, "horizonDays" 1..90, "basis" ≥8 chars citing the deterministic source, "counterfactual"? },',
    '    "dependsOn": [findingIds] (default []), "reversible": boolean } ],',
    '  "dropped": [ { "findingId", "reason": string ≥10 chars — a REAL reason } ] — every open finding you did NOT include MUST appear here,',
    '  "conflicts": [ { "findingIds": [≥2], "kind": same_entity|opposing_direction|budget_contention|self_competition|protected_scope, "resolution": ≥10 chars } ],',
    '  "changeBudgetUsed": { "entities": int, "valueCents": int } }',
  ].join('\n'),
  'critic-output': [
    'Reply with ONLY a JSON object — no prose, no fences — of shape:',
    '{ "verdict": "pass" | "revise" | "block",',
    '  "checks": [ { "check": one of the twelve named checks from your instructions,',
    '    "result": "pass" | "fail" | "n/a", "note"?: string, "offendingItems": [findingIds] (default []) } ],',
    '  "blockedItems": [findingIds] (default []), "summary": string ≤1500 }',
    'Every one of the twelve checks MUST appear exactly once in checks.',
  ].join('\n'),
}

function buildPrompt(
  charter: EffectiveCharter,
  observations: ObservationResult[],
  exemplarBlock = '',
): string {
  const parts: string[] = [charter.systemPrompt, '', '## Evidence']
  for (const o of observations) {
    parts.push(
      `### Observation \`${o.key}\` — id: ${o.id} — data as of ${o.dataVintage.toISOString()}`,
      '```json',
      JSON.stringify(o.payload, null, 2),
      '```',
      '',
    )
  }
  if (exemplarBlock) parts.push(exemplarBlock, '')
  parts.push('## Output contract', CONTRACT_HINTS[charter.outputSchemaKey])
  return parts.join('\n')
}

function stripFences(text: string): string {
  const t = text.trim()
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t)
  return m ? m[1]!.trim() : t
}

// Optional-undefined members instead of narrowing — see BudgetVerdict in
// budget-guard.ts for why (strict:false disables the narrow).
type Validated =
  | { ok: true; data: unknown; error?: undefined }
  | { ok: false; error: string; data?: undefined }

/** Parse + schema-validate + evidence-integrity + key-grammar check.
 *  Never coerces. */
function validateReply(
  text: string,
  schemaKey: OutputSchemaKey,
  knownEvidenceIds: ReadonlySet<string>,
  dedupeKeyPattern?: string,
): Validated {
  let json: unknown
  try {
    json = JSON.parse(stripFences(text))
  } catch (err) {
    return { ok: false, error: `reply is not valid JSON: ${String(err)}` }
  }
  const parsed = OUTPUT_SCHEMAS[schemaKey].safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    return { ok: false, error: `schema validation failed: ${issues}` }
  }
  if (schemaKey === 'analyst-output') {
    const out = parsed.data as AnalystOutputT
    for (const f of out.findings) {
      const unknown = f.evidenceRefs.filter((r) => !knownEvidenceIds.has(r))
      if (unknown.length > 0) {
        return {
          ok: false,
          error:
            `finding for ${f.entityId} cites evidence id(s) not in this run's observations: ${unknown.join(', ')}. ` +
            `Valid ids: ${[...knownEvidenceIds].join(', ')}`,
        }
      }
    }
    // NAF.B — the pinned dedupeKey grammar. A key the charter's regex
    // rejects is a validation failure like any other: retried once with
    // the pattern named, then the run fails and nothing is stored. This
    // is what makes the AgentFinding unique a semantic dedupe rather
    // than a hope (A2 measured 4 key families from one unpinned model).
    if (dedupeKeyPattern) {
      const re = new RegExp(dedupeKeyPattern)
      const bad = (parsed.data as AnalystOutputT).findings.find(
        (f) => !re.test(f.dedupeKey),
      )
      if (bad) {
        return {
          ok: false,
          error:
            `finding for ${bad.entityId} has dedupeKey "${bad.dedupeKey}" which does not match the required pattern ${dedupeKeyPattern}. ` +
            `Use exactly <kind>:<entityId> (e.g. "${bad.kind}:${bad.entityId}").`,
        }
      }
    }
  }
  return { ok: true, data: parsed.data }
}

export async function executeCharter(
  key: string,
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  const started = Date.now()
  const charter = await resolveCharter(key)
  if (!charter) return { runId: null, ok: false, error: `unknown charter: ${key}` }

  const effectivelyOff = !charter.enabled || charter.autonomyLevel === 'OFF'
  if (effectivelyOff && !opts.ignoreEnabled && !opts.preview) {
    // The dark ship: a disabled charter is a silent no-op, not a run row.
    return { runId: null, ok: true, skipped: 'disabled' }
  }

  // Gates. The orchestrator checks these between agents too; the executor
  // re-checks so a directly-invoked run is just as guarded.
  let haltedReason: string | null = null
  if (isAiKillSwitchOn()) haltedReason = 'kill_switch'
  let fleetCeilingUSD = 0
  if (!haltedReason) {
    const fleet = await getFleetState()
    fleetCeilingUSD = fleet.dailyCeilingUSD
    if (fleet.halted) {
      haltedReason = fleet.degraded
        ? 'fleet_state_unreadable'
        : `fleet_halted${fleet.haltReason ? `: ${fleet.haltReason}` : ''}`
    }
  }
  if (!haltedReason) {
    const charterDay = await checkCharterDayBudget(key, charter.dailyBudgetUSD)
    if (!charterDay.ok) haltedReason = `${charterDay.reason}: ${charterDay.detail}`
  }
  if (!haltedReason) {
    const fleetDay = await checkFleetDayBudget(fleetCeilingUSD)
    if (!fleetDay.ok) haltedReason = `${fleetDay.reason}: ${fleetDay.detail}`
  }
  if (haltedReason) {
    const run = await prisma.agentRun
      .create({
        data: {
          agentKey: key,
          charterVersion: charter.version,
          // WF.5 — a gate-tripped PREVIEW run stays in preview mode, or a
          // budget-stopped test step would leak into the real runs table.
          mode: opts.preview ? 'preview' : opts.mode,
          orchestrationId: opts.orchestrationId ?? null,
          workflowKey: opts.workflowKey ?? null,
          workflowRevisionId: opts.workflowRevisionId ?? null,
          trigger: opts.trigger,
          status: 'done',
          ok: false,
          haltedReason,
          userId: opts.userId ?? null,
          latencyMs: Date.now() - started,
          endedAt: new Date(),
        },
      })
      .catch(() => null)
    return { runId: run?.id ?? null, ok: false, haltedReason }
  }

  // Create FIRST — the row exists before any work (house contract).
  const run = await prisma.agentRun.create({
    data: {
      agentKey: key,
      charterVersion: charter.version,
      charterRevisionId: opts.charterRevisionId ?? charter.activeRevisionId ?? null,
      mode: opts.preview ? 'preview' : opts.mode,
      orchestrationId: opts.orchestrationId ?? null,
      workflowKey: opts.workflowKey ?? null,
      workflowRevisionId: opts.workflowRevisionId ?? null,
      trigger: opts.trigger,
      status: 'running',
      userId: opts.userId ?? null,
      input: {
        charterKey: key,
        charterVersion: charter.version,
        observationKeys: charter.observationKeys,
      } as Prisma.InputJsonValue,
    },
  })

  let seq = 0
  const step = (s: Omit<Parameters<typeof recordStep>[0], 'agentRunId' | 'seq'>) =>
    recordStep({ agentRunId: run.id, seq: ++seq, ...s })

  let totalIn = 0
  let totalOut = 0
  let totalCost = 0
  try {
    // 1 — observations (deterministic evidence; cached across agents).
    const observations: ObservationResult[] = []
    for (const obsKey of charter.observationKeys) {
      const t0 = Date.now()
      // AC.4 — the charter's marketplace scope reaches the evidence layer.
      const obs = await getObservation(obsKey, {
        marketplace: singleMarketplace(charter.scopeMarketplaces),
      })
      observations.push(obs)
      await step({
        type: 'observation',
        name: obsKey,
        output: {
          id: obs.id,
          cached: obs.cached,
          dataVintage: obs.dataVintage.toISOString(),
        },
        latencyMs: Date.now() - t0,
      })
    }
    const evidenceIds = new Set(observations.map((o) => o.id))

    // 1b — evidence staleness (NAF.B, charter-opt-in). Checked BEFORE the
    // provider so stale evidence costs $0 and fails loudly — analysing
    // yesterday's data as if it were fresh is the wrong kind of success.
    if (charter.maxEvidenceAgeHours != null) {
      const maxMs = charter.maxEvidenceAgeHours * 3600_000
      const stale = observations.find(
        (o) => Date.now() - o.dataVintage.getTime() > maxMs,
      )
      if (stale) {
        const detail =
          `${stale.key} vintage ${stale.dataVintage.toISOString()} exceeds ` +
          `the charter tolerance of ${charter.maxEvidenceAgeHours}h`
        await step({
          type: 'gate',
          name: 'evidence-staleness',
          ok: false,
          errorMessage: detail,
        })
        const reason = `stale_evidence: ${detail}`
        await prisma.agentRun.update({
          where: { id: run.id },
          data: {
            status: 'done',
            ok: false,
            haltedReason: reason,
            latencyMs: Date.now() - started,
            endedAt: new Date(),
          },
        })
        return { runId: run.id, ok: false, haltedReason: reason }
      }
    }

    // 2 — model routing (AI-2; provider-agnostic, L9).
    let feature = charter.modelFeature
    let provider = await getProviderForFeature(feature)
    if (!provider && charter.fallbackFeature) {
      feature = charter.fallbackFeature
      provider = await getProviderForFeature(feature)
    }
    // AC.4 — a per-worker pin beats the tier preference. An unknown
    // provider name falls back to the tier's provider rather than failing
    // the run: a bad pin must not take a worker offline silently.
    if (charter.modelProvider) {
      const pinned = getProvider(charter.modelProvider)
      if (pinned) provider = pinned
    }
    if (!provider) throw new Error('No AI provider configured.')
    const model = charter.modelName ?? (await resolveModelForFeature(feature, provider))
    const maxOutputTokens = Math.min(
      8192,
      Math.max(1024, Math.floor(charter.maxTokensPerRun / 4)),
    )

    // 2b — operator precedent (NAF.E): the last five decided exemplars
    // for THIS charter, rendered into the prompt. Analysts have none
    // (approvals attribute to the queueing run — the director); an empty
    // store adds nothing, and the step is only traced when it changed
    // the prompt.
    const exemplars = await retrieveExemplars(charter.key).catch(() => [])
    const exemplarBlock = renderExemplarBlock(exemplars)
    if (exemplarBlock) {
      await step({
        type: 'observation',
        name: 'exemplars',
        output: { count: exemplars.length },
      })
    }

    // 3 — generate → validate, retrying once with the error appended.
    // AC.2 — a preview may swap the prompt so a DRAFT charter can be judged
    // against the same evidence without being activated.
    // AC.8 — otherwise a live split may route this run to the candidate arm.
    let promptSource = opts.promptOverride
    if (!promptSource && !opts.preview) {
      const pick = await pickRevisionForRun(key).catch(() => null)
      if (pick?.arm === 'candidate' && pick.systemPrompt) {
        promptSource = pick.systemPrompt
        await prisma.agentRun.update({
          where: { id: run.id },
          data: { charterRevisionId: pick.revisionId },
        })
        await step({ type: 'gate', name: 'ab-split', output: { arm: 'candidate' } })
      }
    }
    const basePrompt = buildPrompt(
      promptSource ? { ...charter, systemPrompt: promptSource } : charter,
      observations,
      exemplarBlock,
    )
    let prompt = basePrompt
    let validated: Validated = { ok: false, error: 'not attempted' }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const t1 = Date.now()
      const result = await provider.generate({
        prompt,
        model,
        feature,
        jsonMode: true,
        temperature: 0.2,
        maxOutputTokens,
      })
      const modelMs = Date.now() - t1
      totalIn += result.usage.inputTokens
      totalOut += result.usage.outputTokens
      totalCost += result.usage.costUSD
      logUsage({
        provider: result.usage.provider,
        model: result.usage.model,
        feature,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUSD: result.usage.costUSD,
        latencyMs: modelMs,
        ok: true,
      })
      await step({
        type: 'model',
        name: result.usage.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUSD: result.usage.costUSD,
        latencyMs: modelMs,
      })

      validated = validateReply(
        result.text,
        charter.outputSchemaKey,
        evidenceIds,
        charter.dedupeKeyPattern,
      )
      await step({
        type: 'validation',
        name: charter.outputSchemaKey,
        ok: validated.ok,
        errorMessage: validated.ok ? undefined : validated.error,
      })
      if (validated.ok) break

      if (attempt === 1) {
        // Mid-run circuit breaker before spending on the retry.
        const budget = checkRunBudget(
          { tokens: totalIn + totalOut, toolCalls: 0 },
          charter,
        )
        if (!budget.ok) {
          await step({
            type: 'gate',
            name: 'run-budget',
            ok: false,
            errorMessage: budget.detail,
          })
          const reason = `budget_${budget.reason}: ${budget.detail}`
          await prisma.agentRun.update({
            where: { id: run.id },
            data: {
              status: 'done',
              ok: false,
              haltedReason: reason,
              inputTokens: totalIn,
              outputTokens: totalOut,
              costUSD: totalCost,
              model,
              provider: provider.name,
              latencyMs: Date.now() - started,
              endedAt: new Date(),
            },
          })
          return { runId: run.id, ok: false, haltedReason: reason, costUSD: totalCost }
        }
        prompt =
          basePrompt +
          '\n\n## Correction required\nYour previous reply failed validation:\n' +
          validated.error +
          '\nReply again with ONLY the corrected JSON object.'
      }
    }
    if (!validated.ok) {
      if (opts.preview) {
        // A preview exists to SHOW the failure, not to raise it.
        await prisma.agentRun.update({
          where: { id: run.id },
          data: {
            status: 'done', ok: false, costUSD: totalCost,
            inputTokens: totalIn, outputTokens: totalOut,
            errorMessage: validated.error, model, provider: provider.name,
            latencyMs: Date.now() - started, endedAt: new Date(),
          },
        })
        return {
          runId: run.id, ok: false, costUSD: totalCost,
          validationError: validated.error,
          previewFindings: [],
          inputTokens: totalIn, outputTokens: totalOut,
        }
      }
      // Twice invalid: the run fails and NOTHING enters the blackboard.
      throw new Error(`output failed schema validation twice: ${validated.error}`)
    }

    // AC.2 — the preview stops here: evidence read, model called, output
    // validated, and the blackboard untouched.
    if (opts.preview) {
      const previewOut =
        charter.outputSchemaKey === 'analyst-output'
          ? ((validated.data as AnalystOutputT).findings as unknown[])
          : [validated.data]
      await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'done', ok: true, costUSD: totalCost,
          inputTokens: totalIn, outputTokens: totalOut,
          findingCount: previewOut.length,
          output: { preview: true, data: validated.data } as Prisma.InputJsonValue,
          model, provider: provider.name,
          latencyMs: Date.now() - started, endedAt: new Date(),
        },
      })
      return {
        runId: run.id, ok: true, costUSD: totalCost,
        previewFindings: previewOut,
        findingCount: previewOut.length,
        inputTokens: totalIn, outputTokens: totalOut,
      }
    }

    // 4 — persist findings (analyst charters; later tiers persist their
    // own artifact types in their phases).
    let findingCount = 0
    let dropped = 0
    let scanned: number | null = null
    let notes: string | null = null
    if (charter.outputSchemaKey === 'analyst-output') {
      const out = validated.data as AnalystOutputT
      scanned = out.scanned
      notes = out.notes ?? null
      const kept = out.findings.slice(0, charter.maxFindingsPerRun)
      dropped = out.findings.length - kept.length
      for (const f of kept) {
        await prisma.agentFinding.upsert({
          where: {
            charterKey_entityType_entityId_dedupeKey: {
              charterKey: key,
              entityType: f.entityType,
              entityId: f.entityId,
              dedupeKey: f.dedupeKey,
            },
          },
          create: {
            runId: run.id,
            charterKey: key,
            charterVersion: charter.version,
            domain: charter.domain,
            marketplace: null,
            entityType: f.entityType,
            entityId: f.entityId,
            entityName: f.entityName ?? null,
            kind: f.kind,
            severity: f.severity,
            confidence: f.confidence,
            observation: f.observation as Prisma.InputJsonValue,
            evidenceRefs: f.evidenceRefs,
            dataVintage: new Date(f.dataVintage),
            proposedTool: f.proposedTool ?? null,
            proposedArgs: (f.proposedArgs ?? undefined) as
              | Prisma.InputJsonValue
              | undefined,
            expectedEffect: (f.expectedEffect ?? undefined) as
              | Prisma.InputJsonValue
              | undefined,
            rationale: f.rationale,
            dedupeKey: f.dedupeKey,
            expiresAt: new Date(Date.now() + f.expiresInHours * 3600_000),
          },
          update: {
            // A re-detection refreshes the open finding, never duplicates it.
            runId: run.id,
            charterVersion: charter.version,
            severity: f.severity,
            confidence: f.confidence,
            observation: f.observation as Prisma.InputJsonValue,
            evidenceRefs: f.evidenceRefs,
            dataVintage: new Date(f.dataVintage),
            rationale: f.rationale,
            expiresAt: new Date(Date.now() + f.expiresInHours * 3600_000),
            status: 'open',
          },
        })
        findingCount++
      }
    }

    // 4b — NAF.C: director and critic artifacts. The director's judgment
    // becomes an AgentPlan (status draft — the critic and the council
    // decide what happens next); the critic annotates the plan its
    // evidence names. Neither touches findings.
    let planId: string | null = null
    if (charter.outputSchemaKey === 'director-output') {
      const out = validated.data as DirectorOutputT
      const blast = foldPlanBlast(out.items, {
        conflictsCount: out.conflicts.length,
      })
      const plan = await prisma.agentPlan.create({
        data: {
          runId: run.id,
          charterKey: key,
          domain: charter.domain,
          marketplace: null,
          horizon: 'week',
          headline: out.headline,
          narrative: out.narrative,
          items: out.items as unknown as Prisma.InputJsonValue,
          droppedItems: out.dropped as unknown as Prisma.InputJsonValue,
          conflicts: out.conflicts as unknown as Prisma.InputJsonValue,
          changeBudget: out.changeBudgetUsed as unknown as Prisma.InputJsonValue,
          blastRadius: blast as unknown as Prisma.InputJsonValue,
          status: 'draft',
        },
      })
      planId = plan.id
    }
    if (charter.outputSchemaKey === 'critic-output') {
      const out = validated.data as CriticOutputT
      const cited = observations[0]?.payload as { planId?: string } | undefined
      const targetPlanId = cited?.planId
      if (!targetPlanId) {
        throw new Error(
          'critic evidence carries no planId — nothing to annotate',
        )
      }
      await prisma.agentPlan.update({
        where: { id: targetPlanId },
        data: {
          criticVerdict: out.verdict,
          criticNotes: {
            checks: out.checks,
            blockedItems: out.blockedItems,
            summary: out.summary,
          } as unknown as Prisma.InputJsonValue,
          status: 'critiqued',
        },
      })
      planId = targetPlanId
    }

    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: 'done',
        ok: true,
        output: {
          findingCount,
          droppedFindings: dropped,
          scanned,
          notes,
          planId,
        } as Prisma.InputJsonValue,
        findingCount,
        inputTokens: totalIn,
        outputTokens: totalOut,
        costUSD: totalCost,
        model,
        provider: provider.name,
        latencyMs: Date.now() - started,
        endedAt: new Date(),
      },
    })
    return { runId: run.id, ok: true, findingCount, costUSD: totalCost, planId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.agentRun
      .update({
        where: { id: run.id },
        data: {
          status: 'failed',
          ok: false,
          errorMessage: msg,
          inputTokens: totalIn,
          outputTokens: totalOut,
          costUSD: totalCost,
          latencyMs: Date.now() - started,
          endedAt: new Date(),
        },
      })
      .catch(() => {})
    return { runId: run.id, ok: false, error: msg, costUSD: totalCost }
  }
}
