/**
 * AX-ZD.1e — does claimEntityWrite actually give mutual exclusion?
 *
 * The advisory-lock primitive was measured separately. What this proves is the
 * COMPOSITION — lock + blocker check + state claim — under real concurrency,
 * which is the only thing that matters and the one thing a mocked unit test
 * cannot show.
 *
 * Uses synthetic entity ids that can never collide with a real campaign, and
 * removes every row it creates in a finally block.
 */
import prisma from '../src/db.js'
import { claimEntityWrite } from '../src/services/advertising/ads-mutation.service.js'

const ENTITY_ID = `zd1e-probe-${process.pid}`
const Q1 = `zd1e-q1-${process.pid}`
const Q2 = `zd1e-q2-${process.pid}`
let failures = 0

const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

try {
  await prisma.adMutation.createMany({
    data: [Q1, Q2].map((q, i) => ({
      entityType: 'CAMPAIGN', entityId: ENTITY_ID, field: `probeField${i}`,
      intendedValue: 'x', state: 'PENDING', actor: 'automation:zd1e-probe',
      idempotencyKey: `${q}:probeField${i}`, outboundQueueId: q,
    })),
  })

  // Two workers race for the same entity. Exactly one may win.
  const [a, b] = await Promise.all([
    claimEntityWrite('CAMPAIGN', ENTITY_ID, Q1),
    claimEntityWrite('CAMPAIGN', ENTITY_ID, Q2),
  ])
  check('exactly one concurrent claim wins', [a, b].filter(Boolean).length === 1, `A=${a} B=${b}`)

  const inFlight = await prisma.adMutation.count({
    where: { entityId: ENTITY_ID, state: 'IN_FLIGHT' },
  })
  check('exactly one row moved to IN_FLIGHT', inFlight === 1, `count=${inFlight}`)

  // The loser must still be claimable once the winner settles.
  const loserQ = a ? Q2 : Q1
  const winnerQ = a ? Q1 : Q2
  const blockedAgain = await claimEntityWrite('CAMPAIGN', ENTITY_ID, loserQ)
  check('loser is still refused while the winner is in flight', blockedAgain === false)

  await prisma.adMutation.updateMany({
    where: { outboundQueueId: winnerQ },
    data: { state: 'APPLIED', settledAt: new Date() },
  })
  const afterSettle = await claimEntityWrite('CAMPAIGN', ENTITY_ID, loserQ)
  check('loser claims successfully once the winner settles', afterSettle === true)

  // A different entity must never be blocked by this one.
  const OTHER = `${ENTITY_ID}-other`
  await prisma.adMutation.create({
    data: {
      entityType: 'CAMPAIGN', entityId: OTHER, field: 'probeField0',
      intendedValue: 'x', state: 'PENDING', actor: 'automation:zd1e-probe',
      idempotencyKey: `zd1e-q3-${process.pid}:probeField0`,
      outboundQueueId: `zd1e-q3-${process.pid}`,
    },
  })
  const otherClaim = await claimEntityWrite('CAMPAIGN', OTHER, `zd1e-q3-${process.pid}`)
  check('a different entity is not blocked', otherClaim === true)
} finally {
  const removed = await prisma.adMutation.deleteMany({
    where: { entityId: { startsWith: `zd1e-probe-${process.pid}` } },
  })
  console.log(`cleaned up ${removed.count} probe rows`)
  await prisma.$disconnect()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
