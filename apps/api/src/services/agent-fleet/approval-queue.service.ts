/**
 * Approvals grid (docs/approvals-grid/PLAN.md, Owner's yes 2026-10-05) — the read side of the one queue.
 *
 * One row per request (`AgentApproval`), whoever asked: Claude over MCP, a fleet worker, the in-app assistant, a cron.
 * The old split into "Waiting" (the 3 fleet tools) and an uncounted "outside" list (capped at 100) is gone: `show=open`
 * is every request a person may still act on or watch, paged, and `total` counts all of them.
 *
 *   queuePage    GET /api/agent/fleet/approvals/queue?show=open|done|all&cursor=&limit=
 *   queueCounts  GET /api/agent/fleet/approvals/queue/counts (the health strip and the nav badge)
 *   queueDetail  GET /api/agent/fleet/approvals/queue/:id (the drawer)
 *   approvalsNeedYouCount  the sidebar badge (GET /api/sidebar/counts)
 *
 * Every field is computed from what is stored (PLAN §3): `state` from status, the reason prefix, executeAfter and
 * decidedAt; "why it waits" from today's rule (claude-trust.service.ts), worked out at read time, never stored.
 * The preview is shown through THIS viewer's money filter (`storedOutputOf`): a viewer who may not use the tool sees
 * no change lines, only what the request's ids name.
 *
 * Cost (the Neon data-transfer note): the page is polled every 3–15 s. A list call is one page query with a lean
 * select and a count, then batched joins — runs, people, connections, plan step counts and first steps, this
 * business's AgentTool rules, one product lookup — and the trust brakes only when a waiting Claude request is set to
 * run by rule. No track records, no history, no per-row query. The counts are a handful of COUNT queries.
 */
import { Prisma } from '@nexus/database'
import {
  QUEUE_SHOWS,
  type QueueAsker,
  type QueueAutomation,
  type QueueChange,
  type QueueCounts,
  type QueueDecider,
  type QueueDetail,
  type QueueEvent,
  type QueuePage,
  type QueueRow,
  type QueueShow,
  type QueueState,
  type QueueTarget,
  type QueueTrustLevel,
} from '@nexus/shared/approval-queue'
import prisma from '../../db.js'
import { actorLabel, missingPermissions, storedOutputOf, type ToolPrincipal } from '../agents/call-tool.js'
import { EXPIRY_HOURS } from '../agents/approval-gate.service.js'
import { getTool } from '../agents/tool-registry.js'
import { PLAN_TOOL, type AgentTool, type ClaudeTrust } from '../agents/tool-types.js'
import { autonomyOf, autoRunsInLastDay, CLAUDE_CHARTER, ruleFrom, type Autonomy } from '../agents/claude-trust.service.js'
import { undoStateOf } from '../agents/claude-activity.service.js'
import { getAutonomousAgent } from '../agents/autonomous-agent.service.js'
import {
  adDeliveryOf,
  adMeaning,
  channelQueueOf,
  ebayDeliveryOf,
  ebayMeaning,
  executedMeaning,
  publishedMeaning,
} from '../agents/tools/approval.tools.js'
import { masterCurrency } from '../fx-rate.service.js'
import { cannotApproveFor, planApprovalRefusal, reversibilityOf, UNDO_WINDOW_MS } from './approval-inbox.service.js'
import { bulkApproveRefusal } from './bulk-approve-policy.js'
import { FLEET_CHARTERS, resolveCharter } from './charter-registry.js'
import { resolveFleetLabels } from './fleet-labels.service.js'
import { clip, productRefsOf, resolveRequest, stepChangesOf, type ResolvedRequest, type TargetContext } from './approval-target.js'

/* ── the one status (PLAN §3) ──────────────────────────────────────────────────────────────────── */

/** The statuses whose rows are open (waiting, starting, on hold, running, failed, back to you). */
const OPEN_STATUSES = ['pending', 'scheduled', 'executing'] as const
/** `reason` of a run that failed: approval-gate.service.ts decideApproval (`execution failed: …`, `execution error: …`). */
const FAILED_PREFIXES = ['execution failed', 'execution error'] as const
/**
 * `reason` of a request handed back without running: approval-inbox.service.ts handBack (`not run — …`, stale,
 * permission, rule at commit) and claude-trust.service.ts handToPerson (`not run by rule — …`, Pause, daily cap).
 */
const HANDED_BACK_PREFIX = 'not run'

const PENDING_STATES: ReadonlySet<QueueState> = new Set(['waiting', 'back_to_you', 'failed'])

/**
 * The state a person sees, from what is stored. A request handed back or failed is a plain `pending` row with a reason
 * prefix (research/01 §2.3), the same reading claude-activity.service.ts `outcomeOf` makes. A `scheduled` row whose run
 * time lies more than the stop window after its decision was held (POST …/hold pushes `executeAfter`).
 */
export function queueStateOf(ap: { status: string; reason: string | null; executeAfter: Date | null; decidedAt: Date | null }): QueueState {
  const reason = ap.reason ?? ''
  switch (ap.status) {
    case 'pending':
      if (FAILED_PREFIXES.some((prefix) => reason.startsWith(prefix))) return 'failed'
      if (reason.startsWith(HANDED_BACK_PREFIX)) return 'back_to_you'
      return 'waiting'
    case 'scheduled':
      return ap.executeAfter && ap.decidedAt && ap.executeAfter.getTime() - ap.decidedAt.getTime() > UNDO_WINDOW_MS ? 'on_hold' : 'starting'
    case 'executing':
      return 'running'
    case 'executed':
      return 'done'
    case 'approved':
      return 'recorded'
    case 'rejected':
      return 'rejected'
    case 'expired':
      return 'expired'
    case 'superseded':
      return 'replaced'
    default:
      // A status this reader does not know waits where a person looks, as claude-activity.service.ts reads it.
      return 'waiting'
  }
}

/** Rows that are pending and failed: the one predicate the counts and the badge subtract (null-safe). */
const FAILED_WHERE: Prisma.AgentApprovalWhereInput = { OR: FAILED_PREFIXES.map((prefix) => ({ reason: { startsWith: prefix } })) }
/** Pending rows that need a person: waiting or back to you (not failed). `reason` null counts. */
const NEEDS_YOU_WHERE: Prisma.AgentApprovalWhereInput = {
  status: 'pending',
  OR: [{ reason: null }, { NOT: FAILED_WHERE }],
}

/* ── query parsing ─────────────────────────────────────────────────────────────────────────────── */

