/**
 * Google Ads changes (2026-10-15, Owner's brief) — what every Google Ads change tool shares:
 *
 *   preview   the change is built from the request and the account's LIVE state (marketing/google-ads/live.ts), then
 *             Google checks it (validate_only: Google answers whether it would accept it and changes nothing). A change
 *             Google would refuse is never queued: the answer says why, with the place Google named. The preview says
 *             what changes (from → to), what can make the account spend more ("SPENDS MONEY": an enable, a budget or bid
 *             raise — the person decides each), where it lands and how many operations it costs.
 *   re-check  when the approved request runs, the gate takes the dry run again (ctx.approvalId): the live state is read
 *             again and compared (`basis`, `plan`, `reach`), without asking Google to check it a second time.
 *   run       only as a request a PERSON approved, as that person (ads-change-kit approvedRun; never decidedVia auto): the change is
 *             built again from the live state, refused when what was approved has moved, and sent as ONE atomic
 *             request (all or nothing). Google writes have no cancel window: the approval is the brake. Never by rule.
 *
 * Every Google Ads change tool is alwaysAsk, maxClaudeTrust 'ask' (Owner 2026-10-15: never "runs by rule" for Google).
 * Nothing here names a business: the account is the business's chosen Google Ads account (change-account.ts).
 */
import { z } from 'zod'
import { factHash, type ToolContext, type ToolResult } from '../tool-types.js'
import { approvedRun, canonical, notRun } from './ads-change-kit.js'
import { googleChangeAccount, type GoogleChangeAccount } from '../../marketing/google-ads/change-account.js'
import type { GoogleChangeDraft } from '../../marketing/google-ads/change-draft.js'
import { GoogleAdsWriteError, mutateGoogleAds, writeErrorSentence, type GoogleMutateOperation, type GoogleMutateResponse } from '../../marketing/google-ads/write-client.js'
import type { GoogleAdsTarget } from '../../marketing/google-ads/types.js'
import { GoogleAdsReadError } from '../../marketing/google-ads/errors.js'
import { googleAdsWritesMode } from '../../gateway/channels.js'
import { googleAdsRedis, timed } from '../../marketing/google-ads/ops-budget.js'

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────

export const googleAccountArg = z.string().trim().min(1).max(64).optional()
  .describe('the Google account, by its connectionId (channel-connections); default the business\'s chosen Google Ads account')
export const googleIdArg = (what: string) => z.string().trim().regex(/^\d{1,20}$/, 'a Google id is digits only')
  .describe(`${what} (Google's id, digits only; google-ads-live shows it)`)
export const googleWhyArg = z.string().trim().max(300).optional()
  .describe('why, in a sentence: shown to the person who approves it and kept with the change')
export const googleCentsArg = (what: string) => z.coerce.number().int().min(1).max(100_000_000)
  .describe(`${what}, in minor units (cents) of the account's currency (never converted)`)
export const matchTypeArg = z.preprocess((v) => (typeof v === 'string' ? v.toUpperCase() : v), z.enum(['EXACT', 'PHRASE', 'BROAD']))
  .describe('EXACT, PHRASE or BROAD')

/** The preview keys the re-check compares (approval-inbox MATERIAL_PREVIEW_FIELDS): the live facts, the operations, where it lands. */
export const GOOGLE_MATERIAL = ['basis', 'plan', 'reach'] as const

/** The sentence every Google Ads change tool's description ends with. */
export const GOOGLE_CHANGE_RULES =
  ' Nothing changes until a person approves it in Nexus (Approvals); it then runs as that person, never by a rule. '
  + 'Google checks the change first (validate_only), so a change Google would refuse is never queued. The preview says '
  + 'what changes (from → to), what can make the account spend more (spendsMoney: enabling, a budget or bid raise — the '
  + 'person\'s decision), and the operations it costs (the account has a daily Google Ads allowance). One request, all '
  + 'or nothing; a change sent to Google has no cancel window.'

/**
 * The sentence the description of a change Google cannot check first ends with (a GoogleSender tool: applying or
 * dismissing Google's recommendations — RecommendationService has no validate_only).
 */
export const GOOGLE_UNCHECKED_CHANGE_RULES =
  ' Nothing changes until a person approves it in Nexus (Approvals); it then runs as that person, never by a rule. '
  + 'Google CANNOT check this change first (it has no validate_only for it): the preview is built from the live account, '
  + 'and when the approved change runs Nexus reads it again and sends it only if nothing it stands on moved. The preview '
  + 'says what changes, what can make the account spend more (spendsMoney — the person\'s decision), and the operations '
  + 'it costs. One request, all or nothing; a change sent to Google has no cancel window.'

