/**
 * Negative Targeting page (2026-10-11) — /api/advertising/waste/*: stop the waste, our keywords (pause, kept paused) and
 * shoppers' search terms (negative exact / phrase / product target), on one page. No Prisma here
 * (scripts/check-route-prisma-ratchet.mjs): services/advertising/waste/* does the work. Three lanes add their blocks to
 * this one file: READ (NREAD), WRITE (NWRITE), RULES (NRULES); each block stands alone.
 *
 * Every read: ads.view (permissions-manifest.ts), `Cache-Control: no-store`, the workspace is the request's (another
 * business's campaign, ad group, product or row is a 404). Money is in cents of the row's currency under WASTE_MONEY keys,
 * stripped for a person without financials.adspend.view (the same switch as the response filter, field-filter.ts); such a
 * person's rows are never ordered by a money key (the order would give the ranking away). Hrefs carry no /w/<id> prefix.
 *
 * WRITE block (lane NWRITE) — the page's writes, through the same code as Claude's Nexus tools
 * (services/advertising/waste/write.ts; the ask() pattern of advertising-brain.routes.ts). The person who clicks Send is
 * the approver. ads.campaigns.manage (the manifest's /api/advertising write rule) and each tool's own permissions.
 *
 *   POST /advertising/waste/preview          { items: [{ rowId, action, where?, keepUntil?, targetRowId?, adGroupId? }], why? }
 *                                            (action KEEP_UNTIL too; each step has level and final) → { steps, blocked,
 *                                            planHash } — writes nothing
 *   POST /advertising/waste/apply            { planHash, items, why?, code? } → 202 { changeSetId, status: queued | waiting,
 *                                            executeAfter?, needsCode, approve, steps, blocked } · 200 { status: applied }
 *                                            when the business lets the tool run without approval · 409 the preview moved ·
 *                                            400 nothing to send or the request refused
 *   POST /advertising/waste/skip             { ids, days: 7 | 30 } or { ids, until (≤ 30 d) } → { skipped, undo } — Nexus only;
 *                                            { reopen: [skip ids] } (an unskip's undo) → { reopened, notReopened, undo }
 *   POST /advertising/waste/unskip           { ids } → { unskipped, undo: { body: { reopen } } | null }
 *   GET  /advertising/waste/waiting/:id     NFIX — every step of a waiting request (a plan is approved together)
 *   POST /advertising/waste/waiting/decide   { decisions: [{ approvalId, decide: approve | reject, reason?, code? }] } →
 *                                            { results, failed } — each through the Approvals page's path; a rule's Ask-me
 *                                            card (`suggestion:<id>`) through the Suggestions page's own apply / dismiss (a
 *                                            pause_target keeps the keyword paused); one that is not the page's is 404
 *
 * Undo: POST /api/advertising/changes/:id/undo, or undo-change with the changeSetId (the set) or a step's change id.
 * Idempotency-Key honoured on every POST here (COMMAND_SCOPES).
 *
 * RULES block (lane NRULES) — the stop-waste rules (services/advertising/waste-rules/*): reads and the preview need ads.view,
 * every write ads.automation.manage (permissions-manifest.ts, named on their own).
 *
 *   GET   /advertising/waste/rules?channel=&market=       { channel, market, rules: WasteRuleRow[], totals, note } — the
 *                                                       brain (negatives lever) and Harvest (source negatives) first, read
 *                                                       only; then every rule that pauses or unpauses a keyword or adds
 *                                                       negatives: the Bid rules' row shape + kind, source, test, ad group
 *   GET   /advertising/waste/rules/starters               the two starters (PLAN §2 defaults; a new rule is born at Watch)
 *   POST  /advertising/waste/rules                        save a new stop-waste rule → 201 { id, name, created, level, scope }
 *   PATCH /advertising/waste/rules/:id                    edit one (fields left out keep the rule's own; Auto → Ask me)
 *   POST  /advertising/waste/rules/preview                { ruleId? | rule?, limit? } → { wouldChange, wouldAsk, sample:
 *                                                       [{ row, campaign, adGroup, action, why, alone, asks, test }],
 *                                                       refused: [{ row, why }] } — writes nothing
 *   GET   /advertising/waste/rules/:id/history?days=&market=&limit=   its changes, each with `changeId` for the undo route
 *   POST  /advertising/waste/rules/:id/archive | /unarchive          archive (replaces delete) / restore at Off
 *   POST  /advertising/waste/rules/mode { ids, mode }     Off · Watch · Ask me · Auto, each through the level dial
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { FIELDS } from '@nexus/shared/permissions'
import { financialPayloadCopy } from '../lib/auth/field-filter.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'
import { readHistory } from '../services/advertising/waste/history.js'
import { isMoneySort, MAX_PAGE_SIZE, WASTE_MONEY } from '../services/advertising/waste/pure.js'
import { invalidateWasteFacts, readWasteRowIds, readWasteRows } from '../services/advertising/waste/read.js'
import { readRowDetail } from '../services/advertising/waste/row.js'
import { readStopped } from '../services/advertising/waste/stopped.js'
import { requestPrincipal, ToolAccessError, type UserPrincipal } from '../services/agents/call-tool.js'
import { APPLY_BODY, DECIDE_BODY, PREVIEW_BODY, applyWaste, decideWaiting, previewWaste } from '../services/advertising/waste/write.js'
import { waitingSteps } from '../services/advertising/waste/waiting-steps.js'
import { MAX_SKIP_ROWS, reopenSkips, skipRows, unskipRows } from '../services/advertising/waste/skip.js'
import { listWasteRules, wasteRuleHistory, WASTE_RULES_MONEY } from '../services/advertising/waste-rules/read.js'
import { previewWasteRule } from '../services/advertising/waste-rules/preview.js'
import { saveWasteRule, setWasteRuleArchived, setWasteRulesMode } from '../services/advertising/waste-rules/write.js'
import { STARTERS } from '../services/advertising/waste-rules/pure.js'
import type { AdsActor } from '../services/advertising/ads-mutation.service.js'

const NO_PERMISSIONS: ResolvedPermissions = { isOwner: false, permissions: new Set() }

/** The switch the response filter strips money under (field-filter.ts). */
const moneyFiltered = () => process.env.NEXUS_RBAC_MODE === 'enforce' || process.env.NEXUS_WORKSPACES_ENABLED === '1'