export const QUEUE_PAGE_DEFAULT = 100
export const QUEUE_PAGE_MAX = 200

/** A query the list cannot read: the route answers 400 with its message. */
export class QueueQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueueQueryError'
  }
}

export interface QueueQuery {
  show?: unknown
  cursor?: unknown
  limit?: unknown
}

function parseQuery(raw: QueueQuery): { show: QueueShow; cursor: { at: Date; id: string } | null; limit: number } {
  const show = raw.show === undefined || raw.show === '' ? 'open' : raw.show
  if (typeof show !== 'string' || !(QUEUE_SHOWS as readonly string[]).includes(show)) {
    throw new QueueQueryError(`show must be one of ${QUEUE_SHOWS.join(', ')}.`)
  }
  let limit = QUEUE_PAGE_DEFAULT
  if (raw.limit !== undefined && raw.limit !== '') {
    const n = Number(raw.limit)
    if (!Number.isInteger(n) || n < 1 || n > QUEUE_PAGE_MAX) throw new QueueQueryError(`limit must be a whole number from 1 to ${QUEUE_PAGE_MAX}.`)
    limit = n
  }
  const cursor = typeof raw.cursor === 'string' && raw.cursor ? decodeCursor(raw.cursor) : null
  return { show: show as QueueShow, cursor, limit }
}

function encodeCursor(row: { requestedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([row.requestedAt.toISOString(), row.id])).toString('base64url')
}

function decodeCursor(raw: string): { at: Date; id: string } {
  try {
    if (raw.length > 200) throw new Error('long')
    const [at, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as [string, string]
    const date = new Date(at)
    if (typeof id !== 'string' || !id || Number.isNaN(date.getTime())) throw new Error('shape')
    return { at: date, id }
  } catch {
    throw new QueueQueryError('cursor: not one this list gave out. Start again without it.')
  }
}

function whereForShow(show: QueueShow): Prisma.AgentApprovalWhereInput {
  if (show === 'open') return { status: { in: [...OPEN_STATUSES] } }
  if (show === 'done') return { status: { notIn: [...OPEN_STATUSES] } }
  return {}
}

/* ── the rows ──────────────────────────────────────────────────────────────────────────────────── */

const APPROVAL_SELECT = {
  id: true,
  toolName: true,
  status: true,
  args: true,
  preview: true,
  requestedAt: true,
  expiresAt: true,
  executeAfter: true,
  decidedAt: true,
  decidedBy: true,
  decidedByUserId: true,
  decisionVia: true,
  reason: true,
  operatorNote: true,
  agentRunId: true,
} satisfies Prisma.AgentApprovalSelect

type ApprovalRow = Prisma.AgentApprovalGetPayload<{ select: typeof APPROVAL_SELECT }>

interface RunRow {
  id: string
  agentKey: string
  via: string | null
  userId: string | null
  oauthGrantId: string | null
  mode: string | null
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null)
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

/** The rule of one tool in this business, from its AgentTool row (claude-trust.service.ts ruleFrom, in one query). */
interface ToolRule {
  level: ClaudeTrust
  max: ClaudeTrust
  limits: Rec | null
  limitsInvalid: string | null
}

const RANK: Record<ClaudeTrust, number> = { off: 0, ask: 1, confirm: 2, auto: 3 }

/** claude-trust.service.ts `ruleFrom` — the one reading of a stored rule — kept to the fields this page needs. */
function ruleOf(tool: AgentTool, row: { claudeTrust: string; claudeLimits: unknown } | undefined): ToolRule {
  const rule = ruleFrom(tool, row ?? null)
  return { level: rule.level, max: rule.ceiling, limits: rule.limits ?? null, limitsInvalid: rule.limitsInvalid ?? null }
}

const LEVEL_WORDS: Record<ClaudeTrust, string> = { off: 'Off', ask: 'Ask me', confirm: 'Confirm in Claude', auto: 'Run by itself' }

/** Everything one list (or detail) call joins, read once for all its rows. */
interface Joins {
  runs: Map<string, RunRow>
  people: Map<string, { name: string; first: string }>
  grants: Map<string, { name: string | null; runScope: boolean }>
  stepCounts: Map<string, Record<string, number>>
  firstSteps: Map<string, { toolName: string; args: unknown; preview: unknown }>
  rules: Map<string, { claudeTrust: string; claudeLimits: unknown }>
  charterNames: Map<string, string>
  targetCtx: TargetContext
  visible: (toolName: string, value: unknown) => unknown | null
  /** Read only when a waiting Claude request is set to run by rule (lazily, once per call). */
  brakes: () => Promise<{ autonomy: Autonomy; used: number }>
}

/** What a built row carries besides the row itself, for the drawer. */
interface Built {
  row: QueueRow
  ap: ApprovalRow
  run: RunRow | undefined
  tool: AgentTool | undefined
  resolved: ResolvedRequest
  visiblePreview: unknown | null
  /** The names the page looked up, for the drawer's items. */
  ctx: TargetContext
}

const FLEET_AD_TOOLS = new Set(['set-target-bid', 'create-negative-keyword', 'graduate-keyword'])
const LINE_MAX = 160

const clipLine = (change: QueueChange, max: number): QueueChange => ({
  label: clip(change.label, max),
  from: change.from === null ? null : clip(change.from, max),
  to: change.to === null ? null : clip(change.to, max),
})

async function joinsFor(approvals: ApprovalRow[], viewer: ToolPrincipal | null, opts: { allItems?: boolean } = {}): Promise<Joins> {
  const runIds = [...new Set(approvals.map((a) => a.agentRunId))]
  const planIds = approvals.filter((a) => a.toolName === PLAN_TOOL).map((a) => a.id)
  const [runs, stepGroups, firstSteps] = await Promise.all([
    runIds.length
      ? prisma.agentRun.findMany({ where: { id: { in: runIds } }, select: { id: true, agentKey: true, via: true, userId: true, oauthGrantId: true, mode: true } })
      : Promise.resolve([] as RunRow[]),
    planIds.length
      ? prisma.agentPlanStep.groupBy({ by: ['approvalId', 'status'], where: { approvalId: { in: planIds } }, _count: { _all: true } })
      : Promise.resolve([]),
    planIds.length
      ? prisma.agentPlanStep.findMany({ where: { approvalId: { in: planIds }, position: 1 }, select: { approvalId: true, toolName: true, args: true, preview: true } })
      : Promise.resolve([]),
  ])
  const runById = new Map(runs.map((r) => [r.id, r]))
  const stepCounts = new Map<string, Record<string, number>>()
  for (const g of stepGroups) {
    const counts = stepCounts.get(g.approvalId) ?? {}
    counts[g.status] = g._count._all
    stepCounts.set(g.approvalId, counts)
  }

  // This business's rules for every tool on the page, a plan's kinds and a plan's first step included.
  const toolNames = new Set(approvals.map((a) => a.toolName))
  for (const a of approvals) for (const kind of kindsOf(a.preview)) toolNames.add(kind)
  for (const s of firstSteps) toolNames.add(s.toolName)
  const userIds = [...new Set(runs.map((r) => r.userId).filter((id): id is string => !!id))]
  const grantIds = [...new Set(runs.map((r) => r.oauthGrantId).filter((id): id is string => !!id))]
  const visible = viewer ? storedOutputOf(viewer) : () => null

  // The names on the page: the first product of each row (and, in the drawer, every item's).
  const refs = new Set<string>()
  for (const a of approvals) {
    const shown = a.preview == null ? null : visible(a.toolName, a.preview)
    for (const ref of productRefsOf(a.toolName, a.args, shown, opts.allItems)) refs.add(ref)
  }
  for (const s of firstSteps) {
    const shown = s.preview == null ? null : visible(s.toolName, s.preview)
    for (const ref of productRefsOf(s.toolName, s.args, shown)) refs.add(ref)
  }
  // An ad request whose preview, as this viewer sees it, does not name its target or campaign (from before previews
  // named them, or hidden from this viewer): the fleet labels name it (FX.1) — a keyword's text is not money.
  const unnamed = approvals.filter((a) => {
    if (!FLEET_AD_TOOLS.has(a.toolName)) return false
    const shown = rec(a.preview == null ? null : visible(a.toolName, a.preview))
    return !rec(shown?.target)?.expression && !rec(shown?.campaign)?.name
  })
  const refList = [...refs].slice(0, 500)

  const [rules, people, grants, products, labels] = await Promise.all([
    prisma.agentTool.findMany({ where: { name: { in: [...toolNames] } }, select: { name: true, claudeTrust: true, claudeLimits: true } }),
    userIds.length
      ? prisma.userProfile.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, displayName: true } })
      : Promise.resolve([]),
    grantIds.length
      ? prisma.oAuthGrant.findMany({ where: { id: { in: grantIds } }, select: { id: true, scopes: true, client: { select: { clientName: true } } } })
      : Promise.resolve([]),
    refList.length
      ? prisma.product.findMany({ where: { OR: [{ id: { in: refList } }, { sku: { in: refList } }] }, select: { id: true, sku: true, name: true }, take: 1000 })
      : Promise.resolve([]),
    unnamed.length
      ? resolveFleetLabels({ args: unnamed.map((a) => rec(a.args) ?? {}), entityIds: [] })
      : Promise.resolve(undefined),
  ])

  const productMap = new Map<string, { id: string; sku: string; name: string }>()
  for (const p of products) {
    productMap.set(p.id, p)
    productMap.set(p.sku, p)
  }

  // Fleet workers by their charter's name: the code charters at once, an instance through the (cached) registry.
  const charterNames = new Map<string, string>()
  for (const run of runs) {
    const key = run.agentKey
    if (charterNames.has(key)) continue
    if (FLEET_CHARTERS[key]) charterNames.set(key, FLEET_CHARTERS[key].name)
    else if (run.mode) {
      const charter = await resolveCharter(key).catch(() => null)
      if (charter) charterNames.set(key, charter.name)
    }
  }

  let brakes: Promise<{ autonomy: Autonomy; used: number }> | null = null
  return {
    runs: runById,
    people: new Map(people.map((p) => {
      const name = actorLabel({ id: p.id, email: p.email, displayName: p.displayName ?? undefined })
      const first = p.displayName?.trim().split(/\s+/)[0] || name
      return [p.id, { name, first }]
    })),
    grants: new Map(grants.map((g) => [g.id, { name: g.client?.clientName ?? null, runScope: g.scopes.includes('nexus.run') }])),
    stepCounts,
    firstSteps: new Map(firstSteps.map((s) => [s.approvalId, { toolName: s.toolName, args: s.args, preview: s.preview }])),
    rules: new Map(rules.map((r) => [r.name, { claudeTrust: r.claudeTrust, claudeLimits: r.claudeLimits }])),
    charterNames,
    targetCtx: { masterCurrency: masterCurrency(), products: productMap, ...(labels ? { labels } : {}) },
    visible,
    brakes: () => (brakes ??= Promise.all([autonomyOf(), autoRunsInLastDay()]).then(([autonomy, used]) => ({ autonomy, used }))),
  }
}

