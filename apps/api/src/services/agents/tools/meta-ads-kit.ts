/**
 * Meta ads changes (step 17, 2026-10-21; mirrors google-ads-kit.ts, Google #632) — what every Meta change tool shares:
 *
 *   preview   the change is built from the request and the ad account's LIVE state (marketing/meta-ads/live-*.ts), then
 *             Meta checks each request Nexus uses its check for (`execution_options=["validate_only"]`: Meta answers whether
 *             it would accept it and changes nothing — documented on campaign updates and creates only; until LIVE-PROBE
 *             ST17-01, only a campaign pause: gateway META_UPDATE_CHECK_PROVEN). A change Meta would refuse is never
 *             queued: the answer says why. Any other request says why it was not checked ("Meta has no check for this
 *             change" / "Meta's check is not used for this change yet"). With Meta changes switched off, no check is sent. The preview says what changes (from → to), what can make the account spend more
 *             ("SPENDS MONEY": switching on, a budget or bid raise — the person decides each), each request it sends, and
 *             Meta's limits it meets (one change of the same object every 30 s; an ad set's budget 4 times an hour).
 *   re-check  when the approved request runs, the gate takes the dry run again (ctx.approvalId): the live state is read
 *             again and compared (`basis`, `plan`, `reach`), without asking Meta to check it a second time.
 *   run       only as a request a PERSON approved, as that person (ads-change-kit approvedRun): in Nexus, or by the
 *             business's "Claude's changes need no approval" switch in the name of the person who asked (#691) — never
 *             decidedVia auto. The change is built again from the live state, refused when what was approved has moved,
 *             and sent request by request, in order: Meta has no all-or-nothing request for several objects (a batch runs
 *             its parts one by one), so the answer says step by step what Meta did. A request Meta refuses changes
 *             nothing for that object and the next pause or archive goes on — but no switch-on (or raise) is sent after a
 *             step that did not happen (review fix A1); one Meta did not confirm, a throttle, or any error of Nexus's own
 *             stops the rest (never sent again by Nexus), and what was done keeps its record and undo (A3). Each request is
 *             read back; an answer that is not a plain success is judged by reading the object (write-client.ts, B1).
 *             Meta writes have no cancel window: the approval is the brake.
 *
 * Every Meta change tool is alwaysAsk, maxClaudeTrust 'ask'. Nothing here names a business: the account is the
 * business's chosen Meta ad account (marketing/meta-ads/change-account.ts), and the gateway checks every object of every
 * request is of it.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { factHash, type ToolContext, type ToolResult } from '../tool-types.js'
import { approvedRun, canonical, notRun } from './ads-change-kit.js'
import { metaChangeAccount, type MetaChangeAccount } from '../../marketing/meta-ads/change-account.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import { expectedOf, metaCheckChange, metaSendChange, MetaWriteError, readBackMismatch, readsOf, type MetaChangeResult, type MetaObjectChange } from '../../marketing/meta-ads/write-client.js'
import { grantRefusal } from '../../marketing/meta-ads/live-safety.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import { metaAdsWritesMode } from '../../gateway/channels.js'
import { metaObjectState, META_ADSET_BUDGET_CHANGES_PER_HOUR, META_OBJECT_EDIT_GAP_MS } from '../../gateway/meta-object-limits.js'

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────

export const metaConnectionArg = z.string().trim().min(1).max(64).optional()
  .describe('the Meta connection, by its connectionId (meta-connection view summary); default: this business\'s one')
export const metaIdArg = (what: string) => z.string().trim().regex(/^\d{1,20}$/, 'a Meta id is digits only')
  .describe(`${what} (Meta's id, digits only; meta-ads-live or meta-ads-overview shows it)`)
export const metaWhyArg = z.string().trim().max(300).optional()
  .describe('why, in a sentence: shown to the person who approves it and kept with the change')

/** The preview keys the re-check compares (approval-inbox MATERIAL_PREVIEW_FIELDS): the live facts, the requests, where it lands. */
export const META_MATERIAL = ['basis', 'plan', 'reach'] as const

/**
 * The sentence every Meta change tool's description ends with — the #691 truth included: with the business's "Claude's
 * changes need no approval" switch on, a change runs 20 s after it is asked for, unless a person stops it.
 */