// ── where it lands ──────────────────────────────────────────────────────────────────────────────────────────────

export interface GoogleReach { mode: 'live' | 'off'; accountId: string; customerId: string }

function reachOf(account: GoogleChangeAccount): { reach: GoogleReach; warning: string | null } {
  const mode = googleAdsWritesMode() === 'live' ? 'live' : 'off'
  return {
    reach: { mode, accountId: account.accountId, customerId: account.customerId },
    warning: mode === 'off'
      ? 'Google Ads writes are switched off in Nexus (NEXUS_GOOGLE_ADS_WRITES=off): after approval this change is NOT sent to Google.'
      : null,
  }
}

// ── preview ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Builds the change from the account's live state; reads Google (live.ts), never writes. */
export type GoogleDraftBuilder = (account: GoogleChangeAccount) => Promise<GoogleChangeDraft | { refusal: string }>

export interface GooglePreview {
  summary: string
  changes: GoogleChangeDraft['changes']
  totals: GoogleChangeDraft['totals']
  warnings?: string[]
  spendsMoney: boolean
  /** Each way the change can make the account spend more, in words (the person's decision). */
  spendsMoneyBecause?: string[]
  skipped?: string[]
  account: { accountId: string; customerId: string; name: string | null; currency: string }
  reach: GoogleReach
  googleCheck: { checked: true; accepted: true; sentence: string } | { checked: false; sentence: string }
  operations: number
  basis: string
  plan: string
}

/** A re-check of an approval (the gate's fresh dry run): it reads, it does not ask Google to check again. */
const isRecheck = (ctx: ToolContext) => !!ctx.approvalId

async function draftFor(args: Record<string, unknown>, build: GoogleDraftBuilder): Promise<{ account: GoogleChangeAccount; draft: GoogleChangeDraft } | { refusal: string }> {
  try {
    const account = await googleChangeAccount(typeof args.accountId === 'string' ? args.accountId : null)
    if ('refusal' in account) return account
    const draft = await build(account)
    if ('refusal' in draft) return draft
    return { account, draft }
  } catch (err) {
    if (err instanceof GoogleAdsReadError) return { refusal: `Nexus could not read the Google Ads account: ${err.message}` }
    throw err
  }
}

function previewOf(account: GoogleChangeAccount, draft: GoogleChangeDraft, check: GooglePreview['googleCheck']): GooglePreview {
  const { reach, warning } = reachOf(account)
  const spends = draft.spendsMoney
  const warnings = [
    ...spends.map((s) => `SPENDS MONEY (your decision): ${s}`),
    ...(warning ? [warning] : []),
    ...draft.warnings,
  ]
  return {
    summary: draft.summary,
    changes: draft.changes,
    totals: draft.totals,
    ...(warnings.length ? { warnings } : {}),
    spendsMoney: spends.length > 0,
    ...(spends.length ? { spendsMoneyBecause: spends } : {}),
    ...(draft.skipped.length ? { skipped: draft.skipped } : {}),
    account: { accountId: account.accountId, customerId: account.customerId, name: account.name, currency: account.currency },
    reach,
    googleCheck: check,
    operations: draft.operations.length,
    basis: factHash(draft.stands),
    plan: factHash(draft.operations),
  }
}

/** How long Google's acceptance of an exact plan is remembered: the same plan within it is not checked (and paid) twice. */
export const CHECK_MEMORY_MS = 30 * 60_000
const checkKey = (customerId: string, plan: string) => `nexus:gads:checked:${customerId}:${plan}`

async function rememberedCheck(customerId: string, plan: string): Promise<string | null> {
  try {
    const redis = await googleAdsRedis()
    return redis ? await timed(redis.get(checkKey(customerId, plan))) : null
  } catch { return null }
}
async function rememberCheck(customerId: string, plan: string): Promise<void> {
  try {
    const redis = await googleAdsRedis()
    if (redis) await timed(redis.set(checkKey(customerId, plan), new Date().toISOString(), 'PX', CHECK_MEMORY_MS))
  } catch { /* a check not remembered is only made again */ }
}