/** The person sees ad spend: no filter, the owner, all financials, or ad spend. */
function seesAdSpend(request: FastifyRequest): boolean {
  if (!moneyFiltered()) return true
  const resolved = request.__rbacResolved ?? NO_PERMISSIONS
  return resolved.isOwner || resolved.permissions.has(FIELDS.financialsView) || resolved.permissions.has(FIELDS.financialsAdspendView)
}

/** The answer's money keys, stripped under the same switch as the response filter. */
function withoutHiddenMoney<T>(request: FastifyRequest, payload: T): T {
  if (!moneyFiltered()) return payload
  return financialPayloadCopy(payload, request.__rbacResolved ?? NO_PERMISSIONS, WASTE_MONEY)
}

function badQuery(reply: FastifyReply, error: z.ZodError) {
  const issue = error.issues[0]
  return reply.code(400).send({ error: issue ? `${issue.path.join('.') || 'query'}: ${issue.message}` : 'the query is not one this read takes' })
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// READ block (lane NREAD) — rows, rows/ids, stopped, row/:id, history. The MCP tool `ad-waste` reads the same functions.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const id = z.string().trim().min(1).max(64)
const SCOPE = {
  channel: z.enum(['AMAZON']).default('AMAZON'),
  // One market, or none: every market with Amazon ads in this business, one market's facts each (S3: each is reused a
  // short while), merged; money stays per row and per currency.
  market: z.string().trim().toUpperCase().min(2).max(20).optional(),
  portfolioId: id.optional(),
  productId: id.optional(),
  campaignId: id.optional(),
  adGroupId: id.optional(),
}
const PAGE = {
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
}
const ROWS_QUERY = z.object({
  ...SCOPE, ...PAGE,
  kind: z.enum(['keyword', 'term', 'all']).default('all'),
  show: z.enum(['wasting', 'waiting', 'skipped', 'turned-on', 'clashes', 'all']).default('wasting'),
  owner: z.string().trim().min(1).max(64).optional(),
  sort: z.string().trim().regex(/^-?(spend|clicks|orders|xCpa|text|where|product|owner|state)$/, 'one of spend, clicks, orders, xCpa, text, where, product, owner, state (a leading - for descending)').optional(),
}).strict()
const STOPPED_QUERY = z.object({
  ...SCOPE, ...PAGE,
  kind: z.enum(['keyword', 'term', 'all']).default('all'),
  owner: z.string().trim().min(1).max(64).optional(),
  show: z.enum(['kept', 'negated', 'turned-on', 'still-bought', 'all']).default('all'),
}).strict()
const HISTORY_QUERY = z.object({
  ...SCOPE,
  days: z.coerce.number().int().min(1).max(90).default(30),
  kind: z.enum(['keyword', 'term', 'all']).default('all'),
}).strict()

/** A person who does not see ad spend is never ordered by it: a money sort reads as `where`. */
const sortFor = (request: FastifyRequest, sort: string | undefined) => (sort && isMoneySort(sort) && !seesAdSpend(request) ? 'where' : sort ?? (seesAdSpend(request) ? '-spend' : 'where'))

const wasteReadRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/advertising/waste/rows', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = ROWS_QUERY.safeParse(request.query ?? {})
    if (!parsed.success) return badQuery(reply, parsed.error)
    const out = await readWasteRows({ ...parsed.data, sort: sortFor(request, parsed.data.sort) })
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    const { ok: _ok, ...body } = out
    return withoutHiddenMoney(request, body)
  })

  fastify.get('/advertising/waste/rows/ids', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = ROWS_QUERY.safeParse(request.query ?? {})
    if (!parsed.success) return badQuery(reply, parsed.error)
    const out = await readWasteRowIds({ ...parsed.data, sort: sortFor(request, parsed.data.sort) })
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return { ids: out.ids, total: out.total, truncated: out.truncated }
  })

  fastify.get('/advertising/waste/stopped', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = STOPPED_QUERY.safeParse(request.query ?? {})
    if (!parsed.success) return badQuery(reply, parsed.error)
    const out = await readStopped(parsed.data)
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    const { ok: _ok, ...body } = out
    return withoutHiddenMoney(request, body)
  })

  fastify.get('/advertising/waste/row/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const rowId = String((request.params as { id?: string }).id ?? '').trim()
    if (!rowId || rowId.length > 600) return reply.code(400).send({ error: 'id: a row id (kw:<id>, term:<market>|<ad group>|<words>, neg:<id>)' })
    const out = await readRowDetail(rowId)
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    const { ok: _ok, ...body } = out
    return withoutHiddenMoney(request, body)
  })

  fastify.get('/advertising/waste/history', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = HISTORY_QUERY.safeParse(request.query ?? {})
    if (!parsed.success) return badQuery(reply, parsed.error)
    const out = await readHistory(parsed.data)
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return withoutHiddenMoney(request, { rows: out.rows, days: out.days, truncated: out.truncated })
  })
}

