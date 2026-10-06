/**
 * Approvals grid (docs/approvals-grid/PLAN.md §4; Owner decision 2 = A, 2026-10-05) — "what would this rule have done?"
 * for the "Automate this kind…" modal: of Claude's requests of one tool in this business over the last `days`, how many
 * the proposed level and limits would have let run by themselves, and how many of those the person actually rejected.
 *
 * The verdict per request is the real rule's own check, never a copy: the tool's `limits` schema (parsed strictly, as
 * setClaudeRule stores them and ruleFrom reads them back) and the tool's own `withinLimits(preview, limits)` — the call
 * claude-trust.service.ts `limitsRefusal` makes at ask time and again at commit — on the preview the request stored
 * (the gate stores `raw.preview ?? raw.data`, the very value the rule judged). Only `auto` runs by itself; at `watch`,
 * `confirm` or below nothing would have, so `wouldRun` is 0.
 *
 * ADS AUTONOMY AA-W2-4 — it reads the verdict a request asked at watch recorded (AgentApproval.ruleVerdict): one the
 * ads strategy held below auto where it landed would not have run whatever this kind's rule, so it is counted in
 * `heldByStrategy`, not in `wouldRun`. (Requests not asked at watch recorded no verdict: the strategy is not replayed.)
 *
 * What it does NOT replay, because they are the business's brakes of the moment and not part of the kind's rule: the
 * connection's nexus.run scope, a Pause, and the daily cap. Requests from other doors (fleet agents, the in-app
 * assistant) are not counted: Claude's rule never applies to them.
 *
 * Read-only. Business-scoped like every read here (row-level security). Examples are shown through the reader's own
 * money filter (`storedOutput`): a preview of a tool they may not use is not described.
 */

import type { RuleSimulation } from '@nexus/shared/approval-queue'
import prisma from '../../db.js'
import { offeredOn } from './call-tool.js'
import { CLAUDE_CHARTER, claudeRuleOf, levelNotAllowed, levelsFor } from './claude-trust.service.js'
import { getTool } from './tool-registry.js'
import { CLAUDE_TRUST_LEVELS, type ClaudeTrust } from './tool-types.js'

export const SIMULATE_DEFAULT_DAYS = 30
export const SIMULATE_MAX_DAYS = 90
const MAX_EXAMPLES = 5
/** Rows read per page: the whole window is read, a page at a time, selecting only what the verdict needs. */
const PAGE = 500

export type SimulateRefusal = { ok: false; status: 400 | 404; error: string }

export interface SimulateQuery {
  /** Whole days back from now, 1–90 (more is read as 90). Default 30. */
  days?: unknown
  /** The proposed level. Default `auto`. */
  level?: unknown
  /** The proposed limits: an object, or its JSON text (the query string). Absent = the business's limits now. */
  limits?: unknown
}

const isLevel = (value: unknown): value is ClaudeTrust =>
  typeof value === 'string' && (CLAUDE_TRUST_LEVELS as readonly string[]).includes(value)

const refuse = (status: 400 | 404, error: string): SimulateRefusal => ({ ok: false, status, error })

/** The preview's own one line, as the Approvals page reads it (tool-types.ts PreviewConvention). */
function summaryOf(preview: unknown): string | null {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null
  const p = preview as { summary?: unknown; effect?: unknown }
  if (typeof p.summary === 'string' && p.summary.trim()) return p.summary.trim()
  if (typeof p.effect === 'string' && p.effect.trim()) return p.effect.trim()
  return null
}

/** AA-W2-4 — a recorded watch verdict whose level the ads strategy set (always below auto: it only narrows). */
function heldByTheStrategy(verdict: unknown): boolean {
  return !!verdict && typeof verdict === 'object' && !Array.isArray(verdict) && !!(verdict as { strategy?: unknown }).strategy
}