export const META_CHANGE_RULES =
  ' Nothing changes until a person approves it in Nexus (Approvals) — or, when this business\'s "Claude\'s changes need no '
  + 'approval" switch is on, it runs 20 s after the request unless stopped; either way it runs as that person, never by a '
  + 'rule of its own. Meta checks a request first where Nexus uses Meta\'s check (validate_only: today a campaign pause and the create of a campaign, an ad set or a creative); '
  + 'for any other the preview says why not, and the run reads the live state again first. With Meta changes switched off '
  + 'nothing is sent, not even a check. The '
  + 'preview says what changes (from → to), what can make the account spend more (spendsMoney — the person\'s decision) '
  + 'and every request it sends. Meta has no all-or-nothing request: each is sent on its own, in order, and the answer '
  + 'says step by step what Meta did; a change sent to Meta has no cancel window.'

// ── where it lands ──────────────────────────────────────────────────────────────────────────────────────────────

export interface MetaReach { mode: 'live' | 'off'; accountId: string; adAccountId: string }

function reachOf(account: MetaChangeAccount): { reach: MetaReach; warning: string | null } {
  const mode = metaAdsWritesMode() === 'live' ? 'live' : 'off'
  return {
    reach: { mode, accountId: account.accountId, adAccountId: account.adAccountId },
    warning: mode === 'off' ? 'Meta ads writes are switched off in Nexus (NEXUS_META_ADS_WRITES=off): after approval this change is NOT sent to Meta.' : null,
  }
}

// ── preview ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Builds the change from the account's live state; reads Meta (live-*.ts), never writes. */
export type MetaDraftBuilder = (account: MetaChangeAccount) => Promise<MetaChangeDraft | { refusal: string }>

/**
 * What became of each request's check: Meta would accept it; Meta has no check for it; Meta has one but Nexus does not use
 * it for this change yet (META_UPDATE_CHECK_PROVEN); Meta changes are switched off (no check is sent); a re-check.
 */
export type MetaRequestCheck = 'accepted' | 'no-check' | 'not-used-yet' | 'writes-off' | 'not-asked-again'

export interface MetaPreview {
  summary: string
  changes: MetaChangeDraft['changes']
  totals: MetaChangeDraft['totals']
  warnings?: string[]
  spendsMoney: boolean
  /** Each way the change can make the account spend more, in words (the person's decision). */
  spendsMoneyBecause?: string[]
  skipped?: string[]
  account: { accountId: string; adAccountId: string; name: string | null; currency: string | null }
  reach: MetaReach
  metaCheck: { checked: 'all' | 'some' | 'none'; sentence: string }
  /** Every request Nexus sends, in order, and whether Meta checked it. */
  requests: Array<{ step: number; label: string; metaCheck: MetaRequestCheck }>
  basis: string
  plan: string
  /** Step 19 — what Meta's check of a create recommended (include_recommendations, master CMP-031), when it had any. */
  metaRecommendations?: unknown[]
  /** Step 22 — everything a delete takes with it, in full (change-draft.ts alsoDeleted). */
  alsoDeleted?: unknown
}

/** A re-check of an approval (the gate's fresh dry run): it reads, it does not ask Meta to check again. */
const isRecheck = (ctx: ToolContext) => !!ctx.approvalId

async function draftFor(args: Record<string, unknown>, build: MetaDraftBuilder): Promise<{ account: MetaChangeAccount; draft: MetaChangeDraft } | { refusal: string }> {
  try {
    const account = await metaChangeAccount(typeof args.connectionId === 'string' ? args.connectionId : null)
    if ('refusal' in account) return account
    const draft = await build(account)
    if ('refusal' in draft) return draft
    if (!draft.requests.length) return { refusal: draft.skipped.length ? `Nothing to change: ${draft.skipped.join(' ')}` : 'Nothing to change.' }
    return { account, draft }
  } catch (err) {
    if (err instanceof MetaReadError) return { refusal: `Nexus could not read the Meta ad account: ${err.message}` }
    throw err
  }
}

/**
 * The exact plan of a change: its requests (object, form fields), in order — never their labels. Step 36 review A3 — and a
 * request's method, edge and object kind, ONLY when it names them: a status change's plan hash stays byte for byte what
 * step 17 made (a pending approval does not go stale at a deploy).
 */