/**
 * The outcome of Google's check of a change: accepted (with the preview), refused by Google or by Nexus's own checks
 * (`why`), or not checked at all (`notChecked`: the allowance, Redis, a read that failed — nothing was judged).
 */
export type GoogleCheckOutcome =
  | { status: 'accepted'; preview: GooglePreview }
  | { status: 'refused'; why: string }
  | { status: 'not-checked'; why: string }

/** Build from the live state and let Google check it (or reuse its acceptance of the same plan in the last 30 minutes). */
export async function googleCheck(args: Record<string, unknown>, build: GoogleDraftBuilder): Promise<GoogleCheckOutcome> {
  const built = await draftFor(args, build)
  if ('refusal' in built) return { status: 'refused', why: built.refusal }
  const { account, draft } = built
  const plan = factHash(draft.operations)
  const at = await rememberedCheck(account.customerId, plan)
  if (at) {
    return { status: 'accepted', preview: previewOf(account, draft, { checked: true, accepted: true, sentence: `Google checked this exact change at ${at.slice(11, 16)} UTC (validate_only) and would accept it: ${draft.operations.length} operation${draft.operations.length === 1 ? '' : 's'}.` }) }
  }
  try {
    await mutateGoogleAds(account.target, draft.operations, { validateOnly: true })
  } catch (err) {
    // Google answered (refused): judged. Anything else (nothing sent, no answer): not checked.
    const judged = err instanceof GoogleAdsWriteError && err.outcome === 'refused'
    return judged ? { status: 'refused', why: writeErrorSentence(err) } : { status: 'not-checked', why: writeErrorSentence(err) }
  }
  await rememberCheck(account.customerId, plan)
  return {
    status: 'accepted',
    preview: previewOf(account, draft, { checked: true, accepted: true, sentence: `Google checked this change (validate_only) and would accept it: ${draft.operations.length} operation${draft.operations.length === 1 ? '' : 's'}.` }),
  }
}

/**
 * A change that is not a GoogleAdsService.Mutate (RecommendationService apply / dismiss): Google has no validate_only for
 * it, so the preview is built on the live state alone and says why Google did not check it (`notChecked`); the run sends
 * the draft's operations with `send`, which fails as mutateGoogleAds does (a GoogleAdsWriteError with its outcome).
 */
export interface GoogleSender {
  notChecked: string
  send: (target: GoogleAdsTarget, operations: GoogleMutateOperation[]) => Promise<{ responses: GoogleMutateResponse[] }>
}

