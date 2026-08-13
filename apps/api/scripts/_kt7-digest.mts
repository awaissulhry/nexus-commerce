/**
 * _kt7-digest.mts — KT.7 §4.3: prove the digest with NEXUS_ENABLE_OUTBOUND_EMAILS OFF.
 *
 * 🔴 An unsent email is the easiest possible false positive, so this asserts the transport reports
 * dryRun rather than trusting that it "worked". READ-ONLY apart from whatever the transport logs.
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { buildKtDigest, renderKtDigest, notableSince, kt7Thresholds } from '../src/services/advertising/kt7-notify.service.js'
import { runKtDigestOnce } from '../src/jobs/kt-digest.job.js'
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }

async function main() {
  h('the gates, before anything is claimed')
  line(`NEXUS_ENABLE_OUTBOUND_EMAILS = ${process.env.NEXUS_ENABLE_OUTBOUND_EMAILS ?? 'unset ⇒ the transport is a mock and sends nothing'}`)
  line(`NEXUS_ENABLE_KT_DIGEST_CRON  = ${process.env.NEXUS_ENABLE_KT_DIGEST_CRON ?? 'unset ⇒ the cron does not schedule'}`)
  line(`NEXUS_KT_DIGEST_TO           = ${process.env.NEXUS_KT_DIGEST_TO ?? 'unset ⇒ build, do not send'}`)
  line(`RESEND_API_KEY               = ${process.env.RESEND_API_KEY ? 'set' : 'unset'}`)

  h('the thresholds it will judge with')
  const t = kt7Thresholds()
  line(`targets ≥ ${t.targets} · campaigns ≥ ${t.campaigns} · commit ≥ €${(t.commitCents / 100).toFixed(2)} · bid change ≥ €${(t.bidDeltaCents / 100).toFixed(2)}`)

  h('the digest for the last 24h — CONTENT, verified before any inbox is involved')
  const since = new Date(Date.now() - 24 * 3600_000)
  const data = await buildKtDigest(since)
  line(`applied(still standing) ${data.applied} · reversed ${data.reversed} · refused ${data.refused} · open proposals ${data.proposedOpen} · engine bid writes ${data.engineBidWrites}`)
  const r = renderKtDigest(data)
  line()
  line(`SUBJECT: ${r.subject}`)
  line()
  for (const l of r.text.split('\n')) line(`  ${l}`)

  h('the "quiet day" branch — it must NOT read like the digest failed')
  const quiet = await buildKtDigest(new Date('2020-01-01'), new Date('2020-01-02'))
  const qr = renderKtDigest(quiet)
  line(`SUBJECT: ${qr.subject}`)
  for (const l of qr.text.split('\n').slice(0, 3)) line(`  ${l}`)

  h('notable events, and WHY each qualified')
  const n = await notableSince(new Date(Date.now() - 7 * 86_400_000))
  line(`notable in 7d: ${n.length}`)
  for (const x of n) line(`  [${x.kind}] "${x.term}" ${x.marketplace} — tripped: ${x.tripped.join(', ')}`)

  h('the job, end to end, with the gate OFF')
  const summary = await runKtDigestOnce()
  line(summary)
  line()
  line(summary.includes('NOT SENT') || summary.includes('dry-run')
    ? '✓ the job says plainly that nothing was sent, and why — no false positive available here'
    : '🔴 it claimed a send with the outbound gate off')

  h('control')
  line(`KeywordBidProposal rows ${await prisma.keywordBidProposal.count()}`)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