/** The tools a plan's preview names as its kinds of change (change-plan.service.ts PlanKind). */
function kindsOf(preview: unknown): string[] {
  const kinds = rec(preview)?.kinds
  return Array.isArray(kinds) ? kinds.map((k) => rec(k)?.tool).filter((t): t is string => typeof t === 'string') : []
}

/* ── who asked, who decided ────────────────────────────────────────────────────────────────────── */

function askerOf(run: RunRow | undefined, joins: Joins): QueueAsker {
  if (!run) return { kind: 'system', label: 'Nexus', person: null, connection: null }
  const person = run.userId ? joins.people.get(run.userId) ?? null : null
  const connection = run.oauthGrantId ? joins.grants.get(run.oauthGrantId)?.name ?? null : null
  if (run.agentKey === CLAUDE_CHARTER || run.via === 'claude') {
    return { kind: 'claude', label: person ? `Claude · ${person.first}` : 'Claude', person: person?.name ?? null, connection }
  }
  const charter = joins.charterNames.get(run.agentKey)
  if (charter || run.mode) return { kind: 'fleet', label: charter ?? run.agentKey, person: null, connection: null }
  const autonomous = getAutonomousAgent(run.agentKey)
  if (autonomous) return { kind: 'system', label: autonomous.name, person: null, connection: null }
  // The copilot's "Request approval" button and the Activity page's Undo (agentKey manual-action), or the in-app assistant.
  if (run.agentKey === 'manual-action') return { kind: 'assistant', label: person ? `${person.first} in Nexus` : 'Someone in Nexus', person: person?.name ?? null, connection: null }
  if (run.via === 'app') return { kind: 'assistant', label: person ? `Assistant · ${person.first}` : 'Assistant', person: person?.name ?? null, connection: null }
  return { kind: 'system', label: run.agentKey, person: person?.name ?? null, connection: null }
}

