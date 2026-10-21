/**
 * Platform health — the Meta ads connection (Meta ads step 5, 2026-10-21: "platform-health-checks learns META").
 *
 * Like the Amazon checks, it reads Nexus's OWN records and makes no Meta call: the daily watchdog must never spend the
 * business's Meta rate limit, and a part that stopped is found from what Nexus kept of it.
 *
 *   meta-ads   per Meta connection of the business: its state (steps 1–2: sign-in, token, permissions, a chosen ad
 *              account, the daily read and a token Meta refused during it — AUTH_LOST), the token's last check (the
 *              heartbeat checks it every 12 h with debug_token) and its expiry (Nexus renews a 60-day token 30 days
 *              before it ends, so 14 days left means the renewal kept failing), the daily read's last success (06:50 UTC
 *              every day), the ad account's status and disable reason as the last read saw them (Meta lets ads run only
 *              in status 1, 8 and 9), Meta's throttles in the call ledger in the last 24 h, and Meta's notices that a
 *              call was upgraded from an expired API version (X-Ad-Api-Version-Warning, the deprecation watch).
 *
 * A business with no Meta connection has nothing to watch here: ok. Evidence holds ids, dates, counts and codes only.
 * meta-account-health view summary answers the same facts with their details; its live views read Meta now.
 */
import prisma from '../../../db.js'
import { DAY, HOUR, plural, worst, type CheckStatus, type HealthCheck, type Verdict } from '../types.js'

/** The ad account statuses in which Meta delivers ads (reference/ad-account, account_status; master LG-006). */
export const META_RUNNING_STATUSES: ReadonlySet<number> = new Set([1, 8, 9])
/** account_status → what it means for the ads. */
export const META_ACCOUNT_STATUS_MEANING: Readonly<Record<number, string>> = {
  1: 'Active: ads can run.',
  2: 'Disabled: no ad runs. The disable reason says why; a person appeals in Meta\'s Account Quality (no API).',
  3: 'Unsettled: a payment is due and ads do not run until it is paid (Ads Manager › Billing and payments).',
  7: 'Under Meta\'s risk review: no ad runs until Meta finishes it.',
  8: 'Pending settlement: ads still run while a payment is settled.',
  9: 'In grace period: ads still run for now; pay the open balance before the grace period ends.',
  100: 'Being closed: no ad runs.',
  101: 'Closed: no ad runs.',
}
/** Review B7 — Meta's reference names each disable reason only: what to do about it is Nexus's advice, and is labelled so. */
export const NEXUS_ADVICE = 'Nexus\'s advice: Meta\'s reference gives only the reason\'s name (reference/ad-account, disable_reason).'
/** disable_reason → what a person does about it, in Nexus's words (Meta's reference lists the names 0–15 only). */
export const META_DISABLE_REASON_STEP: Readonly<Record<number, string>> = {
  1: 'Meta found an ads policy breach: read Account Quality in Meta Business Suite and request a review there.',
  2: 'Meta is reviewing intellectual-property reports: answer in Account Quality.',
  3: 'Meta sees a payment risk: check the payment method in Billing and payments, then request a review in Account Quality.',
  4: 'Meta shut the account down as untrusted: only Meta support can say more.',
  5: 'Meta is reviewing the account (AFC review): wait for Meta or request a review in Account Quality.',
  6: 'The business portfolio is under an integrity review: read Account Quality for the business.',
  7: 'Closed for good: it cannot run ads again; use another ad account.',
  8: 'An unused reseller account was closed: reopen it in Meta Business settings or use another one.',
  9: 'Closed as unused: reopen it in Meta Business settings, or use another ad account.',
  10: 'An umbrella ad account: Meta does not let it run ads.',
  11: 'The business portfolio broke Meta\'s Business Manager policies: read Account Quality for the business.',
  12: 'Meta judged the account misrepresented: request a review in Account Quality.',
  13: 'The legal entity was un-shared from the account: share it again in Meta Business settings.',
  14: 'A click-to-message conversation is under review: read Account Quality.',
  15: 'Meta thinks the account was compromised: secure the people and the business in Meta first; make no ad change until Meta restores it.',
}

export interface MetaConnectionFacts {
  connectionId: string
  label: string
  /** steps 1–2's state (meta-accounts.service.ts metaConnectionState) and its sentence. */
  state: string
  stateText: string
  token: { checkedAt: string | null; isValid: boolean | null; expiresAt: string | null; neverExpires: boolean; missingRequired: string[] }
  adAccountId: string | null
  read: { lastReadAt: string | null; lastSuccessAt: string | null; lastStatus: string | null; lastDataDay: string | null }
  /** As the last daily read saw it; null when Nexus has not read the account. */
  account: { status: number | null; disableReason: number | null } | null
}

