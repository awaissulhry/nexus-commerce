/**
 * NAF.SB.W.8 — creating and retiring worker instances.
 *
 * Its own file, not `agent-fleet.routes.ts`, per the session-locks protocol:
 * that file is 771 lines and shared, a duplicate route path there is a boot
 * crash, and one-line conflicts in `index.ts` merge where 771-line ones do not.
 *
 * What "create a worker" honestly means (operator decision 2026-08-07, and
 * Part 6 of docs/2026-08-07-naf-sbw-workers-page.md): a new INSTANCE of a
 * charter type that already exists in code — new name, scope, budget, cadence
 * and an appended prompt overlay. Never a new capability. The tools, output
 * schema, evidence feeds and autonomy ceiling all come from the template and
 * cannot be named here at all, which is how laws L2 and L3 survive a UI that
 * creates workers.
 */
import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  bustCharterCache,
  FLEET_CHARTERS,
  listCharters,
} from '../services/agent-fleet/charter-registry.js'
import { recordControlChange } from '../services/agent-fleet/control-audit.service.js'

/** kebab-case, and unmistakably an id rather than a sentence. */
const KEY_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

interface CreateBody {
  templateKey?: string
  key?: string
  name?: string
  description?: string
  scopeMarketplaces?: string[]
  scopePortfolioIds?: string[]
  scopeCampaignIds?: string[]
  dailyBudgetUSD?: number
  maxTokensPerRun?: number
  maxFindingsPerRun?: number
  cadence?: string | null
  promptOverlay?: string
}

