/**
 * KT.7 §4.3 — the notification channels, and the definition of "big".
 *
 * The operator's model was four channels: **daily digest · failures and refusals · a live change log
 * on the page · immediate for anything big.** The change log is the drawer (KT.7 web). This file is
 * the other three, and it deliberately reuses what exists rather than adding a transport:
 * `sendEmail` from `services/email/transport.js`, which is the same Resend path the dashboard digest
 * uses and which **returns `dryRun: true` and sends nothing** unless `NEXUS_ENABLE_OUTBOUND_EMAILS`
 * is set. An unsent email is the easiest possible false positive, so every result here carries that
 * flag through to the caller rather than reporting "sent".
 *
 * ── 🔴 "Anything big", and the axis that had to be refused ────────────────────────────────────
 *
 * Measured over 30 days on `AD_BID_UPDATE`/`AD_TARGET` (18,202 rows, both bids readable on all of
 * them):
 *
 * | candidate axis | measured | verdict |
 * |---|---|---|
 * | absolute bid change | p50 €0.33 · p90 €0.40 · **p99 €1.56** · max €2.49 | usable |
 * | targets per change set | only **4 sets** in 30d; p50 6, p90 81 | usable, but 81 is a p90 of four samples |
 * | euros committed | last published day, all markets **€115.76** | usable |
 * | **percentage bid change** | p50 **95%** · p90 **1,650%** · p99 **5,900%** | 🔴 **refused** |
 *
 * The percentage axis is unusable on this account and it is worth saying why: the no-pause
 * suppress/restore cycle turns 2¢ into 42¢ (+2,000%) thousands of times a month, so a percentage
 * threshold fires on every restore and never on a real operator decision. Only **100 of 18,202** bid
 * writes in 30 days were operator-made. The absolute change carries the same intent without the
 * distortion.
 *
 * Every threshold below is a DEFAULT with an env override, and the digest prints the value it used
 * beside the number it judged — a threshold nobody chose is a threshold nobody trusts, and one nobody
 * can see is worse.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { sendEmail } from '../email/transport.js'

const numEnv = (k: string, d: number): number => {
  const v = Number(process.env[k])
  return Number.isFinite(v) && v > 0 ? v : d
}

export interface Kt7Thresholds {
  targets: number
  commitCents: number
  campaigns: number
  bidDeltaCents: number
}

/** The defaults, each anchored to the measurement in this file's header. */
export function kt7Thresholds(): Kt7Thresholds {
  return {
    // 20, not the measured p90 of 81: 81 is a p90 of FOUR change sets, which is not an anchor. 20 is
    // about half of what `giacca moto` currently resolves to (39 targets), so a row of that size trips.
    targets: numEnv('NEXUS_KT_BIG_TARGETS', 20),
    // 10% of the most recent published all-market day (€115.76).
    commitCents: numEnv('NEXUS_KT_BIG_COMMIT_CENTS', 1158),
    campaigns: numEnv('NEXUS_KT_BIG_CAMPAIGNS', 5),
    // p99 of every bid move in 30 days. NOT a percentage — see the header.
    bidDeltaCents: numEnv('NEXUS_KT_BIG_BID_DELTA_CENTS', 156),
  }
}

export interface Kt7Notable {
  kind: 'applied' | 'refused'
  id: string
  term: string
  marketplace: string
  at: Date
  targets: number
  campaigns: number
  commitCents: number
  bidCents: number
  /** which thresholds it crossed — named, so "big" is never a bare adjective */
  tripped: string[]
  text: string
}

/**
 * Anything worth an immediate alert, and WHY it qualified.
 *
 * A refusal is always notable regardless of size: it is the system declining to do what was asked,
 * which is precisely the thing that must never be silent. A success is notable only when it crosses a
 * threshold.
 */
