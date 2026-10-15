/**
 * Google Ads programme 2, G12 (2026-10-16) — what every Merchant Center change tool shares, after the Google Ads kit
 * (google-ads-kit.ts), for the Merchant API:
 *
 *   preview   the change is built from the request, the account's LIVE state and Nexus's own records
 *             (marketing/google-merchant/*). Google CANNOT check it first: no Merchant API write has validate_only (the
 *             request messages of productInputs.insert / .delete, dataSources.create / .patch / .delete / .fetch and
 *             promotions.insert have no such field — discovery documents products_v1, datasources_v1, promotions_v1,
 *             read 2026-10-16). The preview says so, says what changes (from → to), what can cost money (spendsMoney: a
 *             product that can show in paid ads again, a promotion that changes the price buyers see) and where it lands.
 *   re-check  when the approved request runs, the gate takes the dry run again (ctx.approvalId): the live state and the
 *             records are read again and compared (`basis`, `plan`, `reach`).
 *   run       only as a request a PERSON approved, as that person, never by rule: the change is built again, refused when
 *             what was approved has moved, and sent as ONE Merchant API call. A change sent has no cancel window.
 *
 * The account is the Merchant Center account this business chose in Nexus (client.ts merchantAccount): a Merchant Center
 * id never crosses businesses, and the gateway checks it again on every call.
 */
import { z } from 'zod'
import { factHash, type ToolContext, type ToolResult } from '../tool-types.js'
import { approvedRun, canonical, notRun } from './ads-change-kit.js'
import { googleAdsWritesMode } from '../../gateway/channels.js'
import { MerchantError, merchantAccount, sendMerchantCall, type MerchantAccount } from '../../marketing/google-merchant/client.js'
import type { MerchantChangeDraft, MerchantDraftResult } from '../../marketing/google-merchant/change-draft.js'

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────

export const merchantAccountArg = z.string().trim().min(1).max(64).optional()
  .describe('the Google account, by its connectionId (channel-connections); default the one this business chose its Merchant Center account through')
export const merchantCenterIdArg = z.string().trim().regex(/^\d{1,20}$/, 'a Merchant Center id is digits only').optional()
  .describe('the Merchant Center account id, only to say which one is meant: it must be the one this business chose in Nexus (google-merchant-live view overview names it)')
export const merchantIdArg = (what: string) => z.string().trim().regex(/^\d{1,20}$/, 'a Google id is digits only')
  .describe(`${what} (Google's id, digits only; google-merchant-live shows it)`)
export const merchantWhyArg = z.string().trim().max(300).optional()
  .describe('why, in a sentence: shown to the person who approves it and kept with the change')

/** The sentence every Merchant Center change tool's description ends with. */
export const MERCHANT_CHANGE_RULES =
  ' Nothing changes until a person approves it in Nexus (Approvals); it then runs as that person, never by a rule. '
  + 'Google CANNOT check a Merchant Center change first (the Merchant API has no validate_only): the preview is built from '
  + 'the live account and Nexus\'s own records, and when the approved change runs Nexus reads them again and sends it only '
  + 'if nothing it stands on moved. The preview says what changes (from → to), what can cost money (spendsMoney — the '
  + 'person\'s decision) and where it lands. ONE Merchant API call; a change sent to Google has no cancel window. Only the '
  + 'Merchant Center account this business chose in Nexus: ids never cross businesses.'

export const NOT_CHECKED = 'Google cannot check a Merchant Center change first (the Merchant API has no validate_only): this preview is built '
  + 'from the live account and Nexus\'s own records; they are read again before it runs.'

// ── preview ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MerchantReach { mode: 'live' | 'off'; accountId: string; merchantCenterId: string }

export type MerchantDraftBuilder = (account: MerchantAccount) => Promise<MerchantDraftResult>

export interface MerchantPreview {
  summary: string
  changes: MerchantChangeDraft['changes']
  totals: MerchantChangeDraft['totals']
  warnings?: string[]
  spendsMoney: boolean
  spendsMoneyBecause?: string[]
  account: { accountId: string; merchantCenterId: string; name: string | null }
  reach: MerchantReach
  googleCheck: { checked: false; sentence: string }
  calls: 1
  basis: string
  plan: string
}

const OFF = 'Google writes are switched off in Nexus (NEXUS_GOOGLE_ADS_WRITES=off, which holds Merchant Center changes too): after approval this change is NOT sent to Google.'

async function draftFor(args: Record<string, unknown>, build: MerchantDraftBuilder): Promise<{ account: MerchantAccount; draft: MerchantChangeDraft } | { refusal: string }> {
  try {
    const account = await merchantAccount({
      accountId: typeof args.accountId === 'string' ? args.accountId : null,
      merchantCenterId: typeof args.merchantCenterId === 'string' ? args.merchantCenterId : null,
    })
    if ('refusal' in account) return account
    const draft = await build(account)
    if ('refusal' in draft) return draft
    return { account, draft }
  } catch (err) {
    if (err instanceof MerchantError) return { refusal: `Nexus could not read Merchant Center: ${err.message}` }
    throw err
  }
}

