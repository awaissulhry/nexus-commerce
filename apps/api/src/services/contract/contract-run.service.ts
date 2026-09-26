/**
 * P1.8 — the nightly contract run. It asks each channel's SANDBOX for one read and one dry-run write per
 * operation and checks the shape of the answer, so a channel change turns this red before it reaches a
 * live listing. Exception (review 2026-09-26): Amazon SP-API's static sandbox answers FIXED examples, so its
 * checks prove sign-in and reachability only (`RequiredOperation.proves`) and the sentence says so.
 *
 * Safety, enforced here:
 *   - a check may only be a read or the channel's own dry run (`kind: 'read'` at the gateway), so no
 *     contract run can ever change a listing;
 *   - the URL must resolve to a SANDBOX host (`sandboxUrlOf`); a channel with no sandbox host, or with no
 *     account named for the run, is reported as **not configured** — never as green;
 *   - the run needs its own switch and its own accounts. It sends nothing until the Owner sets them;
 *   - an eBay check runs only as a connection whose `connectionMetadata.environment` is 'sandbox'
 *     (`ACCOUNT_ENVIRONMENT`); any other named account is refused — failed, nothing sent, no token read.
 *
 * Verdict (P1.8 completion): **green only when every required operation of every applicable channel passed**
 * (`REQUIRED_OPERATIONS`). One failed check anywhere is red. Anything short of full coverage — an account
 * or fixture nobody named, an operation with no check — is **partial**, and the sentence names each gap.
 * Nothing passed at all is not-configured. A channel with no sandbox (Etsy) is **not applicable**: out of the
 * verdict and the counts, its reason in the sentence (review 2026-09-26; it kept every run partial before).
 * Shopify is stated but out of the verdict.
 *
 * Accounts come from the environment, one per channel, because a sandbox account is not the account the
 * shop sells with: `NEXUS_CONTRACT_ACCOUNT_EBAY`, `…_AMAZON_SP`, `…_AMAZON_ADS`, `…_SHOPIFY` (Etsy is not applicable)
 * (plus `NEXUS_CONTRACT_AMAZON_SELLER_ID` for the Amazon seller path). Sandbox fixtures a check reads are
 * named the same way: `NEXUS_CONTRACT_EBAY_SANDBOX_SKU`, `NEXUS_CONTRACT_EBAY_SANDBOX_ITEM_ID`.
 */
import { gatewayCall, GatewayRefusal } from '../gateway/gateway.js'
import { sandboxUrlOf, SPEC_KEY } from '../gateway/channels.js'
import type { GatewayChannel } from '../gateway/vocabulary.js'
import {
  ACCOUNT_ENVIRONMENT, CHANNEL_CONTRACTS, NOT_APPLICABLE_CHANNELS, OUT_OF_SCOPE_CHANNELS, REQUIRED_OPERATIONS,
  type ContractCheck, type RequiredOperation,
} from './channel-contracts.js'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export type ContractCheckStatus = 'passed' | 'failed' | 'not-configured' | 'not-applicable'

export interface ContractCheckResult {
  channel: GatewayChannel
  name: string
  /** The required operation this result speaks for. */
  covers: string
  what: string
  status: ContractCheckStatus
  detail: string | null
  latencyMs: number | null
}

/** 'uncovered' = a required operation no check proves yet. */
export type ContractOperationStatus = ContractCheckStatus | 'uncovered'

export interface ContractOperationCoverage {
  operation: string
  label: string
  status: ContractOperationStatus
  checks: string[]
  detail: string | null
}

export interface ContractChannelCoverage {
  channel: GatewayChannel
  status: 'covered' | 'partial' | 'failed' | 'not-configured' | 'not-applicable'
  operations: ContractOperationCoverage[]
}

export interface ContractRunSummary {
  /**
   * green — every required operation of every applicable channel passed; red — a check failed;
   * partial — something passed but not everything required; not-configured — nothing passed.
   */
  status: 'green' | 'partial' | 'red' | 'not-configured'
  passed: number
  failed: number
  notConfigured: number
  /** Results of channels with no sandbox (Etsy): stated, never counted as passed, outside the verdict. */
  notApplicable: number
  /** Required operations of the APPLICABLE in-scope channels, and how many of them passed. */
  required: number
  proven: number
  channels: ContractChannelCoverage[]
  /** One sentence per required operation that was not proven. */
  gaps: string[]
  results: ContractCheckResult[]
  sentence: string
}