function deciderOf(ap: ApprovalRow, state: QueueState, title: string): QueueDecider | null {
  if (state === 'expired') return { kind: 'expiry', label: 'Expired' }
  // Handed back or failed: the decision was taken back with the row; it waits for a new one.
  if (PENDING_STATES.has(state)) return null
  if (!ap.decidedBy && !ap.decidedAt && !ap.decisionVia) return null
  if (ap.decisionVia === 'auto') return { kind: 'rule', label: `Rule · ${title}` }
  // An older row decided without the decider's name: say so, never invent a person ("Someone").
  if (!ap.decidedBy) return { kind: 'system', label: ap.decisionVia === 'claude-confirm' ? 'Code in Claude · name not recorded' : 'Name not recorded' }
  const name = ap.decidedBy
  if (ap.decisionVia === 'claude-confirm') return { kind: 'claude-code', label: `${name}, code in Claude` }
  // A duplicate undo withdrawn by Nexus (approval-gate.service.ts askedFor): decidedBy is the control tool's name.
  if (state === 'rejected' && (ap.reason ?? '').startsWith('withdrawn')) return { kind: 'system', label: 'Nexus (withdrawn)' }
  return { kind: 'person', label: name }
}

/* ── automation: why it waits, read at read time ───────────────────────────────────────────────── */

const RULES_ONLY_FOR_CLAUDE = 'Rules apply only to Claude’s requests'

function alwaysNeedsYou(tool: AgentTool): string {
  if ((tool.reversibility ?? 'none') === 'none') return 'This kind always needs you: it cannot be undone'
  if (tool.openWorld) return 'This kind always needs you: it reaches a marketplace or a buyer'
  return 'This kind always needs you'
}

/**
 * Why a change set to run by rule does not run by itself now, in the order claude-trust.service.ts `autoRefusal` (and,
 * for a plan, `planRuleRefusal`) checks: the connection's nexus.run, the business's Pause, the limits, the daily cap.
 * `runScope` null = the request names no Claude connection, so that check cannot be made and is not claimed.
 */
async function ruleRunWhy(runScope: boolean | null, joins: Joins, limits: () => string | null, changes: number): Promise<string | null> {
  if (runScope === false) return 'This Claude connection may not run changes by rule: it was connected without nexus.run'
  const { autonomy, used } = await joins.brakes()
  if (autonomy.paused) return `Changes that run by rule are paused in this business${autonomy.reason ? ` (${autonomy.reason})` : ''}`
  const outside = limits()
  if (outside) return outside
  if (used + changes > autonomy.dailyAutoCap) return `This business’s limit of ${autonomy.dailyAutoCap} changes run by rule in 24 hours is reached`
  return null
}

function confirmWords(title: string, runScope: boolean | null): string {
  return runScope === false
    ? `Your rule for ${title}: Confirm in Claude, but this Claude connection may not confirm changes (connected without nexus.run)`
    : `Your rule for ${title}: Confirm in Claude — the person who asked can confirm it with their code, or you approve it here`
}

async function automationOf(
  ap: ApprovalRow,
  state: QueueState,
  tool: AgentTool | undefined,
  asker: QueueAsker,
  run: RunRow | undefined,
  joins: Joins,
  planSteps?: Array<{ toolName: string; preview: unknown }>,
): Promise<QueueAutomation> {
  const waits = state === 'waiting' || state === 'back_to_you'
  const runScope = run?.oauthGrantId ? (joins.grants.get(run.oauthGrantId)?.runScope ?? null) : null

  if (ap.toolName === PLAN_TOOL) {
    // A plan runs by rule only when every step may (claude-trust.service.ts planRuleRefusal): its level is its lowest
    // kind's, its ceiling its lowest kind's ceiling. A kind Nexus does not know counts as Ask me.
    let level: ClaudeTrust = 'auto'
    let max: ClaudeTrust = 'auto'
    let lowest: { name: string; tool: AgentTool | undefined; rule: ToolRule | null } | null = null
    const kinds = kindsOf(ap.preview)
    for (const name of kinds) {
      const kindTool = getTool(name)
      const rule = kindTool ? ruleOf(kindTool, joins.rules.get(name)) : null
      const kindLevel = rule?.level ?? 'ask'
      if (RANK[kindLevel] < RANK[level]) {
        level = kindLevel
        lowest = { name, tool: kindTool, rule }
      }
      if (RANK[rule?.max ?? 'ask'] < RANK[max]) max = rule?.max ?? 'ask'
    }
    if (!kinds.length) level = max = 'ask'
    let whyWaits: string | null = null
    if (waits) {
      if (asker.kind !== 'claude') whyWaits = `${RULES_ONLY_FOR_CLAUDE}: a person approves every request from ${asker.label}`
      else if (level !== 'auto') {
        const title = lowest?.tool?.title ?? lowest?.name ?? 'one of its kinds'
        whyWaits = !lowest?.rule || lowest.rule.max === 'ask'
          ? `A plan runs by itself only when every step may: ${title} always needs you`
          : `A plan runs by itself only when every step may: your rule for ${title} is ${LEVEL_WORDS[level]}`
      } else {
        const steps = Number(rec(rec(ap.preview)?.totals)?.steps ?? 0) || 1
        const stepLimits = () => {
          for (const [index, step] of (planSteps ?? []).entries()) {
            const stepTool = getTool(step.toolName)
            const outside = stepTool ? limitsWords(stepTool, ruleOf(stepTool, joins.rules.get(step.toolName)), step.preview) : null
            if (outside) return `Step ${index + 1} (${stepTool!.title}): ${outside}`
          }
          return null
        }
        whyWaits = await ruleRunWhy(runScope, joins, stepLimits, steps)
        whyWaits ??= planSteps
          ? 'Your rules would run every step of it by themselves now; when it was asked, they did not'
          : 'Your rules may run every kind of change in this plan; open it to see each step against its limits'
      }
    }
    return { level: level as QueueTrustLevel, max: max as QueueTrustLevel, whyWaits }
  }

  if (!tool) return { level: 'ask', max: 'ask', whyWaits: waits ? 'Nexus does not know this kind of change, so it always needs you' : null }
  const rule = ruleOf(tool, joins.rules.get(tool.name))
  let whyWaits: string | null = null
  if (waits) {
    if (asker.kind !== 'claude') whyWaits = `${RULES_ONLY_FOR_CLAUDE}: a person approves every request from ${asker.label}`
    else if (rule.max === 'ask') whyWaits = alwaysNeedsYou(tool)
    else if (rule.level === 'off') whyWaits = `Your rule for ${tool.title}: Off — Claude is no longer offered it`
    else if (rule.level === 'ask') whyWaits = `Your rule for ${tool.title}: Ask me`
    else if (rule.level === 'confirm') whyWaits = confirmWords(tool.title, runScope)
    else {
      // The rule's verdict is told to Claude only and never stored (research/02 §3.3): worked out again, now.
      whyWaits = await ruleRunWhy(runScope, joins, () => limitsWords(tool, rule, ap.preview), 1)
      whyWaits ??= `Your rule for ${tool.title} would run it by itself now; when it was asked, it did not`
    }
  }
  return { level: rule.level as QueueTrustLevel, max: rule.max as QueueTrustLevel, whyWaits }
}