export const planOf = (draft: MetaChangeDraft): string => factHash(draft.requests.map((r) => ({
  objectId: r.objectId, params: r.params,
  ...(r.method ? { method: r.method } : {}), ...(r.edge ? { edge: r.edge } : {}), ...(r.objectKind ? { objectKind: r.objectKind } : {}),
})))

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The preview's sentence about Meta's check, from what became of each request's. */
function checkSummary(checks: MetaRequestCheck[], recheck: boolean): MetaPreview['metaCheck'] {
  if (recheck) return { checked: 'none', sentence: 'Re-check before running: the live state was read again; Meta was not asked to check it twice.' }
  if (checks.some((c) => c === 'writes-off')) return { checked: 'none', sentence: 'Meta changes are switched off in Nexus (NEXUS_META_ADS_WRITES): Meta was not asked to check it, and after approval nothing is sent.' }
  const n = (c: MetaRequestCheck) => checks.filter((x) => x === c).length
  const accepted = n('accepted')
  if (accepted === checks.length) return { checked: 'all', sentence: 'Meta checked every request of this change (validate_only) and would accept it.' }
  const none = n('no-check')
  const notYet = n('not-used-yet')
  if (none === checks.length) {
    return { checked: 'none', sentence: 'Meta has no check for this change (its reference documents validate_only on campaign changes and creates only): the preview is built from the live state, and when the approved change runs Nexus reads it again and sends it only if nothing it stands on moved.' }
  }
  const parts = [
    accepted ? `Meta checked ${plural(accepted, 'request')} (validate_only) and would accept ${accepted === 1 ? 'it' : 'them'}.` : '',
    notYet ? `Meta's check is not used for this change yet for ${plural(notYet, 'request')}: Nexus asks it only of a pause until a live probe shows Meta honours validate_only on campaign updates.` : '',
    none ? `Meta has no check for ${plural(none, 'request')} (its reference documents validate_only on campaign changes and creates only).` : '',
    'What Meta did not check is built from the live state and read again before it is sent.',
  ]
  return { checked: accepted ? 'some' : 'none', sentence: parts.filter(Boolean).join(' ') }
}

/**
 * Meta's limits this change meets, in words: one change of the same object every 30 s (Nexus waits it out, its undo too),
 * an ad set's budget 4 times an hour (an undo counts), and the Limited access tier's ~20 changes per 5 minutes.
 */
async function limitWarnings(account: MetaChangeAccount, draft: MetaChangeDraft): Promise<string[]> {
  const out: string[] = []
  const now = Date.now()
  const recent: string[] = []
  for (const request of draft.requests) {
    const state = await metaObjectState(account.accountId, request.objectId, now)
    if (state.heldUntil) recent.push(`${request.label} (Meta holds it until ${new Date(state.heldUntil).toISOString().slice(11, 19)} UTC)`)
    else if (state.touchedAt && now - state.touchedAt < META_OBJECT_EDIT_GAP_MS) recent.push(request.label)
    if (request.budget) {
      const used = state.budgetChanges.length
      if (state.budgetHeldUntil) out.push(`${request.label}: Meta blocks this ad set's budget changes until ${new Date(state.budgetHeldUntil).toISOString().slice(11, 16)} UTC (it allows ${META_ADSET_BUDGET_CHANGES_PER_HOUR} an hour); it is not sent before then.`)
      else if (used + 2 > META_ADSET_BUDGET_CHANGES_PER_HOUR) {
        out.push(`${request.label}: this ad set's budget changed ${used} time${used === 1 ? '' : 's'} in the last hour; Meta allows ${META_ADSET_BUDGET_CHANGES_PER_HOUR} an hour and then blocks its budget for an hour (an undo counts too)${used + 1 > META_ADSET_BUDGET_CHANGES_PER_HOUR ? ', so Meta refuses this one now' : ', so this change leaves no room for its undo within the hour'}.`)
      }
    }
  }
  if (recent.length) out.push(`Meta allows one change of the same object every 30 s: ${recent.join('; ')} ${recent.length === 1 ? 'was' : 'were'} changed or checked moments ago, so Nexus waits up to 30 s before sending ${recent.length === 1 ? 'it' : 'them'}.`)
  if (draft.requests.some((r) => r.undoable)) out.push('Its undo changes the same objects again: Meta takes that only 30 s after this change (one change of an object every 30 s), so an undo asked at once waits that out.')
  if (draft.requests.length > 10) {
    out.push(`This change sends ${draft.requests.length} requests. At Meta's Limited access tier an ad account takes about 20 changes per 5 minutes (a change counts 3 of its 60 points): Nexus sends them in order and stops when Meta says to slow down; the answer then lists the ones not sent.`)
  }
  return out
}