export async function simulateClaudeRule(
  toolName: string,
  query: SimulateQuery,
  /** What the reader may see of a stored preview (call-tool.ts storedOutputOf): null when hidden. */
  storedOutput: (toolName: string, value: unknown) => unknown | null,
): Promise<{ ok: true; simulation: RuleSimulation } | SimulateRefusal> {
  const tool = getTool(toolName)
  if (!tool || !offeredOn(tool, 'mcp')) return refuse(404, `${toolName} is not a tool Claude is offered.`)

  // days
  let days = SIMULATE_DEFAULT_DAYS
  if (query.days !== undefined && query.days !== '') {
    const n = Number(query.days)
    if (!Number.isInteger(n) || n < 1) return refuse(400, `days must be a whole number from 1 to ${SIMULATE_MAX_DAYS}.`)
    days = Math.min(n, SIMULATE_MAX_DAYS)
  }

  // level — never above the tool's ceiling, in the words setClaudeRule refuses it with.
  const level = query.level === undefined || query.level === '' ? 'auto' : query.level
  if (!isLevel(level)) return refuse(400, `level must be one of ${CLAUDE_TRUST_LEVELS.join(', ')}.`)
  if (!levelsFor(tool).includes(level)) return refuse(400, levelNotAllowed(tool, level))

  // limits — checked with the tool's own schema, as setClaudeRule checks them before it stores them.
  let limits: Record<string, unknown> | null
  if (query.limits === undefined || query.limits === '') {
    const rule = await claudeRuleOf(toolName)
    if (rule?.limitsInvalid) {
      return refuse(400, `The limits saved for ${toolName} no longer fit it (${rule.limitsInvalid}). Pass the limits to test.`)
    }
    limits = rule?.limits ?? null
  } else {
    let proposed: unknown = query.limits
    if (typeof proposed === 'string') {
      try {
        proposed = JSON.parse(proposed)
      } catch {
        return refuse(400, 'limits must be a JSON object.')
      }
    }
    if (!tool.limits) return refuse(400, `${toolName} has no limits to set.`)
    const parsed = tool.limits.strict().safeParse(proposed)
    if (!parsed.success) {
      return refuse(400, `Limits for ${toolName}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'limits'} — ${i.message}`).join('; ')}.`)
    }
    limits = parsed.data as Record<string, unknown>
  }

  /** Would this stored preview have run by itself under the proposed rule? The tool's own check; a throw is a no. */
  const wouldRunOne = (preview: unknown): boolean => {
    if (level !== 'auto' || !tool.withinLimits || !limits) return false
    try {
      return tool.withinLimits(preview, limits) === null
    } catch {
      return false // the real rule's failure leaves a request with a person (decideByRule)
    }
  }

  const since = new Date(Date.now() - days * 24 * 3600_000)
  let considered = 0
  let wouldRun = 0
  let rejectedAmongWouldRun = 0
  let heldByStrategy = 0
  const examples: RuleSimulation['examples'] = []
  let cursor: string | undefined
  for (;;) {
    const page = await prisma.agentApproval.findMany({
      where: { toolName, requestedAt: { gte: since }, agentRun: { agentKey: CLAUDE_CHARTER } },
      orderBy: { id: 'desc' },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, status: true, preview: true, reason: true, operatorNote: true, ruleVerdict: true },
    })
    for (const ap of page) {
      // A duplicate undo Nexus withdrew is not a request anyone decided.
      if (ap.status === 'rejected' && ap.reason?.startsWith('withdrawn:')) continue
      considered++
      if (!wouldRunOne(ap.preview)) continue
      if (heldByTheStrategy(ap.ruleVerdict)) {
        heldByStrategy++
        continue
      }
      wouldRun++
      if (ap.status !== 'rejected') continue
      rejectedAmongWouldRun++
      if (examples.length < MAX_EXAMPLES) {
        const visible = storedOutput(toolName, ap.preview)
        examples.push({
          id: ap.id,
          summary: (visible != null ? summaryOf(visible) : null) ?? tool.title,
          rejectedReason: ap.operatorNote?.trim() || null,
        })
      }
    }
    if (page.length < PAGE) break
    cursor = page[page.length - 1].id
  }

  return { ok: true, simulation: { toolName, days, considered, wouldRun, rejectedAmongWouldRun, examples, heldByStrategy } }
}