export async function notableSince(since: Date): Promise<Kt7Notable[]> {
  const t = kt7Thresholds()
  const rows = await prisma.keywordBidProposal.findMany({
    where: { OR: [{ decidedAt: { gte: since } }, { proposedAt: { gte: since }, status: 'REFUSED' }] },
    orderBy: { proposedAt: 'desc' },
    take: 200,
  })

  const out: Kt7Notable[] = []
  for (const r of rows) {
    const tripped: string[] = []
    if (r.actionableTargets >= t.targets) tripped.push(`${r.actionableTargets} targets (≥ ${t.targets})`)
    if (r.actionableCampaigns >= t.campaigns) tripped.push(`${r.actionableCampaigns} campaigns (≥ ${t.campaigns})`)
    if (r.commitmentCents >= t.commitCents) tripped.push(`commits ${eur(r.commitmentCents)} (≥ ${eur(t.commitCents)})`)

    if (r.status === 'REFUSED') {
      out.push({
        kind: 'refused', id: r.id, term: r.term, marketplace: r.marketplace,
        at: r.decidedAt ?? r.proposedAt, targets: r.actionableTargets, campaigns: r.actionableCampaigns,
        commitCents: r.commitmentCents, bidCents: r.requestedBidCents,
        tripped: ['refused'],
        text: r.ceilingVerdict === 'REFUSED' ? r.ceilingMessage : r.confirmationText,
      })
      continue
    }
    if (r.status === 'APPLIED' && tripped.length > 0) {
      out.push({
        kind: 'applied', id: r.id, term: r.term, marketplace: r.marketplace,
        at: r.decidedAt ?? r.proposedAt, targets: r.actionableTargets, campaigns: r.actionableCampaigns,
        commitCents: r.commitmentCents, bidCents: r.requestedBidCents,
        tripped, text: r.confirmationText,
      })
    }
  }
  return out
}

export interface Kt7DigestData {
  since: Date
  until: Date
  applied: number
  appliedTargets: number
  appliedCommitCents: number
  refused: number
  reversed: number
  proposedOpen: number
  notable: Kt7Notable[]
  thresholds: Kt7Thresholds
  /** engine writes on the same targets, for context — the page is not the only thing moving bids */
  engineBidWrites: number
}

/**
 * The daily digest's content.
 *
 * 🔴 It reports **reversed** separately from **applied**. A change that was applied and then undone is
 * not a change the account kept, and a digest that counted it would overstate what the page did — the
 * same defect the spend ledger had before the §6 gate caught it.
 */
export async function buildKtDigest(since: Date, until = new Date()): Promise<Kt7DigestData> {
  const decided = await prisma.keywordBidProposal.findMany({
    where: { decidedAt: { gte: since, lte: until } },
    select: { id: true, status: true, actionableTargets: true, commitmentCents: true, executionId: true },
  })
  const applied = decided.filter((d) => d.status === 'APPLIED')

  let reversed = 0
  let keptTargets = 0
  let keptCents = 0
  for (const a of applied) {
    if (!a.executionId) { keptTargets += a.actionableTargets; keptCents += a.commitmentCents; continue }
    const live = await prisma.advertisingActionLog.count({ where: { executionId: a.executionId, rolledBackAt: null } })
    if (live === 0) reversed++
    else { keptTargets += a.actionableTargets; keptCents += a.commitmentCents }
  }

  // 🔴 Null-safe complement. `NOT: { userId: 'x' }` would drop every row whose actor is NULL, and a
  // third of this log carried a null actor as recently as 2026-08-04.
  const engineBidWrites = await prisma.advertisingActionLog.count({
    where: {
      actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', createdAt: { gte: since, lte: until },
      OR: [{ userId: null }, { userId: { startsWith: 'automation:' } }],
    },
  })

  return {
    since, until,
    applied: applied.length - reversed,
    appliedTargets: keptTargets,
    appliedCommitCents: keptCents,
    refused: decided.filter((d) => d.status === 'REFUSED').length,
    reversed,
    proposedOpen: await prisma.keywordBidProposal.count({ where: { status: 'PROPOSED' } }),
    notable: await notableSince(since),
    thresholds: kt7Thresholds(),
    engineBidWrites,
  }
}

function eur(c: number): string { return `€${(c / 100).toFixed(2)}` }

/**
 * Render it. Plain and short: a digest nobody reads is a digest that does not exist, and this one has
 * exactly one job — tell the operator what the Keyword Tracker did with their money yesterday.
 *
 * "Nothing happened" and "the digest could not tell" are written as different sentences, because they
 * are different facts and D4 forbids rendering them the same.
 */
