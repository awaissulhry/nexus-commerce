/**
 * Meta ads changes (step 17, 2026-10-21; mirrors google-ads-kit.ts, Google #632) — what every Meta change tool shares:
 *
 *   preview   the change is built from the request and the ad account's LIVE state (marketing/meta-ads/live-*.ts), then
 *             Meta checks each request it has a check for (`execution_options=["validate_only"]`: Meta answers whether it
 *             would accept it and changes nothing — documented on campaign updates and creates only). A change Meta would
 *             refuse is never queued: the answer says why. A request Meta has no check for says so ("Meta has no check
 *             for this change"). The preview says what changes (from → to), what can make the account spend more
 *             ("SPENDS MONEY": switching on, a budget or bid raise — the person decides each), each request it sends, and
 *             Meta's limits it meets (one change of the same object every 30 s; an ad set's budget 4 times an hour).
 *   re-check  when the approved request runs, the gate takes the dry run again (ctx.approvalId): the live state is read
 *             again and compared (`basis`, `plan`, `reach`), without asking Meta to check it a second time.
 *   run       only as a request a PERSON approved, as that person (ads-change-kit approvedRun): in Nexus, or by the
 *             business's "Claude's changes need no approval" switch in the name of the person who asked (#691) — never
 *             decidedVia auto. The change is built again from the live state, refused when what was approved has moved,
 *             and sent request by request, in order: Meta has no all-or-nothing request for several objects (a batch runs
 *             its parts one by one), so the answer says step by step what Meta did. A request Meta refuses changes
 *             nothing for that object and the next goes on; one Meta did not confirm (no answer, a 5xx) stops the rest and
 *             is never sent again by Nexus. Each request is read back (read-after-write). Meta writes have no cancel
 *             window: the approval is the brake.
 *
 * Every Meta change tool is alwaysAsk, maxClaudeTrust 'ask'. Nothing here names a business: the account is the
 * business's chosen Meta ad account (marketing/meta-ads/change-account.ts), and the gateway checks every object of every
 * request is of it.
 */
import { z } from 'zod'
import { factHash, type ToolContext, type ToolResult } from '../tool-types.js'
import { approvedRun, canonical, notRun } from './ads-change-kit.js'
import { metaChangeAccount, type MetaChangeAccount } from '../../marketing/meta-ads/change-account.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import { metaCheckChange, metaSendChange, MetaWriteError, type MetaChangeResult } from '../../marketing/meta-ads/write-client.js'
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
  + 'rule of its own. Meta checks a request first where it has a check for it (validate_only: campaign changes); for '
  + 'any other the preview says "Meta has no check for this change", and the run reads the live state again first. The '
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

/** What Meta made of each request's check: it would accept it, it has no check for it, or this is a re-check. */
export type MetaRequestCheck = 'accepted' | 'no-check' | 'not-asked-again'

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

/** The exact plan of a change: its requests (object, form fields), in order — never their labels. */
const planOf = (draft: MetaChangeDraft): string => factHash(draft.requests.map((r) => ({ objectId: r.objectId, params: r.params })))