export function isContractRunEnabled(): boolean {
  return process.env.NEXUS_ENABLE_CHANNEL_CONTRACT_RUN === 'true'
}

/** The sandbox account named for a channel, or null when the Owner has not named one. */
export function contractAccountOf(channel: GatewayChannel): string | null {
  return envValue(`NEXUS_CONTRACT_ACCOUNT_${channel}`)
}

function envValue(name: string): string | null {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : null
}

type AccountEnvironment = 'production' | 'sandbox'
const CHANNEL_LABEL: Record<GatewayChannel, string> = { EBAY: 'eBay', AMAZON_SP: 'Amazon', AMAZON_ADS: 'Amazon Ads', SHOPIFY: 'Shopify', ETSY: 'Etsy' }

/** The named account's environment, read the way the token service reads it; null = no such account. */
async function accountEnvironmentOf(connectionId: string): Promise<AccountEnvironment | null> {
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { connectionMetadata: true } })
  if (!row) return null
  return (row.connectionMetadata as { environment?: string } | null)?.environment === 'sandbox' ? 'sandbox' : 'production'
}

async function runCheck(check: ContractCheck, accountId: string, environmentOf: (id: string) => Promise<AccountEnvironment | null>): Promise<ContractCheckResult> {
  const base = { channel: check.channel, name: check.name, covers: check.covers, what: check.what }
  const refused = (detail: string): ContractCheckResult => ({ ...base, status: 'failed', detail, latencyMs: null })
  const label = CHANNEL_LABEL[check.channel]

  // The account first: a check of a channel with an account rule (eBay: sandbox only) is never sent as any
  // other account — refused loudly (failed), because the Owner named the wrong kind of account.
  const required = ACCOUNT_ENVIRONMENT[check.channel]
  let environment: AccountEnvironment | null = null
  if (required || check.appClientId) {
    try {
      environment = await environmentOf(accountId)
    } catch (error) {
      return refused(`The ${label} account named for the contract run could not be read (${error instanceof Error ? error.message : String(error)}); nothing was sent.`)
    }
    if (!environment) return refused(`Refused, nothing sent: the account named in NEXUS_CONTRACT_ACCOUNT_${check.channel} (${accountId}) does not exist.`)
    if (required && environment !== required) {
      return refused(`Refused, nothing sent: the account named in NEXUS_CONTRACT_ACCOUNT_${check.channel} (${accountId}) is not an ${label} ${required} account (its connection is ${environment}); a contract check sends only a ${required} account's token.`)
    }
  }

  const unnamed = (check.needs ?? []).filter((name) => !envValue(name))
  if (unnamed.length) {
    return { ...base, status: 'not-configured', detail: `No sandbox fixture named for ${check.name} (set ${unnamed.join(', ')}); nothing was sent.`, latencyMs: null }
  }
  const fixture = Object.fromEntries((check.needs ?? []).map((name) => [name, envValue(name)!]))
  const context = { accountId, sellerId: process.env.NEXUS_CONTRACT_AMAZON_SELLER_ID ?? undefined, fixture }
  const sandboxUrl = sandboxUrlOf(check.channel, check.url(context))
  if (!sandboxUrl) {
    return { ...base, status: 'not-configured', detail: `${check.channel} has no sandbox host for this call; nothing was sent.`, latencyMs: null }
  }

  // Our app's client id, for the environment of the account the call signs in as (as every Ads caller does).
  let appClientId: string | undefined
  if (check.appClientId) {
    try {
      appClientId = (await (await import('../cx/apps.service.js')).getChannelApp(SPEC_KEY[check.channel], environment!)).clientId
    } catch (error) {
      return refused(`No ${label} app client id for the ${environment} environment (${error instanceof Error ? error.message : String(error)}); nothing was sent.`)
    }
    if (!appClientId) return refused(`No ${label} app client id for the ${environment} environment; nothing was sent.`)
  }

  const started = Date.now()
  try {
    let appToken: string | undefined
    if (check.auth === 'ebay-app') {
      if (check.channel !== 'EBAY' || environment !== 'sandbox') return refused('Notification contract reads require the eBay sandbox application; nothing was sent.')
      try { appToken = await (await import('../cx/connectors/ebay/client.js')).ebayAppToken('sandbox') }
      catch { return refused('The eBay sandbox application token could not be obtained; no notification read was sent.') }
      if (!appToken?.trim()) return refused('The eBay sandbox application returned no token; no notification read was sent.')
    }
    // eBay Trading carries the token in its own header: the account's token, from the same source the
    // gateway uses, and never a call without it (a failed token read is a failed check, below).
    const token = check.auth === 'iaf-header'
      ? await (await import('../cx/token.service.js')).getAccessToken(accountId)
      : undefined
    if (check.auth === 'iaf-header' && !token) throw new Error(`No token for the ${check.channel} sandbox account; nothing was sent.`)
    const answer = await gatewayCall({
      channel: check.channel,
      operation: `contract.${check.name}`,
      // A contract check is a read or the channel's own dry run — never a write.
      kind: 'read',
      connectionId: accountId,
      url: sandboxUrl,
      method: check.method ?? 'GET',
      headers: { ...check.headers?.({ ...context, token, appClientId }), ...(appToken ? { Authorization: `Bearer ${appToken}` } : {}) },
      body: check.body?.({ ...context, token, appClientId }) ?? null,
      ...(check.auth === 'iaf-header' || check.auth === 'ebay-app' ? { auth: 'none' as const } : {}),
      ...(check.answerOk ? { answerOk: check.answerOk } : {}),
      timeoutMs: 30_000,
    })
    const detail = check.assert({ status: answer.status, text: answer.text, json: answer.json.bind(answer) }, context)
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

function operationCoverage(channel: GatewayChannel, op: RequiredOperation, results: ContractCheckResult[]): ContractOperationCoverage {
  const mine = results.filter((r) => r.channel === channel && r.covers === op.id)
  const base = { operation: op.id, label: op.label, checks: mine.map((r) => r.name) }
  const first = (status: ContractCheckStatus) => mine.find((r) => r.status === status)
  if (mine.length === 0) return { ...base, status: 'uncovered', detail: op.gap ?? 'no check proves it yet' }
  if (first('failed')) return { ...base, status: 'failed', detail: first('failed')!.detail }
  if (mine.every((r) => r.status === 'passed')) return { ...base, status: 'passed', detail: null }
  // Not-configured and not-applicable are never a pass, whatever else covered the operation. Not-configured
  // wins: a check that exists but could not run must never be excused as "no sandbox".
  const blocker = first('not-configured') ?? first('not-applicable')!
  return { ...base, status: blocker.status, detail: blocker.detail }
}

function channelStatus(operations: ContractOperationCoverage[]): ContractChannelCoverage['status'] {
  if (operations.some((op) => op.status === 'failed')) return 'failed'
  // A channel that requires nothing proves nothing: never excluded, never covered.
  if (operations.length === 0) return 'not-configured'
  // Only a WHOLE channel leaves the verdict; one not-applicable operation beside others keeps it partial.
  if (operations.every((op) => op.status === 'not-applicable')) return 'not-applicable'
  const passed = operations.filter((op) => op.status === 'passed').length
  if (passed === operations.length) return 'covered'
  return passed === 0 ? 'not-configured' : 'partial'
}

const gapSentence = (op: ContractOperationCoverage) =>
  `${op.label} — ${op.status === 'uncovered' ? op.detail : `${op.status}: ${op.detail ?? 'no detail'}`}`.replace(/\.\s*$/, '')

/**
 * The verdict from the results, against a required-operations list. Pure, so the rule is tested on its own.
 * A channel whose every operation is not applicable (no sandbox) leaves the verdict and the counts; it is
 * named with its reason in every sentence, so its absence from "green" is visible, not silent.
 */
export function summarizeContractRun(
  results: ContractCheckResult[],
  required: Partial<Record<GatewayChannel, RequiredOperation[]>> = REQUIRED_OPERATIONS,
): ContractRunSummary {
  const channels: ContractChannelCoverage[] = (Object.entries(required) as Array<[GatewayChannel, RequiredOperation[]]>)
    .map(([channel, ops]) => {
      const operations = ops.map((op) => operationCoverage(channel, op, results))
      return { channel, status: channelStatus(operations), operations }
    })
  const applicable = channels.filter((c) => c.status !== 'not-applicable')
  const excluded = channels.filter((c) => c.status === 'not-applicable')
  const operations = applicable.flatMap((c) => c.operations)
  const gaps = operations.filter((op) => op.status !== 'passed').map(gapSentence)
  const proven = operations.length - gaps.length

  const count = (status: ContractCheckStatus) => results.filter((r) => r.status === status).length
  const passed = count('passed')
  const failed = count('failed')
  const notConfigured = count('not-configured')
  const notApplicable = count('not-applicable')
  // A failed check anywhere is red, in scope or not: a channel changed. Green needs every required
  // operation of every applicable channel proven — an empty required list proves nothing.
  const status: ContractRunSummary['status'] = failed > 0 ? 'red'
    : passed === 0 ? 'not-configured'
    : operations.length > 0 && applicable.every((c) => c.status === 'covered') ? 'green'
    : 'partial'

  // How much was proven comes FIRST: the cron dashboards show a truncated summary.
  const head = `${proven}/${operations.length} required operations proven — `
  const notProven = gaps.length ? ` Not proven: ${gaps.join(' | ')}.` : ''
  // A pass that proves less than a contract says so, by channel (Amazon SP's static sandbox).
  const reachOnly = applicable.filter((c) => c.status === 'covered' && (required[c.channel] ?? []).every((op) => op.proves === 'sign-in and reachability'))
  const reach = reachOnly.length ? ` ${reachOnly.map((c) => c.channel).join(', ')}: sign-in and reachability only (static sandbox examples), not a contract check.` : ''
  const outside = excluded.length
    ? ` Not applicable (excluded from the verdict): ${excluded.map((c) => `${c.channel} — ${c.operations[0]?.detail ?? 'no reason given'}`.replace(/\.\s*$/, '')).join(' | ')}.`
    : ''
  const sentence = status === 'red'
    ? `${head}Red: ${failed} channel contract check(s) failed: ${results.filter((r) => r.status === 'failed').map((r) => `${r.name} — ${r.detail}`).join(' | ')}.${notProven}${outside}`
    : status === 'green'
      ? `${head}Green on ${applicable.map((c) => c.channel).join(', ')}.${reach}${outside}`
      : status === 'partial'
        ? `${head}Partial, not green.${notProven}${reach}${outside}`
        : `${head}No channel contract check could run.${notProven}${outside}`

  return { status, passed, failed, notConfigured, notApplicable, required: operations.length, proven, channels, gaps, results, sentence }
}

/** Run every contract check. Never throws: the summary is the result, including when nothing could run. */
export async function runChannelContracts(): Promise<ContractRunSummary> {
  const results: ContractCheckResult[] = []
  // One read per named account per run, however many of its checks need it.
  const environments = new Map<string, Promise<AccountEnvironment | null>>()
  const environmentOf = (id: string) => {
    if (!environments.has(id)) environments.set(id, accountEnvironmentOf(id))
    return environments.get(id)!
  }

  for (const check of CHANNEL_CONTRACTS) {
    const accountId = contractAccountOf(check.channel)
    if (!accountId) {
      results.push({ channel: check.channel, name: check.name, covers: check.covers, what: check.what, status: 'not-configured',
        detail: `No sandbox account named for ${check.channel} (set NEXUS_CONTRACT_ACCOUNT_${check.channel}).`, latencyMs: null })
      continue
    }
    results.push(await runCheck(check, accountId, environmentOf))
  }

  // No sandbox exists, so nothing is ever sent: each operation is stated NOT APPLICABLE, with the reason.
  for (const { channel, reason } of NOT_APPLICABLE_CHANNELS) {
    for (const op of REQUIRED_OPERATIONS[channel] ?? []) {
      results.push({ channel, name: op.id, covers: op.id, what: 'read', status: 'not-applicable', detail: reason, latencyMs: null })
    }
  }

  for (const { channel, reason } of OUT_OF_SCOPE_CHANNELS) {
    const accountId = contractAccountOf(channel)
    results.push({ channel, name: `${channel.toLowerCase()}.sandbox`, covers: `${channel.toLowerCase()}.sandbox`, what: 'read', status: 'not-configured',
      detail: accountId ? `${reason} (an account is named, but this run has no check for it yet.)` : reason, latencyMs: null })
  }

  const summary = summarizeContractRun(results)
  const log = summary.status === 'red' ? logger.error : logger.info
  log.call(logger, 'channel-contract-run', { status: summary.status, proven: summary.proven, required: summary.required, passed: summary.passed, failed: summary.failed, notConfigured: summary.notConfigured, notApplicable: summary.notApplicable })
  return summary
}