// ═══════════════════════════════════════════ WRITE block (lane NWRITE) ═══════════════════════════════════════════

const SKIP_BODY = z.object({
  ids: z.array(z.string().trim().min(1).max(500)).min(1).max(MAX_SKIP_ROWS).optional(),
  days: z.union([z.literal(7), z.literal(30)]).optional(),
  /** An exact end (at most 30 days out: never "dismiss forever"). */
  until: z.string().trim().max(40).optional(),
  /** Polish M5 — the undo of an unskip: the very skips it ended, reopened (their ids, from the unskip's answer). */
  reopen: z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_SKIP_ROWS).optional(),
  reason: z.string().trim().max(300).optional(),
}).refine((b) => [b.days != null, b.until != null, b.reopen != null].filter(Boolean).length === 1, { message: 'name one of days (7 or 30), until or reopen' })
  .refine((b) => b.reopen != null || (b.ids?.length ?? 0) > 0, { message: 'ids: name the rows to skip' })
const UNSKIP_BODY = z.object({ ids: z.array(z.string().trim().min(1).max(500)).min(1).max(MAX_SKIP_ROWS) })

/** The first problem of a body, in words. */
const problemOf = (error: z.ZodError) => {
  const issue = error.issues[0]
  return issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'the body is not one this route takes'
}

/** The signed-in person behind the request, or the refusal already sent (an API key has no person: nothing is asked). */
async function personOf(request: FastifyRequest, reply: FastifyReply): Promise<UserPrincipal | null> {
  try {
    return await requestPrincipal(request)
  } catch (error) {
    if (!(error instanceof ToolAccessError)) throw error
    await reply.code(error.statusCode).send({ error: error.message, code: error.code })
    return null
  }
}