export interface MetaHealthFacts {
  /** False when NEXUS_META_ADS_SYNC switches the daily read off on the server. */
  readingOn: boolean
  connections: MetaConnectionFacts[]
  /** Meta's throttles (and Nexus's own holds before Meta's limit) in the call ledger, last 24 h, per connection and code. */
  throttles: Array<{ connectionId: string | null; code: string; calls: number; lastAt: string | null; local: boolean }>
  /** Calls to Meta in the same 24 h, per connection. */
  calls: Array<{ connectionId: string | null; calls: number }>
  /** Meta's "upgraded from an expired API version" notices (deprecation watch) in the last 30 days, distinct endpoints. */
  versionNotices: number
}

/** The heartbeat checks the token every 12 h (cx/connectors/meta/spec.ts CHECK_EVERY_MS): older than this is late. */
const META_TOKEN_CHECK_LATE_MS = 36 * HOUR
/** Nexus renews 30 days before the end; this many days left means the renewal kept failing. */
export const META_TOKEN_WARN_DAYS = 14
const META_TOKEN_FAIL_DAYS = 7
/** The daily read runs at 06:50 UTC: its last success older than this is late, older than the second a failure. */
const META_READ_LATE_MS = 26 * HOUR
const META_READ_FAIL_MS = 50 * HOUR
/** Meta throttled this many calls in 24 h: worth a look (Nexus backs off from 75 % of Meta's limits on its own). */
const META_THROTTLES_WARN = 5
/** Nexus's own hold before Meta's limit (gateway rate bucket), not Meta's refusal. */
export const LOCAL_HOLD = 'RATE_LIMITED_LOCAL'

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)
const hoursAgo = (at: string | null, now: Date) => (at ? Math.floor((now.getTime() - Date.parse(at)) / HOUR) : null)
const daysLeft = (at: string | null, now: Date) => (at ? Math.floor((Date.parse(at) - now.getTime()) / DAY) : null)