/** Why the change is outside the tool's limits, in the limit verdict's own words (claude-trust.service.ts limitsRefusal). */
function limitsWords(tool: AgentTool, rule: ToolRule, preview: unknown): string | null {
  if (rule.limitsInvalid) return `The limits saved for ${tool.title} no longer fit it (${rule.limitsInvalid}); set them again`
  if (!tool.withinLimits || !rule.limits) return `${tool.title} has no limits to run inside`
  const outside = tool.withinLimits(preview, rule.limits)
  return outside ? `Over your limit: ${outside}` : null
}

/* ── words of a row ────────────────────────────────────────────────────────────────────────────── */

const capitalised = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

function noteOf(ap: ApprovalRow, state: QueueState, decider: QueueDecider | null, automation: QueueAutomation, plan: QueueRow['plan']): string | null {
  const reason = (ap.reason ?? '').trim()
  switch (state) {
    case 'waiting':
      return automation.whyWaits
    case 'back_to_you':
      if (reason.startsWith('not run by rule — ')) return `Not run by your rule: ${reason.slice('not run by rule — '.length)}`
      return `Not run: ${reason.replace(/^not run\s*—\s*/, '')}`
    case 'failed':
      return `Failed: ${reason.replace(/^execution (failed|error):\s*/, '')}`
    case 'starting':
    case 'on_hold': {
      const head = state === 'on_hold' ? 'On hold' : null
      const by = decider?.kind === 'rule' ? 'Runs by your rule' : decider?.kind === 'claude-code' ? `Confirmed in Claude by ${decider.label.replace(/, code in Claude$/, '')}` : decider ? `Approved by ${decider.label}` : null
      return [head, by].filter(Boolean).join(' · ') || null
    }
    case 'running': {
      if (!plan) return 'Running'
      const done = plan.byStatus.done ?? 0
      const failed = plan.byStatus.failed ?? 0
      const skipped = plan.byStatus.skipped ?? 0
      return `${done} of ${plan.steps} steps done${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}`
    }
    case 'done':
      if (plan && reason) return capitalised(reason)
      return decider?.kind === 'rule' ? 'Ran by your rule' : decider ? `Ran · approved by ${decider.label}` : 'Ran'
    case 'rejected': {
      const words = (ap.operatorNote ?? '').trim() || reason
      if (reason.startsWith('withdrawn')) return capitalised(reason)
      return words ? `Rejected: ${words}` : decider ? `Rejected by ${decider.label}` : 'Rejected'
    }
    case 'expired':
      return reason.startsWith('expired:') ? capitalised(reason.replace(/^expired:\s*/, '')) : 'Nobody decided in time. Nothing changed.'
    case 'replaced':
      return 'Replaced by an edit'
    case 'recorded':
      return 'Approved; this kind only previews, so nothing ran'
  }
}

/* ── building rows ─────────────────────────────────────────────────────────────────────────────── */

async function buildRows(
  approvals: ApprovalRow[],
  viewer: ToolPrincipal | null,
  opts: { allItems?: boolean; planSteps?: Map<string, Array<{ toolName: string; preview: unknown }>> } = {},
): Promise<Built[]> {
  if (!approvals.length) return []
  const joins = await joinsFor(approvals, viewer, opts)
  const cannotApprove = cannotApproveFor(viewer)
  const now = Date.now()
  const built: Built[] = []
  for (const ap of approvals) {
    const tool = getTool(ap.toolName)
    const title = tool?.title ?? ap.toolName
    const state = queueStateOf(ap)
    const run = joins.runs.get(ap.agentRunId)
    const asker = askerOf(run, joins)
    const decider = deciderOf(ap, state, title)
    const isPlan = ap.toolName === PLAN_TOOL
    const visiblePreview = ap.preview == null ? null : joins.visible(ap.toolName, ap.preview)
    const resolved = resolveRequest(ap.toolName, ap.args, visiblePreview, joins.targetCtx)

    // A plan names its first step's target, with the step count (contract: count > 1, sku/name of the first item).
    let plan: QueueRow['plan'] = null
    if (isPlan) {
      const byStatus = joins.stepCounts.get(ap.id) ?? {}
      const steps = Object.values(byStatus).reduce((n, c) => n + c, 0)
      plan = { steps, byStatus }
      const first = joins.firstSteps.get(ap.id)
      const firstShown = first && first.preview != null ? joins.visible(first.toolName, first.preview) : null
      const firstTarget = first ? resolveRequest(first.toolName, first.args, firstShown, joins.targetCtx).target : null
      resolved.target = steps || firstTarget
        ? { ...(firstTarget ?? { kind: 'other', id: null, sku: null, name: null, href: null }), count: Math.max(steps, 1) } as QueueTarget
        : null
      if (steps === 1 && first) {
        const one = resolveRequest(first.toolName, first.args, firstShown, joins.targetCtx)
        resolved.channel = one.channel
        resolved.market = one.market
      }
    }

    const automation = await automationOf(ap, state, tool, asker, run, joins, opts.planSteps?.get(ap.id))

    // May THIS viewer approve it now? Only a waiting request can be approved; the approve's own refusal words.
    let cannotApproveWhy: string | null = null
    let canApprove = false
    if (PENDING_STATES.has(state)) {
      cannotApproveWhy = cannotApprove(ap.toolName)
      if (!cannotApproveWhy && isPlan && viewer) cannotApproveWhy = await planApprovalRefusal(ap.id, viewer)
      if (!cannotApproveWhy && ap.expiresAt && ap.expiresAt.getTime() <= now) cannotApproveWhy = 'This request expired before anyone approved it. Nothing changed.'
      canApprove = !cannotApproveWhy
    }

    // Decision 1 = A: one kind at a time, never a kind that cannot be undone, never a plan.
    let bulkBlockedWhy: string | null = isPlan ? 'A plan is approved on its own' : bulkApproveRefusal(ap.toolName)
    if (!bulkBlockedWhy && !PENDING_STATES.has(state)) bulkBlockedWhy = 'Only a request that waits for a decision can be approved'
    if (!bulkBlockedWhy && !canApprove) bulkBlockedWhy = cannotApproveWhy ?? 'You may not approve it'

    const reachOutside = isPlan ? Number(rec(rec(ap.preview)?.totals)?.reachOutside ?? 0) > 0 : !!tool?.openWorld

    const row: QueueRow = {
      id: ap.id,
      toolName: ap.toolName,
      title,
      area: tool?.category ?? null,
      state,
      rawStatus: ap.status,
      note: null,
      target: resolved.target,
      channel: resolved.channel,
      market: resolved.market,
      changes: resolved.changes.slice(0, 3).map((c) => clipLine(c, LINE_MAX)),
      changeCount: resolved.changeCount,
      summary: resolved.summary ? clip(resolved.summary, 400) : null,
      asker,
      decider,
      reversibility: reversibilityOf(ap.toolName),
      reachesOutside: reachOutside,
      nexusRecord: resolved.nexusRecord,
      requestedAt: ap.requestedAt.toISOString(),
      expiresAt: iso(ap.expiresAt),
      executeAfter: ap.status === 'scheduled' ? iso(ap.executeAfter) : null,
      decidedAt: iso(ap.decidedAt),
      plan,
      canApprove,
      cannotApproveWhy,
      bulkApprovable: !bulkBlockedWhy,
      bulkBlockedWhy,
      automation,
    }
    row.note = noteOf(ap, state, decider, automation, plan)
    built.push({ row, ap, run, tool, resolved, visiblePreview, ctx: joins.targetCtx })
  }
  return built
}