const actorOf = (person: UserPrincipal) => `user:${person.userId}`

/** The page's write routes (registered by the plugin below). */
export async function wasteWriteRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/advertising/waste/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const person = await personOf(request, reply)
    if (!person) return
    const parsed = PREVIEW_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    const out = await previewWaste(parsed.data.items, person, parsed.data.why)
    return { steps: out.steps, blocked: out.blocked, planHash: out.planHash }
  })

  fastify.post('/advertising/waste/apply', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const person = await personOf(request, reply)
    if (!person) return
    const parsed = APPLY_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    const out = await applyWaste(parsed.data, person)
    return reply.code(out.http).send(out.body)
  })

  fastify.post('/advertising/waste/skip', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const person = await personOf(request, reply)
    if (!person) return
    const parsed = SKIP_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    if (parsed.data.reopen) {
      const out = await reopenSkips({ ids: parsed.data.reopen })
      if ('error' in out) return reply.code(400).send({ error: out.error })
      return out
    }
    const until = parsed.data.until ? new Date(parsed.data.until) : null
    if (until && Number.isNaN(until.getTime())) return reply.code(400).send({ error: 'until: not a date' })
    // Never "dismiss forever": an exact end is at most 30 days out (review N3).
    if (until && until.getTime() > Date.now() + 30 * 86_400_000 + 60_000) return reply.code(400).send({ error: 'until: at most 30 days from now' })
    const out = await skipRows({ ids: parsed.data.ids ?? [], days: parsed.data.days ?? null, until, by: actorOf(person), reason: parsed.data.reason })
    if ('error' in out) return reply.code(400).send({ error: out.error })
    return out
  })

  fastify.post('/advertising/waste/unskip', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const person = await personOf(request, reply)
    if (!person) return
    const parsed = UNSKIP_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    const out = await unskipRows({ ids: parsed.data.ids, by: actorOf(person) })
    if ('error' in out) return reply.code(400).send({ error: out.error })
    return out
  })

  // NFIX — every step of a request that waits (a change plan is approved together: the review lists each one first).
  fastify.get('/advertising/waste/waiting/:approvalId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const person = await personOf(request, reply)
    if (!person) return
    const id = String((request.params as { approvalId?: unknown }).approvalId ?? '').trim()
    if (!id || id.length > 64) return reply.code(400).send({ error: 'approvalId: name the request' })
    const out = await waitingSteps(id, person)
    if (!out) return reply.code(404).send({ error: 'No request of the Negative Targeting page with this id.' })
    return out
  })

  fastify.post('/advertising/waste/waiting/decide', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const person = await personOf(request, reply)
    if (!person) return
    const parsed = DECIDE_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    const results = await decideWaiting(parsed.data.decisions, person)
    const failed = results.filter((r) => !r.ok).length
    // One decision: its own status, as the Approvals page answers it. Several: 200 with each result.
    if (results.length === 1 && failed) return reply.code(results[0].httpStatus ?? 409).send({ results, failed })
    return { results, failed }
  })
}

// ═════════════════════════════════════════ end WRITE block (lane NWRITE) ═════════════════════════════════════════

// ═══════════════════════════════════════════ RULES block (lane NRULES) ═══════════════════════════════════════════