function previewOf(account: MetaChangeAccount, draft: MetaChangeDraft, checks: MetaRequestCheck[], recheck: boolean, limits: string[], recommendations: unknown[] = []): MetaPreview {
  const { reach, warning } = reachOf(account)
  const spends = draft.spendsMoney
  const warnings = [...spends.map((s) => `SPENDS MONEY (your decision): ${s}`), ...(warning ? [warning] : []), ...draft.warnings, ...limits]
  const metaCheck = checkSummary(checks, recheck)
  return {
    summary: draft.summary,
    changes: draft.changes,
    totals: draft.totals,
    ...(warnings.length ? { warnings } : {}),
    spendsMoney: spends.length > 0,
    ...(spends.length ? { spendsMoneyBecause: spends } : {}),
    ...(draft.skipped.length ? { skipped: draft.skipped } : {}),
    account: { accountId: account.accountId, adAccountId: account.adAccountId, name: account.name, currency: account.currency },
    reach,
    metaCheck,
    requests: draft.requests.map((r, i) => ({ step: r.step, label: r.label, metaCheck: checks[i] })),
    basis: factHash(draft.stands),
    plan: planOf(draft),
    ...(recommendations.length ? { metaRecommendations: recommendations } : {}),
    ...(draft.alsoDeleted !== undefined ? { alsoDeleted: draft.alsoDeleted } : {}),
  }
}

/** Step 19 — Meta's recommendations as the preview shows them: at most 10, each at most 1,000 characters of its JSON. */
const shownRecommendations = (list: unknown[]): unknown[] => list.slice(0, 10).map((r) => {
  const text = JSON.stringify(r) ?? ''
  return text.length > 1000 ? `${text.slice(0, 999)}…` : r
})

/** How long Meta's acceptance of an exact plan is remembered: the same plan within it is not checked twice. */
export const CHECK_MEMORY_MS = 30 * 60_000
const CHECK_KEY = (adAccountId: string, plan: string) => `nexus:meta-ads:checked:${adAccountId}:${plan}`
const REDIS_TIMEOUT_MS = 2_500

/** The app's Redis (null when none is configured), each command given 2.5 s. */
async function memory(): Promise<{ get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> } | null> {
  if (!process.env.REDIS_URL?.trim() && !process.env.REDIS_HOST?.trim()) return null
  const { redis } = await import('../../../lib/queue.js')
  const timed = <T>(work: Promise<T>) => { work.catch(() => {}); return Promise.race([work, new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('Redis did not answer in time')), REDIS_TIMEOUT_MS).unref?.() })]) }
  return {
    get: (key) => timed(redis.connection.get(key)),
    set: async (key, value) => { await timed(redis.connection.set(key, value, 'PX', CHECK_MEMORY_MS)) },
  }
}
async function rememberedCheck(adAccountId: string, plan: string): Promise<string | null> {
  try { return (await (await memory())?.get(CHECK_KEY(adAccountId, plan))) ?? null } catch { return null }
}
async function rememberCheck(adAccountId: string, plan: string): Promise<void> {
  try { await (await memory())?.set(CHECK_KEY(adAccountId, plan), new Date().toISOString()) } catch { /* a check not remembered is only made again */ }
}

/**
 * The dry run of a Meta change tool: build from the live state, let Meta check each request it has a check for (not on
 * a re-check; the same plan's acceptance is remembered 30 minutes), preview. A request Meta would refuse refuses the whole
 * preview, with Meta's words and the step; a check that could not be made (no answer, a throttle) queues nothing.
 */
