/**
 * P1.8 — the nightly contract run. It asks each channel's SANDBOX for one read and one dry-run write per
 * operation and checks the shape of the answer, so a channel change turns this red before it reaches a
 * live listing.
 *
 * Safety, enforced here:
 *   - a check may only be a read or the channel's own dry run (`kind: 'read'` at the gateway), so no
 *     contract run can ever change a listing;
 *   - the URL must resolve to a SANDBOX host (`sandboxUrlOf`); a channel with no sandbox host, or with no
 *     account named for the run, is reported as **not configured** — never as green;
 *   - the run needs its own switch and its own accounts. It sends nothing until the Owner sets them.
 *
 * Accounts come from the environment, one per channel, because a sandbox account is not the account the
 * shop sells with: `NEXUS_CONTRACT_ACCOUNT_EBAY`, `…_AMAZON_SP`, `…_AMAZON_ADS`, `…_SHOPIFY`, `…_ETSY`
 * (plus `NEXUS_CONTRACT_AMAZON_SELLER_ID` for the Amazon seller path).
 */
import { gatewayCall, GatewayRefusal } from '../gateway/gateway.js'
import { sandboxUrlOf } from '../gateway/channels.js'
import type { GatewayChannel } from '../gateway/vocabulary.js'
import { CHANNELS_WITHOUT_SANDBOX, CHANNEL_CONTRACTS, type ContractCheck } from './channel-contracts.js'
import { logger } from '../../utils/logger.js'

export type ContractCheckStatus = 'passed' | 'failed' | 'not-configured'

export interface ContractCheckResult {
  channel: GatewayChannel
  name: string
  what: string
  status: ContractCheckStatus
  detail: string | null
  latencyMs: number | null
}

export interface ContractRunSummary {
  /** green only when at least one check ran and every check that ran passed. */
  status: 'green' | 'red' | 'not-configured'
  passed: number
  failed: number
  notConfigured: number
  results: ContractCheckResult[]
  sentence: string
}

export function isContractRunEnabled(): boolean {
  return process.env.NEXUS_ENABLE_CHANNEL_CONTRACT_RUN === 'true'
}

/** The sandbox account named for a channel, or null when the Owner has not named one. */
export function contractAccountOf(channel: GatewayChannel): string | null {
  const value = process.env[`NEXUS_CONTRACT_ACCOUNT_${channel}`]
  return value && value.trim() ? value.trim() : null
}

async function runCheck(check: ContractCheck, accountId: string): Promise<ContractCheckResult> {
  const base = { channel: check.channel, name: check.name, what: check.what }
  const context = { accountId, sellerId: process.env.NEXUS_CONTRACT_AMAZON_SELLER_ID ?? undefined }
  const sandboxUrl = sandboxUrlOf(check.channel, check.url(context))
  if (!sandboxUrl) {
    return { ...base, status: 'not-configured', detail: `${check.channel} has no sandbox host for this call; nothing was sent.`, latencyMs: null }
  }
  const started = Date.now()
  try {
    const answer = await gatewayCall({
      channel: check.channel,
      operation: `contract.${check.name}`,
      // A contract check is a read or the channel's own dry run — never a write.
      kind: 'read',
      connectionId: accountId,
      url: sandboxUrl,
      method: check.method ?? 'GET',
      headers: check.headers?.(context),
      body: check.body?.(context) ?? null,
      timeoutMs: 30_000,
    })
    const detail = check.assert({ status: answer.status, text: answer.text, json: answer.json.bind(answer) })
    return { ...base, status: detail ? 'failed' : 'passed', detail, latencyMs: Date.now() - started }
  } catch (error) {
    const sentence = error instanceof GatewayRefusal
      ? `${error.code}: ${error.message}`
      : error instanceof Error ? error.message : String(error)
    // A refusal by our own gateway (account needs sign-in, rate bucket, …) is a failed check: the run
    // exists to say "this could not be proven tonight", never to pass quietly.
    return { ...base, status: 'failed', detail: sentence, latencyMs: Date.now() - started }
  }
}

/** Run every contract check. Never throws: the summary is the result, including when nothing could run. */
export async function runChannelContracts(): Promise<ContractRunSummary> {
  const results: ContractCheckResult[] = []

  for (const check of CHANNEL_CONTRACTS) {
    const accountId = contractAccountOf(check.channel)
    if (!accountId) {
      results.push({ channel: check.channel, name: check.name, what: check.what, status: 'not-configured',
        detail: `No sandbox account named for ${check.channel} (set NEXUS_CONTRACT_ACCOUNT_${check.channel}).`, latencyMs: null })
      continue
    }
    results.push(await runCheck(check, accountId))
  }

  for (const { channel, reason } of CHANNELS_WITHOUT_SANDBOX) {
    const accountId = contractAccountOf(channel)
    results.push({ channel, name: `${channel.toLowerCase()}.sandbox`, what: 'read', status: 'not-configured',
      detail: accountId ? `${reason} (an account is named, but this run has no check for it yet.)` : reason, latencyMs: null })
  }

  const passed = results.filter((r) => r.status === 'passed').length
  const failed = results.filter((r) => r.status === 'failed').length
  const notConfigured = results.filter((r) => r.status === 'not-configured').length
  const status: ContractRunSummary['status'] = failed > 0 ? 'red' : passed > 0 ? 'green' : 'not-configured'
  const sentence = failed > 0
    ? `${failed} channel contract check(s) failed: ${results.filter((r) => r.status === 'failed').map((r) => `${r.name} — ${r.detail}`).join(' | ')}`
    : passed > 0
      ? `${passed} channel contract check(s) passed; ${notConfigured} not configured.`
      : `No channel contract check could run: ${notConfigured} not configured.`

  const log = failed > 0 ? logger.error : logger.info
  log.call(logger, 'channel-contract-run', { status, passed, failed, notConfigured })
  return { status, passed, failed, notConfigured, results, sentence }
}