function previewOf(account: MerchantAccount, draft: MerchantChangeDraft): MerchantPreview {
  const mode = googleAdsWritesMode() === 'live' ? 'live' : 'off'
  const warnings = [...draft.spendsMoney, ...(mode === 'off' ? [OFF] : []), ...draft.warnings]
  return {
    summary: draft.summary,
    changes: draft.changes,
    totals: draft.totals,
    ...(warnings.length ? { warnings } : {}),
    spendsMoney: draft.spendsMoney.length > 0,
    ...(draft.spendsMoney.length ? { spendsMoneyBecause: draft.spendsMoney } : {}),
    account: { accountId: account.accountId, merchantCenterId: account.merchantCenterId, name: account.name },
    reach: { mode, accountId: account.accountId, merchantCenterId: account.merchantCenterId },
    googleCheck: { checked: false, sentence: NOT_CHECKED },
    calls: 1,
    basis: factHash(draft.stands),
    plan: factHash(draft.call),
  }
}

/** The dry run of a Merchant change tool (and the gate's re-check): build from the live state and the records, preview. */
export async function merchantChangePreview(args: Record<string, unknown>, _ctx: ToolContext, build: MerchantDraftBuilder): Promise<ToolResult> {
  const built = await draftFor(args, build)
  if ('refusal' in built) return { ok: false, error: built.refusal }
  return { ok: true, preview: previewOf(built.account, built.draft) }
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MerchantRunOutcome { data: Record<string, unknown>; before: Record<string, unknown>; after: Record<string, unknown> }

/**
 * `execute` of a Merchant change tool: only as a request a person approved, as that person; the change is built again and
 * sent only when it is exactly what was approved. `finish` turns Google's answer (and the moment it was sent: a promotion
 * ended "now") into the record.
 */
export async function runMerchantChange(
  args: Record<string, unknown>,
  ctx: ToolContext,
  build: MerchantDraftBuilder,
  operation: string,
  finish: (draft: MerchantChangeDraft, answer: Record<string, unknown>, sentAt: Date) => MerchantRunOutcome,
): Promise<ToolResult> {
  const run = approvedRun(ctx, String(args.why ?? ''))
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  if (ctx.decidedVia === 'auto' || ctx.approvedByPerson !== true) return notRun('Not run: a Merchant Center change runs only when a person approved it, never by a rule.')
  const approved = (ctx.approvedPreview ?? {}) as Partial<MerchantPreview>
  if (!approved.reach || !approved.basis || !approved.plan) return notRun('Not run: this request does not record what was approved. Ask for it again.')
  const built = await draftFor(args, build)
  if ('refusal' in built) return notRun(`Not run: ${built.refusal}`)
  const { account, draft } = built
  const now = previewOf(account, draft)
  if (canonical(now.reach) !== canonical(approved.reach)) {
    return notRun(`Not run: it was approved for ${approved.reach.mode === 'live' ? 'Google' : 'nothing (writes off)'} on Merchant Center ${approved.reach.merchantCenterId}, and it would now go ${now.reach.mode === 'live' ? 'to Google' : 'nowhere (writes off)'} on ${now.reach.merchantCenterId}.`)
  }
  if (now.reach.mode !== 'live') return notRun('Not run: Google writes are switched off in Nexus (NEXUS_GOOGLE_ADS_WRITES=off). Nothing was sent.')
  if (now.basis !== approved.basis || now.plan !== approved.plan) {
    return notRun('Not run: Merchant Center (or Nexus\'s record of it) changed since this was approved — what it stands on, or the call it would send. Nothing was sent. Ask for it again with the account as it is now.')
  }
  const sentAt = new Date()
  let answer: Record<string, unknown>
  try {
    answer = await sendMerchantCall(account, draft.call, operation, sentAt)
  } catch (err) {
    if (err instanceof MerchantError) {
      // Unknown outcome: the request goes back to waiting; approving it again re-reads first (`basis`).
      return notRun(err.outcome === 'unknown' ? `Not confirmed: ${err.message}` : `Not run: ${err.message}${err.outcome === 'not_sent' ? '' : ' Nothing was changed.'}`)
    }
    throw err
  }
  const outcome = finish(draft, answer, sentAt)
  const stamp = (record: Record<string, unknown>) => ({ ...record, accountId: account.accountId, merchantCenterId: account.merchantCenterId })
  return {
    ok: true,
    data: {
      summary: draft.summary,
      account: { accountId: account.accountId, merchantCenterId: account.merchantCenterId },
      changeSetId: run.changeSetId,
      ...outcome.data,
      note: 'Merchant Center takes a few minutes to process a change: google-merchant-live shows it then.',
    },
    change: { before: stamp(outcome.before), after: stamp(outcome.after) },
  }
}

/**
 * Undo's "now": the Merchant Center account a recorded change was made on, or null when it is no longer this business's
 * chosen account — undo then says it changed and sends nothing.
 */
export async function merchantRecordAccount(record: unknown): Promise<MerchantAccount | null> {
  const r = (record ?? {}) as { accountId?: unknown; merchantCenterId?: unknown }
  const account = await merchantAccount({ accountId: typeof r.accountId === 'string' ? r.accountId : null })
  if ('refusal' in account) return null
  return typeof r.merchantCenterId === 'string' && r.merchantCenterId === account.merchantCenterId ? account : null
}