export async function metaChangePreview(args: Record<string, unknown>, ctx: ToolContext, build: MetaDraftBuilder): Promise<ToolResult> {
  const built = await draftFor(args, build)
  if ('refusal' in built) return { ok: false, error: built.refusal }
  const { account, draft } = built
  const limits = await limitWarnings(account, draft)
  if (isRecheck(ctx)) return { ok: true, preview: previewOf(account, draft, draft.requests.map(() => 'not-asked-again'), true, limits) }
  // Review fix A2 — with Meta changes switched off, no check is sent either (the gateway refuses it too).
  if (metaAdsWritesMode() !== 'live') return { ok: true, preview: previewOf(account, draft, draft.requests.map(() => 'writes-off'), false, limits) }
  const checkable = draft.requests.filter((r) => r.check === 'meta')
  const plan = planOf(draft)
  const remembered = checkable.length ? await rememberedCheck(account.adAccountId, plan) : null
  const recommendations: unknown[] = []
  if (checkable.length && !remembered) {
    for (const request of checkable) {
      try {
        const answer = await metaCheckChange(account.target, { ...objectChangeOf(request), budget: undefined, readBackInPost: undefined })
        if (answer?.recommendations?.length) recommendations.push(...answer.recommendations)
      } catch (err) {
        if (!(err instanceof MetaWriteError)) throw err
        return { ok: false, error: err.outcome === 'refused'
          ? `Meta would refuse step ${request.step} (${request.label}): ${err.message} Nothing was queued.`
          : `Not queued: Meta could not check step ${request.step} (${request.label}): ${err.message}` }
      }
    }
    await rememberCheck(account.adAccountId, plan)
  }
  return { ok: true, preview: previewOf(account, draft, draft.requests.map((r) => (r.check === 'meta' ? 'accepted' : r.check === 'not-yet' ? 'not-used-yet' : 'no-check')), false, limits, shownRecommendations(recommendations)) }
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One request of a run, as the answer reports it. */
export interface MetaRunStep {
  step: number
  label: string
  /** done: Meta made it · refused: Meta said no (nothing changed for it) · not_confirmed: sent, Meta did not say · not_sent */
  outcome: 'done' | 'refused' | 'not_confirmed' | 'not_sent'
  sentence: string
  /** done: the object as Meta read it back (status, effective_status), when it could be read. */
  readBack?: { status: string | null; effectiveStatus: string | null } | null
  /** Step 18 — done, a change past status: the fields it asked, as Meta read them back. */
  values?: Record<string, unknown>
}

export interface MetaRunOutcome {
  /** What the tool answers besides the steps. */
  data: Record<string, unknown>
  before: unknown
  after: unknown
  /** Step 22 (review A5) — the change has no undo: this sentence takes the place of "Undo puts back only what Meta made." */
  noUndo?: string
}

/**
 * Step 18 — one request as the write client sends it: its own gateway operation (default `<kind>.status`), the kind the
 * gateway confirms, its read-back and what that must show, and for a budget schedule its edge, method and parent. A
 * status change (set-meta-status) gives none of the step 18 fields and goes exactly as in step 17.
 */
export function objectChangeOf(request: MetaChangeRequest): MetaObjectChange {
  return {
    objectId: request.objectId,
    kind: request.objectKind ?? request.kind,
    params: request.params,
    operation: request.operation ?? `${request.kind}.status`,
    budget: request.budget,
    readBackInPost: request.readBackInPost,
    ...(request.expect ? { expect: request.expect } : {}),
    ...(request.readBackFields ? { readBackFields: request.readBackFields } : {}),
    ...(request.edge ? { edge: request.edge } : {}),
    ...(request.method ? { method: request.method } : {}),
    ...(request.parent ? { parent: request.parent } : {}),
    ...(request.recommendations ? { recommendations: true } : {}),
    ...(request.readBackObject ? { readBackObject: true as const } : {}),
    // Step 39 — the read-back that judges it.
    ...(request.judge ? { judge: request.judge } : {}),
    ...(request.readBackOf ? { readBackOf: request.readBackOf } : {}),
    // Step 36 — a request never read back (a test lead).
    ...(request.skipReadBack ? { skipReadBack: request.skipReadBack } : {}),
    // Step 30 — a webhook or alert subscription change travels as its request says (write-client.ts MetaRequestVia).
    ...(request.via ? { via: request.via } : {}),
  }
}

/** Step 36 — Meta's code of a failure in the request's own plain words (base code: `80005/123` → `80005`), or ''. */
function explained(request: MetaChangeRequest, err: MetaWriteError): string {
  const base = (err.failure.code ?? '').split('/')[0]
  const words = base && request.explain ? request.explain[base] : undefined
  return words ? ` ${words}` : ''
}

/** Step 18 — the step's sentence for a done request past status: what Meta reads back for the fields it asked. */
function doneSettingsSentence(request: MetaChangeRequest, result: MetaChangeResult): string {
  const expected = expectedOf(request)
  // Step 39 — a request judged by its own read-back says how it reads now.
  const judged = request.judge && result.node && result.readBack !== 'none' ? request.judge(result.node) : null
  const read = result.afterError
    ? `Meta's answer was not a success (${result.afterError.replace(/\.$/, '')}), but Nexus read it back as asked: Meta made it.`
    : judged
      ? `Meta made it; it now reads ${judged.reads}.`
      : request.method === 'DELETE'
        ? 'Meta confirmed it.'
        // Step 36 — a request never read back on purpose (a test lead): Meta's answer names its id.
        : request.skipReadBack && result.node && (typeof result.node.id === 'string' || typeof result.node.id === 'number')
          ? `Meta made it (id ${result.node.id}).`
        : result.readBack === 'none' || !result.node
          ? 'Meta confirmed it; Nexus could not read it back (meta-ads-live shows it).'
          // Step 21 — a create whose read-back judges no field (a reach & frequency prediction is worked out later): made.
          // Step 39 — the same for a block-list draft Meta made.
          : !Object.keys(expected).length
            ? 'Meta made it.'
            : `Meta made it; it now reads ${readsOf(result.node, expected)}.`
  return `${request.label}: ${read}${result.waitedMs ? ` Nexus waited ${Math.round(result.waitedMs / 1000)} s first (Meta's limit of one change of an object every 30 s).` : ''}`
}

/** The step's sentence for a done request. */
function doneSentence(request: MetaChangeRequest, result: MetaChangeResult): string {
  // Step 23 — a request with its own sender says what Meta made in its own words.
  if (request.doneSentence) return request.doneSentence(result)
  if (request.expect || request.method === 'DELETE' || request.edge || request.judge) return doneSettingsSentence(request, result)
  const status = typeof result.node?.status === 'string' ? result.node.status : null
  const effective = typeof result.node?.effective_status === 'string' ? result.node.effective_status : null
  const wanted = request.params.status
  const read = result.afterError
    ? `Meta's answer was not a success (${result.afterError.replace(/\.$/, '')}), but Nexus read it back as ${status ?? wanted}: Meta made it.`
    : result.readBack === 'none'
      ? 'Meta confirmed it; Nexus could not read it back (meta-ads-live shows it).'
      : `Meta made it; it now reads ${status ?? wanted}${effective && effective !== status ? ` (${effective})` : ''}.`
  return `${request.label}: ${read}${result.waitedMs ? ` Nexus waited ${Math.round(result.waitedMs / 1000)} s first (Meta's limit of one change of an object every 30 s).` : ''}`
}

/**
 * `execute` of a Meta change tool: only as a request a person approved, as that person; built again from the live state,
 * sent only when it is exactly what was approved, request by request. `finish` turns the requests Meta made (with their
 * read-back) into the record: what they replaced and wrote, for undo. Nothing done at all = not run (the steps say why).
 */
export async function runMetaChange(
  args: Record<string, unknown>,
  ctx: ToolContext,
  build: MetaDraftBuilder,
  finish: (draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult; notAsAsked?: string }>) => MetaRunOutcome,
  after?: (account: MetaChangeAccount, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>) => Promise<string>,
): Promise<ToolResult> {
  const run = approvedRun(ctx, String(args.why ?? ''))
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  if (ctx.decidedVia === 'auto' || ctx.approvedByPerson !== true) {
    return notRun('Not run: a Meta change runs only when a person approved it (in Nexus, or by this business\'s "Claude\'s changes need no approval" switch in the name of the person who asked), never by a rule.')
  }
  const approved = (ctx.approvedPreview ?? {}) as Partial<MetaPreview>
  if (!approved.reach || !approved.basis || !approved.plan) return notRun('Not run: this request does not record what was approved. Ask for it again.')
  const built = await draftFor(args, build)
  if ('refusal' in built) return notRun(`Not run: ${built.refusal}`)
  const { account, draft } = built
  const now = previewOf(account, draft, draft.requests.map(() => 'not-asked-again'), true, [])
  if (canonical(now.reach) !== canonical(approved.reach)) {
    return notRun(`Not run: it was approved for ${approved.reach.mode === 'live' ? 'Meta' : 'nothing (writes off)'} on ad account ${approved.reach.adAccountId}, and it would now go ${now.reach.mode === 'live' ? 'to Meta' : 'nowhere (writes off)'} on ${now.reach.adAccountId}.`)
  }
  if (now.reach.mode !== 'live') return notRun('Not run: Meta ads writes are switched off in Nexus (NEXUS_META_ADS_WRITES=off). Nothing was sent.')
  if (now.basis !== approved.basis || now.plan !== approved.plan) {
    return notRun('Not run: the Meta ad account changed since this was approved (what it stands on, or the requests it would send). Nothing was sent. Ask for it again with the account as it is now.')
  }

  const steps: MetaRunStep[] = []
  const done: Array<{ request: MetaChangeRequest; result: MetaChangeResult; notAsAsked?: string }> = []
  let stoppedAt: number | null = null
  // Review fix A1 — the first request of this change that did not happen: a later switch-on (or raise) is never sent,
  // because what its "nothing spends yet" stood on may be exactly that request.
  let missedAt: number | null = null
  // Step 39 (review A9) — a change whose later request takes ids from an earlier one (`prepare`: a list made from the
  // block-list draft it uploaded) gets this run's own id: the gateway lets a request use only what an earlier request of
  // the SAME run made. Every other change goes exactly as before.
  const runId = draft.requests.some((r) => r.prepare !== undefined) ? randomUUID() : null
  for (const request of draft.requests) {
    if (stoppedAt !== null) {
      steps.push({ step: request.step, label: request.label, outcome: 'not_sent', sentence: `${request.label}: not sent — Nexus stopped after step ${stoppedAt}.` })
      continue
    }
    if (missedAt !== null && request.raisesSpend) {
      steps.push({ step: request.step, label: request.label, outcome: 'not_sent', sentence: `${request.label}: not sent — step ${missedAt} did not happen, and Nexus sends nothing that can make the account spend more after a step of the same change that did not (what it stood on may have been that step).` })
      continue
    }
    // Step 22 — a request that stands on earlier steps of the same change goes only when each of them happened as asked.
    const missing = (request.needs ?? []).filter((s) => !done.some((d) => d.request.step === s && !d.notAsAsked))
    if (missing.length) {
      missedAt ??= request.step
      steps.push({ step: request.step, label: request.label, outcome: 'not_sent', sentence: `${request.label}: not sent — it stands on step ${missing.join(', ')} of this change, which did not happen as asked.` })
      continue
    }
    try {
      // Step 39 — a request that takes params from an earlier one (a list made from the draft step 1 uploaded) gets them now.
      const params = request.prepare ? { ...request.params, ...(await request.prepare(done)) } : request.params
      // Step 23 — a request may bring its own sender (an upload read again, a multi-call video upload): one step all the same.
      const result = request.send ? await request.send(account.target) : await metaSendChange(account.target, { ...objectChangeOf(request), params, ...(runId ? { runId } : {}) })
      // Step 18 — a change past status: Meta said success, but a field it asked reads back otherwise: not done (no
      // record, no undo), and a missed step for what follows. Step 39: or its own read-back judge says so.
      const judged = request.judge && result.node && result.readBack !== 'none' ? request.judge(result.node) : null
      const moved = judged ? judged.moved : request.expect ? readBackMismatch(result.node, expectedOf(request)) : []
      // Step 19 (review A4) — a create or a copy Meta made that reads back otherwise: recorded as made (so undo can delete
      // it), the step not confirmed, and a missed step for what follows.
      if (moved.length && request.recordEvenIfNotAsAsked) {
        missedAt ??= request.step
        const reads = readsOf(result.node!, expectedOf(request))
        done.push({ request, result, notAsAsked: reads })
        steps.push({ step: request.step, label: request.label, outcome: 'not_confirmed', sentence: `${request.label}: Meta made it, but it reads back ${reads}, not what was asked (${moved.join(', ')}). Nexus records what Meta made (its undo can delete it) and never sends it again by itself; meta-ads-live shows it now.` })
        continue
      }
      if (moved.length) {
        missedAt ??= request.step
        steps.push({ step: request.step, label: request.label, outcome: 'not_confirmed', sentence: `${request.label}: Meta answered success but it reads back ${judged ? judged.reads : readsOf(result.node!, expectedOf(request))}, not what was asked (${moved.join(', ')}). Nexus records no change for it and never sends it again by itself; meta-ads-live shows it now.` })
        continue
      }
      // Meta said success, but the object reads back with another status than the one asked: not done (no record, no
      // undo), and a missed step for what follows (no later switch-on).
      const readStatus = typeof result.node?.status === 'string' ? result.node.status : null
      if (readStatus && request.params.status && readStatus !== request.params.status) {
        missedAt ??= request.step
        steps.push({ step: request.step, label: request.label, outcome: 'not_confirmed', sentence: `${request.label}: Meta answered success but it reads back ${readStatus}${typeof result.node?.effective_status === 'string' ? ` (${result.node.effective_status})` : ''}, not ${request.params.status}. Nexus records no change for it and never sends it again by itself; meta-ads-live shows it now.` })
        continue
      }
      done.push({ request, result })
      steps.push({
        step: request.step, label: request.label, outcome: 'done', sentence: doneSentence(request, result),
        readBack: result.node ? { status: typeof result.node.status === 'string' ? result.node.status : null, effectiveStatus: typeof result.node.effective_status === 'string' ? result.node.effective_status : null } : null,
        ...(request.expect && result.node ? { values: Object.fromEntries(Object.keys(request.expect).map((f) => [f, result.node![f] ?? null])) } : {}),
      })
    } catch (err) {
      // Review fix A3 — EVERY error ends in a step, never in a lost run: what was already done keeps its record and undo.
      missedAt ??= request.step
      if (!(err instanceof MetaWriteError)) {
        // metaSendChange turns every error of a send into a MetaWriteError; anything else came before Meta was reached.
        steps.push({ step: request.step, label: request.label, outcome: 'not_sent', sentence: `${request.label}: not sent — Nexus hit a problem of its own (${err instanceof Error ? err.message : String(err)}).` })
        stoppedAt = request.step
        continue
      }
      if (err.outcome === 'refused' && !err.failure.throttled && !err.failure.authLost) {
        // Meta said no for this one object: nothing changed for it, and the next object is its own request. Step 39 (D6):
        // refused for access on a request that needs a Meta capability grant — the grant and the no-grant controls.
        const words = request.grant && err.failure.permissionDenied ? grantRefusal(err, request.grant).message : err.message
        steps.push({ step: request.step, label: request.label, outcome: 'refused', sentence: `${request.label}: ${words}${explained(request, err)}` })
        continue
      }
      // Not confirmed, a throttle, a lost token, a hold: the next requests would meet the same; Nexus stops here.
      steps.push({ step: request.step, label: request.label, outcome: err.outcome === 'unknown' ? 'not_confirmed' : 'not_sent', sentence: `${request.label}: ${err.message}${explained(request, err)}` })
      stoppedAt = request.step
    }
  }
  const report = steps.map((s) => `${s.step}. ${s.sentence}`).join(' ')
  if (!done.length) {
    return notRun(steps.some((s) => s.outcome === 'not_confirmed') ? `Not confirmed: ${report}` : `Not run: Meta changed nothing. ${report}`)
  }
  const outcome = finish(draft, done)
  const bookkeeping = after ? await after(account, done).catch(() => 'Nexus\'s pages show the change after the next daily read; meta-ads-live shows it now.') : null
  // Every record names the Meta account it was made on: undo reads that account and goes to it, never another.
  const stamp = (record: unknown) => (record && typeof record === 'object' && !Array.isArray(record) ? { ...record, accountId: account.accountId, adAccountId: account.adAccountId } : record)
  const partial = done.length < draft.requests.length || done.some((d) => d.notAsAsked)
  return {
    ok: true,
    data: {
      summary: draft.summary,
      account: { accountId: account.accountId, adAccountId: account.adAccountId },
      sentence: partial
        ? `Meta made ${done.filter((d) => !d.notAsAsked).length} of ${draft.requests.length} requests as asked; the steps say what happened to each. ${outcome.noUndo ?? 'Undo puts back only what Meta made.'}`
        : `Meta made all ${draft.requests.length} request${draft.requests.length === 1 ? '' : 's'}.`,
      done: done.length,
      of: draft.requests.length,
      steps,
      changeSetId: run.changeSetId,
      ...outcome.data,
      ...(bookkeeping ? { nexusRead: bookkeeping } : {}),
    },
    change: { before: stamp(outcome.before), after: stamp(outcome.after) },
  }
}

/**
 * Undo's "now": the Meta account a recorded change was made on (its record names it), or null when that account is no
 * longer this business's chosen ad account — then undo says the account changed and sends nothing.
 */
export async function recordAccount(record: unknown): Promise<MetaChangeAccount | null> {
  const r = (record ?? {}) as { accountId?: unknown; adAccountId?: unknown }
  const account = await metaChangeAccount(typeof r.accountId === 'string' ? r.accountId : null)
  if ('refusal' in account) return null
  if (typeof r.adAccountId === 'string' && r.adAccountId !== account.adAccountId) return null
  return account
}