/* ── the three reads ───────────────────────────────────────────────────────────────────────────── */

/** One page of the queue for this viewer: `show=open` oldest first, `done`/`all` newest first; a stable cursor. */
export async function queuePage(raw: QueueQuery, viewer: ToolPrincipal | null): Promise<QueuePage> {
  const q = parseQuery(raw ?? {})
  const where = whereForShow(q.show)
  const ascending = q.show === 'open'
  const dir = ascending ? 'asc' : 'desc'
  const after: Prisma.AgentApprovalWhereInput = q.cursor
    ? ascending
      ? { OR: [{ requestedAt: { gt: q.cursor.at } }, { requestedAt: q.cursor.at, id: { gt: q.cursor.id } }] }
      : { OR: [{ requestedAt: { lt: q.cursor.at } }, { requestedAt: q.cursor.at, id: { lt: q.cursor.id } }] }
    : {}
  const [found, total] = await Promise.all([
    prisma.agentApproval.findMany({
      where: { AND: [where, after] },
      orderBy: [{ requestedAt: dir }, { id: dir }],
      take: q.limit + 1,
      select: APPROVAL_SELECT,
    }),
    prisma.agentApproval.count({ where }),
  ])
  const page = found.slice(0, q.limit)
  const nextCursor = found.length > q.limit ? encodeCursor(page[page.length - 1]) : null
  const rows = (await buildRows(page, viewer)).map((b) => b.row)
  return { rows, nextCursor, total }
}

/** 00:00 UTC today: AgentApproval carries no business time zone, and Workspace has none to read. */
const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

/** The health strip: a handful of counts and one minimum, nothing else. */
export async function queueCounts(now: Date = new Date()): Promise<QueueCounts> {
  const [pending, backToYou, failed, scheduled, running, ranByRuleToday, oldest] = await Promise.all([
    prisma.agentApproval.count({ where: { status: 'pending' } }),
    prisma.agentApproval.count({ where: { status: 'pending', reason: { startsWith: HANDED_BACK_PREFIX } } }),
    prisma.agentApproval.count({ where: { status: 'pending', ...FAILED_WHERE } }),
    // Starting vs on hold needs both times of each scheduled row: a handful of rows (20-second windows and holds).
    prisma.agentApproval.findMany({ where: { status: 'scheduled' }, select: { executeAfter: true, decidedAt: true } }),
    prisma.agentApproval.count({ where: { status: 'executing' } }),
    // A rule-run that ran keeps decisionVia auto; its decidedAt is when its run claimed it (or, for a plan, its approve).
    prisma.agentApproval.count({ where: { decisionVia: 'auto', status: { in: ['executing', 'executed'] }, decidedAt: { gte: startOfUtcDay(now) } } }),
    prisma.agentApproval.aggregate({ where: NEEDS_YOU_WHERE, _min: { requestedAt: true } }),
  ])
  const starting = scheduled.filter((s) => queueStateOf({ status: 'scheduled', reason: null, executeAfter: s.executeAfter, decidedAt: s.decidedAt }) === 'starting').length
  const waiting = Math.max(0, pending - backToYou - failed)
  return {
    needsYou: waiting + backToYou,
    waiting,
    backToYou,
    starting,
    running,
    failed,
    ranByRuleToday,
    oldestNeedsYouAt: iso(oldest._min.requestedAt),
  }
}

/** The nav badge: requests that need a person (waiting + back to you), in one count. */
export async function approvalsNeedYouCount(): Promise<number> {
  return prisma.agentApproval.count({ where: NEEDS_YOU_WHERE })
}

/* ── the drawer ────────────────────────────────────────────────────────────────────────────────── */

const PRICE_TOOLS = new Set(['set-price', 'bulk-price-change', 'set-master-prices'])
const EBAY_AD_TOOLS = new Set(['set-ebay-ad-rates', 'promote-ebay-listings', 'set-ebay-campaign-budget', 'ebay-keywords-change', 'create-ebay-campaign'])
const NEXUS_CANNOT_SEE = 'Nexus cannot see the channel’s answer for this kind of change.'