/** The dry run of a Google Ads change tool: build from the live state, let Google check it (not on a re-check), preview. */
export async function googleChangePreview(args: Record<string, unknown>, ctx: ToolContext, build: GoogleDraftBuilder, sender?: GoogleSender): Promise<ToolResult> {
  if (sender) {
    const built = await draftFor(args, build)
    if ('refusal' in built) return { ok: false, error: built.refusal }
    return { ok: true, preview: previewOf(built.account, built.draft, { checked: false, sentence: sender.notChecked }) }
  }
  if (isRecheck(ctx)) {
    const built = await draftFor(args, build)
    if ('refusal' in built) return { ok: false, error: built.refusal }
    return { ok: true, preview: previewOf(built.account, built.draft, { checked: false, sentence: 'Re-check before running: the live facts were read again; Google was not asked to check it twice.' }) }
  }
  const out = await googleCheck(args, build)
  if (out.status === 'accepted') return { ok: true, preview: out.preview }
  return { ok: false, error: out.status === 'refused' && !out.why.startsWith('Google Ads refused') ? out.why : `Not queued: ${out.why}` }
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GoogleRunOutcome {
  /** What the tool answers (the ids Google gave what it made, …). */
  data: Record<string, unknown>
  before: unknown
  after: unknown
}

/**
 * `execute` of a Google Ads change tool: only as an approved request, as the approver; the change is built again from the
 * live state and sent only when it is exactly what was approved. `finish` turns Google's results into the record.
 */
export async function runGoogleChange(
  args: Record<string, unknown>,
  ctx: ToolContext,
  build: GoogleDraftBuilder,
  finish: (draft: GoogleChangeDraft, responses: GoogleMutateResponse[]) => GoogleRunOutcome,
  sender?: GoogleSender,
): Promise<ToolResult> {
  const run = approvedRun(ctx, String(args.why ?? ''))
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  // Owner 2026-10-15: a Google Ads change runs only when a PERSON approved it — never by a rule (the ceiling 'ask'
  // already says so; this holds it in the run itself).
  if (ctx.decidedVia === 'auto' || ctx.approvedByPerson !== true) return notRun('Not run: a Google Ads change runs only when a person approved it, never by a rule.')
  const approved = (ctx.approvedPreview ?? {}) as Partial<GooglePreview>
  if (!approved.reach || !approved.basis || !approved.plan) return notRun('Not run: this request does not record what was approved. Ask for it again.')
  const built = await draftFor(args, build)
  if ('refusal' in built) return notRun(`Not run: ${built.refusal}`)
  const { account, draft } = built
  const now = previewOf(account, draft, { checked: false, sentence: '' })
  if (canonical(now.reach) !== canonical(approved.reach)) {
    return notRun(`Not run: it was approved for ${approved.reach.mode === 'live' ? 'Google' : 'nothing (writes off)'} on account ${approved.reach.customerId}, and it would now go ${now.reach.mode === 'live' ? 'to Google' : 'nowhere (writes off)'} on ${now.reach.customerId}.`)
  }
  if (now.reach.mode !== 'live') return notRun('Not run: Google Ads writes are switched off in Nexus (NEXUS_GOOGLE_ADS_WRITES=off). Nothing was sent.')
  if (now.basis !== approved.basis || now.plan !== approved.plan) {
    return notRun('Not run: the Google Ads account changed since this was approved (what it stands on, or the operations it would send). Nothing was sent. Ask for it again with the account as it is now.')
  }
  let responses: GoogleMutateResponse[]
  try {
    responses = (sender
      ? await sender.send(account.target, draft.operations)
      : await mutateGoogleAds(account.target, draft.operations, { validateOnly: false, operation: 'ads.mutate' })).responses
  } catch (err) {
    // Unknown outcome: the request goes back to waiting, and approving it again re-reads the account first (`basis`),
    // so the change is sent again only when it is not there.
    if (err instanceof GoogleAdsWriteError && err.outcome === 'unknown') return notRun(`Not confirmed: ${err.message}`)
    return notRun(`Not run: ${writeErrorSentence(err)}`)
  }
  const outcome = finish(draft, responses)
  const reread = await rereadAfterChange(account.customerId)
  // Every record names the Google account it was made on: undo reads that account and goes to it, never another.
  const stamp = (record: unknown) => (record && typeof record === 'object' && !Array.isArray(record) ? { ...record, accountId: account.accountId, customerId: account.customerId } : record)
  return {
    ok: true,
    data: { summary: draft.summary, account: { accountId: account.accountId, customerId: account.customerId }, operations: draft.operations.length, changeSetId: run.changeSetId, ...outcome.data, nexusRead: reread },
    change: { before: stamp(outcome.before), after: stamp(outcome.after) },
  }
}

/** After a change: ask Nexus to read the account again (at most once an hour), so its Google Ads pages show it. Never fails the change. */
async function rereadAfterChange(customerId: string): Promise<string> {
  try {
    const { enqueueGoogleAdsSync } = await import('../../marketing/google-ads/enqueue.js')
    const asked = await enqueueGoogleAdsSync({ customerId, kind: 'MANUAL' })
    return asked.queued ? 'Nexus reads the account again now; its Google Ads pages show the change after that read.' : `Nexus's Google Ads pages show the change after the next read (${asked.reason ?? 'the daily read'}). google-ads-live shows it now.`
  } catch {
    return 'Nexus\'s Google Ads pages show the change after the next daily read. google-ads-live shows it now.'
  }
}

/**
 * Undo's "now": the Google account a recorded change was made on (its record names it), or null when that account is
 * no longer this business's Google Ads account — then undo says the account changed and sends nothing.
 */
export async function recordAccount(record: unknown): Promise<GoogleChangeAccount | null> {
  const r = (record ?? {}) as { accountId?: unknown; customerId?: unknown }
  const account = await googleChangeAccount(typeof r.accountId === 'string' ? r.accountId : null)
  if ('refusal' in account) return null
  if (typeof r.customerId === 'string' && r.customerId !== account.customerId) return null
  return account
}

/** The id at the end of a resource name Google gave back (`customers/1/sharedSets/22` → `22`). */
export const resultId = (response: GoogleMutateResponse | undefined, kind: string): string | null => {
  const name = response?.[kind]?.resourceName
  return name ? name.slice(name.lastIndexOf('/') + 1) : null
}