const RULES_MARKET = z.string().trim().min(2).max(20).optional()
const RULES_ID = z.string().trim().min(1).max(64)
const RULES_QUERY = z.object({ market: RULES_MARKET, channel: z.enum(['AMAZON', 'EBAY', 'amazon', 'ebay']).optional() })
const RULES_HISTORY_QUERY = z.object({
  market: RULES_MARKET,
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})
const RULES_SCOPE = z.object({
  marketplace: z.string().trim().min(2).max(20).nullable().optional(),
  portfolioId: RULES_ID.nullable().optional(),
  campaignId: RULES_ID.nullable().optional(),
  adGroupId: RULES_ID.nullable().optional(),
  productId: RULES_ID.nullable().optional(),
  wholeAccount: z.boolean().optional(),
}).strict()
const RULE_BODY = z.object({
  kind: z.enum(['PAUSE_KEYWORD', 'NEGATE_TERM']).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  scope: RULES_SCOPE.optional(),
  windowDays: z.number().int().min(14).max(90).optional(),
  minClicks: z.number().int().min(1).max(10_000).optional(),
  cpaMultiple: z.number().min(0.5).max(10).optional(),
  spendFloorCents: z.number().int().min(1).max(10_000_000).optional(),
  match: z.enum(['EXACT', 'PHRASE']).optional(),
  level: z.enum(['AD_GROUP', 'CAMPAIGN']).optional(),
  runAt: z.string().trim().max(5).optional(),
}).strict()
const RULES_PREVIEW_BODY = z.object({ ruleId: RULES_ID.optional(), rule: RULE_BODY.optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict()
const RULES_MODE_BODY = z.object({ ids: z.array(RULES_ID).min(1).max(100), mode: z.enum(['OFF', 'WATCH', 'ASK', 'AUTO']) }).strict()

/** The rules' answer without the money keys this person may not see (the test's bars too). */
function withoutHiddenRuleMoney<T>(request: FastifyRequest, payload: T): T {
  if (!moneyFiltered()) return payload
  return financialPayloadCopy(payload, request.__rbacResolved ?? NO_PERMISSIONS, WASTE_RULES_MONEY)
}

/** The page's stop-waste rules routes (registered by the plugin below). */
export async function wasteRulesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/advertising/waste/rules', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = RULES_QUERY.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    return withoutHiddenRuleMoney(request, await listWasteRules({ market: parsed.data.market ?? null, channel: parsed.data.channel ?? 'AMAZON' }))
  })

  fastify.get('/advertising/waste/rules/starters', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return withoutHiddenRuleMoney(request, { starters: STARTERS })
  })

  fastify.post('/advertising/waste/rules/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = RULES_PREVIEW_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    const out = await previewWasteRule(parsed.data)
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return withoutHiddenRuleMoney(request, out.data)
  })

  fastify.post('/advertising/waste/rules/mode', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const person = await personOf(request, reply)
    if (!person) return
    const parsed = RULES_MODE_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    return (await setWasteRulesMode(parsed.data.ids, parsed.data.mode, actorOf(person) as AdsActor)).data
  })

  fastify.post('/advertising/waste/rules', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const person = await personOf(request, reply)
    if (!person) return
    const parsed = RULE_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    if (!parsed.data.kind) return reply.code(400).send({ error: 'kind: PAUSE_KEYWORD or NEGATE_TERM' })
    const out = await saveWasteRule({ body: parsed.data as never }, actorOf(person) as AdsActor)
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return reply.code(201).send(out.data)
  })

  fastify.patch('/advertising/waste/rules/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const person = await personOf(request, reply)
    if (!person) return
    const { id: ruleId } = request.params as { id: string }
    const parsed = RULE_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    const out = await saveWasteRule({ id: ruleId, body: parsed.data as never }, actorOf(person) as AdsActor)
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return out.data
  })

  fastify.get('/advertising/waste/rules/:id/history', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { id: ruleId } = request.params as { id: string }
    const parsed = RULES_HISTORY_QUERY.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    const out = await wasteRuleHistory(ruleId, { days: parsed.data.days, limit: parsed.data.limit, market: parsed.data.market ?? null })
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return withoutHiddenRuleMoney(request, out.data)
  })

  const archive = (archived: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store')
    const person = await personOf(request, reply)
    if (!person) return
    const { id: ruleId } = request.params as { id: string }
    const out = await setWasteRuleArchived(ruleId, archived, actorOf(person) as AdsActor)
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return out.data
  }
  fastify.post('/advertising/waste/rules/:id/archive', archive(true))
  fastify.post('/advertising/waste/rules/:id/unarchive', archive(false))
}

// ═════════════════════════════════════════ end RULES block (lane NRULES) ═════════════════════════════════════════

const advertisingWasteRoutes: FastifyPluginAsync = async (fastify) => {
  // The reads reuse one market's facts for a short while (read.ts marketWasteFacts): a write through this page forgets
  // them, so the next read shows it at once.
  fastify.addHook('onResponse', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && reply.statusCode < 400) invalidateWasteFacts()
  })
  await fastify.register(wasteReadRoutes)
  await wasteWriteRoutes(fastify)
  await wasteRulesRoutes(fastify)
}

export default advertisingWasteRoutes