const CHECK_SENTENCE: Record<MetaPreview['metaCheck']['checked'], string> = {
  all: 'Meta checked every request of this change (validate_only) and would accept it.',
  some: 'Meta checked the campaign requests (validate_only) and would accept them. Meta has no check for the other requests (its reference documents validate_only on campaign changes and creates only): they are built from the live state, read again before they are sent.',
  none: 'Meta has no check for this change (its reference documents validate_only on campaign changes and creates only): the preview is built from the live state, and when the approved change runs Nexus reads it again and sends it only if nothing it stands on moved.',
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

function previewOf(account: MetaChangeAccount, draft: MetaChangeDraft, checks: MetaRequestCheck[], recheck: boolean, limits: string[]): MetaPreview {
  const { reach, warning } = reachOf(account)
  const spends = draft.spendsMoney
  const warnings = [...spends.map((s) => `SPENDS MONEY (your decision): ${s}`), ...(warning ? [warning] : []), ...draft.warnings, ...limits]
  const checked = checks.filter((c) => c === 'accepted').length
  const metaCheck: MetaPreview['metaCheck'] = recheck
    ? { checked: 'none', sentence: 'Re-check before running: the live state was read again; Meta was not asked to check it twice.' }
    : { checked: checked === 0 ? 'none' : checked === checks.length ? 'all' : 'some', sentence: CHECK_SENTENCE[checked === 0 ? 'none' : checked === checks.length ? 'all' : 'some'] }
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
  }
}

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
  const checkable = draft.requests.filter((r) => r.checkable)
  const plan = planOf(draft)
  const remembered = checkable.length ? await rememberedCheck(account.adAccountId, plan) : null
  if (checkable.length && !remembered) {
    for (const request of checkable) {
      try {
        await metaCheckChange(account.target, { objectId: request.objectId, params: request.params, operation: `${request.kind}.status` })
      } catch (err) {
        if (!(err instanceof MetaWriteError)) throw err
        return { ok: false, error: err.outcome === 'refused'
          ? `Meta would refuse step ${request.step} (${request.label}): ${err.message} Nothing was queued.`
          : `Not queued: Meta could not check step ${request.step} (${request.label}): ${err.message}` }
      }
    }
    await rememberCheck(account.adAccountId, plan)
  }
  return { ok: true, preview: previewOf(account, draft, draft.requests.map((r) => (r.checkable ? 'accepted' : 'no-check')), false, limits) }
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
}

export interface MetaRunOutcome {
  /** What the tool answers besides the steps. */
  data: Record<string, unknown>
  before: unknown
  after: unknown
}

/** The step's sentence for a done request. */
function doneSentence(request: MetaChangeRequest, result: MetaChangeResult): string {
  const status = typeof result.node?.status === 'string' ? result.node.status : null
  const effective = typeof result.node?.effective_status === 'string' ? result.node.effective_status : null
  const wanted = request.params.status
  const read = result.readBack === 'none'
    ? 'Meta confirmed it; Nexus could not read it back (meta-ads-live shows it).'
    : wanted && status && status !== wanted
      ? `Meta answered success, but reads it back as ${status}${effective ? ` (${effective})` : ''}.`
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
  finish: (draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>) => MetaRunOutcome,
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
  const done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }> = []
  let stoppedAt: number | null = null
  for (const request of draft.requests) {
    if (stoppedAt !== null) {
      steps.push({ step: request.step, label: request.label, outcome: 'not_sent', sentence: `${request.label}: not sent — Nexus stopped after step ${stoppedAt}.` })
      continue
    }
    try {
      const result = await metaSendChange(account.target, { objectId: request.objectId, params: request.params, operation: `${request.kind}.status`, budget: request.budget })
      done.push({ request, result })
      steps.push({
        step: request.step, label: request.label, outcome: 'done', sentence: doneSentence(request, result),
        readBack: result.node ? { status: typeof result.node.status === 'string' ? result.node.status : null, effectiveStatus: typeof result.node.effective_status === 'string' ? result.node.effective_status : null } : null,
      })
    } catch (err) {
      if (!(err instanceof MetaWriteError)) throw err
      if (err.outcome === 'refused' && !err.failure.throttled && !err.failure.authLost) {
        // Meta said no for this one object: nothing changed for it, and the next object is its own request.
        steps.push({ step: request.step, label: request.label, outcome: 'refused', sentence: `${request.label}: ${err.message}` })
        continue
      }
      // No answer, a throttle, a lost token, a hold: the next requests would meet the same; Nexus stops here.
      steps.push({ step: request.step, label: request.label, outcome: err.outcome === 'unknown' ? 'not_confirmed' : 'not_sent', sentence: `${request.label}: ${err.message}` })
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
  const partial = done.length < draft.requests.length
  return {
    ok: true,
    data: {
      summary: draft.summary,
      account: { accountId: account.accountId, adAccountId: account.adAccountId },
      sentence: partial
        ? `Meta made ${done.length} of ${draft.requests.length} requests; the steps say what happened to each. Undo puts back only what Meta made.`
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