/** One connection judged: its status and what is wrong, in words. Pure. */
function judgeConnection(c: MetaConnectionFacts, facts: MetaHealthFacts, now: Date): { status: CheckStatus; problems: string[] } {
  const problems: Array<[CheckStatus, string]> = []
  const name = `Meta "${c.label}"`
  if (c.state === 'sign_in_needed' || c.state === 'token_problem' || c.state === 'permission_missing') problems.push(['fail', `${name}: ${c.stateText}`])
  else if (c.state === 'choose_account') problems.push(['warn', `${name}: no ad account is chosen, so Nexus reads nothing (Settings › Channels › Meta).`])
  // The token: its last check, its expiry.
  const checkedHours = hoursAgo(c.token.checkedAt, now)
  if (c.state !== 'sign_in_needed') {
    if (checkedHours === null) problems.push(['warn', `${name}: Nexus has not checked the token with Meta yet (it checks every 12 hours).`])
    else if (checkedHours * HOUR > META_TOKEN_CHECK_LATE_MS) problems.push(['warn', `${name}: the token was last checked ${checkedHours} hours ago (Nexus checks it every 12 hours: the connection heartbeat may not be running).`])
    const left = c.token.neverExpires ? null : daysLeft(c.token.expiresAt, now)
    if (left !== null && left >= 0 && left < META_TOKEN_FAIL_DAYS) problems.push(['fail', `${name}: the token expires in ${plural(left, 'day')} and Nexus could not renew it: make a new system-user token in Meta Business settings and enter it in Settings › Channels › Meta.`])
    else if (left !== null && left >= 0 && left < META_TOKEN_WARN_DAYS) problems.push(['warn', `${name}: the token expires in ${left} days and Nexus has not renewed it yet (it tries from 30 days before).`])
  }
  // The daily read (only once an account is chosen and the token works).
  if (c.adAccountId && (c.state === 'ok' || c.state === 'read_failed' || c.state === 'first_read_pending')) {
    const status = c.read.lastStatus
    const successHours = hoursAgo(c.read.lastSuccessAt, now)
    if (!facts.readingOn) problems.push(['warn', `${name}: the daily Meta read is switched off on the server (NEXUS_META_ADS_SYNC), so the numbers do not move.`])
    else if (status === 'AUTH_LOST' || status === 'FAILED') problems.push(['fail', c.state === 'read_failed' ? `${name}: ${c.stateText}` : `${name}: the last daily read ${status === 'AUTH_LOST' ? 'stopped because Meta refused the token' : 'failed'}.`])
    else if (successHours === null) problems.push(['warn', `${name}: the first read of the ad account has not finished yet.`])
    else if (successHours * HOUR > META_READ_FAIL_MS) problems.push(['fail', `${name}: the last good daily read is ${successHours} hours old (it runs every day at 06:50 UTC).`])
    else if (successHours * HOUR > META_READ_LATE_MS) problems.push(['warn', `${name}: the last good daily read is ${successHours} hours old (it runs every day at 06:50 UTC).`])
    if (facts.readingOn && (status === 'PARTIAL' || status === 'THROTTLED')) problems.push(['warn', `${name}: the last daily read was not complete (${status === 'THROTTLED' ? 'Meta asked Nexus to slow down' : 'a part of it failed'}).`])
  }
  // The ad account as the last read saw it.
  const s = c.account?.status ?? null
  const reason = c.account?.disableReason ?? null
  if (s !== null && s !== 1) {
    const words = META_ACCOUNT_STATUS_MEANING[s] ?? `status ${s}, which Meta does not document.`
    problems.push([META_RUNNING_STATUSES.has(s) ? 'warn' : 'fail', `${name}: the ad account's status at Meta is ${words}`])
  }
  if (reason !== null && reason !== 0) problems.push(['fail', `${name}: Meta gives disable reason ${reason}. ${META_DISABLE_REASON_STEP[reason] ? `Nexus's advice: ${META_DISABLE_REASON_STEP[reason]}` : 'Meta does not document it.'}`])
  // Meta's throttles of this connection.
  const meta = facts.throttles.filter((t) => t.connectionId === c.connectionId && !t.local)
  const throttled = meta.reduce((n, t) => n + t.calls, 0)
  if (meta.some((t) => t.code === '613')) problems.push(['warn', `${name}: Meta cut Nexus's calls without naming a limit (613, its abuse protection) in the last 24 hours: find what calls so often, and ask Meta support if it goes on.`])
  else if (throttled >= META_THROTTLES_WARN) problems.push(['warn', `${name}: Meta throttled ${plural(throttled, 'call')} in the last 24 hours (${meta.map((t) => t.code).join(', ')}); Nexus backs off and reads again later.`])
  return { status: worst(problems.length ? problems.map(([st]) => st) : ['ok']), problems: problems.map(([, words]) => words) }
}

/** The verdict over every Meta connection of the business. Pure. */
export function judgeMetaHealth(facts: MetaHealthFacts, now: Date): Verdict {
  if (!facts.connections.length) {
    return { status: 'ok', message: 'This business has no Meta connection: there is nothing to watch.', likelyCause: null, nextStep: null, evidence: { connections: 0 } }
  }
  const judged = facts.connections.map((c) => ({ c, ...judgeConnection(c, facts, now) }))
  const problems = judged.flatMap((j) => j.problems)
  if (facts.versionNotices > 0) problems.push(`Meta upgraded ${plural(facts.versionNotices, 'call')} from an expired API version in the last 30 days: the pinned version (META_GRAPH_API_VERSION) has to move, or calls Meta no longer upgrades will fail.`)
  const status = worst([...judged.map((j) => j.status), ...(facts.versionNotices > 0 ? ['warn' as const] : [])])
  const healthy = judged.filter((j) => j.status === 'ok').map((j) => j.c)
  const fine = healthy.map((c) => `"${c.label}" — token checked ${c.token.checkedAt?.slice(0, 16).replace('T', ' ') ?? 'never'} UTC${c.token.neverExpires ? ', no expiry date' : c.token.expiresAt ? `, valid until ${c.token.expiresAt.slice(0, 10)}` : ''}${c.read.lastSuccessAt ? `, last daily read ${c.read.lastSuccessAt.slice(0, 16).replace('T', ' ')} UTC` : ''}`)
  return {
    status,
    message: problems.length
      ? `${problems.join(' ')}${fine.length ? ` Fine: ${fine.join('; ')}.` : ''}`
      : `The Meta connection is healthy: ${fine.join('; ')}; the ad account can run ads and Meta is not throttling Nexus.`,
    likelyCause: status === 'ok' ? null : judged.some((j) => j.c.state === 'sign_in_needed' || j.c.state === 'token_problem')
      ? 'Meta no longer accepts the system-user token (made again, expired, or its app or permissions changed).'
      : 'See each sentence: the token, the daily read, the ad account\'s status at Meta, or Meta\'s rate limits.',
    nextStep: status === 'ok' ? null : 'Read meta-account-health (view summary, then the live views connection, account and problems) for the details; until the Meta read is current, make no Meta change that rests on its numbers.',
    evidence: {
      readingOn: facts.readingOn,
      connections: judged.map(({ c, status: s }) => ({
        connectionId: c.connectionId, label: c.label, status: s, state: c.state, adAccountId: c.adAccountId,
        tokenCheckedAt: c.token.checkedAt, tokenValid: c.token.isValid, tokenExpiresAt: c.token.expiresAt, tokenNeverExpires: c.token.neverExpires, missingPermissions: c.token.missingRequired,
        lastReadAt: c.read.lastReadAt, lastSuccessAt: c.read.lastSuccessAt, lastReadStatus: c.read.lastStatus, lastDataDay: c.read.lastDataDay,
        accountStatus: c.account?.status ?? null, disableReason: c.account?.disableReason ?? null,
      })),
      throttles24h: facts.throttles,
      calls24h: facts.calls,
      versionNotices30d: facts.versionNotices,
    },
  }
}

/** The facts, from Nexus's own records only (no Meta call). */
export async function gatherMetaHealthFacts(now: Date): Promise<MetaHealthFacts> {
  // Imported when run, as the other checks do with their services: the registry stays light.
  const [{ listMetaConnections }, { metaAdsSyncSwitchedOff }] = await Promise.all([
    import('../../meta/meta-accounts.service.js'),
    import('../../marketing/meta-ads/sync-switch.js'),
  ])
  const connections = await listMetaConnections(now)
  const accountIds = connections.map((c) => c.adAccount?.adAccountId).filter((id): id is string => !!id)
  const since = new Date(now.getTime() - DAY)
  const [accounts, throttles, calls, notices] = await Promise.all([
    accountIds.length
      ? prisma.metaAdAccount.findMany({ where: { adAccountId: { in: accountIds } }, select: { adAccountId: true, accountStatus: true, disableReason: true, lastSuccessAt: true } })
      : Promise.resolve([]),
    // Every Meta row of the ledger in the window (cheap: one channel, one day), so the query runs even with no connection.
    prisma.outboundApiCallLog.groupBy({
      by: ['connectionId', 'errorCode'],
      where: { channel: 'META', createdAt: { gte: since }, OR: [{ errorClass: 'rate_limited' }, { errorCode: LOCAL_HOLD }] },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.outboundApiCallLog.groupBy({ by: ['connectionId'], where: { channel: 'META', createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.notification.findMany({
      where: { type: 'channel-deprecation', entityId: { startsWith: 'META:' }, createdAt: { gte: new Date(now.getTime() - 30 * DAY) } },
      select: { entityId: true }, distinct: ['entityId'], take: 100,
    }),
  ])
  const byAccount = new Map(accounts.map((a) => [a.adAccountId, a]))
  return {
    readingOn: !metaAdsSyncSwitchedOff(),
    connections: connections.map((c) => {
      const stored = c.adAccount ? byAccount.get(c.adAccount.adAccountId) ?? null : null
      return {
        connectionId: c.connectionId,
        label: c.label,
        state: c.state,
        stateText: c.stateText,
        token: { checkedAt: c.token.checkedAt, isValid: c.token.isValid, expiresAt: c.token.expiresAt, neverExpires: c.token.neverExpires, missingRequired: c.token.missing.filter((m) => m.required).map((m) => m.scope) },
        adAccountId: c.adAccount?.adAccountId ?? null,
        read: { lastReadAt: c.read.lastReadAt, lastSuccessAt: iso(stored?.lastSuccessAt ?? null), lastStatus: c.read.lastStatus, lastDataDay: c.read.lastDataDay },
        account: stored ? { status: stored.accountStatus, disableReason: stored.disableReason } : null,
      }
    }),
    throttles: throttles.map((t) => ({ connectionId: t.connectionId, code: t.errorCode ?? 'unknown', calls: t._count._all, lastAt: iso(t._max.createdAt), local: t.errorCode === LOCAL_HOLD })),
    calls: calls.map((c) => ({ connectionId: c.connectionId, calls: c._count._all })),
    versionNotices: notices.length,
  }
}

export const metaAdsCheck: HealthCheck<MetaHealthFacts> = {
  id: 'meta-ads',
  subsystem: 'data-feeds',
  title: 'Meta ads connection',
  watches: 'Each Meta connection\'s token is valid, checked in the last 36 hours and not near its end; the daily read of the chosen ad account succeeded in the last day; the ad account can run ads; Meta is not throttling Nexus; no call needed an expired API version.',
  gather: (ctx) => gatherMetaHealthFacts(ctx.now),
  judge: judgeMetaHealth,
}