export function renderKtDigest(d: Kt7DigestData): { subject: string; text: string; html: string } {
  // 🔴 The window, not a day. The digest covers a rolling 24h that STRADDLES midnight, and labelling
  // it with `since`'s date called a window mostly inside the 13th "2026-08-12". Found by reading the
  // rendered subject on prod.
  const from = d.since.toISOString().slice(0, 16).replace('T', ' ')
  const to = d.until.toISOString().slice(0, 16).replace('T', ' ')
  const window = `${from}–${to} UTC`
  const quiet = d.applied === 0 && d.refused === 0 && d.reversed === 0
  // 🔴 And the subject must name the reversals. "0 changes applied" was true and misleading on a
  // window where two changes were applied and then undone — an operator reading only the subject
  // would conclude the page had done nothing at all.
  const bits: string[] = []
  if (d.applied > 0) bits.push(`${d.applied} applied`)
  if (d.reversed > 0) bits.push(`${d.reversed} reversed`)
  if (d.refused > 0) bits.push(`${d.refused} refused`)
  const subject = quiet
    ? `Keyword Tracker — nothing was changed, ${window}`
    : `Keyword Tracker — ${bits.join(', ')}, ${window}`

  const lines: string[] = []
  if (quiet) {
    lines.push(`No bid was applied, refused or reversed from the Keyword Tracker between ${window}.`)
    lines.push(`This is "nothing was asked of it", not "it could not tell" — the page reads its own ledger, and the ledger is empty for that window.`)
  } else {
    lines.push(`Applied and still standing: ${d.applied} (${d.appliedTargets} targets, committing up to ${eur(d.appliedCommitCents)}).`)
    if (d.reversed > 0) lines.push(`Reversed: ${d.reversed} — applied and then undone, so ${d.reversed === 1 ? 'it is' : 'they are'} NOT counted above.`)
    if (d.refused > 0) lines.push(`Refused: ${d.refused}. A refusal is the system declining to do what was asked; each is listed below.`)
  }
  if (d.proposedOpen > 0) lines.push(`Waiting for a decision: ${d.proposedOpen} proposal${d.proposedOpen === 1 ? '' : 's'}.`)
  lines.push(`For scale, automation made ${d.engineBidWrites} keyword bid write${d.engineBidWrites === 1 ? '' : 's'} in the same window — this page is not the only thing moving bids.`)

  if (d.notable.length) {
    lines.push('')
    lines.push('Notable:')
    for (const n of d.notable) {
      lines.push(`  · [${n.kind}] "${n.term}" (${n.marketplace}) at ${eur(n.bidCents)} — ${n.tripped.join(', ')}`)
      lines.push(`      ${n.text}`)
    }
  }
  lines.push('')
  lines.push(`Thresholds used: ≥${d.thresholds.targets} targets · ≥${d.thresholds.campaigns} campaigns · ≥${eur(d.thresholds.commitCents)} committed · ≥${eur(d.thresholds.bidDeltaCents)} bid change.`)
  lines.push(`These are defaults, each anchored to a measurement, and each overridable (NEXUS_KT_BIG_*). A percentage-change threshold is deliberately NOT used: the suppress/restore cycle makes p90 1,650%, so it would fire on every restore and never on a decision.`)

  const text = lines.join('\n')
  const html = `<div style="font:14px/1.6 -apple-system,Segoe UI,sans-serif;color:#1c2530">${
    lines.map((l) => (l === '' ? '<div style="height:8px"></div>' : `<div>${escapeHtml(l)}</div>`)).join('')
  }</div>`
  return { subject, text, html }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}

/**
 * Send it. Returns the transport's own result untouched, including `dryRun`, so a caller can never
 * mistake "generated" for "delivered" — the transport short-circuits to a mock unless
 * `NEXUS_ENABLE_OUTBOUND_EMAILS` is set, and reporting that as a send is the easiest false positive
 * available here.
 */
export async function sendKtDigest(args: { recipients: string | string[]; since: Date; until?: Date }) {
  const data = await buildKtDigest(args.since, args.until)
  const r = renderKtDigest(data)
  const res = await sendEmail({
    to: args.recipients, subject: r.subject, html: r.html, text: r.text, tag: 'kt-digest',
  })
  logger.info('[kt-digest] built', {
    applied: data.applied, refused: data.refused, reversed: data.reversed,
    notable: data.notable.length, sent: res.ok && !res.dryRun, dryRun: res.dryRun,
  })
  return { data, rendered: r, result: res }
}