/** What the channel said about an executed change, where Nexus can know it (approval.tools.ts, as approval-status reads it). */
async function channelResultOf(ap: ApprovalRow, tool: AgentTool | undefined, changeAfter: unknown): Promise<QueueDetail['channelResult']> {
  if (ap.status !== 'executed' || ap.toolName === PLAN_TOOL) return null
  const ads = await adDeliveryOf(ap.id, ap.toolName, ap.preview)
  if (ads) {
    const state = ads.reach === 'sandbox' ? 'unknown'
      : ads.failed || ads.refusedByGate ? 'failed'
        : ads.waiting ? 'waiting'
          : ads.sent || (ads.created && ads.created.total > 0 && ads.created.atAmazon === ads.created.total) ? 'reached'
            : 'unknown'
    return { state, words: adMeaning(ads) }
  }
  if (EBAY_AD_TOOLS.has(ap.toolName)) {
    const ebay = await ebayDeliveryOf(ap.id)
    const state = !ebay ? 'unknown' : ebay.failed ? 'failed' : ebay.waiting ? 'waiting' : ebay.sent || ebay.partly ? 'reached' : 'unknown'
    return { state, words: ebayMeaning(ebay) }
  }
  if (ap.toolName === 'publish-listing') {
    const publicationId = rec(changeAfter)?.publicationId
    if (typeof publicationId !== 'string') return { state: 'unknown', words: publishedMeaning(null) }
    const stored = await (await import('../pim/studio-publication.service.js')).readStoredPublication(publicationId).catch(() => null)
    const status = stored?.status ?? null
    const state = status === 'ACCEPTED' || status === 'VERIFIED' ? 'reached'
      : status === 'FAILED' || status === 'PARTIAL' ? 'failed'
        : status === 'SUBMITTED' || status === 'UNVERIFIED' || status === 'PUBLISHING' ? 'waiting'
          : 'unknown'
    return { state, words: publishedMeaning(status) }
  }
  if (PRICE_TOOLS.has(ap.toolName)) {
    // A heuristic join (the queue does not record the approval): this tool's kind of row for its products since the decision.
    const queue = await channelQueueOf(ap.toolName, rec(ap.args) ?? {}, ap.decidedAt)
    const state = !queue || queue.queued === 0 ? 'unknown' : queue.failed ? 'failed' : queue.waiting ? 'waiting' : queue.sent ? 'reached' : 'unknown'
    return { state, words: executedMeaning(ap.toolName, queue) }
  }
  // A change that stays in Nexus has no channel to answer.
  if (!tool?.openWorld) return null
  return { state: 'unknown', words: NEXUS_CANNOT_SEE }
}

/** What the asker said about why, from the request's own words (`why`, `reason`, `note`): plain text, never Markdown. */
function askerReasonOf(args: unknown): string | null {
  const a = rec(args) ?? {}
  for (const key of ['why', 'reason', 'note']) {
    const value = a[key]
    if (typeof value === 'string' && value.trim()) return clip(value.trim(), 1000)
  }
  return null
}

/** The timeline from stored times only: what is not stored (when a hold was pressed) is not drawn. */
function timelineOf(
  built: Built,
  change: { executedAt: Date; undoneAt: Date | null } | null,
  steps: { firstStarted: Date | null; lastEnded: Date | null } | null,
): QueueEvent[] {
  const { ap, row } = built
  const events: QueueEvent[] = [{ at: ap.requestedAt.toISOString(), kind: 'asked', words: `${row.asker.label} asked` }]
  const by = row.decider
  const approvedWords = by?.kind === 'rule' ? `Approved by your rule · ${row.title}` : by?.kind === 'claude-code' ? `Approved by ${by.label}` : by ? `Approved by ${by.label}` : 'Approved'
  const decided = ap.decidedAt?.toISOString() ?? null
  switch (row.state) {
    case 'starting':
    case 'on_hold':
    case 'recorded':
      if (decided) events.push({ at: decided, kind: 'approved', words: row.state === 'recorded' ? `${approvedWords}; nothing ran (this kind only previews)` : approvedWords })
      break
    case 'running':
      if (row.plan) {
        if (decided) events.push({ at: decided, kind: 'approved', words: approvedWords })
        if (steps?.firstStarted) events.push({ at: steps.firstStarted.toISOString(), kind: 'ran', words: 'Its steps started running' })
      } else if (decided) {
        events.push({ at: decided, kind: 'ran', words: by?.kind === 'rule' ? `Started running by your rule · ${row.title}` : by ? `Started running · approved by ${by.label}` : 'Started running' })
      }
      break
    case 'done':
      if (row.plan) {
        if (decided) events.push({ at: decided, kind: 'approved', words: approvedWords })
        if (steps?.lastEnded) events.push({ at: steps.lastEnded.toISOString(), kind: 'ran', words: row.note ?? 'Its steps ran' })
      } else {
        // A single change's decidedAt is stamped again when its run claims it: it is when it ran, not when it was approved.
        const ranAt = change?.executedAt ?? ap.decidedAt
        if (ranAt) events.push({ at: ranAt.toISOString(), kind: 'ran', words: by?.kind === 'rule' ? `Ran by your rule · ${row.title}` : by ? `Ran · approved by ${by.label}` : 'Ran' })
        if (change?.undoneAt) events.push({ at: change.undoneAt.toISOString(), kind: 'change_undone', words: 'Put back (undone)' })
      }
      break
    case 'rejected':
      if (decided) events.push({ at: decided, kind: 'rejected', words: row.note ?? 'Rejected' })
      break
    case 'replaced':
      if (decided) events.push({ at: decided, kind: 'replaced', words: `Replaced by an edit${by ? ` (${by.label})` : ''}` })
      break
    case 'expired':
      if (ap.expiresAt && ap.expiresAt.getTime() <= Date.now()) events.push({ at: ap.expiresAt.toISOString(), kind: 'expired', words: 'Nobody decided in time. Nothing changed.' })
      break
    case 'failed':
    case 'back_to_you': {
      // A hand-back and a failed run restamp the 24-hour clock (approval-inbox.service.ts handBack, commit path;
      // claude-trust.service.ts handToPerson): that moment is expiresAt − 24 h. A row whose clock was never restamped
      // (expiresAt − 24 h = when it was asked) has no stored moment, and none is drawn.
      const restamped = ap.expiresAt ? new Date(ap.expiresAt.getTime() - EXPIRY_HOURS * 3600_000) : null
      if (restamped && restamped.getTime() - ap.requestedAt.getTime() > 1000) {
        events.push({ at: restamped.toISOString(), kind: row.state === 'failed' ? 'failed' : 'handed_back', words: row.note ?? '' })
      }
      break
    }
    default:
      break
  }
  return events.sort((x, y) => x.at.localeCompare(y.at))
}