const agentFleetWorkerRoutes: FastifyPluginAsync = async (fastify) => {
  /** What you may create from, and what each template will and will not grant. */
  fastify.get('/agent/fleet/worker-templates', async () => {
    return {
      templates: Object.values(FLEET_CHARTERS).map((d) => ({
        key: d.key,
        name: d.name,
        tier: d.tier,
        domain: d.domain,
        description: d.description ?? null,
        // The ceiling an instance inherits and can never exceed.
        autonomyCap: d.autonomyCap,
        // Stated so the review step can be generated rather than written by
        // hand — "what it will never be able to do" has to come from the
        // template or it is marketing.
        observationKeys: d.observationKeys,
        toolNames: d.toolNames,
        dailyBudgetUSD: d.dailyBudgetUSD,
        maxTokensPerRun: d.maxTokensPerRun,
        maxFindingsPerRun: d.maxFindingsPerRun,
        diagnostic: d.diagnostic ?? false,
      })),
    }
  })

  fastify.post<{ Body: CreateBody }>('/agent/fleet/workers', async (request, reply) => {
    const b = request.body ?? {}

    const def = b.templateKey ? FLEET_CHARTERS[b.templateKey] : undefined
    if (!def) {
      return reply.code(400).send({
        error: `unknown template "${b.templateKey ?? ''}" — a worker can only be created from a charter that exists in code`,
      })
    }

    const key = (b.key ?? '').trim()
    if (!KEY_RE.test(key)) {
      return reply.code(400).send({
        error: 'key must be kebab-case: lower-case letters and digits, separated by single hyphens',
      })
    }

    // `AgentCharter` is unique on (key, version), NOT on key — so a collision
    // check has to look at EVERY version, including code charters. Without it
    // `resolveCharter` would have two candidates and FLEET_CHARTERS would win
    // silently, leaving the operator with a worker that does not do what its
    // page says. Flagged in the locks-doc review; enforced here.
    if (FLEET_CHARTERS[key]) {
      return reply.code(409).send({ error: `"${key}" is the key of a built-in worker — choose another` })
    }
    const clash = await prisma.agentCharter.findFirst({ where: { key } })
    if (clash) {
      return reply.code(409).send({ error: `a worker with the key "${key}" already exists` })
    }

    const name = (b.name ?? '').trim()
    if (name.length < 2) return reply.code(400).send({ error: 'name is required' })

    /* Numbers may only NARROW the template. The registry clamps on every read
       anyway, so a too-generous value could never take effect — but accepting
       it silently would leave the page showing a budget the worker does not
       have. Refuse it instead, and say by how much. */
    const narrow = (
      field: 'dailyBudgetUSD' | 'maxTokensPerRun' | 'maxFindingsPerRun',
      value: number | undefined,
      ceiling: number,
    ): number | { error: string } => {
      if (value === undefined) return ceiling
      if (!Number.isFinite(value) || value <= 0) {
        return { error: `${field} must be a positive number` }
      }
      if (value > ceiling) {
        return {
          error: `${field} cannot exceed the template's ${ceiling} — an instance may only narrow what its template allows`,
        }
      }
      return value
    }
    const budget = narrow('dailyBudgetUSD', b.dailyBudgetUSD, def.dailyBudgetUSD)
    if (typeof budget === 'object') return reply.code(400).send(budget)
    const tokens = narrow('maxTokensPerRun', b.maxTokensPerRun, def.maxTokensPerRun)
    if (typeof tokens === 'object') return reply.code(400).send(tokens)
    const findings = narrow('maxFindingsPerRun', b.maxFindingsPerRun, def.maxFindingsPerRun)
    if (typeof findings === 'object') return reply.code(400).send(findings)

    // Only a SINGLE-marketplace scope is enforced end-to-end today, and this
    // series' rule is that an unenforced control is never offered.
    const marketplaces = b.scopeMarketplaces ?? []
    if (marketplaces.length > 1) {
      return reply.code(400).send({
        error: 'only one marketplace can be scoped today — multi-market scope is not enforced yet, so it is refused rather than ignored',
      })
    }

    const created = await prisma.agentCharter.create({
      data: {
        key,
        version: def.version,
        templateKey: def.key,
        promptOverlay: b.promptOverlay?.trim() || null,
        tier: def.tier,
        domain: def.domain,
        name,
        description: b.description?.trim() || def.description || null,
        // Inert for an instance — the resolver reads these from the template
        // and never from the row. Asserted by charter-instances.vitest.test.ts,
        // which writes garbage here and checks the resolved charter is clean.
        systemPrompt: def.systemPrompt,
        outputSchemaKey: def.outputSchemaKey,
        toolNames: def.toolNames,
        observationKeys: def.observationKeys,
        modelFeature: def.modelFeature,
        fallbackFeature: def.fallbackFeature ?? null,
        autonomyCap: def.autonomyCap,
        // Born OFF. Every worker is, and an operator who has just created one
        // has not yet decided to spend on it.
        autonomyLevel: 'OFF',
        enabled: false,
        cadence: b.cadence?.trim() || null,
        scopeMarketplaces: marketplaces,
        scopePortfolioIds: b.scopePortfolioIds ?? [],
        scopeCampaignIds: b.scopeCampaignIds ?? [],
        maxFindingsPerRun: findings,
        maxToolCallsPerRun: def.maxToolCallsPerRun,
        maxTokensPerRun: tokens,
        dailyBudgetUSD: budget,
        createdBy: 'operator',
      },
    })
    bustCharterCache()
    await recordControlChange({
      charterKey: key,
      action: 'policy',
      from: null,
      to: { created: 'instance', templateKey: def.key, name, scopeMarketplaces: marketplaces },
      note: `created from ${def.key}`,
    })
    return reply.code(201).send({ ok: true, key: created.key, charters: await listCharters() })
  })

  /**
   * SB.W.9 — retire. A state, never a delete: its runs, findings, costs and
   * decisions are history the audit trail depends on. Only instances can be
   * retired; a code charter has no row to remove and is switched off instead.
   */
  fastify.delete<{ Params: { key: string } }>(
    '/agent/fleet/workers/:key',
    async (request, reply) => {
      const { key } = request.params
      if (FLEET_CHARTERS[key]) {
        return reply.code(400).send({
          error: `"${key}" is a built-in worker and cannot be retired — switch it off instead`,
        })
      }
      const row = await prisma.agentCharter.findFirst({ where: { key, templateKey: { not: null } } })
      if (!row) return reply.code(404).send({ error: `no worker instance named "${key}"` })

      // Switched off first, then marked. A retired worker that is still enabled
      // is a worker that still runs.
      await prisma.agentCharter.update({
        where: { id: row.id },
        data: { enabled: false, autonomyLevel: 'OFF', supersededBy: 'retired' },
      })
      bustCharterCache()
      await recordControlChange({
        charterKey: key,
        action: 'policy',
        from: { enabled: row.enabled, autonomyLevel: row.autonomyLevel },
        to: { retired: true },
        note: 'retired — switched off and hidden; its history is kept',
      })
      return { ok: true }
    },
  )
}

export default agentFleetWorkerRoutes