/** One request, for the drawer: every change line, its items, its timeline, what the channel said, its change and undo. */
export async function queueDetail(id: string, viewer: ToolPrincipal | null): Promise<QueueDetail | null> {
  const ap = await prisma.agentApproval.findUnique({ where: { id }, select: APPROVAL_SELECT })
  if (!ap) return null
  const isPlan = ap.toolName === PLAN_TOOL

  // A plan's steps, once: the drawer's items, each step against its limits, and when they ran.
  const stepRows = isPlan
    ? await prisma.agentPlanStep.findMany({
        where: { approvalId: id },
        orderBy: { position: 'asc' },
        select: { position: true, toolName: true, args: true, preview: true, startedAt: true, endedAt: true },
      })
    : []
  const [built] = await buildRows([ap], viewer, {
    allItems: true,
    ...(isPlan ? { planSteps: new Map([[id, stepRows.map((s) => ({ toolName: s.toolName, preview: s.preview }))]]) } : {}),
  })
  const { row, resolved, tool } = built

  const recorded = !isPlan && (ap.status === 'executed' || ap.status === 'executing')
    ? await prisma.agentChange.findFirst({
        where: { approvalId: id },
        orderBy: { executedAt: 'desc' },
        select: { id: true, executedAt: true, reversibility: true, undoneAt: true, undoneByApprovalId: true, toolName: true, after: true },
      })
    : null
  const undoApproval = recorded?.undoneByApprovalId
    ? await prisma.agentApproval.findUnique({ where: { id: recorded.undoneByApprovalId }, select: { id: true, status: true } })
    : null
  const liveUndos = new Set(undoApproval && OPEN_STATUSES.includes(undoApproval.status as (typeof OPEN_STATUSES)[number]) ? [undoApproval.id] : [])

  let items = resolved.items
  if (isPlan) {
    // Each step (the first 50): its first change line, named by its product when the page knows it.
    const ctx = await planStepContext(stepRows.slice(0, 50), viewer)
    const visibleStep = viewer ? storedOutputOf(viewer) : () => null
    items = stepRows.slice(0, 50).map((step) => {
      const shown = step.preview == null ? null : visibleStep(step.toolName, step.preview)
      const one = resolveRequest(step.toolName, step.args, shown, ctx)
      const stepTitle = getTool(step.toolName)?.title ?? step.toolName
      const first = one.changes[0]
      return {
        sku: one.target?.sku ?? null,
        name: one.target?.name ?? null,
        change: first ? { ...first, label: `${step.position}. ${stepTitle} · ${first.label}` } : { label: `${step.position}. ${stepTitle}`, from: null, to: null },
      }
    })
  } else {
    // Name each item by its product when the page looked it up.
    items = items.map((item) => ({ ...item, name: item.name ?? (item.sku ? (built.ctx.products?.get(item.sku)?.name ?? null) : null) }))
  }

  const undo = recorded ? undoStateOf(recorded, liveUndos) : null
  const whyNotUndoable = !recorded ? null
    : undo === 'done' ? 'It was already undone.'
      : undo === 'waiting' ? 'An undo of it already waits for a person.'
        : undo === 'not possible' ? (recorded.reversibility === 'none' ? 'This kind of change cannot be undone.' : 'This kind of change has no undo.')
          : null

  const stepTimes = isPlan
    ? {
        firstStarted: stepRows.reduce<Date | null>((min, s) => (s.startedAt && (!min || s.startedAt < min) ? s.startedAt : min), null),
        lastEnded: stepRows.reduce<Date | null>((max, s) => (s.endedAt && (!max || s.endedAt > max) ? s.endedAt : max), null),
      }
    : null

  const mayEdit = PENDING_STATES.has(row.state) && !isPlan && !!tool?.handler && !!viewer && missingPermissions(viewer, tool).length === 0

  return {
    ...row,
    allChanges: resolved.changes.map((c) => clipLine(c, 2000)),
    items: items.slice(0, 50).map((item) => ({ ...item, change: item.change ? clipLine(item.change, LINE_MAX) : null })),
    // The asker's own words, only to a viewer who may read the request (use its tool), as its preview.
    askerReason: viewer && tool && missingPermissions(viewer, tool).length === 0 ? askerReasonOf(ap.args) : null,
    operatorNote: ap.operatorNote,
    reason: ap.reason,
    timeline: timelineOf(built, recorded ? { executedAt: recorded.executedAt, undoneAt: recorded.undoneAt } : null, stepTimes),
    channelResult: await channelResultOf(ap, tool, recorded?.after),
    change: recorded ? { id: recorded.id, undoable: undo === 'possible', undoneAt: iso(recorded.undoneAt), whyNotUndoable } : null,
    canEdit: mayEdit,
    // The request's own arguments, for the drawer's edit form: only when this viewer may edit it (same gate as canEdit).
    editArgs: mayEdit ? rec(ap.args) : null,
  }
}

/**
 * GET …/:id/plan, for the drawer: each step this viewer may see gets its change lines in the grid's own words
 * (`stepChangesOf`: "Base price: €154.00 → €149.00", never the preview's raw 154 → 149). A hidden step gets none.
 */
export function withStepChanges<T extends { tool: string; preview?: unknown }>(list: T[]): Array<T & { changes?: QueueChange[]; changeCount?: number }> {
  const ctx: TargetContext = { masterCurrency: masterCurrency() }
  return list.map((step) => {
    if (step.preview == null) return step
    const { changes, changeCount } = stepChangesOf(step.tool, step.preview, ctx)
    return { ...step, changes: changes.map((c) => clipLine(c, LINE_MAX)), changeCount }
  })
}

/** The product names of a plan's steps (one batched lookup), for the drawer's step list. */
async function planStepContext(steps: Array<{ toolName: string; args: unknown; preview: unknown }>, viewer: ToolPrincipal | null): Promise<TargetContext> {
  const visible = viewer ? storedOutputOf(viewer) : () => null
  const refs = [...new Set(steps.flatMap((s) => productRefsOf(s.toolName, s.args, s.preview == null ? null : visible(s.toolName, s.preview))))].slice(0, 500)
  const products = refs.length
    ? await prisma.product.findMany({ where: { OR: [{ id: { in: refs } }, { sku: { in: refs } }] }, select: { id: true, sku: true, name: true }, take: 1000 })
    : []
  const map = new Map<string, { id: string; sku: string; name: string }>()
  for (const p of products) {
    map.set(p.id, p)
    map.set(p.sku, p)
  }
  return { masterCurrency: masterCurrency(), products: map }
}
